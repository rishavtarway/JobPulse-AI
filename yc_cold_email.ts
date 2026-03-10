import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';

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
    if (!OPENROUTER_API_KEY) {
        console.error("   ❌ ERROR: No OPENROUTER_API_KEY found in .env");
        return null;
    }

    // Using the most robust free models available on OpenRouter
    const fallbackModels = [
        "google/gemini-flash-1.5",
        "meta-llama/llama-3.1-8b-instruct",
        "openai/gpt-3.5-turbo",
        "openrouter/free"
    ];

    let currentModelIdx = 0;
    while (currentModelIdx < fallbackModels.length) {
        try {
            console.log(`   🤖 [Querying AI: ${fallbackModels[currentModelIdx]}]...`);
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
                body: JSON.stringify({ model: fallbackModels[currentModelIdx], messages: [{ role: "user", content: prompt }] }),
                signal: AbortSignal.timeout(30000)
            });

            if (response.status === 429) {
                console.log(`   ⚠️ Rate limited on ${fallbackModels[currentModelIdx]}, switching models...`);
                currentModelIdx++; continue;
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
                // Second attempt: clean markdown formatting more aggressively
                const cleaner = jsonString.replace(/```json/g, '').replace(/```/g, '').trim();
                try { return JSON.parse(cleaner); } catch (je2) { throw new Error("Invalid JSON returned"); }
            }
        } catch (e: any) {
            console.log(`   ⚠️ Model failed (${e.message}), trying next...`);
            currentModelIdx++;
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
    if (careerUrl) {
        console.log(`   🌐 Fetching career page: ${careerUrl}...`);
        careerPageText = await fetchPageContent(careerUrl);
    }

    const search1 = await searchWeb(`${company} startup founders YC mission problems solving funding`);
    await new Promise(r => setTimeout(r, 1000)); // be nice to DDG
    const search2 = await searchWeb(`${company} startup founder CEO email contact careers hiring founders@`);

    const combinedSnippets = [...search1, ...search2].map(s => `Title: ${s.title}\nSnippet: ${s.snippet}\nLink: ${s.link}`).join("\n\n");
    const uniqueLinks = [...new Set([...search1, ...search2].map(s => s.link))];
    if (careerUrl) uniqueLinks.unshift(careerUrl);

    const prompt = `Analyze the search results and career page content for the startup "${company}" and extract precise information.

Career Page Content (Snippet):
${careerPageText}

Web Search Results:
${combinedSnippets}

Extract the following as a JSON object strictly following this format. IF YOU CANNOT FIND A VALUE, RETURN AN EMPTY STRING "". DO NOT WRITE "N/A" OR "NOT FOUND"!

{
  "founder_names": "Names of founders (or 'Team') - attempt to find their exact names.",
  "contact_email": "Find the DIRECT founder email. DO NOT use generic info@ or hello@ emails. Look for founders@, careers@, jobs@, or actively deduce it using the founder's first name (e.g., firstname@companydomain.com) if you found the domain and founder name. Leave blank if totally unsure.",
  "deep_mission": "A 2-sentence summary of the core engineering problem they are solving, their mission, and recent funding/news if mentioned.",
  "tech_stack_or_values": "What technologies they seem to use, or what engineering traits they value."
}`;

    let parsed = await callAI(prompt, true) || {};

    let discoveredEmail = parsed.contact_email || "";
    let founders = parsed.founder_names || "";
    if (founders.toLowerCase().includes("n/a") || founders.toLowerCase().includes("not found")) founders = "";
    if (!founders) founders = "Founding Team";
    if (discoveredEmail.toLowerCase().includes("n/a") || discoveredEmail.toLowerCase().includes("not found")) discoveredEmail = "";

    // Deep fallback search for email if not found in first pass, but founder is known
    if ((!discoveredEmail || discoveredEmail.includes('info@') || discoveredEmail.includes('hello@') || discoveredEmail.length < 5) && founders !== "Founding Team" && founders.length > 2) {
        console.log(`   🕵️‍♂️ Doing deeper targeted scan for ${founders}'s exact email...`);
        const search3 = await searchWeb(`"${founders}" "${company}" "@" email contact`);
        const snippets3 = search3.map(s => `Title: ${s.title}\nSnippet: ${s.snippet}\nLink: ${s.link}`).join("\n\n");
        const uniqueLinks3 = [...new Set(search3.map(s => s.link))];
        uniqueLinks.push(...uniqueLinks3);

        const emailPrompt = `Analyze these deep search results and find the exact email for ${founders} at ${company}.
        
Search Results:
${snippets3}

Return ONLY a JSON object:
{ "contact_email": "exact_email_or_blank" }
Ignore info@ or support@. We want founders@, careers@, or name@domain.com.`;

        const emailParsed = await callAI(emailPrompt, true) || {};
        if (emailParsed.contact_email && !emailParsed.contact_email.includes('info@')) {
            discoveredEmail = emailParsed.contact_email;
            console.log(`   🎯 Deep scan successful: Found ${discoveredEmail}`);
        }
    }

    return {
        founders: founders,
        discoveredEmail: discoveredEmail,
        deepMission: parsed.deep_mission || originalMission || "Building high scale technology.",
        techStack: parsed.tech_stack_or_values || "software engineering",
        sources: uniqueLinks
    };
}

async function generateAgenticDraft(company: string, research: any): Promise<{ subject: string, body: string }> {
    const prompt = `
Generate a highly polished, eye-catching cold email application to a startup founder/HR as valid JSON.
Startup Name: "${company}"
Founders/Contact: "${research.founders}"
What they are solving/Mission (Deep Research): "${research.deepMission}"
Tech/Values: "${research.techStack}"

STRICT RULES:
1. Return JSON: {"subject": "...", "body": "..."}
2. The email must be extremely punchy, designed for a 5-10 second skim by a busy Founder (${research.founders}). Make it directly relevant to their specific mission: "${research.deepMission}".
3. Tone: Confident, crisp, highly professional but modern, NOT generic.
4. Praise/Appreciate: Briefly praise them for their recent work/funding/mission in this specific sector.
5. Include these exact bragging points smoothly without boasting:
   - 2 years of Open Source contributions (including merged PRs in OpenPrinting).
   - 6 paid internships (3 onsite, 3 remote).
   - Backend optimization & architecture experience at Classplus scaling systems.
6. Offer proof of work casually but confidently: "I have 5 links already shared on my profile, but let me know what specific tech stack PRs/links you want to see, and I will share them."
7. NO placeholders like [Company Name] or [Insert Link]. Use "${company}" exactly.
8. Include a witty but professional closing line that makes them want to reply.
9. At the end before closing, casually suggest that if they hire you, you'll save them from buying more expensive SaaS tools because you build tools locally (to add a punchy hook).
10. Body MUST be formatted using HTML <p> tags, keeping paragraphs very short (1-2 sentences max format for skimming).`;

    const parsed = await callAI(prompt, true);
    if (parsed && parsed.subject && parsed.body) {
        parsed.subject = parsed.subject.replace(/[,\[\]\(\)]/g, '');
        return { subject: parsed.subject, body: parsed.body + SIGNATURE_HTML };
    }

    return {
        subject: `Software Engineer | High Scale Architecture | Rishav Tarway`,
        body: `<p>Hi ${research.founders},</p><p>I'm Rishav Tarway. I've been researching ${company} and am incredibly impressed by your mission: ${research.deepMission}. I specialize in building and optimizing highly scalable software architecture.</p><p>For a quick background: I've completed 6 paid internships (3 onsite, 3 remote), most notably handling core backend optimization at Classplus. I've also spent the last 2 years deeply involved in Open Source, recently merging critical fuzzing architecture PRs for OpenPrinting.</p><p>Also, I'm the guy who builds internal tools from scratch locally, so you can probably cancel a few SaaS subscriptions if you hire me.</p><p>I know you're likely skimming this, so I'll keep it brief. I have several proof-of-work links attached to my profile, but let me know exactly what kind of PRs or projects you'd like to see for your stack, and I'll send them over.</p><p>Would love to chat about bringing this engineering rigor to ${company}.</p><p>Best,</p>${SIGNATURE_HTML}`
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
        console.log(`   💡 Found Founders: ${research.founders}`);
        console.log(`   💡 Found Mission: ${research.deepMission}`);

        // Use discovered email if baseline is missing
        const finalEmail = email || research.discoveredEmail;
        if (!finalEmail) {
            console.log(`   ⚠️ WARNING: Could not discover any email for ${company}. Moving to Tracker only.`);
        } else {
            console.log(`   📧 Target Email: ${finalEmail}`);
        }

        // 2. Draft the highly tailored pitch
        console.log(`   ✍️ Drafting tailored pitch leveraging deep research...`);
        const { subject, body } = await generateAgenticDraft(company, research);

        // 3. Document in Markdown Log
        mdLog += `### Startup: ${company}\n`;
        mdLog += `**Contact**: ${research.founders} (${finalEmail || 'Unknown'})\n\n`;
        mdLog += `**Agent Deep Research / Mission Extracted**:\n> ${research.deepMission}\n\n`;
        mdLog += `**Detected Tech/Values**:\n> ${research.techStack}\n\n`;
        mdLog += `**Sources (Verified Web Results)**:\n`;
        research.sources.slice(0, 5).forEach((src: string) => {
            mdLog += `- [${src}](${src})\n`;
        });
        mdLog += `\n**Tailored AI Draft Preview**: \n\`\`\`html\nSubject: ${subject}\n\n${body.replace(/<p>/g, '').replace(/<\/p>/g, '\n\n')}\n\`\`\`\n`;
        mdLog += `---\n`;

        // 4. Send to Gmail Drafts (if email exists)
        if (finalEmail) {
            try {
                await createDraftInGmail(gmail, finalEmail, subject, body);
                console.log(`   ✅ Tailored Draft created in Gmail for ${company}.`);
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
                    role: "Software Engineer (Founding/Core)",
                    channel: "YC Research Agent",
                    email: finalEmail || "No Email Discovered",
                    description: `RESEARCH DATA:\nFounders: ${research.founders}\nMission: ${research.deepMission}\nTech: ${research.techStack}\n\nSources:\n${research.sources.slice(0, 3).join('\n')}`,
                    status: finalEmail ? 'applied' : 'to_apply'
                })
            });
        } catch (e) { }

        await new Promise(r => setTimeout(r, 4000));
    }

    fs.appendFileSync(LOGS_FILE, mdLog);

    console.log("\n=================================================================");
    console.log(" 🎉 ALL DONE! Deep Research Pitches drafted. ");
    console.log(` 📂 Review full deep-dive analyses in: ${LOGS_FILE}`);
    console.log("=================================================================");
    process.exit(0);
}

main().catch(console.error);
