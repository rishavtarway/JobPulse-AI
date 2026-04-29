import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import dns from 'node:dns';

dotenv.config();

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

const APPLICATIONS_FILE = path.join(process.cwd(), 'applications.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly'
];

const SIGNATURE_HTML = `
<br><br>
Best, Rishav Tarway | Mobile: +91 7004544142<br>
<a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

const ATTACHMENTS = [
    { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
    { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
].filter(att => fs.existsSync(att.path));

async function authorizeGmail() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, (redirect_uris || ['http://localhost'])[0]);
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

function extractSubjectFromDescription(description: string): string | null {
    // Description is stored as: <b>SUBJECT: ...the subject...</b><br><br>body
    const match = description.match(/<b>SUBJECT:\s*([^<]+)<\/b>/i);
    if (match) return match[1].trim();
    return null;
}

function extractNameFromEmail(email: string): string {
    const localpart = email.split('@')[0];
    const nameParts = localpart.split(/[._-]/);
    if (nameParts.length > 0) {
        return nameParts[0].charAt(0).toUpperCase() + nameParts[0].slice(1);
    }
    return '';
}

async function callAI(prompt: string, jsonFlag = false): Promise<any> {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const nvidiaKey = process.env.NVIDIA_API_KEY;

    const models = [
        { provider: 'openrouter', name: 'google/gemini-2.0-flash-lite-001' },
        { provider: 'nvidia', name: 'meta/llama-3.1-70b-instruct' },
    ];

    for (const model of models) {
        try {
            let response;
            if (model.provider === 'nvidia') {
                response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: model.name, messages: [{ role: 'user', content: prompt }] })
                });
            } else {
                response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/rishavtarway', 'X-Title': 'JobPulse AI' },
                    body: JSON.stringify({ model: model.name, messages: [{ role: 'user', content: prompt }] })
                });
            }
            const data: any = await response.json();
            if (data.error) { console.log(`   ⚠️ ${model.name}: ${JSON.stringify(data.error)}`); continue; }
            if (!data.choices?.length) continue;
            const content = data.choices[0].message.content;
            if (jsonFlag) {
                try { return JSON.parse(content.substring(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { continue; }
            }
            return content;
        } catch (e: any) {
            console.log(`   ⚠️ ${model.name} failed: ${e.message}`);
        }
    }
    return null;
}

async function generateFollowUpContent(jobText: string, company: string, contactName: string): Promise<{ subject: string, body: string }> {
    const salutation = contactName ? `Hi ${contactName},` : `Hi ${company} Hiring Team,`;

    const prompt = `You are writing a follow-up job application email on behalf of Rishav Tarway. Follow the format EXACTLY.

JOB POST:
"${jobText.substring(0, 800)}"

TARGET COMPANY: ${company}

ABOUT RISHAV:
- 19 months experience across 5 internships (including MOSIP, Classplus).
- Tech Skills: Node.js, React, Android, Python, System Optimization, AI/ML.

FORMAT RULES:
1. SUBJECT LINE: MUST BE EXTREMELY UNIQUE. NO TWO FOLLOW-UP EMAILS SHOULD EVER HAVE MATCHING TITLES.
   - ALWAYS start with: [Follow up]
   - After [Follow up], use a catchy, unique bracket format. Rotate between: {{Subject}}, [[Subject]], or ((Subject)).
   - Integrate unique symbols: :, >>, |, //, ++, --, <>, !=, ==.
   - Use specific details from the job post. NO emojis.
   - Example styles: "[Follow up] {{Scaling ${company} >> P1 Insight}}", "[Follow up] [[Observed: ${company} Backend]] // Checking In", "[Follow up] ((Still excited about ${company})) ++ Rishav".
2. STRICTLY 2 PARAGRAPHS FOR AI TO GENERATE:
   - OVERALL LIMIT: The complete email should never exceed 120 - 150 words.
   - Para 1: EXACTLY ONE SHORT SENTENCE (max 20-30 words). Mention you applied a few days ago, then explicitly align the company's mission from the job post with Rishav's specific tech skills.
   - Para 2: EXACTLY ONE SHORT SENTENCE (max 20 words). Summarize his experience across all 5 internships and showcase how those core tech skills drove impact.
3. Keep the content limited to 1 or 1.5 lines per paragraph. NO sign-off. NO fluff.

RESPOND WITH RAW JSON ONLY:
{ "subject": "...", "para1": "...", "para2": "..." }`;

    const result = await callAI(prompt, true);

    const fallbackSubject = `[Follow up] {{Checking In}} ${company} >> Engineering Role`;
    const p1 = result?.para1 || `I applied to the role at ${company} a few days ago and wanted to follow up to reiterate my strong interest; your focus on ${company}'s mission directly aligns with my deep work in system optimization and backend engineering.`;
    const p2 = result?.para2 || `Over 19 months across 5 internships—including MOSIP and Classplus—I applied Node.js, React, Android, and Python to scale systems and reduce latency, consistently driving measurable impact.`;
    const p3 = `My Open Source Recent PRs <a href="https://github.com/OpenPrinting/fuzzing/pull/48">#48</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/49">#49</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/50">#50</a>, <a href="https://github.com/OpenPrinting/fuzzing/pull/51">#51</a> and detailed projects: <a href="https://github.com/rishavtarway/CoinWatch">CoinWatch</a> (60fps Crypto Tracker — React Native) and <a href="https://github.com/rishavtarway/ProResume">ProResume</a> (AI Resume Builder — GPT-4/FastAPI).`;

    const subject = result?.subject || fallbackSubject;
    const bodyRaw = `<p>${salutation}</p><p>${p1}</p><p>${p2}</p><p>${p3}</p>`;

    return { subject, body: bodyRaw + SIGNATURE_HTML };
}

async function createDraftInGmail(gmail: any, toEmail: string, subject: string, htmlBody: string) {
    const mailOptions = { to: toEmail, subject, html: htmlBody, attachments: ATTACHMENTS };
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
    console.log('\n🔄 =====================================================');
    console.log('   FOLLOW-UP DRAFT GENERATOR');
    console.log('=====================================================');

    const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));

    const now = Date.now();
    const ONE_DAY_MS = 1 * 24 * 60 * 60 * 1000;
    const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

    const candidates = apps.filter((app: any) => {
        // Must be in 'applied' status and have a valid email
        if (app.status !== 'applied') return false;
        if (!app.email || app.email === '') return false;
        
        // Already followed up? Skip.
        if (app.followedUp) return false;

        const appliedAt = new Date(app.appliedDate).getTime();
        const age = now - appliedAt;

        // Skip if applied TODAY (to avoid instant follow-ups)
        // Must be older than 20 hours (to account for different run times the next morning)
        // and younger than 6 days (to catch Wed/Thu/Fri applications on a Tuesday)
        const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;
        return age >= TWENTY_HOURS_MS && age <= SIX_DAYS_MS;
    });

    console.log(`\n📋 Found ${candidates.length} applications to follow up on (1-6 days old).\n`);

    if (candidates.length === 0) {
        console.log('✅ No follow-ups needed right now. All done!\n');
        return;
    }

    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });

    let successCount = 0;
    for (let i = 0; i < candidates.length; i++) {
        const app = candidates[i];
        const company = app.company || 'Unknown';
        const email = app.email;
        
        console.log(`[${i + 1}/${candidates.length}] Checking follow-up for ${company} (${email})`);

        try {
            // 1. Verify the original email was ACTUALLY sent
            const sentList = await gmail.users.messages.list({ userId: 'me', q: `to:${email} in:sent` });
            if (!sentList.data.messages || sentList.data.messages.length === 0) {
                console.log(`   ⏭️ Original application not yet sent in Gmail. Skipping.`);
                continue;
            }

            // 2. Verify we haven't already drafted a follow-up (avoid duplicates)
            const draftList = await gmail.users.drafts.list({ userId: 'me', q: `to:${email} subject:"[Follow up]"` });
            if (draftList.data.drafts && draftList.data.drafts.length > 0) {
                console.log(`   ⏭️ Follow-up draft already exists. Correcting state.`);
                const appIndex = apps.findIndex((a: any) => a.id === app.id);
                if (appIndex !== -1) {
                    apps[appIndex].followedUp = true;
                    apps[appIndex].followUpDate = new Date().toISOString();
                }
                continue;
            }

            const contactName = extractNameFromEmail(email);
            const jobDesc = app.jobDescription || app.description || '';

            const { subject, body } = await generateFollowUpContent(jobDesc, company, contactName);
            console.log(`   📧 Subject: ${subject}`);
            await createDraftInGmail(gmail, email, subject, body);

            // Mark as followed up in applications.json
            const appIndex = apps.findIndex((a: any) => a.id === app.id);
            if (appIndex !== -1) {
                apps[appIndex].followedUp = true;
                apps[appIndex].followUpDate = new Date().toISOString();
            }

            successCount++;
            console.log(`   ✅ Follow-up draft created.`);
        } catch (e: any) {
            console.error(`   ❌ Failed: ${e.message}`);
        }

        // Pacing
        if (i < candidates.length - 1) await new Promise(r => setTimeout(r, 3000));
    }

    fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
    console.log(`\n🎉 Done! ${successCount}/${candidates.length} follow-up drafts created.\n`);
}

main().catch(console.error);
