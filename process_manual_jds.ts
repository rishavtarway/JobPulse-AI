/**
 * Manual JD Processor
 *
 * Reads an array of raw JD strings from a temp JSON input file (path
 * passed as the only CLI arg), runs each through the same Groq-first
 * extractor used by the NAS scraper, and POSTs each extracted job to
 * the dashboard's /api/applications endpoint so it shows up alongside
 * NAS-scraped postings.
 *
 * Why a separate script (not inline in server.ts):
 * - Keeps the heavy LLM logic out of the request/response cycle so the
 *   dashboard click is non-blocking — server.ts spawns this and the
 *   logs stream into the existing terminal panel via /api/logs.
 * - Reuses the proven Groq → NVIDIA → Gemini → OpenRouter fallback
 *   pattern (inlined here so we don't have to refactor
 *   fetch_nas_community.ts into an importable module).
 *
 * Usage:
 *   npx tsx process_manual_jds.ts /tmp/manual_jds_<ts>.json
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

dotenv.config({ override: true });

const SERVER_PORT = process.env.SERVER_PORT || '3000';
const DASHBOARD_INGEST = `http://localhost:${SERVER_PORT}/api/applications`;

interface ExtractedJob {
  company: string;
  role: string;
  email: string | null;
  link: string | null;
  description: string;
}

// ─── EMAIL HELPERS (mirrored from fetch_nas_community.ts) ──────────────────
// Kept inline rather than extracted into a shared module so we don't risk a
// regression in the working NAS scraper. If a third entry-point needs these
// (e.g. Telegram scraper later), extract to email_helpers.ts at that point.

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
  Paragraph 1: Lead with what the company does and a recent growth/mission angle inferred from the JOB TEXT. Show I have actually understood the company.
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

// Lightweight provider disable map (per-process, per-run).
const disabledUntil: Record<string, number> = {};
function isDisabled(p: string): boolean {
  const t = disabledUntil[p];
  return t ? Date.now() < t : false;
}
function disable(p: string, ms: number, reason: string) {
  disabledUntil[p] = Date.now() + ms;
  console.warn(`   🚫 Disabling ${p} for ${Math.round(ms / 1000)}s (${reason}).`);
}

// Pull the first array we can find anywhere inside the LLM's JSON
// response. Models with response_format=json_object wrap arrays under
// arbitrary keys (jobs, data, items, results, etc.) and we shouldn't
// silently degrade to [] just because we picked the wrong key. Mirror
// findFirstArrayInResponse() in fetch_nas_community.ts (max depth 4).
function findFirstArrayInResponse(node: any, maxDepth = 4): any[] | null {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== 'object' || maxDepth <= 0) return null;
  for (const v of Object.values(node)) {
    const found = findFirstArrayInResponse(v, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

function parseJson(content: string, provider: string): any {
  if (!content) return null;
  let cleaned = content.trim();
  // Strip markdown fences if any.
  cleaned = cleaned.replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to pull the first JSON array / object out of the text.
    const arr = cleaned.match(/\[[\s\S]*\]/);
    const obj = cleaned.match(/\{[\s\S]*\}/);
    const candidate = arr?.[0] || obj?.[0];
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch (e: any) {
        console.warn(`   ⚠️  ${provider} JSON parse failed: ${e.message}`);
      }
    }
    return null;
  }
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
    if (!r.ok) {
      console.warn(`   ⚠️  Groq HTTP ${r.status}: ${(data?.error?.message || '').slice(0, 200)}`);
      return null;
    }
    return parseJson(data?.choices?.[0]?.message?.content || '', 'Groq');
  } catch (e: any) {
    console.warn(`   ⚠️  Groq error: ${e.message}`);
    return null;
  }
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
  } catch (e: any) {
    console.warn(`   ⚠️  Gemini error: ${e.message}`);
    return null;
  }
}

async function callAI(prompt: string): Promise<any> {
  const r = await callGroq(prompt);
  if (r !== null) return r;
  const g = await callGemini(prompt);
  if (g !== null) return g;
  return null;
}

function buildPrompt(jds: string[]): string {
  const manifest = jds
    .map((jd, i) => `### POST ${i + 1}\nBODY:\n${jd.slice(0, 6000)}`)
    .join('\n\n---\n\n');
  return `You are extracting EVERY distinct job/internship from MULTIPLE raw job postings the user pasted from various websites (LinkedIn / company careers page / Telegram / Discord / random forum).

For EACH job you find across ALL posts, return one JSON object with:
- "postIndex": 1-based index of the source post the job belongs to (matches "POST N" header).
- "company": company name. Use "Hiring Team" if truly unknown.
- "role": role/title (e.g. "SDE Intern", "Backend Engineer").
- "email": HR/application email if explicitly present, else null.
- "link": the BEST application URL — Google Form / Typeform / Lever / Greenhouse / Workday / Ashby / company careers / LinkedIn job URL. Pick the FIRST plausible one; null if none present.
- "description": the FULL original job text (verbatim, keep emojis and line breaks).

A single post may contain multiple distinct jobs (e.g. "We're hiring SDE-1, SDE-2, and DevOps") — emit one object per role.

OUTPUT RULES:
- Output ONLY a raw JSON ARRAY (no fences, no commentary, no wrapping object).
- Skip memes, replies, generic announcements (anything that isn't a real job posting).
- Always include a job even when both email AND link are null.

POSTS:

${manifest}`;
}

interface DashboardPayload {
  company: string;
  role: string;
  email: string;
  link: string;
  description: string;        // short blurb for card preview
  jobDescription: string;     // full body for the JD modal
  status: 'applied' | 'to_apply';
  type: 'web' | 'manual';
  channel: string;
}
async function postToDashboard(p: DashboardPayload): Promise<boolean> {
  try {
    const r = await fetch(DASHBOARD_INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...p,
        postUrl: '',                  // no source URL for manually-pasted JDs
        telegramId: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

async function main() {
  const argPath = process.argv[2];
  if (!argPath || !fs.existsSync(argPath)) {
    console.error('❌ Usage: tsx process_manual_jds.ts <path-to-input-json>');
    process.exit(1);
  }
  const input = JSON.parse(fs.readFileSync(argPath, 'utf8'));
  const jds: string[] = Array.isArray(input?.jds) ? input.jds.map(String) : [];
  if (!jds.length) {
    console.error('❌ Input file has no "jds" array.');
    process.exit(1);
  }

  console.log(`\n🚀 Manual JD Processor — ${jds.length} JD(s) submitted at ${new Date().toLocaleString()}`);
  console.log(`📡 Dashboard ingest: ${DASHBOARD_INGEST}`);
  console.log(`🤖 Calling Groq (with Gemini fallback) on batched JDs…`);

  // Lazy Gmail bootstrap. If credential.json + token.json are present we
  // mirror the NAS scraper flow and draft an email per email-bearing JD.
  // If they are missing, every job stays as a manual-apply row (current
  // behaviour). Initialised here so it's fetched once for the whole batch.
  const auth = getOAuth2Client();
  const gmail = auth ? google.gmail({ version: 'v1', auth: auth as any }) : null;
  if (gmail) console.log(`📧 Gmail draft mode: ENABLED (email-bearing JDs will be drafted into Gmail).`);
  else console.log(`📧 Gmail draft mode: DISABLED (every JD will be saved as a manual-apply row).`);

  const t0 = Date.now();
  const result = await callAI(buildPrompt(jds));

  if (!result) {
    console.error('❌ All LLM providers failed. No jobs extracted.');
    process.exit(2);
  }
  // Groq's json_object mode forces an object wrapper, so we must walk
  // the tree to find the array regardless of which key the model
  // picked (jobs / data / items / results / etc.).
  let jobs: any[] | null = Array.isArray(result) ? result : findFirstArrayInResponse(result);
  if (!Array.isArray(jobs)) jobs = [];
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`✅ Extracted ${jobs.length} job(s) in ${elapsed}s.`);

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
    // LLMs occasionally emit numeric fields as strings ("postIndex": "2").
    // Coerce first, then validate — Number.isFinite() refuses strings,
    // which would silently force every job back to jds[0].
    const idxRaw = Number(job?.postIndex);
    const idx = Number.isFinite(idxRaw) && idxRaw >= 1 ? Math.max(1, Math.min(jds.length, Math.floor(idxRaw))) : 1;
    const sourceText = jds[idx - 1] || '';

    // Branch on the contact channel the JD provided:
    //   email present  → draft into Gmail (status='applied'), mirroring the
    //                    NAS flow so the dashboard shows it under "Mail
    //                    Drafted Today" with the email body inline.
    //   only link      → manual-apply row (status='to_apply') with the link
    //                    on the "Apply on Portal" button.
    //   neither        → manual-triage row (status='to_apply') so the user
    //                    can still see the JD and decide what to do.
    if (j.email && gmail) {
      console.log(`   📧 ${j.company} — ${j.role} → drafting email to ${j.email}`);
      try {
        const { subject, body } = await generateEmailContent(sourceText || j.description, j.company, j.role);
        await createDraft(gmail, j.email, subject, body);
        console.log(`      ✅ Draft created: "${subject}"`);
        const ok = await postToDashboard({
          company: j.company,
          role: j.role,
          email: j.email,
          link: j.link || '',
          description: `<b>SUBJECT: ${subject}</b><br><br>${body}`,
          jobDescription: sourceText || j.description,
          status: 'applied',
          type: 'web',
          channel: 'Manual JD Paste',
        });
        if (ok) { saved++; drafted++; }
        else console.warn(`      ⚠️  Draft created but dashboard ingest failed.`);
      } catch (e: any) {
        console.warn(`      ⚠️  Draft failed (${e.message}) — falling back to manual-apply row.`);
        const ok = await postToDashboard({
          company: j.company,
          role: j.role,
          email: j.email,
          link: j.link || '',
          description: j.description?.slice(0, 600) || sourceText.slice(0, 600),
          jobDescription: sourceText,
          status: 'to_apply',
          type: 'manual',
          channel: 'Manual JD Paste',
        });
        if (ok) saved++;
      }
    } else {
      const linkLabel = j.link ? `🔗 ${j.link}` : (j.email ? `📧 ${j.email} (no Gmail auth — saved as manual)` : '⚠️ no link / no email');
      console.log(`   📌 ${j.company} — ${j.role} (${linkLabel})`);
      const ok = await postToDashboard({
        company: j.company,
        role: j.role,
        email: j.email || '',
        link: j.link || '',
        description: j.description?.slice(0, 600) || sourceText.slice(0, 600),
        jobDescription: sourceText,
        status: 'to_apply',
        type: 'manual',
        channel: 'Manual JD Paste',
      });
      if (ok) saved++;
      else console.warn(`      ⚠️  Failed to ingest into dashboard.`);
    }
  }

  console.log(`\n🎯 Done. Saved ${saved}/${jobs.length} job(s) to dashboard (${drafted} email draft${drafted === 1 ? '' : 's'} created).`);
  // Best-effort cleanup of the temp input file.
  try { fs.unlinkSync(argPath); } catch {}
}

main().catch((e) => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(3);
});
