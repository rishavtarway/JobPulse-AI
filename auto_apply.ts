import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dns from 'node:dns';

// Force IPv4-first DNS resolution to fix ENOTFOUND issues in Node.js 17+
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}
import { callAI } from './src/utils/ai_service.js';

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
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
if (!OPENROUTER_API_KEY && !NVIDIA_API_KEY) {
  console.error("❌ Missing AI API keys in .env. Cannot generate emails.");
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
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

const SIGNATURE_HTML = `
<br><br>
Regards,<br>
<strong>Rishav Tarway</strong><br>
<a href="https://drive.google.com/file/d/18y1yNOP-C7Mw8_Japfeb9ihsfNk6YiwH/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

// ============================================================================
// 2. GMAIL API AUTHENTICATION
// ============================================================================
async function authorizeGmail() {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');

  console.log(`   📂 Loading credentials from: ${CREDENTIALS_PATH}`);
  if (!fs.existsSync(CREDENTIALS_PATH)) throw new Error("Missing credential.json");
  
  console.log(`   📂 Loading token from: ${TOKEN_PATH}`);
  if (!fs.existsSync(TOKEN_PATH)) throw new Error("Missing token.json");

  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const credentials = JSON.parse(content);
  const clientSecret = credentials.installed?.client_secret || credentials.web?.client_secret;
  const clientId = credentials.installed?.client_id || credentials.web?.client_id;
  const redirectUris = credentials.installed?.redirect_uris || credentials.web?.redirect_uris || ['http://localhost'];

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUris[0]);
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  
  console.log(`   🔑 Token scope: ${token.scope}`);
  console.log(`   📅 Token expiry: ${new Date(token.expiry_date).toLocaleString()}`);
  
  oAuth2Client.setCredentials(token);

  // Pre-flight check: Use a more robust check that works with compose scope
  try {
    console.log("   🧪 Running Gmail pre-flight check...");
    const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });
    // getProfile might fail if scope is ONLY compose, but let's try it and catch
    await gmail.users.getProfile({ userId: 'me' });
    console.log("   ✅ Gmail pre-flight check passed.");
  } catch (err: any) {
    console.warn(`   ⚠️ Pre-flight warning: ${err.message}`);
    if (err.message?.includes('invalid_grant')) {
      throw new Error("Gmail token expired/revoked. Please run 'npx tsx auth_gmail.ts' to re-authorize.");
    }
    // If it's a 403 Insufficient Permission, we might still be able to create drafts
    if (err.code === 403) {
      console.log("   ℹ️ Insufficient permission for getProfile, but proceeding with compose scope...");
    } else {
       throw err;
    }
  }

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
  const prompt = `Critically evaluate if this text is a real engineering job / internship posting or a link to a job application form.
    Message: "${text.substring(0, 1000)}"
Reply ONLY with "YES" if it's a job/internship posting or application form link. 
Reply ONLY with "NO" if it's general chat, career guidance, spam, or a generic question.`;

  const reply = await callAI(prompt);
  return reply?.toUpperCase().includes("YES") || false;
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

  const prompt = `Extract the official company name from this job posting.
Message: "${text.substring(0, 1000)}"
Reply ONLY with the company name. If no specific company name is found, reply ONLY with "Hiring Team".`;

  const name = await callAI(prompt);
  return name?.trim().substring(0, 50) || "Hiring Team";
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

    while (keepFetching && batchCounter < 20) { // Increased batch counter for deeper search
      const batch = await client.getMessages(targetChannel.id, 50, lastFetchedId);
      if (!batch || batch.length === 0) break;

      for (const m of batch) {
        const isNew = m.id > lastProcessedId;
        const alreadyApplied = isAlreadyApplied(m.id.toString(), targetChannel.name);

        if (!seenIds.has(m.id) && !alreadyApplied) {
          // We take it if it's strictly newer OR if we missed it somehow but it's not in DB
          newMessages.push(m);
          seenIds.add(m.id);
        }
      }

      const oldestInBatch = batch[batch.length - 1];
      // Logic: keep fetching until we hit 1000 messages or we are deep past the lastProcessedId
      if (lastFetchedId === oldestInBatch.id || (oldestInBatch.id < (lastProcessedId - 1000))) {
        keepFetching = false;
      }
      lastFetchedId = oldestInBatch.id;
      batchCounter++;
      process.stdout.write(`   Scanning batch... (Oldest: ${oldestInBatch.id}, Found: ${newMessages.length})\r`);
    }

    if (newMessages.length === 0) {
      console.log(`\n   ✅ Checked status of ${targetChannel.name}. No new actionable messages.`);
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
      mdContent += `### [${job.channel}] Job ID: ${job.id} (Posted: ${new Date(job.date).toLocaleString()})\n`;
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
            status: 'to_apply',
            type: 'telegram'
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
  const greeting = contactName === "Team" ? `Hello ${company} Team,` : `Hello ${contactName},`;

  const prompt = `
Generate a minimalist, human-like cold email for a job application.
YOU ARE RISHAV TARWAY. Write strictly in the FIRST PERSON ("I").
NEVER refer to yourself as "Rishav" or "Tarway" in the body.

Applicant Details (USE THESE IN FIRST PERSON):
- IIIT Bangalore: I worked with the MOSIP team (government identity systems) building high-scale BDD test suites and fixing critical sync bugs.
- Classplus: I worked with the Classplus team to optimize backend architecture for 10k+ concurrent users.
- Open Source: I merged PR #48 for OpenPrinting's fuzzing layer.
- Top Skills: Java, Python, TypeScript, Node.js, Selenium, AWS, Redis.

Job Description: "${jobText}"
Target Company: ${company}
Contact Name: ${contactName}

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. SUBJECT LINE: Catchy brackets [] or semicolons ; as per user style. 
   Example: "[Inquiry] Engineering at ${company}".
3. GREETING: Start with exactly one greeting: "Hi ${contactName}," or "Hello ${contactName},".
4. BODY: NO BOLDING. NEVER use your own name in the sentences. 
5. TONE: Human, conversational. No "I am writing...". Just start with the connection to ${company}.
6. Content must be 3 short paragraphs in HTML <p> tags. Total under 130 words.
7. THE ASK: End with: "Would you be open to a quick 14-minute coffee chat this week or next?"`;

  console.log(`   🤖 Generating humanized pitch for ${company}...`);
  const result = await callAI(prompt, true);

  if (!result) {
    return {
      subject: `[Inquiry] Software Engineer role at ${company}`,
      body: `<p>I came across the job opportunity for Software Engineer from your department and it immediately caught my eye as it matches my background in high-scale systems.</p><p>My background is in Node.js, TypeScript, and Java, which directly aligns with what you need. I've completed a research internship at IIIT Bangalore on government identity systems and optimized backend infrastructure at Classplus for 10k+ concurrent users. I'm also deeply involved in Open Source, recently merging PR #48 for OpenPrinting.</p><p>I would genuinely love to hear your perspective on what makes someone successful in this role. Would you be open to a quick 14-minute coffee chat this week or next?</p>${SIGNATURE_HTML}`
    };
  }

  return { subject: result.subject, body: `${result.body}${SIGNATURE_HTML}` };
}

export async function generateYCPolishedEmail(company: string, mission: string, contactName: string): Promise<{ subject: string, body: string }> {
  const greeting = contactName === "Team" ? `Hi ${company} Team,` : `Hi ${contactName},`;

  const prompt = `
Generate an eye-catching, high-impact cold email for a startup founder as valid JSON. 
YOU ARE RISHAV TARWAY. Write strictly in the FIRST PERSON ("I").
NEVER mention your own name ("Rishav" or "Tarway") in the body.

Applicant Facts (USE FIRST PERSON):
- IIIT Bangalore: I built high-scale BDD test suites with the MOSIP team.
- Classplus: I worked with the Classplus team to scale backend for 10k+ users.
- OpenPrinting: I merged critical fuzzing layer PR #48.
- Skills: TypeScript, Node.js, Java, Python, Selenium, AWS.

Startup Name: "${company}"
Mission: "${mission}"
Founder Name: "${contactName}"

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. GREETING: Start with exactly one greeting: "Hi ${contactName}," or "Hey ${contactName},".
3. SUBJECT LINE: Catchy brackets [] or curly braces {}.
4. BODY: NO BOLDING. NEVER use placeholders or blanks. No fluff.
5. THE ASK: End with: "Would you be open to a quick 17-minute coffee chat this week or next?"`;

  console.log(`   🤖 Generating humanized YC pitch for ${company}...`);
  const result = await callAI(prompt, true);

  if (!result) {
    return {
      subject: `[Draft] Engineering at ${company}`,
      body: `<p>${greeting}</p><p>${company}'s mission to ${mission} really resonates with me. I've spent my spare time shipping code to Open Source and recently merged PR #48 for OpenPrinting's fuzzing architecture.</p><p>I've done 6 paid internships (3 onsite, 3 remote), most notably handling core backend optimization at Classplus. I'm the guy who builds internal tools from scratch locally, which might save you a few SaaS seats.</p><p>I'd love to chat more about how I can contribute to the team. Would you be open to a quick 17-minute coffee chat this week or next?</p>${SIGNATURE_HTML}`
    };
  }

  return { subject: result.subject, body: `<p>${greeting}</p>${result.body}${SIGNATURE_HTML}` };
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
  console.log(`\n🚀[PHASE 2] Connecting to Gmail and processing ${newJobs.length} new jobs...`);
  
  let gmail: any;
  try {
    const auth = await authorizeGmail();
    gmail = google.gmail({ version: 'v1', auth: auth as any });
    console.log("✅ Gmail connection established.");
  } catch (authErr: any) {
    console.error(`\n❌ GMAIL AUTHENTICATION FAILED: ${authErr.message}`);
    console.log("Please resolve the auth issue and restart the process.");
    process.exit(1);
  }

  for (let i = 0; i < newJobs.length; i++) {
    const job = newJobs[i];
    const companyName = await extractCompanyName(job.text, job.email);
    const contactName = extractName(job.email, job.text);

    console.log(`\n[${i + 1}/${newJobs.length}] Drafting for ${companyName}(${job.email})`);

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
            status: 'applied',
            type: 'telegram'
          })
        });
      } catch (logErr) {
        // Silent fail for logging
      }

    } catch (e: any) {
      console.error(`   ❌ Failed to create draft:`, e.message);
      if (e.response) {
        console.error(`      Error Details:`, JSON.stringify(e.response.data, null, 2));
      }
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
