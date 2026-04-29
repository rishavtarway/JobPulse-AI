import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dns from 'node:dns';
import fetch from 'node-fetch';

if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

// --- CONFIG & ENV ---
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
const CREDENTIALS_PATH = 'credential.json';
const LOGS_FILE = 'MANUAL_BATCH_LOGS.md';

const SIGNATURE_HTML = `
<br><br>
Regards,<br>
<strong>Rishav Tarway</strong><br>
<a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

// --- GMAIL SETUP ---
async function authorizeGmail() {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    if (!fs.existsSync(TOKEN_PATH)) throw new Error("Missing token.json");
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function createDraftInGmail(gmail: any, to: string, subject: string, body: string) {
    const message = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/html; charset=utf-8',
        'MIME-Version: 1.0',
        '',
        body
    ].join('\n');
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encodedMessage } } });
}

async function searchWeb(query: string) {
    try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(10000)
        });
        const html = await response.text();
        const results = [];
        const resultBlobs = html.split('class="result__body"');
        for (let i = 1; i < resultBlobs.length; i++) {
            const blob = resultBlobs[i];
            const titleMatch = blob.match(/<a class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
            const snippetMatch = blob.match(/<a class="result__snippet[^>]+>([\s\S]*?)<\/a>/);
            const linkMatch = blob.match(/href="([^"]+)"/);
            if (titleMatch && snippetMatch && linkMatch) {
                results.push({
                    title: titleMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim(),
                    snippet: snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim(),
                    link: linkMatch[1]
                });
            }
            if (results.length >= 3) break;
        }
        return results;
    } catch (e) { return []; }
}

async function callAI(prompt: string, expectJson: boolean = false): Promise<any> {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.NVIDIA_API_KEY;
    const endpoint = process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1/chat/completions" : "https://integrate.api.nvidia.com/v1/chat/completions";

    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: process.env.OPENROUTER_API_KEY ? "google/gemini-2.0-flash-lite-001" : "meta/llama-3.1-70b-instruct",
            messages: [{ role: "user", content: prompt }],
            response_format: expectJson ? { type: "json_object" } : undefined
        })
    });
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    return expectJson ? JSON.parse(content) : content;
}

async function deepResearchCompany(company: string, website: string): Promise<any> {
    console.log(`\n🔍 Deep-Dive Research: ${company}...`);
    const results = await searchWeb(`${company} startup ${website} what problem they solve product details founders`);
    const snippets = results.map(r => `[Source]: ${r.snippet}`).join("\n");

    const prompt = `Based on these search results for ${company} (${website}):
    ${snippets}
    
    Identify:
    1. core_problem: What specific technical or business pain point are they solving?
    2. product_details: What is their actual product/offering?
    3. tech_stack: What technologies are they likely using?
    
    Return as JSON: {"core_problem": "...", "product_details": "...", "tech_stack": "..."}`;

    const parsed = await callAI(prompt, true);
    return {
        coreProblem: parsed.core_problem || "Building high scale technology.",
        productDetails: parsed.product_details || "Software solution.",
        techStack: parsed.tech_stack || "software engineering"
    };
}

async function generateAgenticDraft(company: string, contact: any, research: any): Promise<{ subject: string, body: string }> {
    const prompt = `
Generate a high-conviction, human-like cold email for a YC founder as valid JSON.
YOU ARE RISHAV TARWAY. Write strictly in the FIRST PERSON ("I").
NEVER mention your name in the body. Focus on ALIGNMENT—how your specific experience solves ${company}'s problems.

Target Startup: "${company}"
Contact: "${contact.name}" (${contact.role})
Their Product: "${research.productDetails}"
Problem they Solve: "${research.coreProblem}"

Applicant Hard Facts (ALIGN THESE TO THE STARTUP):
- IIIT Bangalore (MOSIP): I built high-scale BDD test suites for gov identity systems used by millions. I'm an expert at ensuring reliability in complex, critical infrastructure.
- Classplus: I worked with the Classplus team to scale backend architecture for 10k+ concurrent users. I understand high-load performance and technical debt.
- Open Source: I merged critical fuzzing layer PR #48 for OpenPrinting. I'm a hands-on contributor who ships code.
- Skills: TypeScript, Node.js, Java, Python, Selenium, AWS, Redis.

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. GREETING: "Hi ${contact.name.split(' ')[0]}," or "Hey ${contact.name.split(' ')[0]},".
3. SUBJECT LINE: Catchy brackets [] or curly braces {}. Make it about THEIR problem or product.
4. BODY: 0% corporate fluff. Start by mentioning a specific technical detail of ${research.productDetails}. 
5. ALIGNMENT: Explicitly connect your MOSIP or Classplus experience to what they are building. Don't just list skills; show how you fit their stage.
6. THE ASK: End with: "Would you be open to a quick 17-minute coffee chat this week or next?"`;

    const result = await callAI(prompt, true);
    return { subject: result.subject, body: `${result.body}${SIGNATURE_HTML}` };
}

async function main() {
    const batch = JSON.parse(fs.readFileSync('batch_input.json', 'utf8'));
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth });

    // Check which companies were already done
    const doneCompanies = fs.existsSync(LOGS_FILE) ? fs.readFileSync(LOGS_FILE, 'utf8') : "";

    for (const comp of batch.companies) {
        if (doneCompanies.includes(comp.name)) {
            console.log(`⏩ Skipping ${comp.name} (already in log)`);
            continue;
        }

        const research = await deepResearchCompany(comp.name, comp.website);
        console.log(`   💡 Mission: ${research.coreProblem}`);

        let batchLog = `### ${comp.name}\n`;

        for (const contact of comp.contacts) {
            console.log(`   ✍️ AI Drafting for ${contact.name} (${contact.email}) with deep alignment...`);
            const { subject, body } = await generateAgenticDraft(comp.name, contact, research);

            await createDraftInGmail(gmail, contact.email, subject, body);
            console.log(`   ✅ Draft Created.`);

            batchLog += `- **Contact**: ${contact.name} (${contact.email}) - [Draft Ready]\n`;
            await new Promise(r => setTimeout(r, 2000));
        }

        batchLog += `- **Detected Problem**: ${research.coreProblem}\n\n`;
        fs.appendFileSync(LOGS_FILE, batchLog);
    }
}

main().catch(console.error);
