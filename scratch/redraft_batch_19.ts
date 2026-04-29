import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
dotenv.config();

const ATTACHMENTS = [
  { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
  { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
  { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
  { filename: 'SRIP_CompletionLetter Certificate2025_IIITB.pdf', path: path.join(process.cwd(), 'SRIP_CompletionLetter Certificate2025_IIITB.pdf') }
].filter(att => fs.existsSync(att.path));

const p3 = `You can check my recent Open Source PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and my detailed personal projects <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (a 60fps Crypto Tracker built with React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (an AI Resume Builder powered by GPT-4 and FastAPI).`;

// The signature already has "Best," so we don't need to add it again in the body.
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

async function run() {
  const jobsPath = path.join(process.cwd(), 'jobs_batch_19.json');
  const jobsData = JSON.parse(fs.readFileSync(jobsPath, 'utf8'));

  console.log(`🚀 Redrafting emails for ${jobsData.length} tailored jobs...`);
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: 'v1', auth: auth as any });

  for (let i = 0; i < jobsData.length; i++) {
    const job = jobsData[i];
    
    // Only process the ones with emails
    if (job.email) {
      console.log(`[${i+1}/${jobsData.length}] Drafting email for ${job.company} (${job.email})...`);
      
      // Removed the <p>Best,</p> from here since the signature has it!
      const fullBody = `<p>Hi ${job.company} Hiring Team,</p>${job.bodyHtml}<p>${p3}</p>`;
      
      try {
          await createDraft(gmail, job.email, job.subject, fullBody);
          console.log(`   ✅ Draft created without duplicate 'Best'.`);
      } catch (e) {
          console.error(`   ❌ Failed to create draft: ${e}`);
      }
    }
  }
  console.log("✅ Draft generation complete.");
}

run();
