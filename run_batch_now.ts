import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const SERVER_PORT = process.env.SERVER_PORT || '3000';
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

const jobsData = [
  { company: "UHarvest", email: "mahima.tripathi@uharvest.in" },
  { company: "Yoeki Soft Pvt Ltd", email: "tanya@yoekisoft.com" },
  { company: "Tekishub", email: "veer.singh@tekishub.com" },
  { company: "Swageazy", email: "amisha@swageazy.com" },
  { company: "KreedaLabs", email: "careers@kreedalabs.com" },
  { company: "Intellisofttech", email: "bhanu@intellisofttech.com" },
  { company: "Demandify Media", email: "pooja.chitale@demandifymedia.com" },
  { company: "Evon Technologies", email: "anjali.chauhan1@evontech.com" },
  { company: "MoonDive", email: "careers@moondive.co" },
  { company: "ODIO", email: "preeti.rai@ezeiatech.com" },
  { company: "Chubb", email: "nithya.b@chubb.com" },
  { company: "MindInventory", email: "shivali.dhinoja@mindinventory.com" },
  { company: "SMT Labs", email: "vaishnavi.shukla@smtlabs.io" },
  { company: "Finicity (Mastercard)", email: "shubham.bhatt@mastercard.com" },
  { company: "Insights IT", email: "hr@insightsits.com" },
  { company: "Cars24", email: "aihiring@cars24.com" },
  { company: "Studio1HQ", email: "arindam@studio1hq.com" },
  { company: "WM", email: "schauha3@wm.com" },
  
  // Manual links
  { company: "Kovilpatti Hiring", link: "https://docs.google.com/forms/d/e/1FAIpQLSdN-tnR2gSjyTb0FjyAakxzcw5RUxMtHpWx9DEBLN24tzK4zg/viewform" },
  { company: "Hawky.ai", link: "https://docs.google.com/forms/d/e/1FAIpQLScWh3o6haY1KyKdyRKqxzJoC01BV8FVAuESxHp_XOhGVRUuqQ/viewform" },
  { company: "House Of Edtech", link: "https://docs.google.com/forms/d/e/1FAIpQLSejh4kbB_2aRThkriD-M5qJeT3Zq8vnqL7e1zQxrJ5xOvf3og/viewform" },
  { company: "Dcluttr", link: "https://docs.google.com/forms/d/e/1FAIpQLSeAxPl81aaCi6N8h9wVYBgc-QssVpUlD74GKe6PqFOsMmFGWQ/viewform" },
  { company: "MobiKwik", link: "https://docs.google.com/forms/d/e/1FAIpQLSemKHtkx58Y8UifVC9480flT0UdTDiQrvn3h0n8hWmn6ed7fw/viewform?usp=send_form" },
  { company: "Groww", link: "https://docs.google.com/forms/d/e/1FAIpQLScIPYkfCsDFGmyyGVS8aTnykbXOsSxWkh5RQ8mGcJMBKjjy_w/viewform" },
  { company: "Remote SDE III", link: "https://docs.google.com/forms/d/e/1FAIpQLScX3mnrvSBNBxxh5g__5q5lZTIeAnWdEeaVLSavD642rph6KQ/viewform" }
];

async function run() {
  console.log("🚀 Agent Antigravity is processing the 25 jobs directly!");
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: 'v1', auth: auth as any });

  for (let i = 0; i < jobsData.length; i++) {
    const job = jobsData[i];
    
    if (job.email) {
      console.log(`[${i+1}/${jobsData.length}] Drafting customized email for ${job.company}...`);
      const subjectVariations = [
        `[Application] {Software Engineer} - (${job.company})`,
        `(Application) [Software Engineer] : {${job.company}}`,
        `{Application} [Software Engineer] - (${job.company})`,
        `[SE Application] (${job.company}) - {Software Engineer}`,
        `{Software Engineer} : [Application] for (${job.company})`
      ];
      const subject = subjectVariations[i % subjectVariations.length];
      const p1 = `I am reaching out to apply for the open role at ${job.company}. I have 19 months of practical software engineering experience and I enjoy building clean and scalable applications. My primary focus is always on producing solid systems and solving complex challenges efficiently.`;
      const p2 = `Through my five internships including my time at MOSIP and Classplus, I have gained hands-on experience using Node.js, React, Android, and system level programming. I know how to spot performance bottlenecks and resolve them quickly to hit delivery milestones without ever compromising on code quality.`;
      
      const body = `<p>Hi ${job.company} Hiring Team,</p><p>${p1}</p><p>${p2}</p><p>${p3}</p><p>Best,</p>`;
      
      // await createDraft(gmail, job.email, subject, body); // DISABLED: Drafts already created
      
      const payload = { company: job.company, role: "Software Engineer", channel: "Antigravity Extractor", telegramId: `antigrav-${Math.random().toString(36).substr(2, 9)}`, email: job.email, status: 'applied', type: 'web', appliedDate: new Date().toISOString(), description: `<b>SUBJECT: ${subject}</b><br><br>${body}` };
      
      try {
        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch(e) {
          const APPS_FILE = path.join(process.cwd(), 'applications.json');
          const apps = fs.existsSync(APPS_FILE) ? JSON.parse(fs.readFileSync(APPS_FILE, 'utf8')) : [];
          apps.unshift({ id: Date.now().toString() + Math.floor(Math.random()*100), ...payload });
          fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
      }
    } else if (job.link) {
      console.log(`[${i+1}/${jobsData.length}] Sending manual link to dashboard for ${job.company}...`);
      const payload = { company: job.company, role: "Software Engineer", channel: "Antigravity Extractor", telegramId: `antigrav-${Math.random().toString(36).substr(2, 9)}`, link: job.link, description: "Extracted Manual Link", status: 'to_apply', type: 'web', appliedDate: new Date().toISOString(), email: '' };
      try {
        await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch(e) {
          const APPS_FILE = path.join(process.cwd(), 'applications.json');
          const apps = fs.existsSync(APPS_FILE) ? JSON.parse(fs.readFileSync(APPS_FILE, 'utf8')) : [];
          apps.unshift({ id: Date.now().toString() + Math.floor(Math.random()*100), ...payload });
          fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
      }
    }
  }
  console.log("✅ ALL JOBS DASHBOARD-SYNCED SUCCESSFULLY.");
}

run();
