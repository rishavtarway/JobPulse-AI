import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

const loadEnv = () => {
    try {
        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            const envFile = fs.readFileSync(envPath, 'utf-8');
            envFile.split('\n').forEach(line => {
                const match = line.match(/^([^#=]+)=(.*)$/);
                if (match) process.env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '');
            });
        }
    } catch (e) { }
};
loadEnv();

const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credentials.json';
const ATTACHMENTS = [{
    filename: 'Rishav_Tarway_Resume.pdf',
    path: path.join(process.cwd(), 'resume', 'Rishav_Tarway_Resume.pdf')
}];

async function authorizeGmail() {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (!fs.existsSync(TOKEN_PATH)) {
        throw new Error("Missing token.json. Please run the main app first to authenticate.");
    }
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

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
                        if (Buffer.isBuffer(info.message)) return resolve(info.message);
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

const SIGNATURE_HTML = `<br><br>
<div style="font-family: Arial, sans-serif; font-size: 14px; color: #333;">
  <strong>Rishav Tarway</strong><br>
  Software Development Engineer<br>
  <a href="https://github.com/rishavtarway">GitHub</a> | <a href="https://linkedin.com/in/rishav-tarway">LinkedIn</a> | <a href="https://tryhards.in/">Portfolio</a><br>
</div>`;

async function generateYCPolishedEmail(company: string, mission: string, contactName: string): Promise<{ subject: string, body: string }> {
    const greeting = contactName === "Team" ? `Hi ${company} Team` : `Hi ${contactName}`;
    const prompt = `
Generate a highly polished, eye-catching cold email application to a startup founder/HR as valid JSON.
Startup Name: "${company}"
Mission/Context: "${mission}"

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. The email must be extremely punchy, designed for a 5-10 second skim by a busy Founder or HR (targeting high-growth startups like YC). It must grab attention immediately and never fail to get a reply.
3. Tone: Confident, crisp, highly professional but modern (not generic or boring).
4. Include these exact bragging points naturally, without sounding boastful:
   - 2 years of Open Source contributions (including merged PRs in OpenPrinting).
   - 6 paid internships (3 onsite, 3 remote).
   - Backend optimization & architecture experience at Classplus scaling systems.
5. Offer proof of work casually but confidently: "I have 5 links already shared on my profile, but let me know what specific tech stack PRs/links you want to see, and I will share them."
6. Focus heavily on how you can impact their specific mission/company: "${mission}". Show them you understand what they are building.
7. NO placeholders like [Company Name] or [Insert Link]. Use "${company}" exactly.
8. Include a witty but professional closing line that makes them want to reply (e.g., "I'd love to briefly chat about how I can bring this same scale and engineering rigor to ${company}." or something similar).
9. Body MUST be formatted using HTML <p> tags, keeping paragraphs very short (1-2 sentences max for skimming).
10. At the end of the content before closing, casually but boldly suggest that if they hire you, you'll save them from buying more expensive SaaS tools because you build tools locally (to add a punchy hook).`;

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const fallbackModels = ["openrouter/free", "google/gemma-3-27b-it:free", "mistralai/mistral-7b-instruct:free"];
    let currentModelIdx = 0;
    while (currentModelIdx < fallbackModels.length) {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: fallbackModels[currentModelIdx], messages: [{ role: "user", content: prompt }] })
            });

            if (response.status === 429) { currentModelIdx++; continue; }
            if (!response.ok) throw new Error(`API error: ${response.status}`);

            const result = await response.json();
            const responseText = result.choices[0].message.content;
            let parsed = { subject: "Engineering Application | Rishav Tarway", body: responseText };

            try {
                let content = responseText.replace(/^```[a-z]*\n/, '').replace(/\n```$/, '').trim();
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
                else parsed = JSON.parse(content);
            } catch (e) {
                let safeBody = responseText.replace(/\n\n/g, '</p><p>').replace(/\n/g, ' ');
                parsed = { subject: `Engineering | ${company} | Rishav Tarway`, body: safeBody };
            }

            parsed.subject = parsed.subject.replace(/[,\[\]\(\)]/g, '');
            return { subject: parsed.subject, body: `<p>${greeting},</p>${parsed.body}${SIGNATURE_HTML}` };
        } catch (e) {
            currentModelIdx++;
        }
    }

    return {
        subject: `Software Engineer | High Scale Architecture | Rishav Tarway`,
        body: `<p>${greeting},</p><p>I'm Rishav Tarway. I saw the great work being done at ${company} and wanted to reach out directly. I specialize in building and optimizing highly scalable software architecture.</p><p>For a quick background: I've completed 6 paid internships (3 onsite, 3 remote), most notably handling core backend optimization at Classplus. I've also spent the last 2 years deeply involved in Open Source, recently merging critical fuzzing architecture PRs for OpenPrinting.</p><p>Also, I'm the guy who builds internal tools from scratch locally, so you can probably cancel a few SaaS subscriptions if you hire me.</p><p>I know you're likely skimming this, so I'll keep it brief. I have several proof-of-work links attached to my profile, but let me know exactly what kind of PRs or projects you'd like to see for your stack, and I'll send them over.</p><p>Would love to chat about bringing this engineering rigor to ${company}.</p><p>Best,</p>${SIGNATURE_HTML}`
    };
}

async function parseStartupsList(text: string): Promise<any[]> {
    const prompt = `Extract a list of startups from the following text. 
Return ONLY a valid JSON array of objects. 
Each object must have exactly these keys: "company" (string), "email" (string), "mission" (string, summarizing what they do or what they need).
If an email is missing, leave it blank, but try to extract it.

Text input:
${text}`;

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "google/gemini-2.0-flash:free", messages: [{ role: "user", content: prompt }] })
        });

        if (response.ok) {
            const result = await response.json();
            const content = result.choices[0].message.content;
            const match = content.match(/\[[\s\S]*\]/);
            if (match) return JSON.parse(match[0]);
        }
    } catch (e) {
        console.error("Failed to parse startups list:", e);
    }
    return [];
}

async function main() {
    const filePath = process.argv[2];
    if (!filePath || !fs.existsSync(filePath)) {
        console.error("❌ Please provide a valid file path containing the startup list.");
        process.exit(1);
    }

    console.log("==================================================");
    console.log("   🚀 STARTING YC COLD OUTREACH PROCESS");
    console.log("==================================================");

    const txt = fs.readFileSync(filePath, 'utf8');
    if (!txt.trim()) {
        console.log("❌ File is empty.");
        process.exit(1);
    }

    console.log("🔍 Parsing startup list using AI...");
    const startups = await parseStartupsList(txt);

    if (startups.length === 0) {
        console.log("❌ No valid startups found with emails. Exiting.");
        process.exit(1);
    }

    console.log(`✅ Found ${startups.length} startup(s) to outreach.`);

    console.log("🔐 Authenticating with Gmail...");
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth });

    for (let i = 0; i < startups.length; i++) {
        const { company, email, mission } = startups[i];
        if (!email || !company) {
            console.log(`⚠️ Skipping entry ${i + 1}: Missing company or email.`);
            continue;
        }

        console.log(`\n[${i + 1}/${startups.length}] Crafting premium outreach for ${company} (${email})...`);
        const { subject, body } = await generateYCPolishedEmail(company, mission, "Team");

        try {
            await createDraftInGmail(gmail, email, subject, body);
            console.log(`   ✅ Draft created in Gmail for ${company}.`);

            // Log to tracker
            const port = process.env.SERVER_PORT || '3000';
            await fetch(`http://127.0.0.1:${port}/api/applications`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    company: company,
                    role: "Software Engineer (Founding/Core)",
                    channel: "YC Startup List",
                    email: email,
                    description: mission,
                    status: 'applied'
                })
            });
        } catch (e: any) {
            console.error(`   ❌ Failed to create draft:`, e.message);
        }

        await new Promise(r => setTimeout(r, 4000));
    }

    console.log("\n==================================================");
    console.log(" 🎉 ALL DONE! YC Pitch drafts are ready in Gmail. ");
    console.log("==================================================");
    process.exit(0);
}

main().catch(console.error);
