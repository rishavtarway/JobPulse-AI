/**
 * Automated nas.com community scraper for the
 * "TechUprise Insider Club" community.
 *
 * Replaces the manual / guided fetch_nas_jobs.ts flow.
 *
 * Strategy:
 *   1. Launch Puppeteer with the persistent profile under ./nas_chrome_profile
 *      so the user only logs in once (cookies persist across runs).
 *   2. Navigate to https://nas.com/techuprise-insider-club/community.
 *   3. If not logged in, leave the headed browser open and poll until the
 *      community feed becomes visible (user signs in once).
 *   4. Auto-scroll the feed until no new posts load, collecting unique post URLs.
 *   5. For every post URL not already in nas_seen_posts.json:
 *         - open it, scroll inside until the body is fully loaded
 *         - send the entire post text to the LLM with a multi-job aware prompt
 *         - dedupe each extracted job (post URL + job id) against
 *           applications.json (telegramId field is reused as a generic
 *           dedupe key, same as fetch_nas_jobs.ts)
 *         - if the job has an email -> draft a Gmail email with
 *           the standard signature + attachments
 *         - if the job has only a link -> push a `to_apply` card to the
 *           dashboard so the chrome-extension resume tailor can finish the job
 *   6. Mark the post URL as seen even when no jobs were extracted, so we
 *      never re-process the same post.
 *
 * Run from the dashboard via /api/trigger-nas, or directly with:
 *   npx tsx fetch_nas_community.ts            # process all unseen posts
 *   npx tsx fetch_nas_community.ts --limit 5  # cap newest unseen posts to 5
 *   npx tsx fetch_nas_community.ts --headless # run without showing the window
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
      options.loginTimeoutMs = Number(args[++i]) * 1000;
    }
  }
  return options;
}

// ============================================================================
// FILE-BACKED DEDUP HELPERS
// ============================================================================

function readApplications(): any[] {
  if (!fs.existsSync(APPLICATIONS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function isAlreadyApplied(dedupeId: string): boolean {
  return readApplications().some(
    (app: any) => app.telegramId === dedupeId && app.channel === CHANNEL_LABEL,
  );
}

function readSeenPosts(): Record<string, { firstSeen: string; jobCount: number }> {
  if (!fs.existsSync(SEEN_POSTS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SEEN_POSTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function markPostSeen(postUrl: string, jobCount: number) {
  const seen = readSeenPosts();
  seen[postUrl] = {
    firstSeen: seen[postUrl]?.firstSeen || new Date().toISOString(),
    jobCount: (seen[postUrl]?.jobCount || 0) + jobCount,
  };
  fs.writeFileSync(SEEN_POSTS_FILE, JSON.stringify(seen, null, 2));
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
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-lite-001',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data: any = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    if (jsonFlag) {
      // Be forgiving — accept either an object or a JSON array.
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
  text: string;
  company?: string;
  role?: string;
  email?: string;
  link?: string;
  id?: string;
}

async function extractJobsFromPost(postText: string): Promise<ExtractedJob[]> {
  const prompt = `You are extracting job postings from one community post.
The post may contain MULTIPLE jobs/internships, possibly from different companies.

Return a JSON ARRAY of job objects. Each object MUST have:
- "text": the complete original text segment for that single job (multi-line ok)
- "company": company name (best guess)
- "role": role/title (e.g. "SDE Intern", "Backend Engineer"). Empty string if unclear.
- "email": HR/application email if explicitly present, else "".
- "link": application link/URL if explicitly present, else "".
- "id": short unique identifier within this post (slug of company+role).

STRICT RULES:
- Only include jobs that have at least one of: email or link.
- Do NOT invent contact info that isn't in the text.
- Skip non-job content (general announcements, memes, comments).
- Output ONLY the raw JSON array — no markdown fences, no commentary.

POST TEXT:
${postText.substring(0, 14000)}`;

  const result = await callAI(prompt, true);
  if (!Array.isArray(result)) return [];
  return result.filter((j) => j && typeof j === 'object' && (j.email || j.link));
}

async function generateEmailContent(
  jobText: string,
  company: string,
): Promise<{ subject: string; body: string }> {
  const prompt = `Write an ultra-tailored, professional 2-paragraph intro for a job application.

JOB DESCRIPTION: "${jobText.substring(0, 800)}"
COMPANY: ${company}

USER CONTEXT (Rishav Tarway):
- 19 months experience across 5 internships (including MOSIP, Classplus).
- Tech Skills: Node.js, React, Android, Python, System Optimization, AI/ML.

STRICT RULES:
1. NO EMOJIS.
2. SHORT SUBJECT: Concise (6-8 words). Use varied brackets ([], {}, (), :).
3. EXACTLY 2 PARAGRAPHS FOR AI TO GENERATE (a 3rd will be appended later):
   - Para 1: Explicitly align the company's mission/goals with my specific tech skills.
   - Para 2: Summarize my experience across all 5 internships and showcase how those core tech skills drove impact.
4. KEEP IT BRIEF: Maximum 2 sentences per paragraph.

RESPOND WITH RAW JSON ONLY (No Markdown):
{ "subject": "...", "para1": "...", "para2": "..." }`;

  const result = await callAI(prompt, true);
  const safeCompany = company || 'Hiring Team';
  const p1 =
    result?.para1 ||
    `I am reaching out regarding the open role at ${safeCompany}. My robust foundation in system optimization and backend telemetry strongly aligns with your mission and technical requirements.`;
  const p2 =
    result?.para2 ||
    `Over the past 19 months across 5 intensive internships (including MOSIP and Classplus), I have extensively utilized Node.js, React, and Android development to scale dynamic applications and drastically reduce system latency.`;
  const subject = result?.subject || `[Application] Software Engineer : ${safeCompany}`;

  const p3 = `My Open Source Recent PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and detailed projects: <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (60fps Crypto Tracker — React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (AI Resume Builder — GPT-4/FastAPI).`;

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
    } catch {
      /* ignore */
    }
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

/**
 * Wait until the user is logged in by polling the page state.
 * We consider the user logged in if a community feed link or post is visible
 * AND there's no visible login/sign-up CTA.
 */
async function waitForLogin(page: Page, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const hasLoginCta =
        /\b(log\s*in|sign\s*in|sign\s*up|continue with google)\b/.test(text) &&
        document.querySelectorAll('input[type="password"], input[type="email"]').length > 0;
      const hasFeed =
        document.querySelectorAll('a[href*="/community/"], a[href*="/post/"], article').length > 3;
      return { hasLoginCta, hasFeed, url: location.href };
    });
    if (state.hasFeed && !state.hasLoginCta) return true;
    if (state.hasLoginCta) {
      console.log('   🔐 Not logged in. Please sign in to nas.com in the open browser window…');
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

async function autoScrollFeed(page: Page, maxIterations = 25): Promise<void> {
  let lastHeight = 0;
  let stableTicks = 0;
  for (let i = 0; i < maxIterations; i++) {
    const newHeight = await page.evaluate(() => {
      // Scroll the main window AND any tall scrollable containers.
      const containers = Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
        (el) => el.scrollHeight > el.clientHeight && el.clientHeight > 200,
      );
      window.scrollBy(0, window.innerHeight * 0.9);
      containers.forEach((c) => c.scrollBy(0, c.clientHeight * 0.9));
      return Math.max(
        document.body.scrollHeight,
        ...containers.map((c) => c.scrollHeight),
      );
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

async function collectPostUrls(page: Page): Promise<string[]> {
  const urls: string[] = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const candidates = all
      .map((a) => a.href)
      .filter((href) => {
        try {
          const u = new URL(href);
          if (!u.hostname.endsWith('nas.com') && !u.hostname.endsWith('nas.io')) return false;
          // Heuristic: post URLs live UNDER the community URL with at least one
          // additional path segment (post id / slug).
          const p = u.pathname.replace(/\/$/, '');
          if (!p.includes('/community')) return false;
          const segs = p.split('/').filter(Boolean);
          const idx = segs.indexOf('community');
          if (idx === -1) return false;
          // Must have at least one segment after "community"
          return segs.length - idx >= 2;
        } catch {
          return false;
        }
      });
    return Array.from(new Set(candidates));
  });
  return urls;
}

async function scrollPostBody(page: Page, ticks = 8): Promise<void> {
  await page.evaluate(async (n) => {
    await new Promise<void>((resolve) => {
      let scrolls = 0;
      const containers = Array.from(document.querySelectorAll<HTMLElement>('div')).filter(
        (el) => el.scrollHeight > el.clientHeight && el.clientHeight > 200,
      );
      const timer = setInterval(() => {
        window.scrollBy(0, 600);
        containers.forEach((c) => c.scrollBy(0, 600));
        scrolls++;
        if (scrolls >= n) {
          clearInterval(timer);
          resolve();
        }
      }, 400);
    });
  }, ticks);
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
  console.log('🚀 NAS Community Auto-Scraper');
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
      console.error('❌ Login timed out. Aborting. Sign in once in the open browser, then re-run.');
      return;
    }
    console.log('✅ Logged in.');

    console.log('📜 Auto-scrolling feed to load posts…');
    await autoScrollFeed(page);

    const postUrls = await collectPostUrls(page);
    console.log(`📝 Discovered ${postUrls.length} post URLs.`);

    const seen = readSeenPosts();
    const unseen = postUrls.filter((u) => !seen[u]);
    console.log(`🆕 ${unseen.length} unseen post(s).`);

    const targets = opts.limit > 0 ? unseen.slice(0, opts.limit) : unseen;

    for (let i = 0; i < targets.length; i++) {
      const url = targets[i];
      console.log(`\n[${i + 1}/${targets.length}] 🔍 ${url}`);
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
      } catch (e) {
        console.warn(`   ⚠️  Failed to open post: ${(e as Error).message}`);
        markPostSeen(url, 0);
        continue;
      }

      await scrollPostBody(page);
      const postText: string = await page.evaluate(() => document.body.innerText);
      console.log(`   📄 Post text length: ${postText.length}`);

      const jobs = await extractJobsFromPost(postText);
      console.log(`   🌟 AI extracted ${jobs.length} job(s).`);

      const urlPath = (() => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })();

      let newJobsThisPost = 0;
      for (const job of jobs) {
        const dedupeId = `${urlPath}-${job.id || job.company || job.role || ''}`
          .replace(/[^a-zA-Z0-9-]/g, '')
          .slice(0, 120);
        if (!dedupeId) continue;
        if (isAlreadyApplied(dedupeId)) {
          console.log(`   ⏭️  Already tracked: ${job.company || job.role || dedupeId}`);
          continue;
        }

        const company = (job.company || 'Unknown').trim();
        const role = (job.role || 'Software Engineer').trim();

        if (job.email && gmail) {
          console.log(`   📧 Drafting email for ${company} → ${job.email}`);
          const { subject, body } = await generateEmailContent(job.text || '', company);
          try {
            await createDraft(gmail, job.email, subject, body);
            console.log(`      ✅ Draft created: "${subject}"`);
          } catch (e) {
            console.warn(`      ⚠️  Draft failed: ${(e as Error).message}`);
          }
          await pushToDashboard({
            company,
            role,
            channel: CHANNEL_LABEL,
            telegramId: dedupeId,
            email: job.email,
            link: job.link || url,
            status: 'applied',
            type: 'web',
            appliedDate: new Date().toISOString(),
            postedDate: new Date().toISOString(),
            description: `<b>SUBJECT: ${subject}</b><br><br>${body}`,
            jobDescription: job.text || '',
          });
        } else if (job.link) {
          console.log(`   📎 Saving manual-apply for ${company} → ${job.link}`);
          await pushToDashboard({
            company,
            role,
            channel: CHANNEL_LABEL,
            telegramId: dedupeId,
            link: job.link,
            status: 'to_apply',
            type: 'web',
            appliedDate: new Date().toISOString(),
            postedDate: new Date().toISOString(),
            description: job.text || '',
            jobDescription: job.text || '',
          });
        } else {
          // Should not happen because extractJobsFromPost filters these out.
          continue;
        }
        newJobsThisPost++;
        totalNewJobs++;
      }

      markPostSeen(url, newJobsThisPost);
    }

    console.log(`\n🎯 Done. Added ${totalNewJobs} new job(s) across ${targets.length} post(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
