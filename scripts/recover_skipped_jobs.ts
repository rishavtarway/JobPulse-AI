import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { TelegramClient } from '../src/telegram/client.js';
import { Config } from '../src/config/index.js';

dotenv.config();

const APPLICATIONS_FILE = path.join(process.cwd(), 'applications.json');
const SERVER_PORT = 3001;

// Reuse signature from auto_apply logic
const SIGNATURE_HTML = `<br><br>Best Regards,<br><b>Rishav Tarway</b><br>Full Stack Developer & AI/ML Engineer<br>Mobile: +91 7004544142<br><a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://github.com/rishavtarway">GitHub</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a><br><a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>Gurugram, Haryana, India`;

const ATTACHMENTS = [
  {
    filename: 'RishavTarway-Resume.pdf',
    path: path.join(process.cwd(), 'RishavTarway-Resume.pdf')
  }
];

async function authorizeGmail() {
    const creds = JSON.parse(fs.readFileSync('credential.json', 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, (redirect_uris || ['http://localhost'])[0]);
    const token = JSON.parse(fs.readFileSync('token.json', 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

function isAlreadyApplied(msgId: string): boolean {
    if (!fs.existsSync(APPLICATIONS_FILE)) return false;
    const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
    return apps.some((app: any) => app.telegramId === msgId);
}

async function callAI(prompt: string, jsonFlag = false): Promise<any> {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const response = await fetch(`https://openrouter.ai/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'google/gemini-2.0-flash-lite-001',
            messages: [{ role: "user", content: prompt }]
        })
    });
    const data: any = await response.json();
    const content = data.choices[0].message.content;
    if (jsonFlag) {
        try {
            return JSON.parse(content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1));
        } catch { return null; }
    }
    return content;
}

async function generateEmailContent(jobText: string, company: string, contactName: string): Promise<{ subject: string, para1: string, para2: string }> {
    const prompt = `Write a job application email for Rishav Tarway. 
    Company: ${company}
    Job: ${jobText}
    
    Rules:
    - 2 paragraphs total.
    - Para 1: Link company mission to Rishav's technical skills (max 20 words).
    - Para 2: Summarize 19 months across 5 internships (MOSIP, Classplus) and impact (max 20 words).
    - Return JSON { subject: "...", para1: "...", para2: "..." }`;
    
    return await callAI(prompt, true);
}

async function createDraft(gmail: any, to: string, subject: string, body: string) {
    const mailOptions = { to, subject, html: body, attachments: ATTACHMENTS };
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

async function main() {
    console.log("🚀 RECOVERING SKIPPED JOBS FROM LAST 24H...");
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });

    try {
        const targetChannel = { id: '-1003338916645', name: 'TechUprise Premium' }; // Hardcoded for recovery
        const messages = await client.getMessages(targetChannel.id, 150);
        
        const now = Date.now();
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

        let processCount = 0;
        for (const m of messages) {
            const msgDate = m.date * 1000;
            if (now - msgDate > TWENTY_FOUR_HOURS) continue;

            const text = m.text || m.mediaCaption || "";
            if (!text.trim()) continue;

            const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i);
            if (!emailMatch) continue;

            if (isAlreadyApplied(m.id.toString())) {
                console.log(`[ID:${m.id}] Already handled. Skipping.`);
                continue;
            }

            console.log(`[ID:${m.id}] Found potentially skipped job. Extracting company...`);
            const company = await callAI(`Extract company name from: ${text.substring(0, 200)}. Return only the name.`);
            
            console.log(`[ID:${m.id}] Drafting for ${company}...`);
            const { subject, para1, para2 } = await generateEmailContent(text, company, "Team");
            const p3 = `My Open Source Recent PRs #48, #49, #50, #51 and projects: CoinWatch and ProResume.`;
            const salutation = `Hi ${company} Team,`;
            const body = `<p>${salutation}</p><p>${para1}</p><p>${para2}</p><p>${p3}</p>${SIGNATURE_HTML}`;

            try {
                await createDraft(gmail, emailMatch[1], subject, body);
                console.log(`   ✅ Draft created for ${emailMatch[1]}`);
                
                // Track in applications.json
                await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        company, role: "Software Engineer", channel: targetChannel.name,
                        telegramId: m.id.toString(), email: emailMatch[1],
                        description: body, jobDescription: text, status: 'applied',
                        type: 'telegram', appliedDate: new Date().toISOString()
                    })
                });
                processCount++;
            } catch (e: any) {
                console.error(`   ❌ Failed: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 3000));
        }

        console.log(`\n🎉 FINISHED! Drafted ${processCount} missed jobs.`);
    } finally {
        await client.disconnect();
    }
}

main().catch(console.error);
