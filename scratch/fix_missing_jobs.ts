import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const SERVER_PORT = process.env.SERVER_PORT || '3000';
const MY_NAME = "Rishav Tarway";

const ATTACHMENTS = [
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

const p3 = `You can check my recent Open Source PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and my detailed personal projects <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (a 60fps Crypto Tracker built with React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (an AI Resume Builder powered by GPT-4 and FastAPI).`;

const SIGNATURE_HTML = `<br>Best, Rishav Tarway<br>Mobile: +91 7004544142<br><a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br><a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>`;

async function authorizeGmail() {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  return oAuth2Client;
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

function generateSubject(job: any, index: number) {
    if (job.specificSubject) {
        return job.specificSubject.replace("Your Name", MY_NAME);
    }

    const role = job.role || "Software Engineer";
    const company = job.company || "Hiring Team";
    
    const variations = [
        `[Application] {${role}} - (${company}) | ${MY_NAME}`,
        `(${MY_NAME}) [Application] for {${role}} : ${company}`,
        `{Application} [${role}] at (${company}) - ${MY_NAME}`,
        `[Job Application] {${role}} - (${company}) : ${MY_NAME}`,
        `(${company}) [${role}] Application | {${MY_NAME}}`,
        `{${role}} Role at (${company}) [Application] - ${MY_NAME}`
    ];
    
    return variations[index % variations.length];
}

async function run() {
  const allJobs = JSON.parse(fs.readFileSync('jobs_batch_56.json', 'utf8'));
  const missingIds = [22, 30, 33, 35, 50, 55]; // 55 was the one that failed

  const jobsData = allJobs.filter((job: any) => missingIds.includes(parseInt(job.id)));

  console.log(`🚀 Processing ${jobsData.length} missing/failed jobs...`);
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: 'v1', auth: auth as any });

  for (let i = 0; i < jobsData.length; i++) {
    const job = jobsData[i];
    
    // Fix email for #55
    if (job.id === "55" && job.email) {
        job.email = job.email.replace(/\.$/, "");
    }

    // Fix link for LinkedIn ones
    if (!job.link && job.description.includes("linkedin.com/in/")) {
        const m = job.description.match(/(https?:\/\/www\.linkedin\.com\/in\/[^\s]+)/);
        if (m) job.link = m[1];
    }

    // Fix phone number only ones
    let phone = null;
    if (!job.email && !job.link) {
        const m = job.description.match(/(\d{10})/);
        if (m) phone = m[1];
    }

    if (job.email) {
      console.log(`[${i+1}/${jobsData.length}] Drafting email for ${job.company} (${job.email})...`);
      const subject = generateSubject(job, i);
      const body = `<p>Hi ${job.company} Hiring Team,</p><p>I am reaching out to apply for the ${job.role} position at ${job.company}...</p><p>${p3}</p><p>Best,</p>`;
      
      try {
          await createDraft(gmail, job.email, subject, body);
          console.log(`   ✅ Draft created.`);
      } catch (e) {
          console.error(`   ❌ Failed to create draft: ${e}`);
      }
      
      await syncToDashboard({ 
          company: job.company, role: job.role, channel: "Batch Fix", 
          telegramId: `batch56-${job.id}`, email: job.email, status: 'applied', type: 'web', 
          description: `<b>SUBJECT: ${subject}</b><br><br>${body}` 
      });
    } else if (job.link) {
      console.log(`[${i+1}/${jobsData.length}] Adding manual link for ${job.company} (${job.link})...`);
      await syncToDashboard({ 
          company: job.company, role: job.role, channel: "Batch Fix", 
          telegramId: `batch56-${job.id}`, link: job.link, status: 'to_apply', type: 'web', 
          description: "LinkedIn Referral Link" 
      });
    } else if (phone) {
      console.log(`[${i+1}/${jobsData.length}] Adding phone contact for ${job.company} (${phone})...`);
      await syncToDashboard({ 
          company: job.company, role: job.role, channel: "Batch Fix", 
          telegramId: `batch56-${job.id}`, notes: `Phone: ${phone}`, status: 'to_apply', type: 'web', 
          description: `Contact via Phone: ${phone}` 
      });
    }
  }
  console.log("✅ Fix complete.");
}

async function syncToDashboard(payload: any) {
    try {
        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
    } catch(e) {
        const APPS_FILE = path.join(process.cwd(), 'applications.json');
        const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        apps.unshift({ id: Date.now().toString() + Math.floor(Math.random()*100), ...payload });
        fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
    }
}

run();
