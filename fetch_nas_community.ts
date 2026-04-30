/**
 * Automated nas.com community scraper for the
 * "TechUprise Insider Club" community.
 *
 * Strategy (v2.1 — last 12h window, oldest-first, dedup-aware):
 *
 *   1. Launch Puppeteer with the persistent profile under ./nas_chrome_profile
 *      so the user only logs in once (cookies persist across runs).
 *   2. Navigate to https://nas.com/techuprise-insider-club/community.
 *      If we land on Home, click the Community tab. Then wait for the Feed.
 *   3. Walk the feed and collect every post card with its relative-age label
 *      ("45m ago" / "2h ago" / …). Keep only cards whose age is ≤ --max-age-hours
 *      (default 12). Sort the survivors OLDEST-FIRST so the dashboard receives
 *      rows in chronological order (oldest first, newest last).
 *   4. Each post key is stable: a sha1 of the headline + first 240 chars of
 *      the snippet — unaffected by the "Xh ago" label which would otherwise
 *      drift between runs. The dedup gate uses BOTH:
 *         - nas_seen_posts.json  (this script's own log)
 *         - applications.json    (channel = "TechUprise NAS Community", via
 *                                 the dedupeId field stored in `telegramId`)
 *      Cards already present in either store are SKIPPED (since we walk
 *      oldest-first within a 12h window we don't break — we just continue).
 *      A post is therefore never re-AI'd.
 *   5. For each new card: click into it (modal or URL-nav, both handled),
 *      scroll the post body fully, capture:
 *         - headline (bold post title)
 *         - full inner text (description, links, everything)
 *         - the relative-time label from the card ("45m ago" / "2h ago" / …)
 *      and parse the relative time into an absolute `postedDate`. The
 *      wall-clock at scrape time becomes `scrapedAt` / `appliedDate`.
 *   6. Send the captured text to the LLM with a multi-job aware prompt that
 *      returns a JSON array of jobs and CATEGORIZES each as
 *      `email-apply` (drafts a 3-paragraph Gmail email + standard signature
 *      + all attachments) or `manual-apply` (saves a `to_apply` card so the
 *      Chrome-extension resume tailor can finish the flow).
 *   7. Persist the post key in `nas_seen_posts.json` along with both
 *      timestamps so the next run never reprocesses it.
 *
 * CLI:
 *   npx tsx fetch_nas_community.ts                       # last 12h, oldest-first
 *   npx tsx fetch_nas_community.ts --limit 5             # cap to N posts
 *   npx tsx fetch_nas_community.ts --headless            # run without showing UI
 *   npx tsx fetch_nas_community.ts --login-timeout 600   # seconds (default 300)
 *   npx tsx fetch_nas_community.ts --max-age-hours 24    # widen window
 */

import fs from 'fs';
import path from 'path';
import puppeteer, { Browser, Page } from 'puppeteer';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// CONSTANTS
// ============================================================================

const COMMUNITY_URL = 'https://nas.com/techuprise-insider-club/community';
const PROFILE_DIR = path.join(process.cwd(), 'nas_chrome_profile');
const APPLICATIONS_FILE = path.join(process.cwd(), 'applications.json');
const SEEN_POSTS_FILE = path.join(process.cwd(), 'nas_seen_posts.json');
const CHANNEL_LABEL = 'TechUprise NAS Community';
const SERVER_PORT = process.env.SERVER_PORT || '3000';
const DASHBOARD_BASE = `http://127.0.0.1:${SERVER_PORT}`;

const ATTACHMENTS = [
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') },
].filter((att) => fs.existsSync(att.path));

const SIGNATURE_HTML = `
<br>
Best, Rishav Tarway<br>
Mobile: +91 7004544142<br>
<a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

/**
 * Paragraph 3 — fixed credibility line with OSS PRs + project links. Static
 * template (the LLM is not allowed to drift on this) so every email closes
 * with the same proof points and the same canonical URLs.
 */
const PARA3_HTML = `<p>You can check my recent Open Source PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and my detailed personal projects <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (a 60fps Crypto Tracker built with React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (an AI Resume Builder powered by GPT-4 and FastAPI).</p>`;

/**
 * Build a catchy subject line that rotates the bracket family between
 * `[ ]`, `{ }`, and `( )` based on the role/company hash so different jobs
 * in the same run don't all look identical. Hook word also rotates so the
 * line opens differently each time.
 */
function buildCatchySubject(role: string, company: string): string {
  const safeRole = role || 'Software Engineer';
  const safeCompany = company || 'Hiring Team';
  const seed = (safeRole + '|' + safeCompany).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const brackets: Array<[string, string]> = [
    ['[', ']'],
    ['{', '}'],
    ['(', ')'],
  ];
  const hooks = [
    'Hands-on',
    'Production-ready',
    'Open-source proof',
    'Shipping fast',
    'Builder',
    'Already shipping',
  ];
  const [open, close] = brackets[seed % brackets.length];
  const hook = hooks[seed % hooks.length];
  return `${open}${hook}${close} ${safeRole} application: Rishav Tarway for ${safeCompany}`;
}

// ============================================================================
// CLI ARGS
// ============================================================================

interface CliOptions {
  limit: number;
  headless: boolean;
  loginTimeoutMs: number;
  /** Only consider posts whose age label is <= this many hours. */
  maxAgeHours: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = {
    limit: 0,
    headless: false,
    loginTimeoutMs: 5 * 60 * 1000,
    maxAgeHours: 12,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      options.limit = Number(args[++i]) || 0;
    } else if (args[i] === '--headless') {
      options.headless = true;
    } else if (args[i] === '--login-timeout') {
      // Default to 300s (5min) when value is missing or non-numeric.
      options.loginTimeoutMs = (Number(args[++i]) || 300) * 1000;
    } else if (args[i] === '--max-age-hours') {
      options.maxAgeHours = Number(args[++i]) || 12;
    }
  }
  return options;
}

// ============================================================================
// FILE-BACKED DEDUP HELPERS
// ============================================================================

interface SeenPost {
  postKey: string;
  postUrl: string;
  headline: string;
  ageLabel: string;
  postedDate: string;
  scrapedAt: string;
  jobCount: number;
}

function readApplications(): any[] {
  if (!fs.existsSync(APPLICATIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

/** dedupeIds previously written by this scraper. */
function knownDedupeIds(): Set<string> {
  const set = new Set<string>();
  for (const app of readApplications()) {
    if (app && app.channel === CHANNEL_LABEL && app.telegramId) set.add(app.telegramId);
  }
  return set;
}

function readSeenPosts(): Record<string, SeenPost> {
  if (!fs.existsSync(SEEN_POSTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_POSTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSeenPost(entry: SeenPost) {
  const seen = readSeenPosts();
  seen[entry.postKey] = entry;
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(seen, null, 2));
}

/**
 * Remove every seen-post entry whose jobCount is 0 so the next run will
 * retry the underlying post (likely a previous run failed extraction
 * because of __name crash, missing modal isolation, LLM parse failure, etc).
 * A real meme/announcement that genuinely has no jobs will get re-AI'd next
 * time too — cheap, and self-correcting.
 */
function pruneEmptySeenPosts(): number {
  if (!fs.existsSync(SEEN_POSTS_FILE)) return 0;
  let raw: Record<string, SeenPost>;
  try {
    raw = JSON.parse(fs.readFileSync(SEEN_POSTS_FILE, 'utf8'));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const k of Object.keys(raw)) {
    if (!raw[k] || (raw[k].jobCount ?? 0) === 0) {
      delete raw[k];
      removed++;
    }
  }
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(raw, null, 2));
  return removed;
}

// ============================================================================
// TIME PARSING
// ============================================================================

const RELATIVE_TIME_RE = /\b(just\s+now|a\s+(few|moment|while)\s+(seconds?|minutes?)?\s*ago|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s+ago)\b/i;

function parseRelativeTime(label: string, reference: Date = new Date()): Date {
  if (!label) return reference;
  const text = label.trim().toLowerCase();
  if (/just\s+now|few\s+(seconds?|moments?)/.test(text)) return reference;

  const match = text.match(/(\d+)\s*([a-z]+)/);
  if (!match) return reference;
  const n = Number(match[1]);
  const unit = match[2];
  let ms = 0;
  if (/^s/.test(unit)) ms = n * 1000;
  else if (/^m(ins?)?$/.test(unit) || unit === 'minute' || unit === 'minutes') ms = n * 60_000;
  else if (/^h/.test(unit)) ms = n * 3_600_000;
  else if (/^d/.test(unit)) ms = n * 86_400_000;
  else if (/^w/.test(unit)) ms = n * 7 * 86_400_000;
  else if (/^mo/.test(unit)) ms = n * 30 * 86_400_000;
  else if (/^y/.test(unit)) ms = n * 365 * 86_400_000;
  else ms = 0;
  return new Date(reference.getTime() - ms);
}

// ============================================================================
// GMAIL HELPERS
// ============================================================================

async function authorizeGmail() {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error('Missing credential.json');
  if (!fs.existsSync(TOKEN_PATH)) throw new Error('Missing token.json. Please ensure you are authenticated.');

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const installed = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  return oAuth2Client;
}

async function createDraft(gmail: any, toEmail: string, subject: string, htmlBody: string) {
  const mailOptions = {
    to: toEmail,
    subject,
    html: htmlBody + SIGNATURE_HTML,
    attachments: ATTACHMENTS,
  };
  const transporter = nodemailer.createTransport({ streamTransport: true });
  const message = await new Promise<Buffer>((resolve, reject) => {
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) return reject(err);
      const chunks: any[] = [];
      (info.message as any).on('data', (chunk: any) => chunks.push(chunk));
      (info.message as any).on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
  const encoded = Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encoded } } });
}

// ============================================================================
// LLM HELPERS
// ============================================================================

function parseJsonContent(content: string, source: string): any {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip markdown code fences if present (```json ... ```).
    const fenceStripped = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    try {
      return JSON.parse(fenceStripped);
    } catch {
      /* fall through */
    }
    const firstBrace = fenceStripped.indexOf('[');
    const firstObj = fenceStripped.indexOf('{');
    const start =
      firstBrace !== -1 && (firstObj === -1 || firstBrace < firstObj) ? firstBrace : firstObj;
    const lastBrace = fenceStripped.lastIndexOf(']');
    const lastObj = fenceStripped.lastIndexOf('}');
    const end = Math.max(lastBrace, lastObj);
    if (start === -1 || end === -1) {
      console.warn(
        `      ⚠️  ${source}: JSON parse failed, no JSON delimiters found. Raw[0..200]=${trimmed.slice(0, 200)}`,
      );
      return null;
    }
    try {
      return JSON.parse(fenceStripped.substring(start, end + 1));
    } catch (e) {
      console.warn(
        `      ⚠️  ${source}: JSON parse failed even after substring. err=${(e as Error).message}. Raw[0..200]=${trimmed.slice(0, 200)}`,
      );
      return null;
    }
  }
}

// Session-level provider disable flag so one daily-quota failure doesn't
// cost us 60s × N retries on every subsequent post.
const nasProviderDisabledUntil: Record<string, number> = {};
const nasIsDisabled = (n: string) => (nasProviderDisabledUntil[n] || 0) > Date.now();
const nasDisable = (n: string, ms: number, reason: string) => {
  nasProviderDisabledUntil[n] = Date.now() + ms;
  console.warn(`      🚫 Disabling ${n} for ${Math.round(ms / 1000)}s (${reason}).`);
};

async function callAI(prompt: string, jsonFlag = false): Promise<any> {
  // PRIMARY: Groq. Llama 3.3 70B versatile, ~1-2s per call, ~30 req/min free.
  // Handles the 18-post batch easily without rate-limit drama.
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey && !nasIsDisabled('groq')) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.2,
          messages: [
            ...(jsonFlag
              ? [
                  {
                    role: 'system',
                    content:
                      'You are a strict JSON-only API. Always respond with raw JSON only, no markdown fences, no commentary. When asked for an array, return ONLY the array literal — never wrap it in an object.',
                  },
                ]
              : []),
            { role: 'user', content: prompt },
          ],
          ...(jsonFlag ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      const data: any = await response.json();
      if (response.status === 429 || response.status === 503) {
        nasDisable('groq', 60_000, `HTTP ${response.status}`);
      } else if (data?.error) {
        console.warn(`      ⚠️  Groq error: ${typeof data.error === 'string' ? data.error : data.error?.message || JSON.stringify(data.error).slice(0, 240)}`);
      } else {
        const content = data?.choices?.[0]?.message?.content;
        if (content) {
          const parsed = jsonFlag ? parseJsonContent(content, 'Groq') : content;
          if (parsed !== null) return parsed;
        }
      }
    } catch (e) {
      console.error('      ⚠️  Groq call failed:', e);
    }
  }

  // FALLBACK 1: direct Google Gemini API. Used when Groq is unavailable or
  // fails. Single short retry only — long retryDelay or "limit: 0" disables
  // Gemini for the rest of the run instead of sleeping 60s × 2 every call.
  const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey && !nasIsDisabled('gemini')) {
    let geminiResult: any = null;
    let geminiSucceeded = false;
    // Single short retry only. If Google returns a long retryDelay or
    // "limit: 0" (daily quota done), we session-disable Gemini and move on
    // to the next post's Groq call, instead of sleeping 60s × 3.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: jsonFlag ? 'application/json' : 'text/plain',
              },
            }),
          },
        );
        const data: any = await response.json();
        if (data?.error) {
          const status = data.error.status || data.error.code;
          const msg: string = data.error.message || JSON.stringify(data.error).slice(0, 240);
          // Rate-limited? Sleep for the retry delay Google sends, then try again.
          const isRateLimit =
            status === 'RESOURCE_EXHAUSTED' ||
            data.error.code === 429 ||
            /quota|rate/i.test(msg);
          if (isRateLimit) {
            // Parse retryDelay. If >=20s OR message contains "limit: 0"
            // (daily quota burned), disable Gemini for the rest of the run.
            let retrySec = 0;
            for (const d of data.error.details || []) {
              if (d.retryDelay && typeof d.retryDelay === 'string') {
                const m = d.retryDelay.match(/(\d+(?:\.\d+)?)s/);
                if (m) retrySec = parseFloat(m[1]);
              }
            }
            const inMsg = msg.match(/retry in ([\d.]+)s/i);
            if (inMsg) retrySec = Math.max(retrySec, parseFloat(inMsg[1]));
            const dailyQuotaDone = /limit:\s*0/i.test(msg);
            if (dailyQuotaDone || retrySec >= 20) {
              const disableMs = dailyQuotaDone ? 6 * 60 * 60 * 1000 : Math.ceil(retrySec * 1000) + 5_000;
              nasDisable('gemini', disableMs, dailyQuotaDone ? 'daily quota (limit:0)' : `long retryDelay ${retrySec}s`);
              break;
            }
            if (attempt === 0 && retrySec > 0 && retrySec <= 10) {
              const waitMs = Math.ceil(retrySec * 1000) + 1_000;
              console.warn(`      ⏳ Gemini short rate-limit (${retrySec}s). One quick retry…`);
              await new Promise((r) => setTimeout(r, waitMs));
              continue;
            }
            console.warn(`      ⚠️  Gemini rate-limited with no usable retry hint. Skipping.`);
            break;
          }
          console.warn(`      ⚠️  Gemini API error: ${msg}`);
          break;
        }
        const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!content) {
          console.warn(
            `      ⚠️  Gemini: empty content. Top-level keys=${Object.keys(data || {}).join(',')} preview=${JSON.stringify(data).slice(0, 240)}`,
          );
          break;
        }
        geminiResult = jsonFlag ? parseJsonContent(content, 'Gemini') : content;
        geminiSucceeded = geminiResult !== null;
        break;
      } catch (e) {
        console.error(`   ⚠️  Gemini call failed (attempt ${attempt + 1}):`, e);
        // network-level failure → fall through to OpenRouter
        break;
      }
    }
    if (geminiSucceeded) return geminiResult;
    // Otherwise: fall through to OpenRouter.
  }

  // FALLBACK 2: OpenRouter (kept around so the script still works for users
  // who only have an OpenRouter key configured).
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    console.warn(
      '   ⚠️  No GROQ_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY — skipping AI extraction.',
    );
    return null;
  }
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-lite-001',
        temperature: 0.1,
        messages: [
          ...(jsonFlag
            ? [
                {
                  role: 'system',
                  content:
                    'You are a strict JSON-only API. Always respond with raw JSON only, no markdown fences, no commentary. When asked for an array, return ONLY the array literal — never wrap it in an object.',
                },
              ]
            : []),
          { role: 'user', content: prompt },
        ],
      }),
    });
    const data: any = await response.json();
    if (data?.error) {
      console.warn(
        `      ⚠️  OpenRouter error: ${typeof data.error === 'string' ? data.error : data.error?.message || JSON.stringify(data.error).slice(0, 240)}`,
      );
      return null;
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      console.warn(
        `      ⚠️  OpenRouter: empty content. Top-level keys=${Object.keys(data || {}).join(',')} preview=${JSON.stringify(data).slice(0, 240)}`,
      );
      return null;
    }
    return jsonFlag ? parseJsonContent(content, 'OpenRouter') : content;
  } catch (e) {
    console.error('   ⚠️  OpenRouter call failed:', e);
    return null;
  }
}

/**
 * Pull the first array we can find anywhere inside the LLM's JSON response.
 * Models intermittently wrap arrays in objects (e.g. {jobs: [...]},
 * {data: {items: [...]}}, {result: {jobs: {list: [...]}}}). Walk the tree
 * up to a small depth and return the first encountered array.
 */
function findFirstArrayInResponse(node: any, maxDepth = 4): any[] | null {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object' || maxDepth <= 0) return null;
  for (const v of Object.values(node)) {
    const found = findFirstArrayInResponse(v, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

interface ExtractedJob {
  category: 'email-apply' | 'manual-apply';
  text: string;
  company?: string;
  role?: string;
  location?: string;
  email?: string;
  link?: string;
  id?: string;
}

async function extractJobsFromPost(headline: string, postText: string): Promise<ExtractedJob[]> {
  const prompt = `You are extracting job postings from ONE community post on a hiring forum.
A post may contain MULTIPLE distinct jobs/internships, possibly from different companies.

Return a JSON ARRAY (not wrapped in any object) of job objects. Each object MUST have:
- "category": exactly "email-apply" if an HR/application email is present, otherwise "manual-apply".
- "text": the complete original text segment for that single job (multi-line ok).
- "company": company name (best guess from the text).
- "role": role/title (e.g. "SDE Intern", "Backend Engineer"). Empty string if unclear.
- "location": location if mentioned (e.g. "Bangalore", "Remote"), else "".
- "email": HR/application email if explicitly present, else "".
- "link": application URL if explicitly present, else "".
- "id": short stable identifier within this post (slug of company+role, lowercase, hyphenated).

STRICT RULES:
- Only include real job/internship postings. Skip memes, replies, generic announcements.
- Only include items that have at least one of: email or link.
- Do NOT invent contact info that isn't literally in the text.
- Output ONLY the raw JSON array — no markdown fences, no commentary.

POST HEADLINE: ${headline || '(none)'}

POST TEXT:
${postText.substring(0, 24000)}`;

  const raw = await callAI(prompt, true);

  // Models intermittently wrap arrays at any depth: { jobs: [...] },
  // { data: { items: [...] } }, etc. Walk the tree.
  let result: any = raw;
  if (result && !Array.isArray(result) && typeof result === 'object') {
    const found = findFirstArrayInResponse(result);
    if (found) {
      console.log(`      ⤷ LLM wrapped array inside object — unwrapping (${found.length} item(s)).`);
      result = found;
    }
  }
  // Single-job object (no array wrapper at all).
  if (result && !Array.isArray(result) && typeof result === 'object' && (result.email || result.link)) {
    console.log(`      ⤷ LLM returned a single job object — wrapping into array.`);
    result = [result];
  }

  if (!Array.isArray(result)) {
    const preview =
      raw === null || raw === undefined ? String(raw) : JSON.stringify(raw).slice(0, 240);
    console.log(
      `      ⤷ LLM returned non-array (parse failed or null). Raw type=${typeof raw} preview=${preview}`,
    );
    return [];
  }
  const before = result.length;
  const filtered = result
    .filter((j) => j && typeof j === 'object' && (j.email || j.link))
    .map((j) => ({
      ...j,
      category: j.email ? 'email-apply' : 'manual-apply',
    })) as ExtractedJob[];
  if (before > 0 && filtered.length === 0) {
    console.log(
      `      ⤷ LLM proposed ${before} item(s) but all filtered out for missing email/link.`,
    );
  }
  return filtered;
}

// ----------------------------------------------------------------------------
// Batch extraction: take ALL post bodies in one shot and have the LLM extract
// every job AND draft the application email subject/body in a single call.
// Saves ~N round-trips per run. Fields chosen to match the dashboard ingest
// payload directly so we can skip the separate generateEmailContent() pass.
// ----------------------------------------------------------------------------

interface BatchedJob {
  postKey: string;          // identifies which feed card this job came from
  inPostId: string;          // 1-based id within the post (stable for dedup)
  company: string;
  role: string;
  email: string | null;
  link: string | null;
  subject: string;
  bodyHtml: string;          // already-drafted application email (HTML)
  description: string;       // original job text for dashboard "description" field
}

async function extractAndDraftAll(
  posts: Array<{ postKey: string; headline: string; body: string }>,
): Promise<BatchedJob[]> {
  if (posts.length === 0) return [];

  // Build a numbered manifest the LLM can reference back via postKey.
  const manifest = posts
    .map(
      (p, i) =>
        `### POST ${i + 1} (postKey=${p.postKey})\nHEADLINE: ${p.headline || '(none)'}\nBODY:\n${p.body.substring(0, 6000)}`,
    )
    .join('\n\n---\n\n');

  const prompt = `You are extracting EVERY distinct job/internship from MULTIPLE community hiring posts AND drafting a tailored 2-paragraph application email per job.

For EACH job you find across ALL posts, return one JSON object with:
- "postKey": the postKey from the POST header the job belongs to (copy verbatim).
- "inPostId": 1-based ordinal of this job within its post (e.g. "1", "2"). If the post has only one job use "1".
- "company": company name (best guess from the text; "Hiring Team" if truly unknown).
- "role": role/title (e.g. "SDE Intern", "Backend Engineer"). Empty string if unclear.
- "email": HR/application email if explicitly present, else null. If multiple, comma-join.
- "link": application URL (Google Form, careers page, etc.) if explicitly present, else null.
- "subject": IGNORE — the host code will overwrite this with a deterministic catchy subject. You can return "" or a placeholder.
- "bodyHtml": EXACTLY 2 paragraphs of HTML using <p> only (no <b>, no lists). Paragraph 1: a SHORT greeting line "<p>Hi <Company> Hiring Team,</p>" followed by a 1-2 sentence paragraph that ties Rishav's stack to THIS role. Paragraph 2: a 1-2 sentence credibility line citing internships + a relevant project, ending with "I have attached my resume and other relevant documents for your review." The host code will append a fixed paragraph 3 + signature — DO NOT include any para about open-source PRs, projects, "Best,", or signatures yourself.
- "description": the FULL original text of THIS job from the post (verbatim, including emojis and line breaks). Prefix with "${'<inPostId>'}. <role>\\n" so each entry is self-identifying.

USER CONTEXT (Rishav Tarway):
- B.Tech CSE (AI & ML), 19 months across 5 internships.
- Tech: Node.js, React, Next.js, React Native, Python, Java, Go, MongoDB, Redis, AWS, Docker, Gemini API.
- Highlight projects: Tech Stream Community (React+Socket.io+MongoDB+AWS+Redis, 500+ users), CoinWatch (React Native, Expo, 60fps), ProResume (React Native + Gemini AI ATS resume builder).
- Open source: WoC 5.0 OpenPrinting (go-avahi) — built OSS-Fuzz infra, 11 fuzz harnesses.

STRICT RULES FOR THE EMAIL DRAFT:
- NO emojis. No em-dashes as separators. No "passionate" / "leverage" / "synergize" / "thrilled".
- Concrete: cite Rishav's actual stack and projects (above). Do NOT invent metrics.
- 2 paragraphs total, each <= 2 sentences.

STRICT RULES FOR THE OUTPUT:
- Output ONLY a raw JSON ARRAY (no markdown fences, no commentary, no wrapping object).
- Skip memes / replies / generic announcements.
- Include a job even when both email AND link are null (set both to null) so the user can manually triage.
- Keep emojis and formatting INSIDE the "description" field; strip them ONLY from "subject" and "bodyHtml".

POSTS:

${manifest}`;

  const raw = await callAI(prompt, true);

  let result: any = raw;
  if (result && !Array.isArray(result) && typeof result === 'object') {
    const found = findFirstArrayInResponse(result);
    if (found) {
      console.log(
        `   ⤷ Batch LLM wrapped array inside object — unwrapping (${found.length} item(s)).`,
      );
      result = found;
    }
  }

  if (!Array.isArray(result)) {
    const preview =
      raw === null || raw === undefined ? String(raw) : JSON.stringify(raw).slice(0, 240);
    console.warn(
      `   ⚠️  Batch LLM returned non-array. Raw type=${typeof raw} preview=${preview}`,
    );
    return [];
  }

  // Validate + coerce. Accept legacy keys ("post_index"/"id") just in case the
  // model improvises slightly off-schema.
  const validKeys = new Set(posts.map((p) => p.postKey));
  const cleaned: BatchedJob[] = [];
  for (const j of result) {
    if (!j || typeof j !== 'object') continue;
    const postKey = String(j.postKey || j.post_key || '').trim();
    if (!validKeys.has(postKey)) continue;
    const company = String(j.company || 'Hiring Team').trim();
    const role = String(j.role || '').trim();
    let bodyHtml = String(j.bodyHtml || j.body_html || '').trim();
    // Strip any LLM-added "Best,", signature, or para3 drift before we
    // append our static para3. Keeps the host-controlled closing pristine.
    bodyHtml = bodyHtml
      .replace(/<p>\s*Best[\s,.\-]*<\/p>\s*$/i, '')
      .replace(/<p>[^<]*Open\s*Source\s*PRs?[^<]*<\/p>\s*/gi, '')
      .replace(/<p>[^<]*Rishav\s*Tarway[^<]*<\/p>\s*$/i, '')
      .trim();
    if (bodyHtml) bodyHtml = `${bodyHtml}\n${PARA3_HTML}`;
    cleaned.push({
      postKey,
      inPostId: String(j.inPostId || j.id || '1'),
      company,
      role,
      email: typeof j.email === 'string' && j.email.trim() ? j.email.trim() : null,
      link: typeof j.link === 'string' && j.link.trim() ? j.link.trim() : null,
      // Always overwrite the LLM's subject with a deterministic catchy one
      // that rotates bracket style + hook word per (role, company).
      subject: buildCatchySubject(role, company),
      bodyHtml,
      description: String(j.description || ''),
    });
  }
  return cleaned;
}

interface DraftedEmail {
  subject: string;
  body: string;
}

async function generateEmailContent(
  jobText: string,
  company: string,
  role: string,
): Promise<DraftedEmail> {
  // We only ask the LLM for the FIRST TWO paragraphs (tailored to the
  // specific role). Paragraph 3 (open-source PRs + projects) and the
  // signature are appended deterministically by the host so they can never
  // drift. The subject is also built deterministically by buildCatchySubject().
  const prompt = `Write the FIRST TWO paragraphs of a job application email for Rishav Tarway. Paragraph 3 and the signature are added by the host code, do NOT include them.

JOB TEXT: """${jobText.substring(0, 1200)}"""
COMPANY: ${company || 'the company'}
ROLE: ${role || 'Software Engineer'}

USER CONTEXT (Rishav Tarway):
- B.Tech CSE (AI & ML), 19 months across 5 internships (MOSIP / Classplus / TechVastra / Testbook / Franchizerz).
- Tech: Node.js, React, Next.js, React Native, Android, Python, Java, Go, MongoDB, Redis, AWS, Docker, Selenium, Cucumber BDD, OSS-Fuzz, Gemini API.

STRICT RULES:
- NO emojis. No em dashes used as separators. No "I am passionate" / "leverage" / "synergize" / "thrilled".
- Output EXACTLY 2 paragraphs of plain text, each 1-2 sentences.
  Paragraph 1: Lead with what the company does and a recent growth/mission angle inferred from the JOB TEXT. Show I have actually understood the company.
  Paragraph 2: Map my specific skills + 1-2 internship outcomes to the role's requirements with concrete numbers, and end with "I have attached my resume and other relevant documents for your review."
- DO NOT include any paragraph about open-source PRs, GitHub projects, CoinWatch, ProResume, or "Best,". Those are appended by the host.

RESPOND WITH RAW JSON ONLY (no markdown):
{ "para1": "...", "para2": "..." }`;

  const result = await callAI(prompt, true);
  const safeCompany = company || 'Hiring Team';
  const safeRole = role || 'Software Engineer';
  const p1 =
    result?.para1 ||
    `${safeCompany} is building products with real user impact, and the JOB TEXT signals real momentum on the engineering side. The mission and current scale align directly with where I have spent the last 19 months.`;
  const p2 =
    result?.para2 ||
    `Across 5 internships (MOSIP, Classplus, TechVastra, Testbook, Franchizerz) I shipped production code in Node.js, React/Next.js, and React Native. At Classplus I cut API latency 25% for 10k+ concurrent users and improved observability 40% via request-ID tracing, the same kind of ownership the ${safeRole} role demands. I have attached my resume and other relevant documents for your review.`;
  const subject = buildCatchySubject(safeRole, safeCompany);

  // Body = greeting + 2 LLM paras + static para3 (OSS PRs + projects).
  // No "<p>Best,</p>" — SIGNATURE_HTML already starts with "Best, Rishav Tarway".
  const body = `<p>Hi ${safeCompany} Hiring Team,</p><p>${p1}</p><p>${p2}</p>${PARA3_HTML}`;
  return { subject, body };
}

// ============================================================================
// PUPPETEER HELPERS
// ============================================================================

function detectChromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((p): p is string => Boolean(p));
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return undefined;
}

async function launchBrowser(headless: boolean): Promise<Browser> {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const executablePath = detectChromeExecutable();
  return puppeteer.launch({
    headless,
    executablePath,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'],
  });
}

async function ensureCommunityTab(page: Page): Promise<void> {
  // If we landed on Home (or any other tab), click the "Community" tab so the Feed renders.
  const navigated = await page.evaluate(() => {
    const nav = Array.from(document.querySelectorAll<HTMLElement>('a, button, span, div'))
      .find((el) => el.innerText && el.innerText.trim().toLowerCase() === 'community');
    if (nav) {
      (nav as HTMLElement).click();
      return true;
    }
    return false;
  });
  if (navigated) {
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function waitForLogin(page: Page, timeoutMs: number): Promise<boolean> {
  // Multi-signal detection so we DON'T hang silently when the page is loaded
  // but the dom regex is unhappy. Returns true the moment any positive signal
  // is seen and there's no visible password input on the page.
  const start = Date.now();
  let tick = 0;
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const tabLabels = Array.from(document.querySelectorAll<HTMLElement>('a, button, span, div'))
        .map((el) => (el.innerText || '').trim().toLowerCase())
        .filter(Boolean);
      const hasCommunityTab = tabLabels.some((t) => t === 'community');
      const hasFeedHeader = tabLabels.some((t) => t === 'feed' || t === 'popular products');
      const hasPostCards = /TechUprise/i.test(document.body.innerText || '') &&
        /Creator/i.test(document.body.innerText || '');
      const hasPasswordInput = !!document.querySelector('input[type="password"]');
      const hasGoogleLoginCta = /continue with google|sign in with google/i.test(
        document.body.innerText || '',
      );
      const url = window.location.href;
      const bodyLen = (document.body.innerText || '').length;
      return {
        hasCommunityTab,
        hasFeedHeader,
        hasPostCards,
        hasPasswordInput,
        hasGoogleLoginCta,
        url,
        bodyLen,
      };
    });

    const onNasDomain = /nas\.(io|com)/.test(state.url);
    // Logged in = on a nas domain, page actually rendered (>500 chars), AND
    // either the Community tab is present OR post cards are visible, AND no
    // password input is sitting on screen demanding a sign-in.
    const looksLoggedIn =
      onNasDomain &&
      state.bodyLen > 500 &&
      (state.hasCommunityTab || state.hasFeedHeader || state.hasPostCards) &&
      !state.hasPasswordInput;

    if (tick % 3 === 0) {
      console.log(
        `   🔍 login probe — url=${state.url.slice(0, 60)} bodyLen=${state.bodyLen} ` +
          `tab=${state.hasCommunityTab} feed=${state.hasFeedHeader} cards=${state.hasPostCards} ` +
          `pwd=${state.hasPasswordInput}`,
      );
    }
    tick++;

    if (looksLoggedIn) return true;
    if (state.hasPasswordInput || state.hasGoogleLoginCta) {
      console.log('   🔐 Not logged in. Please sign in to nas.com in the open browser window…');
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return false;
}

async function autoScrollFeed(
  page: Page,
  maxAgeHours: number,
  maxIterations = 30,
): Promise<void> {
  // Stops on any of:
  //   (a) we've seen a card whose age is > maxAgeHours (feed is newest-first,
  //       so anything below would also be older — no point loading more).
  //   (b) page height stabilises for 3 consecutive ticks.
  //   (c) maxIterations reached.
  let lastHeight = 0;
  let stableTicks = 0;
  for (let i = 0; i < maxIterations; i++) {
    const probe = await page.evaluate((maxAgeMs: number) => {
      const containers = Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
        (el) => el.scrollHeight > el.clientHeight && el.clientHeight > 200,
      );
      window.scrollBy(0, window.innerHeight * 0.9);
      containers.forEach((c) => c.scrollBy(0, c.clientHeight * 0.9));
      const newHeight = Math.max(
        document.body.scrollHeight,
        ...containers.map((c) => c.scrollHeight),
      );

      // Look for a card whose relative-age label exceeds the window.
      const RELATIVE = /\b(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s+ago\b/i;
      const labels = Array.from(document.querySelectorAll<HTMLElement>('span, time, div, p'))
        .map((el) => (el.innerText || '').trim())
        .filter((t) => t && t.length < 40 && RELATIVE.test(t));
      let pastWindow = false;
      for (const label of labels) {
        const m = label.match(RELATIVE);
        if (!m) continue;
        const n = Number(m[1]);
        const unit = m[2].toLowerCase();
        let ms = 0;
        if (/^s/.test(unit)) ms = n * 1000;
        else if (/^m(ins?)?$/.test(unit) || unit === 'minute' || unit === 'minutes') ms = n * 60_000;
        else if (/^h/.test(unit)) ms = n * 3_600_000;
        else if (/^d/.test(unit)) ms = n * 86_400_000;
        else if (/^w/.test(unit)) ms = n * 7 * 86_400_000;
        else if (/^mo/.test(unit)) ms = n * 30 * 86_400_000;
        else if (/^y/.test(unit)) ms = n * 365 * 86_400_000;
        if (ms > maxAgeMs) {
          pastWindow = true;
          break;
        }
      }
      return { newHeight, pastWindow };
    }, maxAgeHours * 3_600_000);

    if (probe.pastWindow) {
      console.log(`   ⏹️  Reached posts older than ${maxAgeHours}h — stopping scroll.`);
      break;
    }

    await new Promise((r) => setTimeout(r, 1500));
    if (probe.newHeight <= lastHeight) {
      stableTicks++;
      if (stableTicks >= 3) break;
    } else {
      stableTicks = 0;
      lastHeight = probe.newHeight;
    }
  }
}

interface FeedCard {
  index: number;
  headline: string;
  snippet: string;
  ageLabel: string;
  postKey: string; // stable hash of headline + snippet
  postUrl: string; // direct URL of the post (e.g. .../community#post-8142fc33)
  // Full inline post body extracted directly from the feed card. nas.com
  // renders the entire post text inside the card itself (CSS line-clamp
  // only hides it visually — the DOM still has all of it), so we don't
  // need to navigate or open a modal to read it. If empty, the caller
  // falls back to the (legacy) navigate-then-extract path.
  bodyText: string;
  cardTitle: string;
}

/**
 * Walk the feed top-down and return one descriptor per post card.
 * The post card root is heuristically the smallest containing element that
 * has BOTH a "TechUprise" / "Creator" creator label AND a relative-time label.
 */
async function collectFeedCards(page: Page): Promise<FeedCard[]> {
  return await page.evaluate(() => {
    const RELATIVE_TIME = /\b(just\s+now|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s+ago)\b/i;

    // sha1 is intentionally INLINED below. The tsx/esbuild loader wraps every
    // named helper (function decl OR arrow assigned to a const) with a call
    // to __name(target, "label") which doesn't exist in the browser context.
    //
    // 1. Find every text node containing a relative-time pattern.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const candidates: Element[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim();
      if (RELATIVE_TIME.test(t)) {
        const el = n.parentElement;
        if (el) candidates.push(el);
      }
    }

    // 2. For each, walk up until we find a card-sized container that also
    //    mentions "TechUprise" or "Creator" (the post author label visible
    //    on every nas.io community post). De-dup by element identity.
    const cardRoots: HTMLElement[] = [];
    const seen = new Set<HTMLElement>();
    for (const el of candidates) {
      let cur: HTMLElement | null = el as HTMLElement;
      let depth = 0;
      while (cur && depth < 12) {
        const text = cur.innerText || '';
        if (
          /TechUprise/i.test(text) &&
          /Creator|creator/.test(text) &&
          text.length > 30 &&
          text.length < 4000
        ) {
          if (!seen.has(cur)) {
            seen.add(cur);
            cardRoots.push(cur);
          }
          break;
        }
        cur = cur.parentElement;
        depth++;
      }
    }

    // 3. Sort by document order so the newest (top of feed) comes first.
    cardRoots.sort((a, b) => {
      const cmp = a.compareDocumentPosition(b);
      if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });

    // 4. Extract a {headline, snippet, ageLabel, postUrl} per card.
    const cards: FeedCard[] = [];
    cardRoots.forEach((root: HTMLElement, index: number) => {
      const fullText = (root.innerText || '').trim();

      const ageMatch = fullText.match(RELATIVE_TIME);
      const ageLabel = ageMatch ? ageMatch[0] : '';

      // Headline: prefer h1–h4/role=heading; reject "TechUprise" page chrome.
      let headline = '';
      const headings = Array.from(
        root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [role="heading"], strong, b'),
      );
      for (const h of headings) {
        const ht = (h.innerText || '').trim().split('\n')[0];
        if (
          ht &&
          ht.length > 4 &&
          ht.length < 200 &&
          !/^TechUprise(\s|$)/i.test(ht) &&
          !/Creator/i.test(ht) &&
          !RELATIVE_TIME.test(ht) &&
          !/Referral Club/i.test(ht)
        ) {
          headline = ht;
          break;
        }
      }
      if (!headline) {
        const lines = fullText
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !/^TechUprise$/i.test(l) &&
              !/Creator/i.test(l) &&
              !/Referral Club/i.test(l) &&
              !RELATIVE_TIME.test(l),
          );
        headline = lines[0] || fullText.slice(0, 80);
      }

      // Snippet: text after the headline, capped.
      let snippet = fullText;
      if (headline) {
        const i = fullText.indexOf(headline);
        if (i >= 0) snippet = fullText.slice(i + headline.length, i + headline.length + 600);
      }
      snippet = snippet.replace(/\s+/g, ' ').trim().slice(0, 240);

      // Stable hash (FNV-1a 32-bit) inlined to avoid a named helper.
      const __input = (headline + '|' + snippet).toLowerCase();
      let __h = 0x811c9dc5;
      for (let __i = 0; __i < __input.length; __i++) {
        __h ^= __input.charCodeAt(__i);
        __h = Math.imul(__h, 0x01000193) >>> 0;
      }
      const postKey = __h.toString(16);

      // Direct post URL: nas.com puts a <a href="...#post-XXXX"> per card.
      // Prefer the longest such href that lives inside this card.
      let postUrl = '';
      const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));
      for (const a of anchors) {
        const href = a.href || '';
        if (/#post-/i.test(href)) {
          if (href.length > postUrl.length) postUrl = href;
        }
      }

      // Pull the inline post title + body straight out of the card. The
      // nas.com feed renders these as:
      //   <div class="text-heading-sm font-semibold ...">{title}</div>
      //   <div class="text-para-sm whitespace-pre-line line-clamp-2 ...">{body}</div>
      // CSS clamping is purely visual; innerText still returns the full
      // text. This means we never have to navigate / open a modal.
      let cardTitle = '';
      const titleEl = root.querySelector<HTMLElement>(
        '[class*="text-heading-sm"][class*="font-semibold"]',
      );
      if (titleEl) {
        cardTitle = (titleEl.innerText || '').trim().split('\n')[0];
      }

      let bodyText = '';
      const bodyEl = root.querySelector<HTMLElement>(
        '[class*="text-para-sm"][class*="whitespace-pre-line"]',
      );
      if (bodyEl) {
        // Strip the inline "...See more" expand-affordance — it's a sibling
        // <div> overlay rendered absolutely; innerText would otherwise
        // append "...See more" at the end of every body.
        const clone = bodyEl.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll('[class*="absolute"][class*="cursor-pointer"]')
          .forEach((n) => n.remove());
        bodyText = (clone.innerText || '').trim();
        // Belt-and-suspenders cleanup if the affordance survived the strip.
        bodyText = bodyText.replace(/\s*\.{3,}\s*See more\s*$/i, '').trim();
      }

      cards.push({ index, headline, snippet, ageLabel, postKey, postUrl, bodyText, cardTitle });
    });

    // Hand back the data + a way to re-find each card by index later.
    // We re-discover roots in the same order in clickIntoCard().
    return cards;
  });
}

// One-shot flag: dump the first post's DOM diagnostics + full HTML so we
// can debug nas.com's actual layout when extraction appears stuck on the
// feed background. Resets per process.
let dumpedDebugForRun = false;

/**
 * Navigate directly to a post URL (e.g. .../community#post-8142fc33).
 * nas.com renders a dedicated post-detail page when you hit that URL,
 * which is far more reliable than dispatching a click on the feed card
 * (the SPA's onClick handlers don't always fire from page.evaluate-driven
 * synthetic clicks). If only the hash changes (so the browser doesn't
 * reload), we force a reload so the SPA actually re-renders.
 */
async function openPostByUrl(
  page: Page,
  postUrl: string,
): Promise<{ navigatedTo: string | null; postText: string; headline: string }> {
  if (!postUrl) {
    return { navigatedTo: null, postText: '', headline: '' };
  }

  const before = page.url();
  const beforePath = before.split('#')[0];
  const targetPath = postUrl.split('#')[0];

  await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});

  // If only the hash changed, the SPA may not have re-rendered. Force a
  // hard reload so the post-detail view is rendered fresh.
  if (beforePath === targetPath) {
    await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  }

  // Give the SPA a beat to settle.
  await new Promise((r) => setTimeout(r, 1500));

  // Scroll inside the (now opened) post to load all content.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let scrolls = 0;
      const containers = Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
        (el) => el.scrollHeight > el.clientHeight && el.clientHeight > 200,
      );
      const timer = setInterval(() => {
        window.scrollBy(0, 700);
        containers.forEach((c) => c.scrollBy(0, 700));
        scrolls++;
        if (scrolls >= 6) {
          clearInterval(timer);
          resolve();
        }
      }, 250);
    });
  });

  const detail = await page.evaluate(() => {
    const RELATIVE_TIME =
      /\b(just\s+now|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s+ago)\b/i;

    // Strip script/style/template noise from any element before reading
    // innerText. innerText on a detached clone falls back to textContent
    // which inlines <script> JSON (Next.js __NEXT_DATA__) and <style>.
    const cleanInnerText = (el: HTMLElement): string => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
      // Also strip obvious page chrome that often sneaks into modal bodies.
      clone
        .querySelectorAll('nav, header, footer, [role="navigation"], [class*="sidebar"], [class*="Sidebar"], [class*="topbar"], [class*="TopBar"]')
        .forEach((n) => n.remove());
      return (clone.innerText || '').trim();
    };

    // ----------------------------------------------------------------
    // PRIORITY ORDER for post-detail isolation. We MUST avoid leaking
    // the surrounding feed into the LLM input — that was the silent bug
    // that left every post showing the same 1761-char preview.
    // ----------------------------------------------------------------
    let target: HTMLElement | null = null;
    let strategy = 'none';

    // 1) Hash-derived id (e.g. #post-c0511e1 → <div id="post-c0511e1">).
    //    nas.com renders the expanded post detail under exactly this id.
    const hash = (window.location.hash || '').replace(/^#/, '');
    if (hash) {
      const byId = document.getElementById(hash);
      if (byId) {
        target = byId;
        strategy = `by-id:${hash}`;
      }
    }

    // 2) Modal / dialog overlays (very common pattern on social SPAs).
    if (!target) {
      const dlg =
        (document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement | null) ||
        (document.querySelector('[role="dialog"]') as HTMLElement | null) ||
        (document.querySelector('[aria-modal="true"]') as HTMLElement | null);
      if (dlg) {
        target = dlg;
        strategy = 'role=dialog';
      }
    }

    // 3) Containers whose className mentions "post" / "PostDetail" / "modal"
    //    / "Drawer" — pick the largest by innerText length.
    if (!target) {
      const candidateRoots = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[class*="PostDetail"], [class*="post-detail"], [class*="PostModal"], [class*="post-modal"], [class*="Modal"], [class*="modal"], [class*="Drawer"], [class*="drawer"]',
        ),
      ).filter((el) => (el.innerText || '').length > 100);
      if (candidateRoots.length) {
        candidateRoots.sort(
          (a, b) => (b.innerText || '').length - (a.innerText || '').length,
        );
        target = candidateRoots[0];
        strategy = `class-match:${(target.className || '').split(/\s+/)[0] || '?'}`;
      }
    }

    // 4) <article> elements — pick largest.
    if (!target) {
      const articles = Array.from(document.querySelectorAll<HTMLElement>('article')).filter(
        (el) => (el.innerText || '').length > 100,
      );
      if (articles.length) {
        articles.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
        target = articles[0];
        strategy = 'article';
      }
    }

    // 5) Last resort — full body clone with chrome stripped.
    if (!target) {
      target = document.body;
      strategy = 'body-fallback';
    }

    const cleanedText = cleanInnerText(target);

    // Pick a headline that is NOT page chrome — search WITHIN the target
    // first so we don't accidentally pick "TechUprise Referral Club" from
    // the surrounding chrome.
    let headline = '';
    const collectHeadings = (root: HTMLElement) =>
      Array.from(
        root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, [role="heading"], strong, b'),
      );
    const headings = [...collectHeadings(target), ...collectHeadings(document.body)];
    for (const h of headings) {
      const ht = (h.innerText || '').trim().split('\n')[0];
      if (
        ht &&
        ht.length > 4 &&
        ht.length < 200 &&
        !/^TechUprise(\s|$)/i.test(ht) &&
        !/Referral Club/i.test(ht) &&
        !/Creator/i.test(ht) &&
        !RELATIVE_TIME.test(ht) &&
        !/^community$/i.test(ht)
      ) {
        headline = ht;
        break;
      }
    }
    return { postText: cleanedText, headline, strategy };
  });

  console.log(`   📦 isolation strategy: ${detail.strategy}`);
  return { navigatedTo: page.url(), postText: detail.postText, headline: detail.headline };
}

/**
 * Re-find the Nth feed card root and click its headline to open the post.
 * Detects whether this navigated to a new URL or opened a modal/in-place view.
 */
async function clickIntoCard(
  page: Page,
  cardIndex: number,
): Promise<{ navigatedTo: string | null; postText: string; headline: string }> {
  const beforeUrl = page.url();
  const beforeBodyLen = (await page.evaluate(() => document.body.innerText.length)) || 0;

  // Tag the click target from inside the page so we can fire a real
  // CDP-level mouse click on it (synthetic .click() inside page.evaluate
  // does NOT trigger React's synthetic event system reliably, which is
  // why every prior run kept landing on the feed background).
  const tagged = await page.evaluate((idx) => {
    const RELATIVE_TIME = /\b(just\s+now|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s+ago)\b/i;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const candidates: Element[] = [];
    let n: Node | null;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || '').trim();
      if (RELATIVE_TIME.test(t)) {
        const el = n.parentElement;
        if (el) candidates.push(el);
      }
    }
    const seen = new Set<HTMLElement>();
    const cardRoots: HTMLElement[] = [];
    for (const el of candidates) {
      let cur: HTMLElement | null = el as HTMLElement;
      let depth = 0;
      while (cur && depth < 12) {
        const text = cur.innerText || '';
        if (
          /TechUprise/i.test(text) &&
          /Creator|creator/.test(text) &&
          text.length > 30 &&
          text.length < 4000
        ) {
          if (!seen.has(cur)) {
            seen.add(cur);
            cardRoots.push(cur);
          }
          break;
        }
        cur = cur.parentElement;
        depth++;
      }
    }
    cardRoots.sort((a, b) => {
      const cmp = a.compareDocumentPosition(b);
      if (cmp & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
    const root = cardRoots[idx];
    if (!root) return false;

    // Clear any previous tag.
    document
      .querySelectorAll('[data-nas-click-target]')
      .forEach((el) => el.removeAttribute('data-nas-click-target'));

    root.scrollIntoView({ block: 'center' });

    // Prefer clicking the bold headline / "See more" / heading element.
    const target =
      root.querySelector<HTMLElement>('h1, h2, h3, h4, [role="heading"], strong, b') ||
      Array.from(root.querySelectorAll<HTMLElement>('span, a, button')).find((el) =>
        /see more/i.test(el.innerText || ''),
      ) ||
      root;
    target.setAttribute('data-nas-click-target', 'yes');
    return true;
  }, cardIndex);

  // Real CDP-level mouse click on the tagged target. This fires native
  // mousedown/mouseup/click events that React DOES handle, unlike the
  // synthetic .click() we used before.
  if (tagged) {
    try {
      await page.click('[data-nas-click-target="yes"]', { delay: 30 });
    } catch (e) {
      console.warn(`   ⚠️  page.click() failed: ${(e as Error).message}`);
    }
  }

  // Wait for either navigation or the body to grow significantly (modal opened).
  await new Promise((r) => setTimeout(r, 2200));

  // Scroll inside the (now opened) post to load all content.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      let scrolls = 0;
      const containers = Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
        (el) => el.scrollHeight > el.clientHeight && el.clientHeight > 200,
      );
      const timer = setInterval(() => {
        window.scrollBy(0, 700);
        containers.forEach((c) => c.scrollBy(0, 700));
        scrolls++;
        if (scrolls >= 8) {
          clearInterval(timer);
          resolve();
        }
      }, 350);
    });
  });

  const afterUrl = page.url();
  const detail = await page.evaluate(() => {
    // Strategy: find the actual post-detail container, NOT the whole feed
    // page sitting behind any modal. We try four progressively-loose
    // strategies and return the first that produces a self-contained chunk
    // of text smaller than the whole body.
    const bodyText = (document.body.innerText || '').trim();
    const bodyLen = bodyText.length;

    const grab = (el: HTMLElement | null): string => {
      if (!el) return '';
      const t = (el.innerText || '').trim();
      return t.length > 80 && t.length < bodyLen * 0.92 ? t : '';
    };

    // 1. URL fragment -> element id (e.g. #post-8142fc33).
    const hash = (window.location.hash || '').replace(/^#/, '').trim();
    let postText = '';
    if (hash) {
      postText = grab(document.getElementById(hash)) || grab(
        document.querySelector<HTMLElement>(`[data-post-id="${hash}"], [data-id="${hash}"]`),
      );
    }

    // 2. Modal / dialog / drawer container.
    if (!postText) {
      const modalSelectors = [
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[class*="modal"]',
        '[class*="Modal"]',
        '[class*="drawer"]',
        '[class*="Drawer"]',
        '[class*="dialog"]',
        '[class*="Dialog"]',
        '[class*="post-detail"]',
        '[class*="PostDetail"]',
        '[class*="overlay"]',
      ];
      for (const sel of modalSelectors) {
        const cands = Array.from(document.querySelectorAll<HTMLElement>(sel));
        let bestModal: HTMLElement | null = null;
        let bestLen = 0;
        for (const el of cands) {
          const t = (el.innerText || '').trim();
          if (t.length > bestLen && t.length < bodyLen * 0.92 && t.length > 200) {
            bestModal = el;
            bestLen = t.length;
          }
        }
        if (bestModal) {
          postText = grab(bestModal);
          if (postText) break;
        }
      }
    }

    // 3. Largest single block that's clearly smaller than the whole body
    //    (so we can be confident it's NOT the whole feed).
    if (!postText) {
      const all = Array.from(document.querySelectorAll<HTMLElement>('article, section, div'));
      let best: { el: HTMLElement; len: number } | null = null;
      for (const el of all) {
        const t = (el.innerText || '').trim();
        if (t.length < 200) continue;
        if (t.length > bodyLen * 0.92) continue; // would mean ~entire body
        if (el === document.body) continue;
        if (!best || t.length > best.len) best = { el, len: t.length };
      }
      if (best) postText = best.el.innerText;
    }

    // 4. Last resort: body itself (this is the broken behaviour we're
    //    trying to avoid, but better than nothing).
    if (!postText) postText = bodyText;

    // Headline: prefer a heading inside the captured block.
    let headline = '';
    const headingSel = 'h1, h2, h3, h4, [role="heading"], strong, b';
    if (postText) {
      // Find the smallest enclosing element of postText to scope the headline lookup.
      const all = Array.from(document.querySelectorAll<HTMLElement>(headingSel));
      for (const h of all) {
        const ht = (h.innerText || '').trim().split('\n')[0];
        if (ht && postText.includes(ht) && ht.length < 200 && ht.length > 4) {
          headline = ht;
          break;
        }
      }
    }
    if (!headline) {
      const fallback = document.querySelector<HTMLElement>(headingSel);
      headline = fallback ? (fallback.innerText || '').trim().split('\n')[0] : '';
    }

    return { headline, postText };
  });

  let navigatedTo: string | null = null;
  if (afterUrl !== beforeUrl) {
    navigatedTo = afterUrl;
  } else {
    const afterLen = detail.postText.length;
    if (afterLen > beforeBodyLen + 200) navigatedTo = null; // Treated as modal
  }

  return { navigatedTo, headline: detail.headline, postText: detail.postText };
}

async function returnToFeed(page: Page, originalUrl: string): Promise<void> {
  const here = page.url();
  if (here !== originalUrl) {
    try {
      await page.goBack({ waitUntil: 'networkidle2', timeout: 30_000 });
    } catch {
      await page.goto(originalUrl, { waitUntil: 'networkidle2', timeout: 60_000 });
    }
  } else {
    // Modal style — try Escape key + click outside.
    await page.keyboard.press('Escape').catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }
  await ensureCommunityTab(page);
  await new Promise((r) => setTimeout(r, 600));
}

// ============================================================================
// DASHBOARD INGEST
// ============================================================================

async function pushToDashboard(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${DASHBOARD_BASE}/api/applications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.warn('   ⚠️  Dashboard ingest failed (server might be down):', (e as Error).message);
  }
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const opts = parseArgs();
  console.log('🚀 NAS Community Auto-Scraper (v2.1 — last 12h, oldest-first, dedup-aware)');
  console.log(`   profile: ${PROFILE_DIR}`);
  console.log(`   headless: ${opts.headless}`);
  console.log(`   limit: ${opts.limit || 'unlimited'}`);
  console.log(`   max age: ${opts.maxAgeHours}h`);
  console.log(`   login timeout: ${Math.round(opts.loginTimeoutMs / 1000)}s`);

  let gmail: any = null;
  try {
    const auth = await authorizeGmail();
    gmail = google.gmail({ version: 'v1', auth: auth as any });
  } catch (e) {
    console.warn(`   ⚠️  Gmail unavailable (${(e as Error).message}). Email drafts will be skipped.`);
  }

  const browser = await launchBrowser(opts.headless);
  let totalNewJobs = 0;

  try {
    const page = await browser.newPage();

    // Belt-and-suspenders: install a no-op __name on every document the page
    // loads. tsx/esbuild's --keep-names emits __name(target, "label") inside
    // anything we serialise via page.evaluate. The helper exists in the Node
    // bundle but NOT in the browser context, so without this shim every
    // evaluate that contains a named helper throws ReferenceError.
    // Plain property assignment (no const) is safe — it doesn't get wrapped.
    await page.evaluateOnNewDocument(() => {
      // @ts-ignore
      if (typeof window.__name === 'undefined') window.__name = function (t) { return t; };
    });

    console.log('📡 Navigating to community feed…');
    await page.goto(COMMUNITY_URL, { waitUntil: 'networkidle2', timeout: 90_000 });

    console.log('🔐 Verifying login state…');
    const loggedIn = await waitForLogin(page, opts.loginTimeoutMs);
    if (!loggedIn) {
      console.error('❌ Login timed out. Sign in once in the open browser, then re-run.');
      return;
    }
    console.log('✅ Logged in.');

    await ensureCommunityTab(page);

    console.log('📜 Auto-scrolling feed to load posts…');
    await autoScrollFeed(page, opts.maxAgeHours);

    const allCards = await collectFeedCards(page);
    console.log(`📝 Discovered ${allCards.length} feed card(s).`);

    const removedEmpty = pruneEmptySeenPosts();
    if (removedEmpty > 0) {
      console.log(
        `🧹 Pruned ${removedEmpty} stale zero-job entries from nas_seen_posts.json so they retry now.`,
      );
    }

    const seen = readSeenPosts();
    const knownIds = knownDedupeIds();
    const feedUrl = page.url();
    const scrapeStart = new Date();

    // Window filter: only posts whose relative age is <= maxAgeHours.
    const maxAgeMs = opts.maxAgeHours * 3_600_000;
    const windowed = allCards.filter((c) => {
      if (!c.ageLabel) return true; // unknown age — don't drop
      const posted = parseRelativeTime(c.ageLabel, scrapeStart);
      return scrapeStart.getTime() - posted.getTime() <= maxAgeMs;
    });
    console.log(
      `⏱️  Within last ${opts.maxAgeHours}h: ${windowed.length}/${allCards.length} card(s).`,
    );

    // Process OLDEST-first inside the window so dashboard rows land in
    // chronological order. Feed comes top-down (newest first), so just reverse.
    const ordered = [...windowed].reverse();

    // ------------------------------------------------------------------
    // PHASE A — body scraping
    // Walk every unseen card and pull its inline body. This used to be
    // entangled with the per-post LLM call inside one big loop; we now
    // collect first, batch-extract second, ingest third.
    // ------------------------------------------------------------------
    type PendingCard = {
      card: FeedCard;
      postText: string;
      detailHeadline: string;
      postUrl: string;
      scrapedAt: Date;
      postedDate: Date;
    };
    const pending: PendingCard[] = [];
    let previousPostBody = '';

    for (const card of ordered) {
      if (opts.limit > 0 && pending.length >= opts.limit) break;

      // Dedup gate: skip but DO NOT stop — since we walk oldest-first, a
      // duplicate just means we already covered that one earlier.
      if (seen[card.postKey]) {
        console.log(`   ⏭️  Skipping already-seen post "${card.headline}".`);
        continue;
      }

      console.log(
        `\n[${pending.length + 1}/${ordered.length}] 🔍 ${card.headline}  (${card.ageLabel || 'no age'})`,
      );

      const scrapedAt = new Date();
      const postedDate = parseRelativeTime(card.ageLabel, scrapedAt);

      let navigatedTo: string | null = null;
      let postText = '';
      let detailHeadline = '';

      // PRIMARY PATH (nas.com 2026 layout): every post's full body is
      // already rendered inline inside its feed card; CSS line-clamp only
      // hides it visually. collectFeedCards() pulls bodyText/cardTitle
      // straight from the card root, so we can skip navigation entirely.
      if (card.bodyText && card.bodyText.length > 50) {
        postText = card.bodyText;
        detailHeadline = card.cardTitle || card.headline;
      } else {
        // FALLBACK PATH: if the inline-body extraction failed for this
        // card (DOM changed, layout variant, etc.), fall back to the old
        // navigate-then-extract path.
        try {
          if (card.postUrl) {
            const result = await openPostByUrl(page, card.postUrl);
            navigatedTo = result.navigatedTo;
            postText = result.postText;
            detailHeadline = result.headline || card.headline;
          } else {
            const result = await clickIntoCard(page, card.index);
            navigatedTo = result.navigatedTo;
            postText = result.postText;
            detailHeadline = result.headline || card.headline;
          }
        } catch (e) {
          console.warn(`   ⚠️  Failed to open post: ${(e as Error).message}`);
          await returnToFeed(page, feedUrl);
          continue;
        }
      }

      const postUrl = navigatedTo || card.postUrl || `${feedUrl}#post-${card.postKey}`;
      const snippetPreview = postText.replace(/\s+/g, ' ').slice(0, 220);
      console.log(`   📄 Post body length: ${postText.length}  url: ${postUrl}`);
      console.log(`   🔎 Body preview: ${snippetPreview}…`);

      // ONE-TIME debug dump on the first post regardless of which
      // navigation path (openPostByUrl / clickIntoCard) was taken. Writes
      // the live DOM to ./nas_debug_first_post.html so we can pick the
      // right post-detail selector when the run still extracts feed text.
      if (!dumpedDebugForRun) {
        dumpedDebugForRun = true;
        try {
          const diag = await page.evaluate(() => {
            const hash = (window.location.hash || '').replace(/^#/, '');
            const byId = hash ? document.getElementById(hash) : null;
            const dialogs = document.querySelectorAll('[role="dialog"]').length;
            const ariaModals = document.querySelectorAll('[aria-modal="true"]').length;
            const articles = document.querySelectorAll('article').length;
            const postIds = Array.from(
              document.querySelectorAll<HTMLElement>('[id^="post-"]'),
            ).map((el) => el.id);
            return {
              url: window.location.href,
              hash,
              byIdFound: !!byId,
              byIdInnerLen: byId ? (byId.innerText || '').length : 0,
              dialogs,
              ariaModals,
              articles,
              postIdsCount: postIds.length,
              postIdsSample: postIds.slice(0, 5),
              bodyLen: (document.body.innerText || '').length,
            };
          });
          console.log('   🩺 DOM DIAG:', JSON.stringify(diag));
          const html = await page.content();
          const fs = await import('node:fs');
          const dumpPath = './nas_debug_first_post.html';
          fs.writeFileSync(dumpPath, html, 'utf-8');
          console.log(
            `   📤 Wrote first-post HTML dump to ${dumpPath} (${html.length} bytes).`,
          );
        } catch (e) {
          console.warn(`   ⚠️  Debug dump failed: ${(e as Error).message}`);
        }
      }

      // Hard-warn if this post's body matches the previous one's. That
      // means we're scraping the feed background instead of the post —
      // the silent failure mode that PRs #5/#7/#10/#12/#13 hunted down.
      if (
        previousPostBody &&
        postText.length === previousPostBody.length &&
        postText.slice(0, 200) === previousPostBody.slice(0, 200)
      ) {
        console.warn(
          `   ⚠️  DUPLICATE BODY — same ${postText.length}-char chunk as previous post. ` +
            `Modal/post isolation FAILED. Skipping LLM call to avoid wasting a request.`,
        );
        await returnToFeed(page, feedUrl);
        continue;
      }
      previousPostBody = postText;

      pending.push({ card, postText, detailHeadline, postUrl, scrapedAt, postedDate });
      await returnToFeed(page, feedUrl);
    }

    // ------------------------------------------------------------------
    // PHASE B — ONE batch LLM call: extract every job AND draft every
    // application email subject/body in a single round-trip. This is the
    // "use the AI once for all the jobs" optimization.
    // ------------------------------------------------------------------
    console.log(
      `\n🤖 Batching ${pending.length} post(s) into ONE LLM call (extract + draft)…`,
    );
    const batched = pending.length
      ? await extractAndDraftAll(
          pending.map((p) => ({
            postKey: p.card.postKey,
            headline: p.detailHeadline,
            body: p.postText,
          })),
        )
      : [];
    console.log(`   ⤷ Batch returned ${batched.length} job(s) total across ${pending.length} post(s).`);

    const jobsByKey = new Map<string, BatchedJob[]>();
    for (const j of batched) {
      if (!jobsByKey.has(j.postKey)) jobsByKey.set(j.postKey, []);
      jobsByKey.get(j.postKey)!.push(j);
    }

    // ------------------------------------------------------------------
    // PHASE C — ingest jobs into the dashboard + create Gmail drafts.
    // For each pending post, prefer the batched result. If the batch
    // came back completely empty (whole call failed), fall back to the
    // legacy per-post extractJobsFromPost + generateEmailContent path so
    // we still produce something on a flaky LLM run.
    // ------------------------------------------------------------------
    for (const p of pending) {
      let jobs: BatchedJob[] = jobsByKey.get(p.card.postKey) || [];

      if (jobs.length === 0 && batched.length === 0) {
        // Whole batch failed — fall back to per-post extraction.
        console.log(
          `   ↩️  Batch empty for "${p.detailHeadline}" — falling back to per-post extraction.`,
        );
        const fallback = await extractJobsFromPost(p.detailHeadline, p.postText);
        for (let i = 0; i < fallback.length; i++) {
          const f = fallback[i];
          const company = (f.company || 'Hiring Team').trim();
          const role = (f.role || '').trim();
          let subject = `Application for ${role || 'role'} - Rishav Tarway (Full Stack Developer)`;
          let bodyHtml = '';
          if (f.email && gmail) {
            const draft = await generateEmailContent(f.text || '', company, role);
            subject = draft.subject;
            bodyHtml = draft.body;
          }
          jobs.push({
            postKey: p.card.postKey,
            inPostId: String(i + 1),
            company,
            role,
            email: f.email || null,
            link: f.link || null,
            subject,
            bodyHtml,
            description: f.text || '',
          });
        }
      }

      console.log(
        `\n📌 ${p.detailHeadline} → ${jobs.length} job(s) ${jobs.length === 0 ? '(no apply targets)' : ''}`,
      );

      let newJobsThisPost = 0;
      for (const j of jobs) {
        const slug = `${j.inPostId}-${(j.company || j.role || '').toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
        const dedupeId = `nas-${p.card.postKey}-${slug}`.slice(0, 120);
        if (knownIds.has(dedupeId)) {
          console.log(`   ⏭️  Already tracked: ${j.company || j.role || dedupeId}`);
          continue;
        }

        const baseRecord = {
          company: j.company || 'Hiring Team',
          role: j.role || 'Software Engineer',
          channel: CHANNEL_LABEL,
          telegramId: dedupeId,
          appliedDate: p.scrapedAt.toISOString(),
          postedDate: p.postedDate.toISOString(),
          jobDescription: j.description || '',
          notes: `Headline: ${p.detailHeadline}\nAge label: ${p.card.ageLabel}`,
        };

        // If the batch returned an email but missed/dropped the bodyHtml
        // (intermittent on Gemini for long batches), fall back to the
        // legacy per-job draft helper so we ALWAYS get an email body.
        // Without this the job silently demoted to to_apply AND the post
        // got marked as seen — so it never retried.
        if (j.email && gmail && !j.bodyHtml) {
          console.log(
            `   ↩️  Batch missed bodyHtml for ${j.company || j.role} — drafting via fallback.`,
          );
          try {
            const draft = await generateEmailContent(j.description || '', j.company || '', j.role || '');
            j.subject = j.subject || draft.subject;
            j.bodyHtml = draft.body;
          } catch (e) {
            console.warn(`      ⚠️  Fallback draft failed: ${(e as Error).message}`);
          }
        }

        if (j.email && gmail && j.bodyHtml) {
          console.log(`   📧 Drafting email for ${j.company} → ${j.email}`);
          try {
            await createDraft(gmail, j.email, j.subject, j.bodyHtml);
            console.log(`      ✅ Draft created: "${j.subject}"`);
          } catch (e) {
            console.warn(`      ⚠️  Draft failed: ${(e as Error).message}`);
          }
          await pushToDashboard({
            ...baseRecord,
            email: j.email,
            link: j.link || p.postUrl,
            status: 'applied',
            type: 'web',
            description: `<b>SUBJECT: ${j.subject}</b><br><br>${j.bodyHtml}`,
          });
        } else if (j.link || j.email) {
          console.log(
            `   📎 Saving manual-apply for ${j.company} → ${j.link || j.email || p.postUrl}`,
          );
          await pushToDashboard({
            ...baseRecord,
            email: j.email || '',
            link: j.link || p.postUrl,
            status: 'to_apply',
            type: 'web',
            description: j.description || '',
          });
        } else {
          // No email AND no link — push for manual triage so the user
          // still sees it on the dashboard (e.g. "DM" / phone-only posts).
          console.log(`   📎 Saving manual-triage for ${j.company} (no email/link)`);
          await pushToDashboard({
            ...baseRecord,
            email: '',
            link: p.postUrl,
            status: 'to_apply',
            type: 'web',
            description: j.description || '',
          });
        }

        knownIds.add(dedupeId);
        newJobsThisPost++;
        totalNewJobs++;
      }

      // Only persist a seen-post record if we actually extracted at
      // least one job. Posts that returned 0 jobs stay unseen so they
      // retry next run — self-healing.
      if (newJobsThisPost > 0) {
        writeSeenPost({
          postKey: p.card.postKey,
          postUrl: p.postUrl,
          headline: p.detailHeadline || p.card.headline,
          ageLabel: p.card.ageLabel,
          postedDate: p.postedDate.toISOString(),
          scrapedAt: p.scrapedAt.toISOString(),
          jobCount: newJobsThisPost,
        });
      } else {
        console.log(
          `   ⎭️  Not marking "${p.detailHeadline || p.card.headline}" as seen (0 jobs) so it retries next run.`,
        );
      }
    }

    console.log(
      `\n🎯 Done. Processed ${pending.length} new post(s), added ${totalNewJobs} new job(s).`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
