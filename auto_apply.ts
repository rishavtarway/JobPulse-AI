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
const TARGET_CHANNELS = [
  { id: "-1003338916645", name: "TechUprise Premium" }
];

let globalClient: TelegramClient | null = null;

// ============================================================================
// 1. HELPERS
// ============================================================================

function safeSlice(text: string, length: number): string {
  if (!text) return "";
  // String.substring/slice can break emoji surrogate pairs. 
  // Array.from(text) handles Unicode characters correctly.
  const chars = Array.from(text);
  if (chars.length <= length) return text;
  return chars.slice(0, length).join('');
}

function isAlreadyApplied(msgId: string, channelName: string): boolean {
  if (!fs.existsSync(APPLICATIONS_FILE)) return false;
  const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
  return apps.some((app: any) => app.telegramId === msgId && app.channel === channelName);
}

function requestOtpFromServer(): Promise<string> {
  return new Promise(async (resolve) => {
    console.log("📡 Discovery Agent: Waiting for OTP from dashboard...");
    const checkOtp = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/telegram-otp`);
        const data: any = await res.json();
        if (data.otp) {
          console.log("✅ OTP received!");
          resolve(data.otp);
        } else {
          setTimeout(checkOtp, 2000);
        }
      } catch (e) {
        setTimeout(checkOtp, 2000);
      }
    };
    checkOtp();
  });
}

function requestPasswordFromServer(): Promise<string> {
  return new Promise(async (resolve) => {
    console.log("📡 Discovery Agent: Waiting for 2FA password from dashboard...");
    const checkPass = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/telegram-password`);
        const data: any = await res.json();
        if (data.password) {
          console.log("✅ Password received!");
          resolve(data.password);
        } else {
          setTimeout(checkPass, 2000);
        }
      } catch (e) {
        setTimeout(checkPass, 2000);
      }
    };
    checkPass();
  });
}

const ATTACHMENTS = [
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

const SIGNATURE_HTML = `
<br><br>
Best, Rishav Tarway | Mobile: +91 7004544142<br>
<a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

// Removed HARDCODED_SCAN_FROM to allow pure automated resumption from state file.

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
    // Falls back to manual terminal auth if token missing
    const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.readonly'] });
    console.log('Authorize this app by visiting this url:', authUrl);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const code = await new Promise<string>((resolve) => rl.question('Enter the code from that page here: ', (code) => { resolve(code); rl.close(); }));
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  }
  return oAuth2Client;
}

async function checkIfSentInGmail(gmail: any, toEmail: string): Promise<boolean> {
  try {
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `to:${toEmail} label:SENT`,
      maxResults: 1
    });
    return (res.data.messages && res.data.messages.length > 0);
  } catch (e: any) {
    console.log(`   ⚠️ Gmail Search failed for ${toEmail}: ${e.message}`);
    return false;
  }
}

async function extractNewJobs(client: TelegramClient) {
  let state = { channelLastIds: {} as Record<string, number> };
  if (fs.existsSync(STATE_FILE)) state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  console.log(`\n🚀 [PHASE 1] Extracting new jobs from ${TARGET_CHANNELS.length} channels...`);
  await client.connect(BROWSER_MODE ? {
    getAuthCode: requestOtpFromServer,
    getPassword: requestPasswordFromServer,
  } : undefined);

  let allParsedJobs: any[] = [];
  let allManualJobs: any[] = [];
  let masterLogAppends = `\n\n--- MULTI-CHANNEL AUTO EXTRACT: ${new Date().toISOString()} ---\n\n`;

  // Generic floor: 21 days ago (extended to catch missed jobs)
  const MIN_POSTED_DATE = Date.now() - (21 * 24 * 60 * 60 * 1000); 

  // Hydrate the brand new TDLib session with the master chat list so the cache recognizes our hardcoded ID
  try {
    console.log('   🔄 Pre-fetching chat list to hydrate fresh session cache...');
    await client.getChats(100);
  } catch (e: any) {
    console.log('   [Warning] Fast chat hydration hit a snag, proceeding anyway: ' + e.message);
  }

  for (const targetChannel of TARGET_CHANNELS) {
    console.log(`\n📡 Scanning Channel: ${targetChannel.name} (${targetChannel.id})...`);
    
    let lastProcessedId = state.channelLastIds[targetChannel.id] || 0;
    console.log(`   Last Processed ID: ${lastProcessedId}`);

    let newMessages: any[] = [];
    let lastFetchedId = 0;
    let keepFetching = true;
    let batchCounter = 0;
    const seenIds = new Set<number>();

    try {
      // Force TDLib to fully open the channel, which forces native synchronization of new messages over the wire
      await (client as any).client.invoke({ _: 'openChat', chat_id: parseInt(targetChannel.id) });
      await (client as any).client.invoke({ _: 'getChat', chat_id: parseInt(targetChannel.id) });
      process.stdout.write(`   ⏳ Synchronizing with Telegram (warmup)...`);
      await new Promise(r => setTimeout(r, 5000));
      process.stdout.write(` Done.\n`);
    } catch (e: any) {
      console.log(`   [TDLib Sync] Warning: ${e.message}`);
    }

    let retryCount = 0;
    while (retryCount < 2) {
      try {
        lastFetchedId = 0;
        newMessages = [];
        seenIds.clear();
        keepFetching = true;
        batchCounter = 0;

        while (keepFetching && batchCounter < 50) {
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
          process.stdout.write(`   Scanning batch... (Oldest: ${oldestInBatch.id}, Found: ${newMessages.length})\r`);
        }

        // Proceed to analyze if we found ANY messages, regardless of ID, 
        // to catch skipped ones in the 48h window.
        if (newMessages.length > 0) {
          break; 
        } else {
          retryCount++;
          if (retryCount < 2) {
            console.log(`\n   🕒 No messages found, waiting and retrying (${retryCount}/1)...`);
            await new Promise(r => setTimeout(r, 4000));
          }
        }
      } catch (e: any) {
        console.log(`\n⚠️ Error fetching messages for ${targetChannel.name}: ${e.message}`);
        break;
      }
    }

    if (newMessages.length > 0) {
      console.log(`\n   🔍 Analyzing ${newMessages.length} messages in ${targetChannel.name}...`);
      
      // Process oldest messages first to advance state safely
      newMessages.sort((a, b) => a.id - b.id);

      for (const m of newMessages) {
        const text = m.text || m.mediaCaption || "";
        if (!text.trim()) continue;
        
        const messageDate = m.date * 1000;
        const isVeryRecent = (Date.now() - messageDate) < (24 * 60 * 60 * 1000); // 24h retry window
        const postedISO = new Date(messageDate).toISOString();

        // 1. Skip if older than MIN_POSTED_DATE (7 days)
        if (messageDate < MIN_POSTED_DATE) {
          continue;
        }

        // 2. Skip if already successfully applied (Database check)
        if (isAlreadyApplied(m.id.toString(), targetChannel.name)) {
          // Always advance state if we see a message we've already handled
          if (m.id > state.channelLastIds[targetChannel.id]) state.channelLastIds[targetChannel.id] = m.id;
          continue; 
        }

        // 3. Skip if already seen in past runs 
        //   EXCEPTION: If message is recent (last 48h) but not in applications.json, 
        //   allow re-processing to catch previously skipped/failed drafts.
        const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
        const isRecent = (Date.now() - messageDate) < FORTY_EIGHT_HOURS_MS;

        if (m.id <= lastProcessedId && !isRecent) {
          continue;
        }

        const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i);
        const linkMatch = text.match(/(https?:\/\/[^\s]+|[a-z0-9]+\.[a-z0-9]+\/[^\s]+|careers\.[a-z0-9]+\.[a-z]+|jobs\.[a-z0-9]+\.[a-z]+)/i);

        if (!(emailMatch || linkMatch)) {
          console.log(`   ⏭️ Skip ID: ${m.id} (Regex: No email or link)`);
          continue;
        }

        const isJob = await isRealJobPosting(text);
        if (isJob === null) {
          console.log(`   ⚠️ AI classification failed for ID: ${m.id}. Skipping remaining messages in this channel to avoid state corruption.`);
          break;
        }
        if (!isJob) continue;
        
        console.log(`   Processing job ID: ${m.id}, Posted: ${postedISO}`);
        masterLogAppends += `[ID:${m.id}] [Chan:${targetChannel.name}] [Date:${postedISO}] ${text.replace(/\n/g, ' ')}\n\n`;

        const company = await extractCompanyName(text, emailMatch ? emailMatch[1] : undefined);

        if (emailMatch) {
          allParsedJobs.push({ id: m.id.toString(), channel: targetChannel.name, date: postedISO, text: text, email: emailMatch[1], company: company, link: linkMatch ? linkMatch[1] : null });
        }
        if (linkMatch) {
          allManualJobs.push({ id: m.id.toString(), channel: targetChannel.name, date: postedISO, text: text, link: linkMatch[1], company: company });
        }

        // 4. Finally advance state only for handled messages
        if (m.id > state.channelLastIds[targetChannel.id]) {
          state.channelLastIds[targetChannel.id] = m.id;
          fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
        }

        // 5. Pacing to respect AI rate limits
        await new Promise(r => setTimeout(r, 4000));
      }
    }
  }

  // Persist state immediately after discovery
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log("\n💾 [STATE] Progress saved to state file.");

  fs.appendFileSync(MASTER_LOG_FILE, masterLogAppends);

  if (allManualJobs.length > 0) {
    let mdContent = `\n\n## Multi-Channel Manual Applications (${new Date().toISOString()})\n\n`;
    for (const job of allManualJobs) {
      mdContent += `### [${job.channel}] Job ID: ${job.id} (Posted: ${job.date})\n`;
      mdContent += `**Apply Here:** [${job.link}](${job.link})\n\n**Description:**\n> ${job.text.replace(/\n/g, '\n> ')}\n\n---\n`;
      try {
        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            company: job.company || "Link Application",
            role: "Software Engineer",
            channel: job.channel,
            telegramId: job.id,
            link: job.link,
            description: job.text,
            jobDescription: job.text,
            status: 'to_apply',
            type: 'telegram',
            appliedDate: job.date,
            _timestamp: new Date(job.date).getTime()
          })
        });
      } catch (e) { }
    }
    fs.appendFileSync('MANUAL_APPLY_TASKS.md', mdContent);
  }

  return allParsedJobs;
}

// ============================================================================
// AI LOGIC
// ============================================================================
async function isRealJobPosting(text: string): Promise<boolean | null> {
  const reply = await callAI(`Is this a job/internship/career opening of ANY KIND (engineering, marketing, HR, operations, etc.)? Ignore generic news, ads for courses, or channel announcements. Reply ONLY YES or NO.\nText: "${safeSlice(text, 500)}"`);
  if (reply === null) return null;
  return reply.toUpperCase().includes("YES");
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
  const reply = await callAI(`Extract only the company name from this job post. If not found, return 'Unknown'.\nText: "${safeSlice(text, 300)}"`);
  return reply?.replace(/['"]/g, '').trim() || "Unknown";
}

function extractName(email: string, text: string): string {
  if (email.includes('.')) {
    const namePart = email.split('@')[0];
    if (namePart.includes('.')) return namePart.split('.')[0].charAt(0).toUpperCase() + namePart.split('.')[0].slice(1);
  }
  return "Team";
}

async function callAI(prompt: string, jsonFlag = false): Promise<any> {
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    // Cycle through models to avoid rate limits
    const models = [
        { provider: 'openrouter', name: 'google/gemini-2.0-flash-lite-001' },
        { provider: 'openrouter', name: 'google/gemini-2.0-pro-exp-02-05:free' },
        { provider: 'openrouter', name: 'google/gemini-2.0-flash-thinking-exp:free' },
        { provider: 'openrouter', name: 'meta-llama/llama-3.1-70b-instruct' },
        { provider: 'nvidia', name: 'meta/llama-3.1-70b-instruct' },
        { provider: 'nvidia', name: 'meta/llama-3.1-405b-instruct' }
    ];

    for (const model of models) {
        let retries = 0;
        const maxRetries = 1;

        while (retries <= maxRetries) {
            try {
                console.log(`🤖 [Querying ${model.provider}: ${model.name}]...`);
                let response;
                if (model.provider === 'nvidia') {
                    response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: model.name, messages: [{ role: "user", content: prompt }] })
                    });
                } else {
                    response = await fetch(`https://openrouter.ai/api/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/rishavtarway/JobPulse-AI', 'X-Title': 'JobPulse AI' },
                        body: JSON.stringify({ model: model.name, messages: [{ role: "user", content: prompt }] })
                    });
                }

                const data: any = await response.json();
                
                if (data.error) {
                    const errMsg = typeof data.error.message === 'string' ? data.error.message : JSON.stringify(data.error);
                    
                    if (data.error.code === 429 || errMsg.includes('Rate limit') || data.status === 429) {
                        console.log(`   ⚠️ Rate limited on ${model.provider}:${model.name}. Waiting 30s to retry... (Attempt ${retries + 1}/${maxRetries + 1})`);
                        await new Promise(r => setTimeout(r, 30000));
                        retries++;
                        continue;
                    }
                    if (data.status === 401 || (data.error && data.error.code === 401) || errMsg.includes('User not found') || errMsg.includes('Invalid API Key')) {
                        console.log(`   ❌ Auth Error on ${model.provider}:${model.name}. Skipping provider...`);
                        break; // Exit retry loop and try next model
                    }
                    console.log(`   ⚠️ API error from ${model.name}: ${errMsg}`);
                    break; // Try next model
                }
                
                if (!data.choices || data.choices.length === 0) {
                  console.log(`   ⚠️ Unexpected AI response format from ${model.name}`);
                  break;
                }

                const content = data.choices[0].message.content;
                if (jsonFlag) {
                    try {
                        return JSON.parse(content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1));
                    } catch {
                        console.log(`   ⚠️ Failed to parse AI JSON response.`);
                        break;
                    }
                }
                return content;
            } catch (e: any) {
                console.log(`   ⚠️ Request failed for ${model.name}: ${e.message}`);
                break;
            }
        }
    }
    return null;
}

async function generateEmailContent(jobText: string, company: string, contactName: string): Promise<{ subject: string, body: string }> {
  const salutation = contactName && contactName !== "Team" ? `Hi ${contactName},` : `Hi ${company} Hiring Team,`;

  const prompt = `You are writing a job application email on behalf of Rishav Tarway. Follow the format EXACTLY.

JOB POST:
"${safeSlice(jobText, 800)}"

TARGET COMPANY: ${company}

ABOUT RISHAV:
- 19 months experience across 5 internships (including MOSIP, Classplus).
- Tech Skills: Node.js, React, Android, Python, System Optimization, AI/ML.

FORMAT RULES:
1. SUBJECT LINE: MUST BE EXTREMELY UNIQUE. NO TWO EMAILS SHOULD EVER HAVE MATCHING TITLES. 
   - Vary the "vibe" for each draft (e.g., one value-driven, one curious, one direct).
   - STRICTLY rotate between double brackets/braces/parentheses: {{Subject}}, [[Subject]], or ((Subject)). 
   - Integrate unique symbols in EVERY title: :, >>, |, //, ++, --, <>, !=, ==.
   - Use specific details from the job post to ensure uniqueness. NO emojis.
   - Example styles: "{{Scaling ${company} >> P1 Insight}}", "[[Observed: ${company} Backend]] // Question", "((Curious about ${company} mission)) ++ Rishav".
2. STRICTLY 2 PARAGRAPHS FOR AI TO GENERATE (I will manually append the 3rd):
   - OVERALL LIMIT: The complete email should never exceed 120 - 150 words.
   - Para 1: EXACTLY ONE SHORT SENTENCE (max 20 words). Explicitly align the company's mission/goals from the job post with Rishav's specific tech skills.
   - Para 2: EXACTLY ONE SHORT SENTENCE (max 20 words). Summarize his experience across all 5 internships and showcase how those core tech skills drove impact.
3. Keep the content limited to 1 or 1.5 lines per paragraph. NO sign-off. NO fluff.

RESPOND WITH RAW JSON ONLY:
{ "subject": "...", "para1": "...", "para2": "..." }`;

  const result = await callAI(prompt, true);

  const fallbackSubject = `{{Inquiry}} Software Development >> ${company}`;
  const p1 = result?.para1 || `I am reaching out regarding the open role at ${company}. My robust foundation in system optimization and backend telemetry strongly aligns with your mission and technical requirements.`;
  const p2 = result?.para2 || `Over the past 19 months across 5 intensive internships (including MOSIP and Classplus), I have extensively utilized Node.js, React, and Android development to scale dynamic applications and drastically reduce system latency.`;
  const p3 = `My Open Source Recent PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and detailed projects: <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (60fps Crypto Tracker — React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (AI Resume Builder — GPT-4/FastAPI).`;
  
  const subject = result?.subject || fallbackSubject;
  const bodyRaw = `<p>${salutation}</p><p>${p1}</p><p>${p2}</p><p>${p3}</p>`;

  return { subject, body: bodyRaw + SIGNATURE_HTML };
}

async function generateFollowUpContent(jobText: string, company: string, contactName: string): Promise<{ subject: string, body: string }> {
  const salutation = contactName && contactName !== "Team" ? `Hi ${contactName},` : `Hi Team,`;

  const prompt = `You are writing a polite follow-up application on behalf of Rishav Tarway. 
  Rishav previously applied but wanted to quickly bump the thread to show his continued interest.

  JOB POST SUMMARY:
  "${safeSlice(jobText, 500)}"
  
  TARGET COMPANY: ${company}
  RECIPIENT: ${contactName || "Team"}

  FORMAT RULES (follow exactly):
  1. SUBJECT LINE: Catchy, unique, and different from the initial application. STRICTLY use varied brackets like {{Subject}}, [[Subject]], or ((Subject)). Include symbols like :, >>, or |. NO emojis. Example: "{{Quick Check}} ${company} infrastructure", "[[Bump]] Re: Engineering @ ${company}".
  2. BODY:
    - Start with salutation: "${salutation}"
    - Paragraph 1: Mention he applied earlier and is checking in because he is very excited about the mission and the role.
    - Paragraph 2: Briefly (1 sentence) re-emphasize that his 19 months of experience at MOSIP/Classplus makes him a strong candidate.
    - Paragraph 3: Thank them for their time and mention he is available for a quick chat.
  3. DO NOT include sign-off.
  4. RESPOND WITH PURE JSON ONLY:
  { "subject": "...", "body": "<p>${salutation}</p><p>Para 1</p><p>Para 2</p><p>Para 3</p>" }`;

  const result = await callAI(prompt, true);
  const fallbackBody = `<p>${salutation}</p><p>I'm bumping this to re-iterate my interest in the SWE opening at ${company}. Having worked on high-scale systems at Classplus, I'm confident I can contribute effectively to your team.</p><p>Thank you for your time, and I look forward to hearing from you soon.</p>`;

  if (!result || typeof result !== 'object') {
    return { subject: `[Follow-up] SWE Role at ${company}`, body: fallbackBody + SIGNATURE_HTML };
  }
  const subject = typeof result.subject === 'string' ? result.subject : `[Follow-up] SWE Role at ${company}`;
  const bodyRaw = typeof result.body === 'string' ? result.body : fallbackBody;

  return { subject, body: bodyRaw + SIGNATURE_HTML };
}

async function createDraftInGmail(gmail: any, toEmail: string, subject: string, htmlBody: string) {
  const mailOptions = { to: toEmail, subject: subject, html: htmlBody, attachments: ATTACHMENTS };
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

// ============================================================================
// MAIN EXECUTION
// ============================================================================
async function main() {
  console.log("==================================================");
  console.log("   !!! JOBPULSE DISCOVERY AGENT v2.0 !!!   ");
  console.log("==================================================");
  console.log("   AUTOMATED JOB APPLICATION WORKFLOW INITIATED   ");
  console.log("==================================================");

  const config = Config.getInstance();
  globalClient = new TelegramClient(config.telegram);

  const cleanup = async (signal: string) => {
    console.log(`\n🛑 Received ${signal}. Closing sessions...`);
    if (globalClient) try { await globalClient.disconnect(); } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', () => cleanup('SIGINT'));
  process.on('SIGTERM', () => cleanup('SIGTERM'));

  try {
    const auth = await authorizeGmail();
    const jobs = await extractNewJobs(globalClient);
    if (jobs.length > 0) {
      console.log(`\n🚀 [PHASE 2] Connecting to Gmail and processing ${jobs.length} jobs...`);
      const gmail = google.gmail({ version: 'v1', auth: auth as any });
      
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const company = job.company || "Unknown";
        const contact = extractName(job.email, job.text);
        
        const alreadySent = await checkIfSentInGmail(gmail, job.email);
        if (alreadySent) {
          console.log(`\n[${i + 1}/${jobs.length}] Skipping ${company} (Date: ${job.date}, already sent)`);
          continue;
        }

        console.log(`\n[${i + 1}/${jobs.length}] Processing INITIAL for ${company} (${job.email})`);
        const { subject, body } = await generateEmailContent(job.text, company, contact);

        try {
          await createDraftInGmail(gmail, job.email, subject, body);
          console.log(`   ✅ Draft created.`);
          await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              company, 
              role: "Software Engineer", 
              channel: job.channel, 
              telegramId: job.id, 
              email: job.email, 
              link: job.link, 
              description: `<b>SUBJECT: ${subject}</b><br><br>${body}`, 
              jobDescription: job.text, 
              status: 'applied', 
              type: 'telegram', 
              appliedDate: new Date().toISOString(), // Now correctly tracks when WE applied
              postedDate: job.date, // Tracks when it was posted on Telegram
              _timestamp: Date.now() 
            })
          });
        } catch (e: any) { console.error(`   ❌ Failed: ${e.message}`); }
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    
    // State is now saved immediately after discovery Phase 1.
    console.log("\n🎉 ALL DONE! Cleaning up...");
    if (globalClient) {
      await globalClient.disconnect();
    }
    process.exit(0);
  } catch (error: any) {
    console.error('❌ DISCOVERY ERROR:', error);
    if (globalClient) {
      try { await globalClient.disconnect(); } catch (e) {}
    }
    process.exit(1);
  }
}

main().catch(console.error);
