import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
import dns from 'node:dns';

// Force IPv4-first DNS resolution to fix ENOTFOUND issues in Node.js 17+
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
const ATTACHMENTS = [{
    filename: 'RishavTarway-Resume.pdf',
    path: path.join(process.cwd(), 'RishavTarway-Resume.pdf')
}];
const LOGS_FILE = 'YC_RESEARCH_AGENT_LOGS.md';

// --- GMAIL SETUP ---
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
                        if (info.message && typeof (info.message as any).on === 'function') {
                            (info.message as any).on('data', (chunk: any) => chunks.push(chunk));
                            (info.message as any).on('end', () => resolve(Buffer.concat(chunks)));
                            (info.message as any).on('error', (err: any) => reject(err));
                        } else {
                            reject(new Error("No message stream returned from nodemailer"));
                        }
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

// --- WEB SEARCH CAPABILITY ---
async function searchWeb(query: string): Promise<{ title: string, snippet: string, link: string }[]> {
    try {
        const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5"
            },
            signal: AbortSignal.timeout(15000)
        });
        const html = await response.text();
        const results = [];
        const resultBlobs = html.split('class="result__body"');

        for (let i = 1; i < resultBlobs.length; i++) {
            const blob = resultBlobs[i];
            const titleMatch = blob.match(/<h2 class="result__title">[\s\S]*?<a class="result__a"[^>]*>([\s\S]*?)<\/a>/i) ||
                blob.match(/<a class="result__url" href="([^"]+)">([\s\S]*?)<\/a>/);
            const snippetMatch = blob.match(/<a class="result__snippet[^>]+>([\s\S]*?)<\/a>/);
            const linkMatch = blob.match(/href="([^"]+)"/);

            if (titleMatch && snippetMatch && linkMatch) {
                let link = linkMatch[1];
                if (link.startsWith('//duckduckgo.com/l/?uddg=')) {
                    link = decodeURIComponent(link.split('uddg=')[1].split('&')[0]);
                }
                const title = titleMatch[titleMatch.length - 1].replace(/<\/?[^>]+(>|$)/g, "").trim();
                const snippet = snippetMatch[1].replace(/<\/?[^>]+(>|$)/g, "").trim();
                results.push({ title, snippet, link });
            }
            if (results.length >= 6) break; // collect top 6
        }
        return results;
    } catch (e: any) {
        console.error("   ⚠️ DDG Search error (or timeout):", e.message);
        return [];
    }
}

// --- AI INTELLIGENCE ---
async function callAI(prompt: string, expectJson: boolean = false): Promise<any> {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

    if (!OPENROUTER_API_KEY && !NVIDIA_API_KEY) {
        console.error("   ❌ ERROR: No API keys found in .env");
        return null;
    }

    // High priority: NVIDIA Models (extremely high context / quality)
    // Low priority: OpenRouter Fallbacks
    const models = [
        { provider: 'nvidia', id: 'meta/llama-3.1-70b-instruct' },
        { provider: 'nvidia', id: 'meta/llama-3.1-405b-instruct' },
        { provider: 'openrouter', id: 'google/gemini-2.0-flash-lite-001' },
        { provider: 'openrouter', id: 'meta-llama/llama-3.2-3b-instruct:free' },
        { provider: 'openrouter', id: 'openrouter/free' }
    ];

    let currentIdx = 0;
    while (currentIdx < models.length) {
        const target = models[currentIdx];
        try {
            console.log(`   🤖 [Querying ${target.provider}: ${target.id}]...`);

            let url = "";
            let key = "";

            if (target.provider === 'nvidia') {
                url = "https://integrate.api.nvidia.com/v1/chat/completions";
                key = NVIDIA_API_KEY || "";
            } else {
                url = "https://openrouter.ai/api/v1/chat/completions";
                key = OPENROUTER_API_KEY || "";
            }

            if (!key) { currentIdx++; continue; }

            const response = await fetch(url, {
                method: "POST",
                headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: target.id, messages: [{ role: "user", content: prompt }] }),
                signal: AbortSignal.timeout(60000)
            });

            if (response.status === 429) {
                console.log(`   ⚠️ Rate limited on ${target.id}, switching...`);
                currentIdx++; continue;
            }
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API error: ${response.status} - ${errText}`);
            }

            const result = await response.json();
            const text = result.choices[0].message.content;

            if (!expectJson) return text;

            let content = text.replace(/^```[a-z]*\n/, '').replace(/\n```$/, '').trim();
            const objMatch = content.match(/\{[\s\S]*\}/);
            const arrMatch = content.match(/\[[\s\S]*\]/);

            let jsonString = content;
            if (objMatch && arrMatch) {
                jsonString = objMatch[0].length > arrMatch[0].length ? objMatch[0] : arrMatch[0];
            } else if (objMatch) {
                jsonString = objMatch[0];
            } else if (arrMatch) {
                jsonString = arrMatch[0];
            }

            try {
                return JSON.parse(jsonString);
            } catch (je) {
                const cleaner = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
                try { return JSON.parse(cleaner); } catch (je2) { throw new Error("Invalid JSON returned"); }
            }
        } catch (e: any) {
            console.log(`   ⚠️ Model failed (${e.message}), trying next...`);
            currentIdx++;
        }
    }
    return null;
}

// --- PAGE CONTENT SCRAPER ---
async function fetchPageContent(url: string): Promise<string> {
    if (!url) return "";
    try {
        const response = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36" },
            signal: AbortSignal.timeout(10000)
        });
        const text = await response.text();
        // Strip script/style tags and return first 4k chars of body
        return text.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .substring(0, 4000);
    } catch (e) {
        return "";
    }
}

async function deepResearchCompany(company: string, originalMission: string, careerUrl?: string): Promise<any> {
    console.log(`\n🔍 Agent searching deep web for: ${company}...`);

    let careerPageText = "";
    const companyDomain = careerUrl ? new URL(careerUrl).hostname.replace('www.', '') : `${company.toLowerCase().replace(/\s+/g, '')}.com`;

    // 1. Better search for Founders and Team with specific Tool queries
    const searchQueries = [
        `"${company}" founders names CEO CTO Y Combinator`,
        `site:linkedin.com/in "${company}" (Founder OR CEO OR "Co-Founder" OR "CTO")`,
        `"${company}" founders email "apollo.io" OR "contactout" OR "snov.io"`,
        `"${company}" email pattern "hunter.io" OR "voila norbert" OR "kaspr"`,
        `"${company}" tech team members "saleshandy" OR "apollo"`
    ];

    if (careerUrl) {
        console.log(`   🌐 Fetching career page: ${careerUrl}...`);
        careerPageText = await fetchPageContent(careerUrl);
    }

    const search1 = await searchWeb(`${company} startup founders YC mission problems solving funding`);
    await new Promise(r => setTimeout(r, 1000));
    const search2 = await searchWeb(`${company} startup founder CEO email contact founders@ ${companyDomain}`);

    const combinedSnippets = [...search1, ...search2].map(s => `Title: ${s.title}\nSnippet: ${s.snippet}\nLink: ${s.link}`).join("\n\n");
    const uniqueLinks = [...new Set([...search1, ...search2].map(s => s.link))];
    if (careerUrl) uniqueLinks.unshift(careerUrl);

    const prompt = `Analyze the search results for the startup "${company}" (domain: ${companyDomain}).
${careerPageText ? `Career Page Snippet: ${careerPageText}\n` : ''}
Web Search Results:
${combinedSnippets}

Extract the following as a JSON object:
{
  "founder_names": "Precise names of founders",
  "contact_email": "Find the DIRECT founder email. Try to find name@domain or founders@domain. If you can't find it but have a founder name like 'John Doe', you can suggest 'john@${companyDomain}' or 'john.doe@${companyDomain}' as a guess. Skip generic emails like info@.",
  "deep_mission": "2-sentence summary of what they do.",
  "tech_stack": "Observed tech/engineering values."
}`;

    let parsed = await callAI(prompt, true) || {};
    let discoveredEmail = parsed.contact_email || "";
    let founders = parsed.founder_names || "Founding Team";

    // Deduce email patterns if we have founder names
    if (!discoveredEmail || discoveredEmail.includes('info@') || discoveredEmail.includes('hello@')) {
        const founderLead = founders.split(/[,&]/)[0].trim();
        if (founderLead && founderLead !== "Founding Team") {
            const firstName = founderLead.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
            const lastName = (founderLead.split(' ')[1] || "").toLowerCase().replace(/[^a-z]/g, '');

            // Prioritize founders@ or first@
            if (!discoveredEmail) {
                discoveredEmail = `founders@${companyDomain}`;
                console.log(`   🕵️‍♂️ Guessing email pattern: ${discoveredEmail}`);
            }
        }
    }

    return {
        contacts: parsed.contacts || [],
        deepMission: parsed.deep_mission || originalMission || "Building high scale technology.",
        techStack: parsed.tech_stack || "software engineering",
        sources: uniqueLinks
    };
}

async function generateAgenticDraft(company: string, research: any): Promise<{ subject: string, body: string }> {
    const prompt = `
Generate a minimalist, human-like cold email for a YC founder as valid JSON.
YOU ARE RISHAV TARWAY. Write strictly in the FIRST PERSON ("I").
NEVER mention your own name ("Rishav" or "Tarway") in the body.

Mission: "${research.deepMission}"
Tech Stack: "${research.techStack}"
Founder Name: "${research.contactName}"
Founder Role: "${research.contactRole || 'Founder'}"

Applicant Facts (USE FIRST PERSON):
- IIIT Bangalore: I built high-scale BDD test suites with the MOSIP team (gov identity systems).
- Classplus: I worked with the Classplus team to scale backend for 10k+ users.
- OpenPrinting: I merged critical fuzzing layer PR #48.
- Skills: TypeScript, Node.js, Java, Python, Selenium, AWS.

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. GREETING: Start with exactly one greeting: "Hi ${research.contactName.split(' ')[0]}," or "Hey ${research.contactName.split(' ')[0]},".
3. SUBJECT LINE: MUST BE EXTREMELY UNIQUE. NO TWO SUBJECT LINES SHOULD EVER MATCH.
   - Vary the approach significantly for each draft (e.g., challenge-focused, curiosity-driven, or outcome-oriented).
   - STRICTLY rotate between double brackets/braces/parentheses: {{Subject}}, [[Subject]], or ((Subject)).
   - Always include distinctive symbols like :, >>, |, //, ++, --, <>, !=, ==.
   - Example styles: "{{Quick observation on ${company} stack}}", "[[Research]] // Why I'm interested in ${company}", "((Question about ${company} growth)) | Engineering". NO emojis.
4. BODY: NO BOLDING. NEVER use your own name in the sentences. 
5. THE ASK: End with: "Would you be open to a quick 17-minute coffee chat this week or next?"`;

    const parsed = await callAI(prompt, true);
    if (parsed && parsed.subject && parsed.body) {
        return { subject: parsed.subject, body: parsed.body };
    }

    return {
        subject: `Building ${company} | Software Engineer`,
        body: `<p>Hey ${research.founders.split(' ')[0]} - I've been following ${company} and am impressed by how you're solving ${research.deepMission.substring(0, 100)}.</p>
<p>I'm reaching out because I want to help you build the product. I've completed 6 paid internships and spend my time shipping code to Open Source (recently merged PRs for OpenPrinting).</p>
<p>I think I can help you ship faster and wouldn't need any SaaS tools because I build my own utilities locally.</p>
<p>Do you have 10 minutes to chat next week?</p>`
    };
}

async function parseRawStartupsInput(text: string): Promise<any[]> {
    const prompt = `Extract a list of startups from the following text. 
Return ONLY a valid JSON array of objects. 
Each object must have exactly these keys: "company" (string), "email" (string, leave blank if missing), "context" (string, short summary), "career_url" (string, found career/jobs links).

Text input:
${text}`;
    return await callAI(prompt, true) || [];
}

async function main() {
    const filePath = process.argv[2];
    if (!filePath || !fs.existsSync(filePath)) {
        console.error("❌ Please provide a valid file path containing the startup list.");
        process.exit(1);
    }

    console.log("==================================================");
    console.log("   🚀 STARTING DEEP RESEARCH YC AGENT PROCESS");
    console.log("==================================================");

    const txt = fs.readFileSync(filePath, 'utf8');
    if (!txt.trim()) {
        console.log("❌ File is empty.");
        process.exit(1);
    }

    console.log("🔍 Parsing baseline startup list using AI...");
    let startups: any = await parseRawStartupsInput(txt);

    // Fallback if AI returned an object containing the array e.g. { "startups": [...] }
    if (startups && !Array.isArray(startups)) {
        if (startups.startups && Array.isArray(startups.startups)) startups = startups.startups;
        else if (startups.companies && Array.isArray(startups.companies)) startups = startups.companies;
        else startups = [];
    }

    if (!startups || !Array.isArray(startups) || startups.length === 0) {
        console.log("❌ No valid startups found. Exiting.");
        process.exit(1);
    }

    console.log(`✅ Identified ${startups.length} startup(s) to research.`);

    console.log("🔐 Authenticating with Gmail...");
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth });

    // Initialize/Append Logs
    let mdLog = `\n\n## YC Research Agent Run - ${new Date().toISOString()}\n`;

    for (let i = 0; i < startups.length; i++) {
        let { company, email, context, career_url } = startups[i];
        if (!company) continue;

        console.log(`\n-------------------------------------------------------------`);
        console.log(`[${i + 1}/${startups.length}] 🧠 Commencing Deep Research Agent for: ${company}`);

        // 1. Deep Research
        const research = await deepResearchCompany(company, context, career_url);
        
        const contactsToMail = research.contacts && research.contacts.length > 0 
            ? research.contacts 
            : (email ? [{ name: "Team", email: email, role: "Team" }] : []);

        if (contactsToMail.length === 0) {
            console.log(`   ⚠️ WARNING: Could not discover any contacts for ${company}.`);
            continue;
        }

        for (const contact of contactsToMail) {
            console.log(`\n   👤 Contact: ${contact.name} (${contact.role})`);
            console.log(`   📧 Email: ${contact.email}`);

            // 2. Draft the highly tailored pitch
            console.log(`   ✍️ Drafting tailored pitch...`);
            const { subject, body } = await generateAgenticDraft(company, {
                ...research,
                contactName: contact.name,
                contactRole: contact.role
            });

            // 3. Document in Markdown Log
            mdLog += `### Startup: ${company} (${contact.name})\n`;
            mdLog += `**Contact**: ${contact.name} - ${contact.role} (${contact.email})\n\n`;
            mdLog += `**Agent Deep Research / Mission Extracted**:\n> ${research.deepMission}\n\n`;
            mdLog += `**Detected Tech/Values**:\n> ${research.techStack}\n\n`;
            mdLog += `**Sources (Verified Web Results)**:\n`;
            research.sources.slice(0, 5).forEach((src: string) => {
                mdLog += `- [${src}](${src})\n`;
            });
            mdLog += `\n**Tailored AI Draft Preview**: \n\`\`\`html\nSubject: ${subject}\n\n${body.replace(/<p>/g, '').replace(/<\/p>/g, '\n\n')}\n\`\`\`\n`;
            mdLog += `---\n`;

            // 4. Send to Gmail Drafts (if email exists)
            if (contact.email) {
                try {
                    await createDraftInGmail(gmail, contact.email, subject, body);
                    console.log(`   ✅ Tailored Draft created in Gmail for ${company} (${contact.name}).`);
                } catch (e: any) {
                    console.error(`   ❌ Failed to create draft:`, e.message);
                }
            }

            // 5. Commit to Tracker Database
            try {
                const port = process.env.SERVER_PORT || '3000';
                await fetch(`http://127.0.0.1:${port}/api/applications`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        company: company,
                        role: `Software Engineer (Founding/Core) - ${contact.name}`,
                        channel: "YC Research Agent",
                        email: contact.email || "No Email Discovered",
                        description: `RESEARCH DATA:\nFounder: ${contact.name}\nRole: ${contact.role}\nMission: ${research.deepMission}\nTech: ${research.techStack}\n\nSources:\n${research.sources.slice(0, 3).join('\n')}`,
                        status: contact.email ? 'applied' : 'to_apply',
                        type: 'yc'
                    })
                });
            } catch (e) { }

            await new Promise(r => setTimeout(r, 4000));
        }
    }

    fs.appendFileSync(LOGS_FILE, mdLog);

    console.log("\n=================================================================");
    console.log(" 🎉 ALL DONE! Deep Research Pitches drafted. ");
    console.log(` 📂 Review full deep-dive analyses in: ${LOGS_FILE}`);
    console.log("=================================================================");
    process.exit(0);
}

main().catch(console.error);
