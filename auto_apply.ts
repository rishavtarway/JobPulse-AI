import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Detect if we are running inside the web server (BROWSER_MODE)
const BROWSER_MODE = process.env.BROWSER_MODE === '1';
const SERVER_PORT = process.env.SERVER_PORT || '3000';

// When in BROWSER_MODE, request OTP from the web server instead of stdin
async function requestOtpFromServer(): Promise<string> {
  console.log('⚠️  Requesting OTP from web dashboard...');
  try {
    const resp = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/internal/request-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      // Long timeout to wait for user input
      signal: AbortSignal.timeout(130_000)
    });
    const data = await resp.json() as { code: string };
    console.log('✅ OTP received from dashboard.');
    return data.code || '';
  } catch (e: any) {
    console.error('❌ Failed to get OTP from server:', e.message);
    return '';
  }
}

async function requestPasswordFromServer(): Promise<string> {
  console.log('🔐 Requesting 2FA password from web dashboard...');
  try {
    const resp = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/internal/request-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(130_000)
    });
    const data = await resp.json() as { password: string };
    console.log('✅ Password received from dashboard.');
    return data.password || '';
  } catch (e: any) {
    console.error('❌ Failed to get password from server:', e.message);
    return '';
  }
}

// ============================================================================
// 1. ENVIRONMENT AND CONFIGURATION SETUP
// ============================================================================
const loadEnv = () => {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envFile = fs.readFileSync(envPath, 'utf-8');
      envFile.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
        }
      });
      console.log("✅ Environment loaded manually.");
    }
  } catch (error) {
    console.error("⚠️ Error reading .env:", error);
  }
};

loadEnv();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("❌ Missing OPENROUTER_API_KEY in .env. Cannot generate emails.");
  process.exit(1);
}

const STATE_FILE = 'auto_apply_state.json';
const NEW_JOBS_FILE = 'latest_jobs_to_apply.json';
const MASTER_LOG_FILE = 'all_extracted_jobs_log.txt';

const TARGET_CHANNELS = [
  { id: "-1003338916645", name: "TechUprise Premium" },
  { id: "-1001511880571", name: "Kushal Vijay Discussion" },
  { id: "-1001419646388", name: "Arsh Goyal" },
  { id: "-1002072564530", name: "BNY/Code Divas Exam" },
  { id: "-1001603220106", name: "Fresher Offcampus Drives" },
  { id: "-1002146855759", name: "Cognizant Discussion" },
  { id: "-1001379678738", name: "Kushal Vijay YouTube" },
  { id: "-1001515619731", name: "Krishan Kumar Jobs" },
  { id: "-1002117864663", name: "The Latest Jobs 2026" },
  { id: "-1002322597297", name: "Talentd Job Notifications" },
  { id: "-1001918258764", name: "TechUprise Exclusive" },
  { id: "-1001204676886", name: "OffCampus Internship" },
  { id: "-1001409153549", name: "Daily Jobs Updates" }
];

// Attachments required for every email
const ATTACHMENTS = [
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

const SIGNATURE_HTML = `
<br><br>
Yours sincerely<br><br>
Rishav Tarway<br>
<a href="https://drive.google.com/file/d/18y1yNOP-C7Mw8_Japfeb9ihsfNk6YiwH/view?usp=sharing">Resume</a> |
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> |
<a href="https://github.com/rishavtarway">GitHub</a> |
<a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> |
<a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source</a> |
<a href="https://codeforces.com/profile/NeonMagic">Codeforces</a>
`;

// ============================================================================
// 2. GMAIL API AUTHENTICATION
// ============================================================================
async function authorizeGmail() {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');

  if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
    throw new Error("Missing credential.json or token.json. Please run Gmail auth script first.");
  }

  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const credentials = JSON.parse(content);
  const clientSecret = credentials.installed?.client_secret || credentials.web?.client_secret;
  const clientId = credentials.installed?.client_id || credentials.web?.client_id;
  const redirectUris = credentials.installed?.redirect_uris || credentials.web?.redirect_uris || ['http://localhost'];

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUris[0]);
  const token = fs.readFileSync(TOKEN_PATH, 'utf8');
  oAuth2Client.setCredentials(JSON.parse(token));
  return oAuth2Client;
}

// ============================================================================
// 3. TELEGRAM EXTRACTION LOGIC
// ============================================================================
// ============================================================================
// AI JOB FILTERING LOGIC
// ============================================================================
async function isRealJobPosting(text: string): Promise<boolean> {
  // Fast heuristic - if it has an email, it's likely a job or contact info
  if (text.includes('@') && (text.toLowerCase().includes('hiring') || text.toLowerCase().includes('job') || text.toLowerCase().includes('internship'))) return true;

  // Otherwise, ask AI to filter out clutter
  const prompt = `Task: Is this a job posting or application link?
Message: "${text.substring(0, 1000)}"
Reply ONLY with "YES" if it's a job/internship posting or application form link. 
Reply ONLY with "NO" if it's general chat, career guidance, spam, or a generic question.`;

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const fallbackModels = ["google/gemini-2.0-flash:free", "mistralai/mistral-7b-instruct:free"];

  for (const model of fallbackModels) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-OpenRouter-Title": "Auto Apply Filter"
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const reply = data.choices[0].message.content.trim().toUpperCase();
        return reply.includes("YES");
      }
    } catch (e) {
      continue;
    }
  }
  return false; // Default to false if AI fails
}

async function extractCompanyName(text: string, email?: string): Promise<string> {
  const genericDomains = ['gmail.com', 'outlook.com', 'yahoo.com', 'hotmail.com', 'icloud.com', 'protonmail.com', 'me.com'];

  if (email) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain && !genericDomains.includes(domain)) {
      const name = domain.split('.')[0];
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  }

  // Ask AI to find company name in text
  const prompt = `Extract the official company name from this job posting.
Message: "${text.substring(0, 1000)}"
Reply ONLY with the company name. If no specific company name is found, reply ONLY with "Hiring Team".`;

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  const models = ["google/gemini-2.0-flash:free", "mistralai/mistral-7b-instruct:free"];

  for (const model of models) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }]
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        const name = data.choices[0].message.content.trim();
        if (name && name.length < 50) return name;
      }
    } catch (e) { }
  }
  return "Hiring Team";
}

const APPS_FILE = 'applications.json';

function isAlreadyApplied(telegramId: string, channel: string): boolean {
  try {
    if (fs.existsSync(APPS_FILE)) {
      const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
      return apps.some((app: any) => app.telegramId === telegramId && app.channel === channel);
    }
  } catch (e) {
    console.error("Error checking applications.json:", e);
  }
  return false;
}

async function extractNewJobs() {
  let state: any = { channelLastIds: {} };
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.channelLastIds) state.channelLastIds = {};
  }

  console.log(`\n🚀 [PHASE 1] Extracting new jobs from ${TARGET_CHANNELS.length} channels...`);

  // Dynamic Imports for Telegram
  const { TelegramClient } = await import('./src/telegram/client.js');
  const { Config } = await import('./src/config/index.js');

  const config = Config.getInstance();
  const client = new TelegramClient(config.telegram);

  await client.connect(BROWSER_MODE ? {
    getAuthCode: requestOtpFromServer,
    getPassword: requestPasswordFromServer,
  } : undefined);

  let allParsedJobs: any[] = [];
  let allManualJobs: any[] = [];
  let masterLogAppends = `\n\n--- MULTI-CHANNEL AUTO EXTRACT: ${new Date().toISOString()} ---\n\n`;

  for (const targetChannel of TARGET_CHANNELS) {
    console.log(`\n📡 Scanning Channel: ${targetChannel.name} (${targetChannel.id})...`);

    // fallback ID 2600000000 is roughly from last few days
    let lastProcessedId = state.channelLastIds[targetChannel.id] || 2600000000;

    // Force TDLib to sync the chat
    try {
      // @ts-ignore
      await client.client.invoke({ _: 'openChat', chat_id: parseInt(targetChannel.id) });
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) { }

    let newMessages: any[] = [];
    let lastFetchedId = 0;
    let keepFetching = true;
    let batchCounter = 0;
    const seenIds = new Set<number>();

    while (keepFetching && batchCounter < 10) {
      const batch = await client.getMessages(targetChannel.id, 50, lastFetchedId);
      if (!batch || batch.length === 0) break;

      for (const m of batch) {
        if (m.id > lastProcessedId && !seenIds.has(m.id)) {
          // CHECK IF ALREADY IN TRACKER
          if (isAlreadyApplied(m.id.toString(), targetChannel.name)) {
            // If already applied, we still update the seen IDs but skip adding to work list
            seenIds.add(m.id);
            continue;
          }
          newMessages.push(m);
          seenIds.add(m.id);
        }
      }

      const oldestInBatch = batch[batch.length - 1];
      if (lastFetchedId === oldestInBatch.id || oldestInBatch.id <= lastProcessedId) {
        keepFetching = false;
      }
      lastFetchedId = oldestInBatch.id;
      batchCounter++;
      process.stdout.write(`   Scanning batch... (Oldest: ${oldestInBatch.id})\r`);
    }

    if (newMessages.length === 0) {
      console.log(`   ✅ No new messages in ${targetChannel.name}.`);
      continue;
    }

    console.log(`\n   🔍 Analyzing ${newMessages.length} messages in ${targetChannel.name} with AI...`);

    for (const m of newMessages) {
      const text = m.text || m.mediaCaption || "";
      if (!text.trim()) continue;

      // 1. Log every message for record
      masterLogAppends += `[ID:${m.id}] [Chan:${targetChannel.name}] [Date:${new Date(m.date * 1000).toISOString()}] ${text.replace(/\n/g, ' ')}\n\n`;

      // 2. Multi-level filtering
      const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i);
      const linkMatch = text.match(/(https?:\/\/[^\s]+)/i);

      if (emailMatch || linkMatch) {
        const isJob = await isRealJobPosting(text);
        if (!isJob) continue;

        const company = await extractCompanyName(text, emailMatch ? emailMatch[1] : undefined);

        if (emailMatch) {
          allParsedJobs.push({
            id: m.id.toString(),
            channel: targetChannel.name,
            date: new Date(m.date * 1000).toISOString(),
            text: text,
            email: emailMatch[1],
            company: company,
            link: linkMatch ? linkMatch[1] : null // STORE LINK IF PRESENT
          });
        }

        // Always add to manual links if a link is present, even if email is there
        if (linkMatch) {
          allManualJobs.push({
            id: m.id.toString(),
            channel: targetChannel.name,
            date: new Date(m.date * 1000).toISOString(),
            text: text,
            link: linkMatch[1],
            company: company
          });
        }
      }
    }

    // Update state for this channel
    const highestId = Math.max(...newMessages.map(m => m.id));
    state.channelLastIds[targetChannel.id] = highestId;
  }

  // Update master files
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  fs.appendFileSync(MASTER_LOG_FILE, masterLogAppends);

  // Handle Manual Jobs Log
  if (allManualJobs.length > 0) {
    let mdContent = `\n\n## Multi-Channel Manual Applications (${new Date().toISOString()})\n\n`;
    allManualJobs.forEach(job => {
      mdContent += `### [${job.channel}] Job ID: ${job.id}\n`;
      mdContent += `**Apply Here:** [${job.link}](${job.link})\n\n`;
      mdContent += `**Description:**\n> ${job.text.replace(/\n/g, '\n> ')}\n\n`;
      mdContent += `---\n`;
    });
    fs.appendFileSync('MANUAL_APPLY_TASKS.md', mdContent);

    // Log to Tracker
    for (const job of allManualJobs) {
      try {
        const port = process.env.SERVER_PORT || '3000';
        const company = await extractCompanyName(job.text);

        await fetch(`http://127.0.0.1:${port}/api/applications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company: job.company || "Link Application",
            role: "Software Engineer",
            channel: job.channel,
            telegramId: job.id,
            link: job.link,
            description: job.text,
            status: 'to_apply'
          })
        });
      } catch (e) { }
    }
  }

  if (allParsedJobs.length === 0) {
    console.log("No new jobs with emails found. Exiting Phase 1.");
    return [];
  }

  console.log(`✅ Extracted ${allParsedJobs.length} NEW actionable job postings across all channels.`);
  fs.writeFileSync(NEW_JOBS_FILE, JSON.stringify(allParsedJobs, null, 2));
  return allParsedJobs;
}

// ============================================================================
// 4. OPENROUTER AI GENERATION LOGIC
// ============================================================================
function extractName(email: string, text: string): string {
  const reachOutMatch = text.match(/reach out (?:to|at) ([A-Z][a-z]+)/);
  if (reachOutMatch) return reachOutMatch[1];
  const emailNameMatch = email.match(/^([a-z]+)/i);
  if (emailNameMatch && !['hr', 'career', 'careers', 'job', 'jobs', 'info', 'hello', 'contact', 'admin', 'manager', 'projects', 'talent'].includes(emailNameMatch[1].toLowerCase())) {
    return emailNameMatch[1].charAt(0).toUpperCase() + emailNameMatch[1].slice(1);
  }
  return "Team";
}

async function generateEmailContent(jobText: string, company: string, contactName: string): Promise<{ subject: string, body: string }> {
  const isGenericCompany = company === "Hiring Team" || company === "your company";
  const greeting = contactName === "Team" ? `Hi ${company}` : `Hi ${contactName}`;

  const prompt = `
Generate a highly polished, eye-catching cold email application as valid JSON.
Job Description: "${jobText}"
Target Company: ${company}

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. The email must be extremely punchy, designed for a 5-10 second skim by a busy Founder or HR (especially targeting YC 2024/2025 startups). It must grab attention immediately and never fail to get a reply.
3. Tone: Confident, crisp, highly professional but modern (not generic or boring).
4. Include these exact bragging points naturally, without sounding boastful:
   - 2 years of Open Source contributions (including merged PRs in OpenPrinting).
   - 6 paid internships (3 onsite, 3 remote).
   - Backend optimization & architecture experience at Classplus scaling systems.
5. Offer proof of work casually but confidently: "I have 5 links already shared on my profile, but let me know what specific tech stack PRs/links you want to see, and I will share them."
6. If the company is unknown or generic, focus heavily on the tech stack, scale, and high-impact work.
7. NO placeholders like [Company Name] or [Insert Link]. Use "${company}" exactly or generic professional terms.
8. Include a witty but professional closing line that makes them want to reply (e.g., "I'd love to show you how I can bring this same scale to ${company}." or something similarly polished).
9. Body MUST be formatted using HTML <p> tags, keeping paragraphs very short (1-2 sentences max for skimming).`;

  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not defined in .env");

  const fallbackModels = ["openrouter/free", "google/gemma-3-27b-it:free", "mistralai/mistral-7b-instruct:free", "meta-llama/llama-3.2-1b-instruct:free"];
  let currentModelIdx = 0;
  let retries = 3;

  while (retries > 0 && currentModelIdx < fallbackModels.length) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-OpenRouter-Title": "Auto Apply Bot"
        },
        body: JSON.stringify({
          model: fallbackModels[currentModelIdx],
          messages: [
            { role: "user", content: prompt }
          ]
        })
      });

      if (response.status === 429 || response.status === 402) {
        console.log(`   ⏳ Model ${fallbackModels[currentModelIdx]} rate-limited/failed (${response.status}). Switching model...`);
        currentModelIdx++;
        if (currentModelIdx >= fallbackModels.length) {
          console.log(`   ⏳ All free models exhausted! Sleeping 15s...`);
          await new Promise(r => setTimeout(r, 15000));
          currentModelIdx = 0;
          retries--;
        }
        continue;
      }

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      const responseText = result.choices[0].message.content;

      let parsed = { subject: "Application | Software Engineer | Rishav Tarway", body: responseText };
      try {
        let content = responseText.replace(/^```[a-z]*\n/, '').replace(/\n```$/, '').trim();
        if (content.startsWith('```')) content = content.substring(3).trim();
        if (content.startsWith('json\n')) content = content.substring(5).trim();
        if (content.endsWith('```')) content = content.substring(0, content.length - 3).trim();

        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else if (content.startsWith("{")) {
          parsed = JSON.parse(content);
        }
      } catch (jsonErr) {
        let safeBody = responseText.replace(/\n\n/g, '</p><p>').replace(/\n/g, ' ');
        if (!safeBody.startsWith('<p>')) safeBody = '<p>' + safeBody + '</p>';
        parsed = { subject: `Software Engineering Application | ${company} | Rishav Tarway`, body: safeBody };
      }

      parsed.subject = (parsed.subject || `Application | ${company} | Rishav Tarway`).replace(/[,\[\]\(\)]/g, '');
      parsed.body = (parsed.body || parsed.subject).replace(/[,\[\]\(\)]/g, '');

      return { subject: parsed.subject, body: `<p>${greeting}</p>${parsed.body}${SIGNATURE_HTML}` };
    } catch (error: any) {
      console.error(`   ⚠️ Attempt failed generating AI content for ${company}: ${error.message}`);
      currentModelIdx++;
    }
  }

  // Fallback if APIs fail
  return {
    subject: `Software Engineer Application | High Scale Product Architecture | Rishav Tarway`,
    body: `<p>${greeting},</p><p>I'm Rishav Tarway. I saw the opening at ${company} and wanted to reach out directly. I specialize in building and optimizing highly scalable software architecture.</p><p>For a quick background: I've completed 6 paid internships (3 onsite, 3 remote), most notably handling core backend optimization at Classplus. I've also spent the last 2 years deeply involved in Open Source, recently merging critical fuzzing architecture PRs for OpenPrinting (selected for Winter of Code 5.0).</p><p>I know you're likely skimming this, so I'll keep it brief. I have several proof-of-work links attached to my profile, but let me know exactly what kind of PRs or projects you'd like to see for your stack, and I'll send them over.</p><p>Would love to briefly chat about how I can bring this level of scale and engineering rigor to ${company}.</p><p>Best,</p>${SIGNATURE_HTML}`
  };
}

// ============================================================================
// 5. GMAIL DRAFT CREATION LOGIC
// ============================================================================
class MailComposer {
  options: any;
  constructor(options: any) { this.options = options; }
  compile() {
    return {
      build: async () => {
        let transporter = nodemailer.createTransport({ streamTransport: true });
        return new Promise<Buffer>((resolve, reject) => {
          transporter.sendMail(this.options, (err, info) => {
            if (err) return reject(err);
            if (Buffer.isBuffer(info.message)) {
              return resolve(info.message);
            }
            const chunks: any[] = [];
            (info.message as any).on('data', (chunk: any) => chunks.push(chunk));
            (info.message as any).on('end', () => resolve(Buffer.concat(chunks)));
          });
        });
      }
    };
  }
}

async function createDraftInGmail(gmail: any, toEmail: string, subject: string, htmlBody: string) {
  const mailOptions = {
    to: toEmail,
    subject: subject,
    html: htmlBody,
    attachments: ATTACHMENTS
  };

  const mail = new MailComposer(mailOptions);
  const message = await mail.compile().build();
  const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw: encodedMessage } },
  });
}

// ============================================================================
// 6. MAIN EXECUTION FLOW
// ============================================================================
async function checkFormFillerStatus() {
  process.stdout.write("🔍 Checking Form Filler Server status... ");
  try {
    const res = await fetch('http://127.0.0.1:3001/api/form-filler/status', { method: 'GET', signal: AbortSignal.timeout(3000) });
    const data = await res.json() as any;
    if (data.status === 'online') {
      console.log(`[ONLINE] ✅ (AI Models Enabled: ${data.llm_available ? 'YES 🤖' : 'NO ⚠️'})`);
    } else {
      console.log(`[OFFLINE] ❌`);
    }
  } catch (e: any) {
    console.log(`[OFFLINE] ❌ (Please run 'npm run form-filler')`);
  }
}

async function main() {
  console.log("==================================================");
  console.log("   AUTOMATED JOB APPLICATION WORKFLOW INITIATED   ");
  console.log("==================================================");

  await checkFormFillerStatus();

  // Phase 1: Extract New Jobs
  const newJobs = await extractNewJobs();

  // Phase 2: Generate & Upload
  console.log(`\n🚀 [PHASE 2] Connecting to Gmail and processing ${newJobs.length} new jobs...`);
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: 'v1', auth });

  for (let i = 0; i < newJobs.length; i++) {
    const job = newJobs[i];
    const companyName = await extractCompanyName(job.text, job.email);
    const contactName = extractName(job.email, job.text);

    console.log(`\n[${i + 1}/${newJobs.length}] Drafting for ${companyName} (${job.email})`);

    // 1. Generate text via OpenRouter
    const { subject, body } = await generateEmailContent(job.text, companyName, contactName);

    // 2. Upload to Gmail
    try {
      await createDraftInGmail(gmail, job.email, subject, body);
      console.log(`   ✅ Draft created in Gmail.`);

      // 3. Log to Tracker
      try {
        const port = process.env.SERVER_PORT || '3000';
        await fetch(`http://127.0.0.1:${port}/api/applications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company: companyName,
            role: "Software Engineer",
            channel: job.channel,
            telegramId: job.id,
            email: job.email,
            link: job.link || null, // LOG LINK IF IT HAD BOTH
            description: job.text,
            status: 'applied'
          })
        });
      } catch (logErr) {
        // Silent fail for logging
      }

    } catch (e: any) {
      console.error(`   ❌ Failed to create draft:`, e.message);
    }

    // Delay 5 seconds between each job to prevent 15 RPM rate-limiting
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("\n==================================================");
  console.log(" 🎉 ALL DONE! Please check your Gmail Drafts. ");
  console.log("==================================================");
  process.exit(0);
}

main().catch(console.error);
