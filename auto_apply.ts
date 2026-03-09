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

const SEARCH_QUERY = "TechUprise Premium Insider Club";
const STATE_FILE = 'auto_apply_state.json';
const NEW_JOBS_FILE = 'latest_jobs_to_apply.json';
const MASTER_LOG_FILE = 'all_extracted_jobs_log.txt';

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
async function extractNewJobs() {
  // Read state to find the last fetched ID
  let lastProcessedId = 0;
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    lastProcessedId = state.lastMessageId || 0;
  }

  if (lastProcessedId === 0) {
    console.error("⚠️ No lastProcessedId found in state. Please ensure you have run the initial extraction.");
    // We will default to a recent timestamp to avoid downloading the whole history
    // Or you can hardcode a specific ID here if needed.
    console.log("Starting from ID 2306867200 (Vinti Web Solution post) as fallback.");
    lastProcessedId = 2306867200;
  }

  console.log(`\n🚀 [PHASE 1] Extracting new jobs since Message ID: ${lastProcessedId}...`);

  // Dynamic Imports for Telegram
  const { TelegramClient } = await import('./src/telegram/client.js');
  const { Config } = await import('./src/config/index.js');

  const config = Config.getInstance();
  const client = new TelegramClient(config.telegram);

  await client.connect(BROWSER_MODE ? {
    getAuthCode: requestOtpFromServer,
    getPassword: requestPasswordFromServer,
  } : undefined);

  const chats = await client.getChats(100);
  const targetChat = chats.find(c => c.title.toLowerCase().includes(SEARCH_QUERY.toLowerCase()));

  if (!targetChat) {
    throw new Error(`❌ No chat found matching: "${SEARCH_QUERY}"`);
  }

  // Force TDLib to sync the chat from the network to avoid stale local cache
  try {
    console.log("   Forcing Telegram network sync for this chat...");
    // @ts-ignore
    await client.client.invoke({ _: 'openChat', chat_id: parseInt(targetChat.id) });
    await new Promise(r => setTimeout(r, 2000)); // wait for network sync
  } catch (e: any) {
    console.log(`   Sync notice: ${e.message}`);
  }

  let newMessages: any[] = [];
  let lastFetchedId = 0;
  let keepFetching = true;
  let fallbackCounter = 0;

  // To prevent duplicate extraction, we will keep track of IDs we've seen in this session
  const seenIdsThisSession = new Set<number>();

  while (keepFetching && fallbackCounter < 15) {
    const batch = await client.getMessages(targetChat.id, 100, lastFetchedId);
    if (!batch || batch.length === 0) break;

    let addedInBatch = 0;
    for (const m of batch) {
      // STRICT DEDUPLICATION: Only add if its ID is strictly greater than the last processed ID
      // AND we haven't seen it in this session yet.
      if (m.id > lastProcessedId && !seenIdsThisSession.has(m.id)) {
        newMessages.push(m);
        seenIdsThisSession.add(m.id);
        addedInBatch++;
      }
    }

    const oldestInBatch = batch[batch.length - 1];

    // Break if we are stuck in a loop fetching the exact same oldest message
    if (lastFetchedId === oldestInBatch.id) {
      break;
    }

    lastFetchedId = oldestInBatch.id;
    fallbackCounter++;

    process.stdout.write(`   Scanning batch... (Oldest ID in batch: ${oldestInBatch.id})\r`);

    // If the oldest message we just fetched is older than or equal to our last processed ID,
    // it means we have successfully traversed back in time far enough and can stop fetching.
    if (oldestInBatch.id <= lastProcessedId) {
      keepFetching = false;
    }
    await new Promise(r => setTimeout(r, 400));
  }

  // Filter out duplicates (just in case)
  const uniqueMessages = Array.from(new Map(newMessages.map(m => [m.id, m])).values());
  uniqueMessages.sort((a, b) => a.id - b.id);

  console.log(`\n✅ Found ${uniqueMessages.length} total new messages in the channel.`);

  if (uniqueMessages.length === 0) {
    console.log("No new messages to process. Exiting early.");
    process.exit(0);
  }

  // Parse out the ones with emails
  const parsedJobs: { id: string, date: string, text: string, email: string }[] = [];
  const manualJobs: { id: string, date: string, text: string, link: string }[] = [];
  let masterLogAppends = `\n\n--- AUTO EXTRACT: ${new Date().toISOString()} ---\n\n`;

  uniqueMessages.forEach(m => {
    const text = m.text || m.mediaCaption || "";
    if (text.trim()) {
      masterLogAppends += `[ID:${m.id}] [Date:${new Date(m.date * 1000).toISOString()}] ${text.replace(/\n/g, ' ')}\n\n`;

      const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i);

      // Check for links if no email
      const linkMatch = text.match(/(https?:\/\/[^\s]+)/i);

      if (emailMatch) {
        parsedJobs.push({
          id: m.id.toString(),
          date: new Date(m.date * 1000).toISOString(),
          text: text,
          email: emailMatch[1]
        });
      } else {
        // Keep track of all other jobs that don't have emails
        manualJobs.push({
          id: m.id.toString(),
          date: new Date(m.date * 1000).toISOString(),
          text: text,
          link: linkMatch ? linkMatch[1] : 'No direct link found'
        });
      }
    }
  });

  // Update master log
  fs.appendFileSync(MASTER_LOG_FILE, masterLogAppends);

  // Create Markdown task list for manual jobs
  if (manualJobs.length > 0) {
    let mdContent = `\n\n## Manual Applications Needed (${new Date().toISOString()})\n\n`;
    manualJobs.forEach(job => {
      mdContent += `### Job ID: ${job.id} (Posted: ${job.date})\n`;
      mdContent += `**Apply Here:** [${job.link}](${job.link})\n\n`;
      mdContent += `**Description:**\n> ${job.text.replace(/\n/g, '\n> ')}\n\n`;
      mdContent += `---\n`;
    });

    fs.appendFileSync('MANUAL_APPLY_TASKS.md', mdContent);
    console.log(`\n⚠️ Found ${manualJobs.length} jobs with web/form links instead of emails. Saved to MANUAL_APPLY_TASKS.md for you to review.`);
  }

  if (parsedJobs.length === 0) {
    console.log("No new jobs with emails found in the new messages. Updating state and exiting.");
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastMessageId: uniqueMessages[uniqueMessages.length - 1].id }, null, 2));
    process.exit(0);
  }

  console.log(`✅ Extracted ${parsedJobs.length} NEW actionable job postings (containing emails).`);
  fs.writeFileSync(NEW_JOBS_FILE, JSON.stringify(parsedJobs, null, 2));

  // Update state to the absolute latest message ID we saw
  const newHighestId = uniqueMessages[uniqueMessages.length - 1].id;
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastMessageId: newHighestId }, null, 2));

  return parsedJobs;
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
  const greeting = contactName === "Team" ? `Hi Team ${company}` : `Hi ${contactName}`;
  const prompt = `
Generate a cold email application as exactly JSON. Do not write any other text.
Job Description: "${jobText}"
Company Name: ${company}

MUST follow these STRICT RULES:
1. ONLY return a JSON object with two keys: "subject" and "body"
2. "subject" must be in format: "<Role Name> Application | <Catchy 3-word phrase> | Rishav Tarway"
3. "body" must be exactly 3 paragraphs formatted with HTML <p> tags.
4. Paragraph 1: Start with "I hope you are doing well. My name is Rishav Tarway and I am reaching out because I have been following ${company} and appreciate the company's commitment to <extract 1 core technical focus of this company from job desc>."
5. Paragraph 2: "With my experience in <mention 1-2 skills from the job desc that match Classplus or IIIT Bangalore or Franchizerz internships> I am excited about the possibility of contributing to the ${company} engineering team."
6. Paragraph 3: "I recently had success contributing to OpenPrinting where I was selected for Winter of Code 5.0 and successfully merged my <a href='https://github.com/OpenPrinting/fuzzing/pull/48'>recent PR #48 at OpenPrinting</a>. Writing extensive fuzzing functions to find edge cases is really driving my passion to learn the in depth architecture of software and find their vulnerabilities making me a perfect fit for this role."
7. Paragraph 4: "I would be more than happy to contribute and connect with the amazing team at ${company}. I have attached my resume along with this."
8. Paragraph 5: "Thank you and I hope to hear from you soon!"
9. NO signature or greeting in the body. Only return flat valid JSON.`;

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
    body: `<p>${greeting}</p><p>I hope you are doing well. My name is Rishav Tarway and I am reaching out because I have been following ${company} and appreciate the company's commitment to building highly scalable software architecture.</p><p>With my experience in backend optimization at Classplus and extensive quality automation during my IIIT Bangalore internship I am excited about the possibility of contributing to the ${company} engineering team.</p><p>I recently had success contributing to OpenPrinting where I was selected for Winter of Code 5.0 and successfully merged my <a href="https://github.com/OpenPrinting/fuzzing/pull/48">recent PR #48 at OpenPrinting</a>. Writing extensive fuzzing functions to find edge cases is really driving my passion to learn the in depth architecture of software and find their vulnerabilities.</p><p>I would be more than happy to contribute and connect with the amazing team at ${company}. I have attached my resume along with this.</p><p>Thank you and I hope to hear from you soon!</p>${SIGNATURE_HTML}`
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
    const domainMatch = job.email.match(/@([a-zA-Z0-9.-]+)\./);
    const companyName = domainMatch ? domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1) : "your company";
    const contactName = extractName(job.email, job.text);

    console.log(`\n[${i + 1}/${newJobs.length}] Drafting for ${companyName} (${job.email})`);

    // 1. Generate text via OpenRouter
    const { subject, body } = await generateEmailContent(job.text, companyName, contactName);

    // 2. Upload to Gmail
    try {
      await createDraftInGmail(gmail, job.email, subject, body);
      console.log(`   ✅ Draft created in Gmail.`);
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
