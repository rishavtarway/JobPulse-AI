/**
 * fetch_telegram_channel.ts
 *
 * Mentorsetu-style Telegram channel scraper. Mirrors the NAS scraper /
 * Manual JD Paste pipeline:
 *   1. Sign in via gramjs (StringSession persisted to telegram_session.txt
 *      so subsequent runs are silent — first run prompts for OTP +
 *      optional 2FA password).
 *   2. Find the channel by exact title (default: env TELEGRAM_CHANNEL_TITLE
 *      or "Mentorsetu Premium 1.1").
 *   3. Pull the latest N messages within the look-back window, skip
 *      already-seen IDs (stored in telegram_seen.json), and run each
 *      fresh message body through the same Groq → Gemini extraction
 *      prompt as Manual JD Paste.
 *   4. For each extracted job:
 *        - email present  → draft into Gmail (status='applied')
 *        - link only      → manual-apply row (status='to_apply')
 *        - neither        → manual-triage row (status='to_apply')
 *
 * Required env (the user already has these in their local .env):
 *   TELEGRAM_API_ID        — numeric, from https://my.telegram.org/apps
 *   TELEGRAM_API_HASH      — 32-char hex
 *   TELEGRAM_PHONE_NUMBER  — full international format e.g. +91xxxxxxxxxx
 *   TELEGRAM_2FA_PASSWORD  — only if 2-step verification is enabled
 *   GROQ_API_KEY / GEMINI_API_KEY — extraction LLMs (same as Manual JDs)
 *
 * Usage:
 *   npx tsx fetch_telegram_channel.ts [--max-age-hours=24] [--limit=100]
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import readline from 'readline';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
// gramjs ships subpath types but no `exports` map in its package.json,
// so under `moduleResolution: nodenext` we have to import the folder's
// own `index.js` explicitly. Equivalent to the package's documented
// `import { StringSession } from 'telegram/sessions';` pattern.
import { TelegramClient } from 'telegram';
// eslint-disable-next-line import/no-unresolved
import { StringSession } from 'telegram/sessions/index.js';

dotenv.config();

const SERVER_PORT = process.env.SERVER_PORT || '3000';
const DASHBOARD_INGEST = `http://localhost:${SERVER_PORT}/api/applications`;
const SESSION_FILE = path.join(process.cwd(), 'telegram_session.txt');
const SEEN_FILE = path.join(process.cwd(), 'telegram_seen.json');
const CHANNEL_TITLE = process.env.TELEGRAM_CHANNEL_TITLE || 'Mentorsetu Premium 1.1';

interface ExtractedJob {
  company: string;
  role: string;
  email: string | null;
  link: string | null;
  description: string;
}

// ─── EMAIL HELPERS (identical to process_manual_jds.ts / NAS scraper) ─────
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

const PARA3_HTML = `<p>You can check my recent Open Source PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and my detailed personal projects <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (a 60fps Crypto Tracker built with React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (an AI Resume Builder powered by GPT-4 and FastAPI).</p>`;

function buildCatchySubject(role: string, company: string): string {
  const safeRole = role || 'Software Engineer';
  const safeCompany = company || 'Hiring Team';
  const seed = (safeRole + '|' + safeCompany).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const brackets: Array<[string, string]> = [['[', ']'], ['{', '}'], ['(', ')']];
  const hooks = ['Hands-on', 'Production-ready', 'Open-source proof', 'Shipping fast', 'Builder', 'Already shipping'];
  const [open, close] = brackets[seed % brackets.length];
  const hook = hooks[seed % hooks.length];
  return `${open}${hook}${close} ${safeRole} application: Rishav Tarway for ${safeCompany}`;
}

function getOAuth2Client(): any | null {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');
  if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
    console.warn('   ⚠️  credential.json or token.json missing — Gmail drafting disabled. Manual rows only.');
    return null;
  }
  try {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const installed = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(installed.client_id, installed.client_secret, installed.redirect_uris[0]);
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    return oAuth2Client;
  } catch (e: any) {
    console.warn(`   ⚠️  Gmail OAuth init failed: ${e.message} — manual rows only.`);
    return null;
  }
}

async function createDraft(gmail: any, toEmail: string, subject: string, htmlBody: string) {
  const mailOptions = { to: toEmail, subject, html: htmlBody + SIGNATURE_HTML, attachments: ATTACHMENTS };
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

interface DraftedEmail { subject: string; body: string }
async function generateEmailContent(jobText: string, company: string, role: string): Promise<DraftedEmail> {
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
  Paragraph 1: Lead with what the company does and a recent growth/mission angle inferred from the JOB TEXT.
  Paragraph 2: Map my specific skills + 1-2 internship outcomes to the role's requirements with concrete numbers, and end with "I have attached my resume and other relevant documents for your review."
- DO NOT include any paragraph about open-source PRs, GitHub projects, CoinWatch, ProResume, or "Best,". Those are appended by the host.

RESPOND WITH RAW JSON ONLY (no markdown):
{ "para1": "...", "para2": "..." }`;
  const result = await callAI(prompt);
  const safeCompany = company || 'Hiring Team';
  const safeRole = role || 'Software Engineer';
  const p1 = result?.para1 ||
    `${safeCompany} is building products with real user impact, and the JOB TEXT signals real momentum on the engineering side. The mission and current scale align directly with where I have spent the last 19 months.`;
  const p2 = result?.para2 ||
    `Across 5 internships (MOSIP, Classplus, TechVastra, Testbook, Franchizerz) I shipped production code in Node.js, React/Next.js, and React Native. At Classplus I cut API latency 25% for 10k+ concurrent users and improved observability 40% via request-ID tracing, the same kind of ownership the ${safeRole} role demands. I have attached my resume and other relevant documents for your review.`;
  const subject = buildCatchySubject(safeRole, safeCompany);
  const body = `<p>Hi ${safeCompany} Hiring Team,</p><p>${p1}</p><p>${p2}</p>${PARA3_HTML}`;
  return { subject, body };
}

// ─── LLM extraction (Groq → Gemini) — identical contract to manual-jds ───
function parseJson(content: string, provider: string): any {
  if (!content) return null;
  let cleaned = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(cleaned); } catch {
    const arr = cleaned.match(/\[[\s\S]*\]/);
    const obj = cleaned.match(/\{[\s\S]*\}/);
    const candidate = arr?.[0] || obj?.[0];
    if (candidate) {
      try { return JSON.parse(candidate); }
      catch (e: any) { console.warn(`   ⚠️  ${provider} JSON parse failed: ${e.message}`); }
    }
    return null;
  }
}

const disabledUntil: Record<string, number> = {};
function isDisabled(p: string): boolean { const t = disabledUntil[p]; return t ? Date.now() < t : false; }
function disable(p: string, ms: number, reason: string) {
  disabledUntil[p] = Date.now() + ms;
  console.warn(`   🚫 Disabling ${p} for ${Math.round(ms / 1000)}s (${reason}).`);
}

async function callGroq(prompt: string): Promise<any> {
  const key = process.env.GROQ_API_KEY;
  if (!key || isDisabled('groq')) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You are a strict JSON-only API. Always respond with raw JSON only, no markdown, no commentary. When asked for an array, return ONLY the array literal.' },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (r.status === 401) { disable('groq', 60 * 60_000, 'HTTP 401'); return null; }
    if (r.status === 402) { disable('groq', 6 * 60 * 60_000, 'HTTP 402'); return null; }
    if (r.status === 429) {
      const retryAfter = parseFloat(r.headers.get('retry-after') || '0');
      const sec = Math.max(3, Math.min(30, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 8));
      disable('groq', Math.ceil(sec * 1000), `HTTP 429 (${sec}s)`);
      return null;
    }
    if (!r.ok) { console.warn(`   ⚠️  Groq HTTP ${r.status}: ${(data?.error?.message || '').slice(0, 200)}`); return null; }
    return parseJson(data?.choices?.[0]?.message?.content || '', 'Groq');
  } catch (e: any) { console.warn(`   ⚠️  Groq error: ${e.message}`); return null; }
}

async function callGemini(prompt: string): Promise<any> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || isDisabled('gemini')) return null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (data?.error) {
      const code = data.error.code || 0;
      if (code === 429 || code === 403) disable('gemini', 60_000, `HTTP ${code}`);
      console.warn(`   ⚠️  Gemini error: ${data.error.message?.slice(0, 200)}`);
      return null;
    }
    return parseJson(data?.candidates?.[0]?.content?.parts?.[0]?.text || '', 'Gemini');
  } catch (e: any) { console.warn(`   ⚠️  Gemini error: ${e.message}`); return null; }
}

async function callAI(prompt: string): Promise<any> {
  const r = await callGroq(prompt);
  if (r !== null) return r;
  const g = await callGemini(prompt);
  if (g !== null) return g;
  return null;
}

function findFirstArrayInResponse(node: any, maxDepth = 4): any[] | null {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object' || maxDepth <= 0) return null;
  for (const v of Object.values(node)) {
    const found = findFirstArrayInResponse(v, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

function buildPrompt(messages: string[]): string {
  const manifest = messages
    .map((msg, i) => `### MESSAGE ${i + 1}\nBODY:\n${msg.slice(0, 6000)}`)
    .join('\n\n---\n\n');
  return `You are extracting EVERY distinct job/internship from MULTIPLE Telegram channel messages (a job-posting community).

For EACH job you find across ALL messages, return one JSON object with:
- "postIndex": 1-based index of the source message (matches "MESSAGE N" header).
- "company": company name. Use "Hiring Team" if truly unknown.
- "role": role/title (e.g. "SDE Intern", "Backend Engineer").
- "email": HR/application email if explicitly present, else null.
- "link": the BEST application URL — Google Form / Typeform / Lever / Greenhouse / Workday / Ashby / company careers / LinkedIn job URL. Pick the FIRST plausible one; null if none present.
- "description": the FULL original message text (verbatim, keep emojis and line breaks).

A single message may contain multiple distinct jobs (e.g. listing 5 companies hiring SDE-1) — emit one object per role.

OUTPUT RULES:
- Output ONLY a raw JSON ARRAY (no fences, no commentary, no wrapping object).
- Skip non-job content (memes, replies, generic announcements, "good morning", etc.).
- Always include a job even when both email AND link are null.

MESSAGES:

${manifest}`;
}

// ─── Dashboard ingest (same payload shape as Manual JD Paste) ────────────
interface DashboardPayload {
  company: string;
  role: string;
  email: string;
  link: string;
  description: string;
  jobDescription: string;
  status: 'applied' | 'to_apply';
  type: 'web' | 'manual';
  channel: string;
  postUrl?: string;
}
async function postToDashboard(p: DashboardPayload): Promise<boolean> {
  try {
    const r = await fetch(DASHBOARD_INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...p,
        telegramId: `tg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        appliedDate: new Date().toISOString(),
        postedDate: new Date().toISOString(),
      }),
    });
    return r.ok;
  } catch (e: any) {
    console.warn(`   ⚠️  Dashboard ingest failed: ${e.message}`);
    return false;
  }
}

// ─── readline-based prompt for first-run OTP / 2FA ────────────────────────
// IMPORTANT: gramjs's `client.start` calls `phoneCode()` first and then
// `password()` if Telegram says SESSION_PASSWORD_NEEDED. We MUST share
// a single readline interface between the two prompts. If we open and
// close a fresh interface for each call, `rl.close()` after the OTP
// terminates Node's stdin readable, so the second `createInterface()`
// gets an already-ended stdin → the password prompt resolves instantly
// with an empty string and gramjs silently gives up on 2FA.
let _rl: readline.Interface | null = null;
function getRl(): readline.Interface {
  if (!_rl) {
    _rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  }
  return _rl;
}
function closeRl() {
  if (_rl) { try { _rl.close(); } catch { /* noop */ } _rl = null; }
}
function ask(question: string, hide = false): Promise<string> {
  const rl = getRl();
  return new Promise((resolve) => {
    if (hide) {
      // Best-effort hidden input — overrides _writeToOutput briefly to
      // echo asterisks instead of the actual character.
      const _w = (rl as any)._writeToOutput;
      (rl as any)._writeToOutput = function (s: string) {
        if (s && s.indexOf('\n') === -1) (rl as any).output.write('*');
        else (rl as any).output.write(s);
      };
      rl.question(question, (a) => {
        (rl as any)._writeToOutput = _w;
        process.stdout.write('\n');
        resolve(a.trim());
      });
    } else {
      rl.question(question, (a) => resolve(a.trim()));
    }
  });
}

// ─── Telegram sign-in (StringSession persisted to telegram_session.txt) ──
async function signInTelegram(apiId: number, apiHash: string, phone: string, twoFa: string): Promise<TelegramClient> {
  const sessionStr = fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '';
  const stringSession = new StringSession(sessionStr);
  const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 });
  console.log(sessionStr ? '🔐 Reusing saved Telegram session…' : '🔐 First run — starting fresh sign-in (will prompt for OTP).');

  try {
    await client.start({
      phoneNumber: async () => phone,
      // gramjs only invokes this callback if Telegram returns
      // SESSION_PASSWORD_NEEDED (i.e. the account has 2-step
      // verification enabled). We try the env var first to allow
      // silent re-auth on session expiry, falling back to an
      // interactive hidden prompt.
      password: async () => twoFa || (await ask('🔐 2FA password (hidden): ', true)),
      phoneCode: async () => (await ask('📱 Enter the OTP Telegram just sent you: ')),
      onError: (err: any) => console.warn(`   ⚠️  Telegram sign-in error: ${err && err.message ? err.message : err}`),
    });
  } finally {
    // Close the shared readline interface only AFTER sign-in is fully
    // done — closing between the OTP and 2FA prompts would EOF stdin
    // and silently skip the password step.
    closeRl();
  }

  if (!sessionStr) {
    try {
      // gramjs's StringSession.save() returns a string, but the broader
      // Session interface declares void. Cast through unknown to unwrap.
      const saved = String((client.session.save() as unknown as string) ?? '');
      fs.writeFileSync(SESSION_FILE, saved, 'utf8');
      console.log(`✅ Saved Telegram session → ${SESSION_FILE}. Future runs are silent.`);
    } catch (e: any) { console.warn(`   ⚠️  Couldn't persist session: ${e.message}`); }
  }
  return client;
}

function loadSeen(): Set<number> {
  try { return new Set<number>(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); }
  catch { return new Set<number>(); }
}
function saveSeen(seen: Set<number>) {
  // Persist a hard cap of the most recent 10 000 IDs so the file doesn't
  // grow forever on a high-traffic channel.
  const arr = Array.from(seen);
  const trimmed = arr.length > 10_000 ? arr.slice(-10_000) : arr;
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(trimmed)); }
  catch (e: any) { console.warn(`   ⚠️  Couldn't persist seen IDs: ${e.message}`); }
}

async function main() {
  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';
  const phone = process.env.TELEGRAM_PHONE_NUMBER || '';
  const twoFa = process.env.TELEGRAM_2FA_PASSWORD || '';

  if (!apiId || !apiHash || !phone) {
    console.error('❌ Missing TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_PHONE_NUMBER in .env.');
    console.error('   Get the first two from https://my.telegram.org/apps (Create new application).');
    process.exit(1);
  }

  // CLI args (supports both --max-age-hours <n> and --max-age-hours=<n>).
  function arg(name: string, fallback: number): number {
    const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) return fallback;
    const tok = process.argv[i];
    const raw = tok.includes('=') ? tok.split('=')[1] : process.argv[i + 1];
    const n = parseFloat(raw || '');
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }
  const maxAgeHours = arg('max-age-hours', 24);
  const limit = Math.max(1, Math.min(500, arg('limit', 100)));
  const cutoffSec = Math.floor((Date.now() - maxAgeHours * 3600 * 1000) / 1000);

  console.log(`\n🚀 Telegram Channel Scraper — channel="${CHANNEL_TITLE}", look-back=${maxAgeHours}h, limit=${limit}`);

  const client = await signInTelegram(apiId, apiHash, phone, twoFa);

  console.log(`🔍 Looking up channel by title: "${CHANNEL_TITLE}"…`);
  const dialogs: any[] = await client.getDialogs({ limit: 200 });
  const dialog = dialogs.find((d: any) => (d.title || '').trim() === CHANNEL_TITLE.trim());
  if (!dialog) {
    console.error(`❌ Channel "${CHANNEL_TITLE}" not found in your dialogs.`);
    console.error(`   Visible (first 30): ${dialogs.slice(0, 30).map((d: any) => d.title).filter(Boolean).join(' / ') || '(none)'}`);
    console.error(`   Make sure you've actually joined the channel from this account, then re-run.`);
    await client.disconnect();
    process.exit(2);
  }
  console.log(`✅ Found channel. Fetching last ${limit} message(s)…`);

  const messages: any[] = await client.getMessages(dialog.entity, { limit });
  const fresh = messages.filter((m: any) => typeof m.message === 'string' && m.message.length >= 80 && Number(m.date || 0) >= cutoffSec);
  console.log(`📨 ${fresh.length}/${messages.length} message(s) within last ${maxAgeHours}h with usable text.`);

  const seen = loadSeen();
  const newMsgs = fresh.filter((m: any) => !seen.has(Number(m.id)));
  console.log(`🆕 ${newMsgs.length} new message(s) to process (after dedup against ${seen.size} previously seen).`);

  if (!newMsgs.length) {
    console.log('🎯 Nothing new. Disconnecting.');
    await client.disconnect();
    return;
  }

  // Single batched LLM call across every fresh message — same shape as
  // Manual JD Paste so we can reuse the extraction prompt.
  const bodies: string[] = newMsgs.map((m: any) => String(m.message || ''));
  console.log(`🤖 Running batched extraction on ${bodies.length} message(s)…`);
  const t0 = Date.now();
  const result = await callAI(buildPrompt(bodies));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (!result) {
    console.error('❌ All LLM providers failed. No jobs extracted. (Messages NOT marked as seen so we retry next run.)');
    await client.disconnect();
    process.exit(3);
  }

  let jobs: any[] | null = Array.isArray(result) ? result : findFirstArrayInResponse(result);
  if (!Array.isArray(jobs)) jobs = [];
  console.log(`✅ Extracted ${jobs.length} job(s) in ${elapsed}s.`);

  const auth = getOAuth2Client();
  const gmail = auth ? google.gmail({ version: 'v1', auth: auth as any }) : null;
  console.log(gmail
    ? '📧 Gmail draft mode: ENABLED.'
    : '📧 Gmail draft mode: DISABLED — every email-bearing job will fall back to a manual-apply row.');

  let saved = 0;
  let drafted = 0;
  for (const job of jobs) {
    const j: ExtractedJob = {
      company: String(job?.company || 'Hiring Team').trim() || 'Hiring Team',
      role: String(job?.role || '').trim() || 'Software Engineer',
      email: job?.email ? String(job.email).trim() : null,
      link: job?.link ? String(job.link).trim() : null,
      description: String(job?.description || '').trim(),
    };
    const idxRaw = Number(job?.postIndex);
    const idx = Number.isFinite(idxRaw) && idxRaw >= 1 ? Math.max(1, Math.min(newMsgs.length, Math.floor(idxRaw))) : 1;
    const sourceMsg = newMsgs[idx - 1];
    const sourceText = String(sourceMsg?.message || j.description);
    const channelLabel = `Telegram · ${CHANNEL_TITLE}`;

    if (j.email && gmail) {
      console.log(`   📧 ${j.company} — ${j.role} → drafting email to ${j.email}`);
      try {
        const { subject, body } = await generateEmailContent(sourceText, j.company, j.role);
        await createDraft(gmail, j.email, subject, body);
        console.log(`      ✅ Draft created: "${subject}"`);
        const ok = await postToDashboard({
          company: j.company, role: j.role, email: j.email, link: j.link || '',
          description: `<b>SUBJECT: ${subject}</b><br><br>${body}`,
          jobDescription: sourceText, status: 'applied', type: 'web', channel: channelLabel,
        });
        if (ok) { saved++; drafted++; }
        else console.warn(`      ⚠️  Draft created but dashboard ingest failed.`);
      } catch (e: any) {
        console.warn(`      ⚠️  Draft failed (${e.message}) — saving as manual row.`);
        const ok = await postToDashboard({
          company: j.company, role: j.role, email: j.email, link: j.link || '',
          description: j.description?.slice(0, 600) || sourceText.slice(0, 600),
          jobDescription: sourceText, status: 'to_apply', type: 'manual', channel: channelLabel,
        });
        if (ok) saved++;
      }
    } else {
      const linkLabel = j.link ? `🔗 ${j.link}` : (j.email ? `📧 ${j.email} (no Gmail auth — saved as manual)` : '⚠️ no link / no email');
      console.log(`   📌 ${j.company} — ${j.role} (${linkLabel})`);
      const ok = await postToDashboard({
        company: j.company, role: j.role, email: j.email || '', link: j.link || '',
        description: j.description?.slice(0, 600) || sourceText.slice(0, 600),
        jobDescription: sourceText, status: 'to_apply', type: 'manual', channel: channelLabel,
      });
      if (ok) saved++;
    }
  }

  // Mark every successfully-extracted-from message as seen, even if it
  // produced 0 jobs — re-running a Groq pass on the same body would just
  // produce 0 again. Messages that errored (no LLM result) bail above.
  for (const m of newMsgs) seen.add(Number(m.id));
  saveSeen(seen);

  console.log(`\n🎯 Done. Saved ${saved}/${jobs.length} job(s) to dashboard (${drafted} email draft${drafted === 1 ? '' : 's'} created).`);
  await client.disconnect();
}

main().catch((e) => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(99);
});
