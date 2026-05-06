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
import dotenv from 'dotenv';

dotenv.config();

const SERVER_PORT = process.env.SERVER_PORT || '3000';
const DASHBOARD_INGEST = `http://localhost:${SERVER_PORT}/api/applications`;

interface ExtractedJob {
  company: string;
  role: string;
  email: string | null;
  link: string | null;
  description: string;
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

async function postToDashboard(j: ExtractedJob, sourceText: string): Promise<boolean> {
  try {
    const r = await fetch(DASHBOARD_INGEST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: j.company,
        role: j.role,
        email: j.email || '',
        link: j.link || '',
        description: j.description?.slice(0, 600) || sourceText.slice(0, 600),
        jobDescription: sourceText,    // full original body for the modal
        postUrl: '',                   // no source URL for manually-pasted JDs
        status: 'to_apply',            // canonical status used by the
                                       // Direct Portals tab filter in
                                       // server.ts (status === 'to_apply'
                                       // || 'manual_review').
        type: 'manual',
        channel: 'Manual JD Paste',
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
  for (const job of jobs) {
    const j: ExtractedJob = {
      company: String(job?.company || 'Hiring Team').trim() || 'Hiring Team',
      role: String(job?.role || '').trim() || 'Software Engineer',
      email: job?.email ? String(job.email).trim() : null,
      link: job?.link ? String(job.link).trim() : null,
      description: String(job?.description || '').trim(),
    };
    const idx = Number.isFinite(job?.postIndex) ? Math.max(1, Math.min(jds.length, Number(job.postIndex))) : 1;
    const sourceText = jds[idx - 1] || '';
    const linkLabel = j.link ? `🔗 ${j.link}` : (j.email ? `📧 ${j.email}` : '⚠️ no link / no email');
    console.log(`   📌 ${j.company} — ${j.role} (${linkLabel})`);
    const ok = await postToDashboard(j, sourceText);
    if (ok) saved++;
    else console.warn(`      ⚠️  Failed to ingest into dashboard.`);
  }

  console.log(`\n🎯 Done. Saved ${saved}/${jobs.length} job(s) to dashboard.`);
  // Best-effort cleanup of the temp input file.
  try { fs.unlinkSync(argPath); } catch {}
}

main().catch((e) => {
  console.error('❌ Fatal:', e?.message || e);
  process.exit(3);
});
