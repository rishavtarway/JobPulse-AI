/**
 * Automated nas.com community scraper for the
 * "TechUprise Insider Club" community.
 *
 * Strategy (v2 — dedup-only, no time cutoff, captures both timestamps):
 *
 *   1. Launch Puppeteer with the persistent profile under ./nas_chrome_profile
 *      so the user only logs in once (cookies persist across runs).
 *   2. Navigate to https://nas.com/techuprise-insider-club/community.
 *      If we land on Home, click the Community tab. Then wait for the Feed.
 *   3. Walk the feed TOP-DOWN (newest first). For every post card we extract
 *      a stable post key (canonical URL when clicking navigates, otherwise a
 *      sha1 of the headline + first 240 chars of the snippet — unaffected by
 *      the "Xh ago" relative-time label which would otherwise drift).
 *   4. The dedup gate uses BOTH:
 *         - nas_seen_posts.json  (this script's own log)
 *         - applications.json    (channel = "TechUprise NAS Community", via
 *                                 the dedupeId field stored in `telegramId`)
 *      As soon as we hit a card already present in either store, we STOP —
 *      everything below in the feed is older and already processed.
 *      We never re-AI a duplicate.
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
 *   npx tsx fetch_nas_community.ts                  # process every new post
 *   npx tsx fetch_nas_community.ts --limit 5        # cap to N newest unseen
 *   npx tsx fetch_nas_community.ts --headless       # run without showing UI
 *   npx tsx fetch_nas_community.ts --login-timeout 600  # seconds
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

// ============================================================================
// CLI ARGS
// ============================================================================

interface CliOptions {
  limit: number;
  headless: boolean;
  loginTimeoutMs: number;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const options: CliOptions = { limit: 0, headless: false, loginTimeoutMs: 5 * 60 * 1000 };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') {
      options.limit = Number(args[++i]) || 0;
    } else if (args[i] === '--headless') {
      options.headless = true;
    } else if (args[i] === '--login-timeout') {
      // Default to 300s (5min) when value is missing or non-numeric.
      options.loginTimeoutMs = (Number(args[++i]) || 300) * 1000;
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
  else if (/^m(in|s)?$/.test(unit) || unit === 'minute' || unit === 'minutes') ms = n * 60_000;
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

async function callAI(prompt: string, jsonFlag = false): Promise<any> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (!openrouterKey) {
    console.warn('   ⚠️  OPENROUTER_API_KEY not set — skipping AI extraction.');
    return null;
  }
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-lite-001',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data: any = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    if (jsonFlag) {
      const trimmed = content.trim();
      try {
        return JSON.parse(trimmed);
      } catch {
        const firstBrace = trimmed.indexOf('[');
        const firstObj = trimmed.indexOf('{');
        const start =
          firstBrace !== -1 && (firstObj === -1 || firstBrace < firstObj) ? firstBrace : firstObj;
        const lastBrace = trimmed.lastIndexOf(']');
        const lastObj = trimmed.lastIndexOf('}');
        const end = Math.max(lastBrace, lastObj);
        if (start === -1 || end === -1) return null;
        try {
          return JSON.parse(trimmed.substring(start, end + 1));
        } catch {
          return null;
        }
      }
    }
    return content;
  } catch (e) {
    console.error('   ⚠️  callAI error:', e);
    return null;
  }
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
${postText.substring(0, 14000)}`;

  const result = await callAI(prompt, true);
  if (!Array.isArray(result)) return [];
  return result
    .filter((j) => j && typeof j === 'object' && (j.email || j.link))
    .map((j) => ({
      ...j,
      category: j.email ? 'email-apply' : 'manual-apply',
    })) as ExtractedJob[];
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
  const prompt = `Write a tailored, professional 3-paragraph job application email for Rishav Tarway.

JOB TEXT: """${jobText.substring(0, 1200)}"""
COMPANY: ${company || 'the company'}
ROLE: ${role || 'Software Engineer'}

USER CONTEXT (Rishav Tarway):
- B.Tech CSE (AI & ML), 19 months across 5 internships (MOSIP / Classplus / TechVastra / Testbook / Franchizerz).
- Tech: Node.js, React, Next.js, React Native, Android, Python, Java, Go, MongoDB, Redis, AWS, Docker, Selenium, Cucumber BDD, OSS-Fuzz, Gemini API.
- Open source: WoC 5.0 OpenPrinting (go-avahi) — built OSS-Fuzz infra, 11 fuzz harnesses, fixed CWE-401 (16MB leak) & CWE-122. PRs in stdlib.js & OpenPrinting.
- Highlight projects: Tech Stream Community (React+Socket.io+MongoDB+AWS+Redis, 500+ users, 99.9% uptime, https://github.com/rishavtarway/CoinWatch), CoinWatch (React Native, Expo, 60fps, https://github.com/rishavtarway/CoinWatch), ProResume (React Native + Gemini AI ATS resume builder, https://github.com/rishavtarway/ProResume).

STRICT RULES:
- NO emojis. No em dashes used as separators. No "I am passionate" / "leverage" / "synergize" / "thrilled".
- Subject: 6–9 words, attention-grabbing, varied brackets ok ([], {}, ()), include role + company.
- Output EXACTLY 3 paragraphs (each 2 sentences max).
  Paragraph 1: Lead with what the company does and a recent growth/mission angle inferred from the JOB TEXT. Show I have actually understood the company.
  Paragraph 2: Map my specific skills + 1-2 internship outcomes to the role's requirements with concrete numbers.
  Paragraph 3: Cite ONE highly relevant project from the list above with its GitHub link, and close on what I can ship in the first 30 days.

RESPOND WITH RAW JSON ONLY (no markdown):
{ "subject": "...", "para1": "...", "para2": "...", "para3": "..." }`;

  const result = await callAI(prompt, true);
  const safeCompany = company || 'Hiring Team';
  const safeRole = role || 'Software Engineer';
  const p1 =
    result?.para1 ||
    `${safeCompany} is building products with real user impact, and the JOB TEXT signals real momentum on the engineering side. The mission and current scale align directly with where I have spent the last 19 months.`;
  const p2 =
    result?.para2 ||
    `Across 5 internships (MOSIP, Classplus, TechVastra, Testbook, Franchizerz) I shipped production code in Node.js, React/Next.js, and React Native. At Classplus I cut API latency 25% for 10k+ concurrent users and improved observability 40% via request-ID tracing — the same kind of ownership the ${safeRole} role demands.`;
  const p3 =
    result?.para3 ||
    `Most relevant: Tech Stream Community (React + Socket.io + MongoDB + Redis + AWS, 500+ users, 99.9% uptime — https://github.com/rishavtarway/CoinWatch) and ProResume (React Native + Gemini AI, ATS-optimised resume builder — https://github.com/rishavtarway/ProResume). Happy to walk through a 30-day plan in a 20-minute call.`;
  const subject = result?.subject || `[Application] ${safeRole} : ${safeCompany}`;

  const body = `<p>Hi ${safeCompany} Hiring Team,</p><p>${p1}</p><p>${p2}</p><p>${p3}</p><p>Best,</p>`;
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasLoginCta =
        /\b(log\s*in|sign\s*in|sign\s*up|continue with google)\b/.test(text) &&
        document.querySelectorAll('input[type="password"], input[type="email"]').length > 0;
      const hasCommunityShell = /\b(community|feed)\b/i.test(document.body.innerText);
      return { hasLoginCta, hasCommunityShell };
    });
    if (state.hasCommunityShell && !state.hasLoginCta) return true;
    if (state.hasLoginCta) {
      console.log('   🔐 Not logged in. Please sign in to nas.com in the open browser window…');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function autoScrollFeed(page: Page, maxIterations = 30): Promise<void> {
  let lastHeight = 0;
  let stableTicks = 0;
  for (let i = 0; i < maxIterations; i++) {
    const newHeight = await page.evaluate(() => {
      const containers = Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
        (el) => el.scrollHeight > el.clientHeight && el.clientHeight > 200,
      );
      window.scrollBy(0, window.innerHeight * 0.9);
      containers.forEach((c) => c.scrollBy(0, c.clientHeight * 0.9));
      return Math.max(document.body.scrollHeight, ...containers.map((c) => c.scrollHeight));
    });
    await new Promise((r) => setTimeout(r, 1500));
    if (newHeight <= lastHeight) {
      stableTicks++;
      if (stableTicks >= 3) break;
    } else {
      stableTicks = 0;
      lastHeight = newHeight;
    }
  }
}

interface FeedCard {
  index: number;
  headline: string;
  snippet: string;
  ageLabel: string;
  postKey: string; // stable hash of headline + snippet
}

/**
 * Walk the feed top-down and return one descriptor per post card.
 * The post card root is heuristically the smallest containing element that
 * has BOTH a "TechUprise" / "Creator" creator label AND a relative-time label.
 */
async function collectFeedCards(page: Page): Promise<FeedCard[]> {
  return await page.evaluate(() => {
    const RELATIVE_TIME = /\b(just\s+now|\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s+ago)\b/i;

    function sha1(str: string): string {
      // Tiny FNV-1a 32-bit hash as a sha1 stand-in (deterministic, no Node crypto in browser).
      let h = 0x811c9dc5;
      for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16);
    }

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

    // 4. Extract a {headline, snippet, ageLabel} per card.
    const cards: FeedCard[] = [];
    cardRoots.forEach((root: HTMLElement, index: number) => {
      const fullText = (root.innerText || '').trim();

      const ageMatch = fullText.match(RELATIVE_TIME);
      const ageLabel = ageMatch ? ageMatch[0] : '';

      // Headline is the most prominent header inside the card.
      let headline = '';
      const heading = root.querySelector<HTMLElement>('h1, h2, h3, h4, [role="heading"], strong, b');
      if (heading) headline = (heading.innerText || '').trim().split('\n')[0];
      if (!headline) {
        // Fallback: first non-meta line that isn't the author label / age.
        const lines = fullText
          .split('\n')
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              !/^TechUprise$/i.test(l) &&
              !/Creator/i.test(l) &&
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

      const postKey = sha1((headline + '|' + snippet).toLowerCase());

      cards.push({ index, headline, snippet, ageLabel, postKey });
    });

    // Hand back the data + a way to re-find each card by index later.
    // We re-discover roots in the same order in clickIntoCard().
    return cards;
  });
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

  await page.evaluate((idx) => {
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
    if (!root) return;

    root.scrollIntoView({ block: 'center' });

    // Prefer clicking the bold headline / "See more" / heading element.
    const target =
      root.querySelector<HTMLElement>('h1, h2, h3, h4, [role="heading"], strong, b') ||
      Array.from(root.querySelectorAll<HTMLElement>('span, a, button')).find((el) =>
        /see more/i.test(el.innerText || ''),
      ) ||
      root;
    target.click();
  }, cardIndex);

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
    // The most informative block on the page: the largest visible text container.
    const all = Array.from(document.querySelectorAll<HTMLElement>('div, article, section'));
    let best: { el: HTMLElement; len: number } | null = null;
    for (const el of all) {
      const t = (el.innerText || '').trim();
      if (t.length < 80) continue;
      if (t.length > 30000) continue;
      // Prefer post-detail-like blocks (avoid full document.body).
      if (el === document.body) continue;
      if (!best || t.length > best.len) best = { el, len: t.length };
    }
    const heading = document.querySelector<HTMLElement>('h1, h2, h3, h4, [role="heading"], strong, b');
    return {
      headline: heading ? (heading.innerText || '').trim().split('\n')[0] : '',
      postText: best ? best.el.innerText : document.body.innerText,
    };
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
  console.log('🚀 NAS Community Auto-Scraper (v2 — dedup-only)');
  console.log(`   profile: ${PROFILE_DIR}`);
  console.log(`   headless: ${opts.headless}`);
  console.log(`   limit: ${opts.limit || 'unlimited'}`);

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
    await autoScrollFeed(page);

    const cards = await collectFeedCards(page);
    console.log(`📝 Discovered ${cards.length} feed card(s).`);

    const seen = readSeenPosts();
    const knownIds = knownDedupeIds();
    const feedUrl = page.url();

    let processed = 0;
    for (const card of cards) {
      // Stop the moment we hit a post we've already processed — feed is
      // ordered newest -> oldest so anything below is older.
      if (seen[card.postKey]) {
        console.log(`🛑 Hit already-seen post "${card.headline}" — stopping (dedup gate).`);
        break;
      }

      if (opts.limit > 0 && processed >= opts.limit) break;

      console.log(`\n[${processed + 1}/${cards.length}] 🔍 ${card.headline}  (${card.ageLabel || 'no age'})`);

      const scrapedAt = new Date();
      const postedDate = parseRelativeTime(card.ageLabel, scrapedAt);

      let navigatedTo: string | null = null;
      let postText = '';
      let detailHeadline = '';
      try {
        const result = await clickIntoCard(page, card.index);
        navigatedTo = result.navigatedTo;
        postText = result.postText;
        detailHeadline = result.headline || card.headline;
      } catch (e) {
        console.warn(`   ⚠️  Failed to open post: ${(e as Error).message}`);
        // Still mark the card as seen so we don't loop on the same broken card.
        writeSeenPost({
          postKey: card.postKey,
          postUrl: feedUrl,
          headline: card.headline,
          ageLabel: card.ageLabel,
          postedDate: postedDate.toISOString(),
          scrapedAt: scrapedAt.toISOString(),
          jobCount: 0,
        });
        await returnToFeed(page, feedUrl);
        processed++;
        continue;
      }

      const postUrl = navigatedTo || `${feedUrl}#post-${card.postKey}`;
      console.log(`   📄 Post body length: ${postText.length}  url: ${postUrl}`);

      const jobs = await extractJobsFromPost(detailHeadline, postText);
      console.log(`   🌟 AI extracted ${jobs.length} job(s).`);

      let newJobsThisPost = 0;
      for (const job of jobs) {
        const dedupeId = `nas-${card.postKey}-${(job.id || job.company || job.role || '')
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '')}`.slice(0, 120);
        if (!dedupeId) continue;
        if (knownIds.has(dedupeId)) {
          console.log(`   ⏭️  Already tracked: ${job.company || job.role || dedupeId}`);
          continue;
        }

        const company = (job.company || 'Unknown').trim();
        const role = (job.role || 'Software Engineer').trim();
        const baseRecord = {
          company,
          role,
          channel: CHANNEL_LABEL,
          telegramId: dedupeId,
          appliedDate: scrapedAt.toISOString(),
          postedDate: postedDate.toISOString(),
          jobDescription: job.text || '',
          notes: `Headline: ${detailHeadline}\nLocation: ${job.location || ''}\nAge label: ${card.ageLabel}`,
        };

        if (job.category === 'email-apply' && job.email && gmail) {
          console.log(`   📧 Drafting email for ${company} → ${job.email}`);
          const { subject, body } = await generateEmailContent(job.text || '', company, role);
          try {
            await createDraft(gmail, job.email, subject, body);
            console.log(`      ✅ Draft created: "${subject}"`);
          } catch (e) {
            console.warn(`      ⚠️  Draft failed: ${(e as Error).message}`);
          }
          await pushToDashboard({
            ...baseRecord,
            email: job.email,
            link: job.link || postUrl,
            status: 'applied',
            type: 'web',
            description: `<b>SUBJECT: ${subject}</b><br><br>${body}`,
          });
        } else if (job.link || job.email) {
          console.log(
            `   📎 Saving manual-apply for ${company} → ${job.link || job.email || postUrl}`,
          );
          await pushToDashboard({
            ...baseRecord,
            email: job.email || '',
            link: job.link || postUrl,
            status: 'to_apply',
            type: 'web',
            description: job.text || '',
          });
        } else {
          continue;
        }
        knownIds.add(dedupeId);
        newJobsThisPost++;
        totalNewJobs++;
      }

      writeSeenPost({
        postKey: card.postKey,
        postUrl,
        headline: detailHeadline || card.headline,
        ageLabel: card.ageLabel,
        postedDate: postedDate.toISOString(),
        scrapedAt: scrapedAt.toISOString(),
        jobCount: newJobsThisPost,
      });

      await returnToFeed(page, feedUrl);
      processed++;
    }

    console.log(`\n🎯 Done. Processed ${processed} new post(s), added ${totalNewJobs} new job(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
