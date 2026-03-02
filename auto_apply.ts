import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

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
  { filename: 'RishavTarway-Resume .pdf', path: path.join(process.cwd(), 'RishavTarway-Resume .pdf') },
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
    await client.connect();

    const chats = await client.getChats(100);
    const targetChat = chats.find(c => c.title.toLowerCase().includes(SEARCH_QUERY.toLowerCase()));

    if (!targetChat) {
        throw new Error(`❌ No chat found matching: "${SEARCH_QUERY}"`);
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
            } else if (linkMatch) {
                // Keep track of forms/linkedin links
                manualJobs.push({
                    id: m.id.toString(),
                    date: new Date(m.date * 1000).toISOString(),
                    text: text,
                    link: linkMatch[1]
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

async function generateEmailContent(jobText: string, company: string, contactName: string): Promise<{subject: string, body: string}> {
  const greeting = contactName === "Team" ? `Hi Team ${company}` : `Hi ${contactName}`;
  const prompt = `
You are writing a cold email application.
Job Description: "${jobText}"
Company Name: ${company}

You MUST follow these STRICT RULES:
1. NO COMMAS, NO BRACKETS [], NO PARENTHESES () anywhere in the output.
2. Return a JSON object with two keys: "subject" and "body"
3. "subject" must be in format: "<Role Name> Application | <Catchy 3-word phrase about the company's focus> | Rishav Tarway" (e.g. "Frontend Developer Application | Scaling Robust UIs | Rishav Tarway")
4. "body" must be exactly 3 paragraphs formatted with HTML <p> tags.
5. Paragraph 1: Start with "I hope you are doing well. My name is Rishav Tarway and I am reaching out because I have been following ${company} and appreciate the company's commitment to <extract 1 core technical focus of this company from job desc>."
6. Paragraph 2: "With my experience in <mention 1-2 skills from the job desc that match Classplus or IIIT Bangalore or Franchizerz internships> I am excited about the possibility of contributing to the ${company} engineering team."
7. Paragraph 3: "I recently had success contributing to OpenPrinting where I was selected for Winter of Code 5.0 and successfully merged my <a href='https://github.com/OpenPrinting/fuzzing/pull/48'>recent PR #48 at OpenPrinting</a>. Writing extensive fuzzing functions to find edge cases is really driving my passion to learn the in depth architecture of software and find their vulnerabilities making me a perfect fit for this role."
8. Paragraph 4: "I would be more than happy to contribute and connect with the amazing team at ${company}. I have attached my resume along with this."
9. Paragraph 5: "Thank you and I hope to hear from you soon!"
10. Do not include the signature or greeting in the body, I will add them. Only return raw JSON, no markdown blocks.`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      let content = data.choices[0].message.content.trim();
      content = content.replace(/^```json\n/, '').replace(/\n```$/, '');
      const parsed = JSON.parse(content);
      parsed.subject = parsed.subject.replace(/[,\[\]\(\)]/g, '');
      parsed.body = parsed.body.replace(/[,\[\]\(\)]/g, '');

      return { subject: parsed.subject, body: `<p>${greeting}</p>${parsed.body}${SIGNATURE_HTML}` };
    }
    throw new Error("Invalid OpenRouter response");
  } catch (error: any) {
    console.error(`Error generating content for ${company}:`, error.message);
    return {
      subject: `Software Engineer Application | High Scale Product Architecture | Rishav Tarway`,
      body: `<p>${greeting}</p><p>I hope you are doing well. My name is Rishav Tarway and I am reaching out because I have been following ${company} and appreciate the company's commitment to building highly scalable software architecture.</p><p>With my experience in backend optimization at Classplus and extensive quality automation during my IIIT Bangalore internship I am excited about the possibility of contributing to the ${company} engineering team.</p><p>I recently had success contributing to OpenPrinting where I was selected for Winter of Code 5.0 and successfully merged my <a href="https://github.com/OpenPrinting/fuzzing/pull/48">recent PR #48 at OpenPrinting</a>. Writing extensive fuzzing functions to find edge cases is really driving my passion to learn the in depth architecture of software and find their vulnerabilities.</p><p>I would be more than happy to contribute and connect with the amazing team at ${company}. I have attached my resume along with this.</p><p>Thank you and I hope to hear from you soon!</p>${SIGNATURE_HTML}`
    };
  }
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
            const chunks: any[] = [];
            info.message.on('data', (chunk: any) => chunks.push(chunk));
            info.message.on('end', () => resolve(Buffer.concat(chunks)));
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
async function main() {
    console.log("==================================================");
    console.log("   AUTOMATED JOB APPLICATION WORKFLOW INITIATED   ");
    console.log("==================================================");

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

        console.log(`\n[${i+1}/${newJobs.length}] Drafting for ${companyName} (${job.email})`);

        // 1. Generate text via OpenRouter
        const { subject, body } = await generateEmailContent(job.text, companyName, contactName);

        // 2. Upload to Gmail
        try {
            await createDraftInGmail(gmail, job.email, subject, body);
            console.log(`   ✅ Draft created in Gmail.`);
        } catch (e: any) {
            console.error(`   ❌ Failed to create draft:`, e.message);
        }

        // Delay to prevent rate-limiting
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log("\n==================================================");
    console.log(" 🎉 ALL DONE! Please check your Gmail Drafts. ");
    console.log("==================================================");
    process.exit(0);
}

main().catch(console.error);
