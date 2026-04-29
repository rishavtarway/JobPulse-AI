import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import nodemailer from 'nodemailer';
import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

const STATE_FILE = path.join(process.cwd(), 'auto_apply_state.json');
const APPLICATIONS_FILE = path.join(process.cwd(), 'applications.json');
const TRACKER_FILE = path.join(process.cwd(), 'applications.md');
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const MASTER_LOG_FILE = path.join(process.cwd(), 'discovery_history.log');
const SERVER_PORT = process.env.SERVER_PORT || '3000';
const BROWSER_MODE = process.env.BROWSER_MODE === '1';

// TARGET: Only TechUprise Premium Insider
const TARGET_CHANNELS = [
  { id: "-1003338916645", name: "TechUprise Premium" }
];

let globalClient: TelegramClient | null = null;

// ============================================================================
// 1. HELPERS
// ============================================================================

function isAlreadyApplied(msgId: string, channelName: string): boolean {
  if (!fs.existsSync(APPLICATIONS_FILE)) return false;
  const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
  return apps.some((app: any) => app.telegramId === msgId && app.channel === channelName);
}

const ATTACHMENTS = [
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

const SIGNATURE_HTML = `
<br>
Best, Rishav Tarway<br>
Mobile: +91 7004544142<br>
<a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

// ============================================================================
// 2. GMAIL API AUTHENTICATION & HELPERS
// ============================================================================
async function authorizeGmail() {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');

  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error("Missing credential.json");
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  } else {
    throw new Error("Missing token.json. Please ensure you are authenticated.");
  }
  return oAuth2Client;
}

function getLastSyncDate(channelName: string): number {
  const defaultDate = Date.now() - (7 * 24 * 60 * 60 * 1000); // Default to last 7 days at most
  try {
    if (!fs.existsSync(APPLICATIONS_FILE)) return defaultDate;
    const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
    let latest = 0;
    for (const app of apps) {
      if (app.channel === channelName && app.appliedDate) {
        const time = new Date(app.appliedDate).getTime();
        if (time > latest) latest = time;
      }
    }
    return latest > 0 ? latest : defaultDate;
  } catch (e) {
    return defaultDate;
  }
}

async function extractJobs(client: TelegramClient) {
  await client.connect();

  let allParsedJobs: any[] = [];
  let allManualJobs: any[] = [];

  for (const targetChannel of TARGET_CHANNELS) {
    console.log(`\n📡 Scanning Channel: ${targetChannel.name}...`);
    const MIN_POSTED_DATE = getLastSyncDate(targetChannel.name);
    console.log(`   ⏱️ Resuming sync from: ${new Date(MIN_POSTED_DATE).toLocaleString()}`);
    
    const chatInfo = await client.getChatInfo(targetChannel.id);
    console.log(`📡 Chat: ${chatInfo.title} (ID: ${chatInfo.id})`);

    let newMessages: any[] = [];
    let lastFetchedId = 0;
    let keepFetching = true;
    let batchCounter = 0;
    const seenIds = new Set<number>();

    try {
      while (keepFetching && batchCounter < 100) {
        const batch = await client.getMessages(targetChannel.id, 50, lastFetchedId);
        if (!batch || batch.length === 0) break;

        for (const m of batch) {
          if (!seenIds.has(m.id)) {
            newMessages.push(m);
            seenIds.add(m.id);
          }
        }
        const oldestInBatch = batch[batch.length - 1];
        const oldestDate = oldestInBatch.date * 1000;
        if (oldestDate < MIN_POSTED_DATE) {
          keepFetching = false;
        }
        lastFetchedId = oldestInBatch.id;
        batchCounter++;
        process.stdout.write(`   Scanning batch... (Found: ${newMessages.length})\r`);
      }
    } catch (e: any) {
      console.log(`\n⚠️ Error fetching: ${e.message}`);
    }

    if (newMessages.length > 0) {
      console.log(`\n   🔍 Analyzing ${newMessages.length} messages...`);
      for (const m of newMessages) {
        const text = m.text || m.mediaCaption || "";
        if (!text.trim()) continue;
        
        const messageDate = m.date * 1000;
        if (messageDate <= MIN_POSTED_DATE) continue;
        
        if (isAlreadyApplied(m.id.toString(), targetChannel.name)) {
          continue;
        }

        const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i);
        const linkMatch = text.match(/(https?:\/\/[^\s]+|[a-z0-9]+\.[a-z0-9]+\/[^\s]+|careers\.[a-z0-9]+\.[a-z]+|jobs\.[a-z0-9]+\.[a-z]+)/i);

        const isJob = await isRealJobPosting(text);
        if (!isJob) continue;
        
        console.log(`   ✅ Job confirmed ID: ${m.id}`);
        const company = await extractCompanyName(text, emailMatch ? emailMatch[1] : undefined);
        const postedISO = new Date(messageDate).toISOString();

        if (emailMatch) {
          allParsedJobs.push({ id: m.id.toString(), channel: targetChannel.name, date: postedISO, text: text, email: emailMatch[1], company: company, link: linkMatch ? linkMatch[1] : null });
        } else if (linkMatch) {
          allManualJobs.push({ id: m.id.toString(), channel: targetChannel.name, date: postedISO, text: text, link: linkMatch[1], company: company });
        }
      }
    }
  }

  // Update dashboard for manual links
  if (allManualJobs.length > 0) {
    for (const job of allManualJobs) {
      try {
        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company: job.company || "Link App", role: "Software Engineer", channel: job.channel, telegramId: job.id, link: job.link, description: job.text, status: 'to_apply', type: 'telegram', appliedDate: job.date
          })
        });
      } catch (e) {}
    }
  }

  return allParsedJobs;
}

async function isRealJobPosting(text: string): Promise<boolean> {
  const reply = await callAI(`Is this a job/internship career opening? Reply ONLY YES or NO.\nText: "${text.substring(0, 300)}"`);
  return reply?.toUpperCase().includes("YES") || false;
}

async function extractCompanyName(text: string, email?: string): Promise<string> {
  const genericDomains = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com'];
  if (email) {
    const domain = email.split('@')[1];
    if (!genericDomains.includes(domain)) {
      const parts = domain.split('.');
      return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
    }
  }
  const reply = await callAI(`Extract only the company name from this job post. If not found, return 'Unknown'.\nText: "${text.substring(0, 300)}"`);
  return reply?.replace(/['"]/g, '').trim() || "Unknown";
}

async function callAI(prompt: string, jsonFlag = false): Promise<any> {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  try {
    const response = await fetch(`https://openrouter.ai/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'google/gemini-2.0-flash-lite-001', messages: [{ role: "user", content: prompt }] })
    });
    const data: any = await response.json();
    const content = data.choices[0].message.content;
    if (jsonFlag) {
      try { return JSON.parse(content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { return null; }
    }
    return content;
  } catch (e) {
    return null;
  }
}

async function generateEmailContent(jobText: string, company: string): Promise<{ subject: string, body: string }> {
  const prompt = `Write an ultra-tailored, professional 2-paragraph intro for a job application.
  
  JOB DESCRIPTION: "${jobText.substring(0, 800)}"
  COMPANY: ${company}

  USER CONTEXT (Rishav Tarway):
  - 19 months experience across 5 internships (including MOSIP, Classplus).
  - Tech Skills: Node.js, React, Android, Python, System Optimization, AI/ML.

  STRICT RULES:
  1. NO EMOJIS.
  2. SHORT SUBJECT: Concise (6-8 words). Use varied brackets ([], {}, (), :).
  3. EXACTLY 2 PARAGRAPHS FOR AI TO GENERATE (I will add a 3rd myself):
     - Para 1: Explicitly align the company's mission/goals from the JD with my specific tech skills.
     - Para 2: Summarize my experience across all 5 internships and showcase how those core tech skills drove impact.
  4. KEEP IT BRIEF: Maximum 2 sentences per paragraph.

  RESPOND WITH RAW JSON ONLY (No Markdown):
  { "subject": "...", "para1": "...", "para2": "..." }`;

  const result = await callAI(prompt, true);
  
  const p1 = result?.para1 || `I am reaching out regarding the open role at ${company}. My robust foundation in system optimization and backend telemetry strongly aligns with your mission and technical requirements.`;
  const p2 = result?.para2 || `Over the past 19 months across 5 intensive internships (including MOSIP and Classplus), I have extensively utilized Node.js, React, and Android development to scale dynamic applications and drastically reduce system latency.`;
  const subject = result?.subject || `[Application] Software Engineer : ${company}`;

  // HARDCODED PARA 3 for 100% Link Accuracy
  const p3 = `My Open Source Recent PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and detailed projects: <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (60fps Crypto Tracker — React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (AI Resume Builder — GPT-4/FastAPI).`;

  const body = `<p>Hi ${company} Hiring Team,</p><p>${p1}</p><p>${p2}</p><p>${p3}</p><p>Best,</p>`;

  return { subject, body };
}

async function createDraft(gmail: any, toEmail: string, subject: string, htmlBody: string) {
  const mailOptions = { to: toEmail, subject: subject, html: htmlBody + SIGNATURE_HTML, attachments: ATTACHMENTS };
  const transporter = nodemailer.createTransport({ streamTransport: true });
  const message = await new Promise<Buffer>((resolve, reject) => {
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) return reject(err);
      const chunks: any[] = [];
      (info.message as any).on('data', (chunk: any) => chunks.push(chunk));
      (info.message as any).on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encoded } } });
}

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.indexOf('--limit');
  const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : Infinity;

  const config = Config.getInstance();
  globalClient = new TelegramClient(config.telegram);
  try {
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });
    const jobs = await extractJobs(globalClient);
    
    // APPLY LIMIT
    const jobsToProcess = jobs.slice(0, Math.min(jobs.length, limit));

    if (jobsToProcess.length > 0) {
      console.log(`\n🚀 [PHASE 2] Drafting ${jobsToProcess.length} emails...`);
      
      let currentSchedule = new Date('2026-04-08T09:37:00+05:30');
      
      for (let i = 0; i < jobsToProcess.length; i++) {
        const job = jobsToProcess[i];
        const draftNum = i + 1;
        
        if (i > 0) {
          if (i % 5 === 0) {
            currentSchedule.setMinutes(currentSchedule.getMinutes() + 2);
          } else {
            currentSchedule.setMinutes(currentSchedule.getMinutes() + 1);
          }
        }

        const scheduleStr = currentSchedule.toLocaleTimeString('en-IN', { 
          hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' 
        });

        console.log(`\n[${draftNum}/${jobsToProcess.length}] Processing ${job.company}...`);
        console.log(`   ⏰ Internal Schedule Offset: ${scheduleStr}`);
        
        const { subject, body } = await generateEmailContent(job.text, job.company);
        
        // Log for verification
        console.log(`   📧 Subject: ${subject}`);
        console.log(`   📝 Body: ${body}`);

        await createDraft(gmail, job.email, subject, body);
        console.log(`   ✅ Draft created.`);
        
        try {
          await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              company: job.company, role: "Software Engineer", channel: job.channel, telegramId: job.id, email: job.email, status: 'applied', type: 'telegram', appliedDate: job.date, description: `<b>SUBJECT: ${subject}</b><br><br>${body}`
            })
          });
        } catch (e) {}
        
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.log("\n🎉 ALL DONE!");
    await globalClient.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ ERROR:', error);
    if (globalClient) await globalClient.disconnect();
    process.exit(1);
  }
}

main();
