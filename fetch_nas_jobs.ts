import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import readline from 'readline';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import { Config } from './src/config/index.js';

dotenv.config();

const APPLICATIONS_FILE = path.join(process.cwd(), 'applications.json');
const SERVER_PORT = process.env.SERVER_PORT || '3000';

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
// HELPERS
// ============================================================================

function isAlreadyApplied(jobId: string, channelName: string): boolean {
  if (!fs.existsSync(APPLICATIONS_FILE)) return false;
  try {
    const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
    return apps.some((app: any) => app.telegramId === jobId && app.channel === channelName);
  } catch(e) {
    return false;
  }
}

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

// ============================================================================
// MAIN SCRAPER - GUIDED EXPERT MODE
// ============================================================================

async function scrapeNasIoDaily() {
    console.log("🚀 Starting Human-Guided NAS.io Web Scraper & Auto-Applier...");
    
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });
    
    // Launch Chrome profile exactly so you can guide it
    const browser = await puppeteer.launch({
        headless: false, 
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        userDataDir: path.join(process.cwd(), 'nas_chrome_profile'),
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();
    const channelLabel = "TechUprise NAS";
    
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const askQuestion = (query: string): Promise<string> => new Promise(resolve => rl.question(query, resolve));
    
    try {
        console.log("📡 Navigating to community website...");
        await page.goto("https://nas.com/techuprise-insider-club/community", { waitUntil: 'networkidle2' });
        
        await askQuestion("\n🔔 SYSTEM READY: Please log in to NAS.com in the popup window if needed.\n   Navigate to the 'Community' feed so it's fully loaded.\n   Press [ENTER] here once you are ready to begin scraping...");
        
        const validJobs: any[] = [];
        let isExtracting = true;
        
        while (isExtracting) {
            const answer = await askQuestion("\n✅ READY FOR NEXT POST\n➡️ Manually click to open a post in the browser (e.g., the 21h ago one).\n   [Press ENTER] when the post is open to scrape it OR [Type 'done' and press ENTER] to finish: ");
            
            if (answer.trim().toLowerCase() === 'done') {
                isExtracting = false;
                break;
            }
            
            // Scrape the currently open page exactly as you see it!
            const currentUrl = await page.url();
            const urlPath = new URL(currentUrl).pathname;
            console.log(`\n🔍 Scraping current open view: ${currentUrl}`);
            
            console.log(`   📜 Scrolling deeply to ensure entire post is fully loaded...`);
            await page.evaluate(async () => {
                await new Promise((resolve) => {
                    let scrolls = 0;
                    // Attempt to scroll the main window, and also any inner containers if it's a modal overlay
                    const scrollableDivs = Array.from(document.querySelectorAll('div')).filter(el => el.scrollHeight > el.clientHeight && el.clientHeight > 200);
                    const timer = setInterval(() => {
                        window.scrollBy(0, 600);
                        if(scrollableDivs.length > 0) scrollableDivs.forEach(div => div.scrollBy(0, 600));
                        scrolls++;
                        if(scrolls >= 8){
                            clearInterval(timer);
                            resolve(null);
                        }
                    }, 400);
                });
            });
            
            const postContent = await page.evaluate(() => document.body.innerText);
            
            console.log(`   🧠 Analyzing text content (length: ${postContent.length}). Sending ENTIRE page text to AI!`);
            
            const prompt = `This text contains multiple job postings. Extract each individual job and return a JSON array containing the job objects. 
Only include jobs that have an application email or specific link.
Each object should have:
- "text": The complete original text segment for that single job.
- "company": Extracted company name.
- "email": The HR/Appliction email address (if present). Exclude if missing.
- "link": Job application link (if present). Exclude if missing.
- "id": Provide a short unique identifier for this particular job within this post (like company name + random string).

TEXT:
${postContent}`;

            const extracted = await callAI(prompt, true);
            if (Array.isArray(extracted) && extracted.length > 0) {
                console.log(`   🌟 AI Extracted ${extracted.length} jobs from this page!`);
                for (const job of extracted) {
                    if (!job.email && !job.link) continue; 
                    
                    const dedupeId = `${urlPath}-${job.id || job.company}`.replace(/[^a-zA-Z0-9-]/g, '');
                    
                    if (isAlreadyApplied(dedupeId, channelLabel)) {
                        console.log(`   ⏭️ Skipping already applied job: ${job.company}`);
                        continue;
                    }
                    
                    validJobs.push({
                        ...job,
                        dedupeId,
                        date: new Date().toISOString()
                    });
                    console.log(`   ➕ Queueing Job: ${job.company}`);
                }
            } else {
                console.log(`   ⚠️ AI couldn't find any distinct jobs with emails/links on this specific page. Try another post.`);
            }
        }

        console.log(`\n🎯 Proceeding to process ${validJobs.length} accumulated jobs for auto-application!`);
        
        if (validJobs.length > 0) {
            // ------------- DRAFTING EMAILS & DASHBOARDING -------------
            let currentSchedule = new Date();
            currentSchedule.setMinutes(currentSchedule.getMinutes() + 1);

            for (let i = 0; i < validJobs.length; i++) {
                const job = validJobs[i];
                const draftNum = i + 1;
                
                if (job.email) {
                    console.log(`\n[${draftNum}/${validJobs.length}] Processing Email Draft for ${job.company}...`);
                    const { subject, body } = await generateEmailContent(job.text, job.company);
                    console.log(`   📧 Draft Subject: ${subject}`);
                    
                    await createDraft(gmail, job.email, subject, body);
                    console.log(`   ✅ Draft created.`);
                    
                    // Track on Dashboard
                    try {
                        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                company: job.company || "Unknown", role: "Software Engineer", channel: channelLabel, telegramId: job.dedupeId, email: job.email, status: 'applied', type: 'web', appliedDate: job.date, description: `<b>SUBJECT: ${subject}</b><br><br>${body}`
                            })
                        });
                    } catch (e) {}
                    
                } else if (job.link) {
                     console.log(`\n[${draftNum}/${validJobs.length}] Saving Manual App Link for ${job.company}...`);
                      try {
                        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                company: job.company || "Unknown", role: "Software Engineer", channel: channelLabel, telegramId: job.dedupeId, link: job.link, description: job.text, status: 'to_apply', type: 'web', appliedDate: job.date
                            })
                        });
                        console.log(`   ✅ Logged to Dashboard.`);
                    } catch (e) {}
                }
                
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        console.log("\n🚀 ALL DONE! Exiting securely.");
        
    } catch (e) {
        console.error("❌ Scraper Error:", e);
    } finally {
        rl.close();
        await browser.close();
    }
}

scrapeNasIoDaily();
