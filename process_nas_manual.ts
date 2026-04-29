import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

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
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("Missing GEMINI_API_KEY in environment!");
        return null;
    }
    
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    temperature: 0.7,
                    responseMimeType: jsonFlag ? "application/json" : "text/plain"
                }
            })
        });
        const data: any = await response.json();
        
        if (data.error) {
            console.error("API Error Response:", data.error.message);
            return null;
        }

        const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (!content) {
             console.error("Unknown API structure:", data);
             return null;
        }

        if (jsonFlag) {
            try {
                // Strip markdown formatting if AI used it
                let cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();
                const firstBracket = cleanContent.indexOf('{');
                const firstSquare = cleanContent.indexOf('[');
                if (firstBracket === -1 && firstSquare === -1) {
                    console.log("No JSON structure found. Raw snippet:", cleanContent.substring(0, 200));
                    return null;
                }
                const isArray = firstSquare !== -1 && (firstBracket === -1 || firstSquare < firstBracket);
                const start = isArray ? firstSquare : firstBracket;
                const end = isArray ? cleanContent.lastIndexOf(']') : cleanContent.lastIndexOf('}');
                return JSON.parse(cleanContent.substring(start, end + 1));
            } catch (e) { 
                console.error("JSON PARSE ERROR. AI Output was:", content.substring(0, 1000));
                return null; 
            }
        }
        return content;
    } catch (e) {
        console.error("Fetch API Error:", e);
        return null;
    }
}

async function generateEmailContent(jobText: string, company: string): Promise<{ subject: string, body: string }> {
  const prompt = `Write an extremely human-sounding, professional 2-paragraph intro for a job application.
  
  JOB DESCRIPTION: "${jobText.substring(0, 800)}"
  COMPANY: ${company}

  USER CONTEXT (Rishav Tarway):
  - 19 months experience across 5 internships (including MOSIP, Classplus).
  - Tech Skills: Node.js, React, Android, Python, System Optimization, AI/ML.

  STRICT RULES:
  1. NO EMOJIS. NO DOUBLE QUOTES ("). NO DASHES OR EM-DASHES (--) ANYWHERE.
  2. BANNED AI WORDS: Do not use flowery AI words like 'thrive', 'delve', 'spearhead', 'tapestry', 'incredibly excited', 'dynamic', 'align'. Write like a normal software engineer texting a recruiter organically.
  3. EXACTLY 2 PARAGRAPHS FOR AI TO GENERATE (I will add a 3rd myself):
     - Para 1: Subtly connect the company's goals from the JD with my practical tech skills.
     - Para 2: Briefly mention my 5 internships including MOSIP and Classplus, and how I fix bottlenecks.
  4. LENGTH: Keep both paragraphs extremely succinct. Maximum 100 to 110 words total combined for both paragraphs, so the final email doesn't exceed 150 words.

  RESPOND WITH RAW JSON ONLY (No Markdown):
  { "para1": "...", "para2": "..." }`;

  const result = await callAI(prompt, true);
  
  const p1 = result?.para1 || `I am reaching out to apply for the open role at ${company}. I have 19 months of practical software engineering experience and I enjoy building clean and scalable applications. My primary focus is always on producing solid systems and solving complex challenges efficiently.`;
  const p2 = result?.para2 || `Through my five internships including my time at MOSIP and Classplus, I have gained hands-on experience using Node.js, React, Android, and system level programming. I know how to spot performance bottlenecks and resolve them quickly to hit delivery milestones without ever compromising on code quality.`;
  
  const subjectVariations = [
    `[Application] {Software Engineer} - (${company})`,
    `(Application) [Software Engineer] : {${company}}`,
    `{Application} [Software Engineer] - (${company})`,
    `[SE Application] (${company}) - {Software Engineer}`,
    `{Software Engineer} : [Application] for (${company})`
  ];
  const subject = subjectVariations[Math.floor(Math.random() * subjectVariations.length)];

  const p3 = `You can check my recent Open Source PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and my detailed personal projects <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (a 60fps Crypto Tracker built with React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (an AI Resume Builder powered by GPT-4 and FastAPI).`;

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

// MAIN EXECUTION
async function processManualBatch() {
    console.log("🚀 Running Manual Job Batch Processor...");
    
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });
    const channelLabel = "Manual Batch Upload";
    
    const content = fs.readFileSync(path.join(process.cwd(), 'nas_manual_jobs.txt'), 'utf8');
    
    console.log(`🧠 AI is extracting distinct jobs from the provided text...`);
    const prompt = `This text contains exactly 25 multiple job postings numbered 1 to 25. Extract each individual job and return a JSON array containing the job objects. 
Only include jobs that have an application email or specific link. Extract as many as you can find.
Each object should have:
- "text": The complete original text segment for that single job.
- "company": Extracted company name.
- "email": The HR/Appliction email address (if present). Exclude if missing.
- "link": Job application link (if present). Exclude if missing.
- "id": Provide a short unique identifier for this particular job within this post (like company name + random string).

TEXT:
${content}`;

    const extracted = await callAI(prompt, true);
    const validJobs: any[] = [];
    
    if (Array.isArray(extracted) && extracted.length > 0) {
        console.log(`🌟 AI Successfully Extracted ${extracted.length} distinct jobs! Queueing for Application...`);
        for (const job of extracted) {
            if (!job.email && !job.link) continue; 
            
            const dedupeId = `manual-batch-${job.id || job.company}`.replace(/[^a-zA-Z0-9-]/g, '');
            
            validJobs.push({
                ...job,
                dedupeId,
                date: new Date().toISOString()
            });
        }
    } else {
        console.log(`⚠️ AI Extraction failed. Output was empty.`);
        return;
    }

    // PROCESS THE BATCH
    for (let i = 0; i < validJobs.length; i++) {
        const job = validJobs[i];
        const draftNum = i + 1;
        
        if (job.email) {
            console.log(`\n[${draftNum}/${validJobs.length}] Generating Email Draft for ${job.company}...`);
            const { subject, body } = await generateEmailContent(job.text, job.company);
            console.log(`   📧 Draft Subject: ${subject}`);
            
            await createDraft(gmail, job.email, subject, body);
            console.log(`   ✅ Draft created.`);
            
            const payload = { company: job.company || "Unknown", role: "Software Engineer", channel: channelLabel, telegramId: job.dedupeId, email: job.email, status: 'applied', type: 'web', appliedDate: job.date, description: `<b>SUBJECT: ${subject}</b><br><br>${body}` };
            try {
                await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } catch (e) {
                console.log("   ⚠️ Dashboard API not reachable. Saving securely to applications.json native file...");
                const apps = fs.existsSync(APPLICATIONS_FILE) ? JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8')) : [];
                apps.unshift({ id: Date.now().toString() + Math.floor(Math.random()*100), ...payload });
                fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
            }
            
        } else if (job.link) {
             console.log(`\n[${draftNum}/${validJobs.length}] Saving Manual App Link for ${job.company}...`);
             const payload = { company: job.company || "Unknown", role: "Software Engineer", channel: channelLabel, telegramId: job.dedupeId, link: job.link, description: job.text, status: 'to_apply', type: 'web', appliedDate: job.date, email: '' };
              try {
                await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                console.log(`   ✅ Logged to Dashboard.`);
            } catch (e) {
                console.log("   ⚠️ Dashboard API not reachable. Saving securely to applications.json native file...");
                const apps = fs.existsSync(APPLICATIONS_FILE) ? JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8')) : [];
                apps.unshift({ id: Date.now().toString() + Math.floor(Math.random()*100), ...payload });
                fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
                console.log(`   ✅ Logged locally.`);
            }
        }
        
        // Anti-rate-limit sleep
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log("\n🎉 ALL 25 JOBS PROCESSED AND FINISHED!");
}

processManualBatch();
