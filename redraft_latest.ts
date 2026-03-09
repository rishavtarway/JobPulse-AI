import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import { GoogleGenerativeAI } from '@google/generative-ai';

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

const NEW_JOBS_FILE = 'latest_jobs_to_apply.json';

const ATTACHMENTS = [
    { filename: 'OpenSourceContributions.pdf', path: path.join(process.cwd(), 'OpenSourceContributions.pdf') },
    { filename: 'RishavTarway_IIITB_InternshipCertificate.pdf', path: path.join(process.cwd(), 'RishavTarway_IIITB_InternshipCertificate.pdf') },
    { filename: 'RishavTarway-Resume.pdf', path: path.join(process.cwd(), 'RishavTarway-Resume.pdf') },
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

function extractName(email: string, text: string): string {
    const reachOutMatch = text.match(/reach out (?:to|at) ([A-Z][a-z]+)/);
    if (reachOutMatch) return reachOutMatch[1];
    const emailNameMatch = email.match(/^([a-z]+)/i);
    if (emailNameMatch && !['hr', 'career', 'careers', 'job', 'jobs', 'info', 'hello', 'contact', 'admin', 'manager', 'projects', 'talent'].includes(emailNameMatch[1].toLowerCase())) {
        return emailNameMatch[1].charAt(0).toUpperCase() + emailNameMatch[1].slice(1);
    }
    return "Team";
}

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function generateEmailContent(jobText: string, company: string, contactName: string): Promise<{ subject: string, body: string } | null> {
    const greeting = contactName === "Team" ? `Hi Team ${company}` : `Hi ${contactName}`;
    const prompt = `
Generate a cold email application as exactly JSON. Do not write any other text.
Job Description: "${jobText}"
Company Name: ${company}

MUST follow these STRICT RULES:
1. ONLY return a JSON object with two keys: "subject" and "body"
2. "subject" must be in format: "<Role Name> Application | <Catchy 3-word phrase> | Rishav Tarway"
3. "body" must be exactly 3 paragraphs formatted with HTML <p> tags.
4. Paragraph 1: Start with "I hope you are doing well. My name is Rishav Tarway and I am reaching out because I have been following ${company} and appreciate the company's commitment to <extract 1 core technical focus of this company from job desc>."
5. Paragraph 2: "With my experience in <mention 1-2 skills from the job desc that match Classplus or IIIT Bangalore or Franchizerz internships> I am excited about the possibility of contributing to the ${company} engineering team."
6. Paragraph 3: "I recently had success contributing to OpenPrinting where I was selected for Winter of Code 5.0 and successfully merged my <a href='https://github.com/OpenPrinting/fuzzing/pull/48'>recent PR #48 at OpenPrinting</a>. Writing extensive fuzzing functions to find edge cases is really driving my passion to learn the in depth architecture of software and find their vulnerabilities making me a perfect fit for this role."
7. Paragraph 4: "I would be more than happy to contribute and connect with the amazing team at ${company}. I have attached my resume along with this."
8. Paragraph 5: "Thank you and I hope to hear from you soon!"
9. NO signature or greeting in the body. Only return flat valid JSON.`;

    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not defined in .env");

    const fallbackModels = ["openrouter/free", "google/gemma-3-27b-it:free", "mistralai/mistral-7b-instruct:free", "meta-llama/llama-3.2-1b-instruct:free"];
    let currentModelIdx = 0;
    let retries = 3;

    while (retries > 0 && currentModelIdx < fallbackModels.length) {
        try {
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:3000",
                    "X-OpenRouter-Title": "Auto Apply Bot"
                },
                body: JSON.stringify({
                    model: fallbackModels[currentModelIdx],
                    messages: [
                        { role: "user", content: prompt }
                    ]
                })
            });

            if (response.status === 429 || response.status === 402) {
                console.log(`   ⏳ Model ${fallbackModels[currentModelIdx]} rate-limited/failed (${response.status}). Switching model...`);
                currentModelIdx++;
                if (currentModelIdx >= fallbackModels.length) {
                    console.log(`   ⏳ All free models exhausted! Sleeping 15s...`);
                    await sleep(15000);
                    currentModelIdx = 0;
                    retries--;
                }
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`OpenRouter API error: ${response.status} ${errorText}`);
            }

            const result = await response.json();
            const responseText = result.choices[0].message.content;

            let parsed = { subject: "Application | Software Engineer | Rishav Tarway", body: responseText };
            try {
                let content = responseText.replace(/^```[a-z]*\n/, '').replace(/\n```$/, '').trim();
                if (content.startsWith('```')) content = content.substring(3).trim();
                if (content.startsWith('json\n')) content = content.substring(5).trim();
                if (content.endsWith('```')) content = content.substring(0, content.length - 3).trim();

                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    parsed = JSON.parse(jsonMatch[0]);
                } else if (content.startsWith("{")) {
                    parsed = JSON.parse(content);
                }
            } catch (jsonErr) {
                let safeBody = responseText.replace(/\n\n/g, '</p><p>').replace(/\n/g, ' ');
                if (!safeBody.startsWith('<p>')) safeBody = '<p>' + safeBody + '</p>';
                parsed = { subject: `Software Engineering Application | ${company} | Rishav Tarway`, body: safeBody };
            }

            parsed.subject = (parsed.subject || `Application | ${company} | Rishav Tarway`).replace(/[,\[\]\(\)]/g, '');
            parsed.body = (parsed.body || parsed.subject).replace(/[,\[\]\(\)]/g, '');

            return { subject: parsed.subject, body: `<p>${greeting}</p>${parsed.body}${SIGNATURE_HTML}` };
        } catch (error: any) {
            console.error(`   ⚠️ Attempt failed generating AI content for ${company}: ${error.message}`);
            currentModelIdx++;
        }
    }
    return null;
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
                        if (Buffer.isBuffer(info.message)) {
                            return resolve(info.message);
                        }
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

async function main() {
    console.log("==================================================");
    console.log("   REDRAFTING 21 FAILED EMAILS FROM JSON LOG      ");
    console.log("==================================================");

    if (!fs.existsSync(NEW_JOBS_FILE)) {
        console.error("Could not find", NEW_JOBS_FILE);
        process.exit(1);
    }

    const rawJobs = fs.readFileSync(NEW_JOBS_FILE, 'utf8');
    const newJobs = JSON.parse(rawJobs);

    console.log(`\n🚀 [PHASE 2] Connecting to Gmail and processing ${newJobs.length} jobs...`);
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth });

    for (let i = 0; i < newJobs.length; i++) {
        const job = newJobs[i];
        const domainMatch = job.email.match(/@([a-zA-Z0-9.-]+)\./);
        const companyName = domainMatch ? domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1) : "your company";
        const contactName = extractName(job.email, job.text);

        console.log(`\n[${i + 1}/${newJobs.length}] Drafting for ${companyName} (${job.email})`);

        const result = await generateEmailContent(job.text, companyName, contactName);

        if (result) {
            try {
                await createDraftInGmail(gmail, job.email, result.subject, result.body);
                console.log(`   ✅ Draft created in Gmail.`);
            } catch (e: any) {
                console.error(`   ❌ Failed to create draft:`, e.message);
            }
        } else {
            console.log(`   ⚠️ Skipping draft for ${companyName} due to generation failure.`);
        }

        console.log("   Sleeping 5s to avoid rate limiting...");
        await sleep(5000);
    }

    console.log("\n==================================================");
    console.log(" 🎉 ALL DONE! Please check your Gmail Drafts. ");
    console.log("==================================================");
    process.exit(0);
}

main().catch(console.error);
