import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';
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
const RESUME_PATH = '/Users/tarway/Documents/JobPulse-AI/RishavTarway-Resume.pdf';

const SIGNATURE_HTML = `
<br>
Best,<br>
Rishav Tarway (<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn Profile</a>)<br>
<a href="https://calendly.com/rishavtarway/new-meeting">Let's connect for a quick chat</a>
`;

// --- RESEARCH DATA (From Tinyfish) ---
const RESEARCH_DATA = [
    {
      "company": "Runlayer",
      "core_problem": "Unmanaged and insecure proliferation of AI tools (MCPs, skills, agents) within enterprises, leading to data exposure and lack of visibility.",
      "technical_innovation": "Provides a 'Command and Control Plane' for MCPs and agents, offering enterprise-grade security, custom threat detection, and a centralized AI resource registry.",
      "technical_issue_mission": "Making AI enterprise-ready by enabling secure, discoverable, and manageable AI tools with real-time data-leak protection."
    },
    {
      "company": "Ankar AI",
      "core_problem": "Inventors spend excessive time on administrative document work (drafting, office actions) rather than on innovation.",
      "technical_innovation": "AI operating system for innovation that provides automated patent drafting and infringement detection tools.",
      "technical_issue_mission": "Reinventing how inventions are created and protected through AI-powered intellectual property tools."
    },
    {
      "company": "1mind",
      "core_problem": "Revenue teams struggle to maintain lead qualification and empathy-driven engagement at scale.",
      "technical_innovation": "Mindy - an always-on AI agent designed for revenue teams with perfect recall and empathy to act as a top producer.",
      "technical_issue_mission": "Augmenting human intelligence to scale revenue operations exponentially through autonomous agents."
    },
    {
      "company": "Sim Studio (Sim)",
      "core_problem": "Complexity in building and debugging reliable agentic workflows using traditional programming methods.",
      "technical_innovation": "Copilot - a best-in-class tool that allows developers to build and debug complex agentic workflows using natural language.",
      "technical_issue_mission": "Optimizing Copilot for speed and reliability to handle increasingly complex multi-agent architectures."
    },
    {
      "company": "Tutor Intelligence",
      "core_problem": "Traditional robots are too rigid and unreliable for the complex, varied tasks required in modern American factories.",
      "technical_innovation": "AI-powered robotic workers that integrate human-in-the-loop intelligence to handle edge cases in industrial settings.",
      "technical_issue_mission": "Developing general-purpose, generally-intelligent robots that can operate autonomously in factory environments."
    },
    {
      "company": "Obin AI",
      "core_problem": "Financial workflows are manual, fragmented, and slow, creating operational bottlenecks for finance teams.",
      "technical_innovation": "AI-powered autonomous agents specifically designed to automate and reimagine financial workflows.",
      "technical_issue_mission": "Scaling financial intelligence to serve humanity by automating complex back-office finance operations."
    },
    {
      "company": "LIV Safe",
      "core_problem": "Fragmented and manual fire safety compliance, inspection reporting, and regulatory management.",
      "technical_innovation": "Inspection, Testing, and Maintenance (ITM) platform with real-time tracking and automated risk assessments.",
      "technical_issue_mission": "Transforming nationwide fire safety standards management through a unified technology-driven ITM platform."
    },
    {
      "company": "Endeavor",
      "core_problem": "Manual inefficiencies in manufacturing back-office tasks like quotes, order entry, and price optimization.",
      "technical_innovation": "Generative AI platform for manufacturing that automates complex industrial sales and operations workflows.",
      "technical_issue_mission": "Automating the 'industrial backbone' by streamlining manufacturing sales and supply chain operations."
    },
    {
      "company": "Arva AI",
      "core_problem": "The manual and inefficient nature of financial crime reviews (AML, KYC, KYB) in banking and fintech.",
      "technical_innovation": "AI platform using in-house models and agentic systems to automate 92% of financial crime reviews.",
      "technical_issue_mission": "Tackling web-scale due diligence and document fraud detection through fine-tuned LLMs and AI workforces."
    },
    {
      "company": "Valerie Health",
      "core_problem": "Administrative bottlenecks in healthcare, specifically manual fax processing, referrals, and patient scheduling.",
      "technical_innovation": "Automated healthcare infrastructure that utilizes AI to manage referral workflows and document processing.",
      "technical_issue_mission": "Building the digital infrastructure to fully automate back-office healthcare operations."
    },
    {
      "company": "Unconventional AI",
      "core_problem": "The massive energy consumption and computational bottlenecks of current AI computing hardware.",
      "technical_innovation": "Neuromorphic and analog compute architectures designed specifically for energy-efficient AI.",
      "technical_issue_mission": "Redesigning the foundation of computing to support the next generation of sustainable AI."
    },
    {
      "company": "duvo.ai",
      "core_problem": "Labor-intensive manual retail operations that are slow to adapt to digital transformation.",
      "technical_innovation": "Rapid-deployment AI workforce for retail that automates 40% of manual tasks within weeks.",
      "technical_issue_mission": "Automating complex retail tasks through an 'AI-first' operational approach."
    },
    {
      "company": "Nexxa.ai",
      "core_problem": "Heavy industries (manufacturing, logistics) lack the advanced AI intelligence needed for modern automation.",
      "technical_innovation": "Artificial Super Intelligence (ASI) for heavy industries, focusing on deep industrial workflow automation.",
      "technical_issue_mission": "Building the 'industrial brain' to autonomously manage heavy industry workflows."
    },
    {
      "company": "Lucis",
      "core_problem": "Reactive healthcare systems where individuals only seek medical attention after becoming symptomatic.",
      "technical_innovation": "Preventive Health OS that analyzes blood biomarkers to provide real-time health scores and recommendations.",
      "technical_issue_mission": "Establishing preventive health as the default healthcare model across Europe."
    },
    {
      "company": "Applied Compute",
      "core_problem": "General AI models are insufficient for executing the specific, complex workflows required by enterprise software.",
      "technical_innovation": "Custom agent workforce platform ('Specific Intelligence') that controls enterprise software like a human.",
      "technical_issue_mission": "Developing agents capable of autonomous execution in complex enterprise environments."
    },
    {
      "company": "Dialogue AI",
      "core_problem": "Market research is traditionally slow, manual, and inaccessible to non-expert teams.",
      "technical_innovation": "Autonomous market research platform that uses AI to automate the entire research lifecycle.",
      "technical_issue_mission": "Democratizing market research through AI-driven automation and insight generation."
    },
    {
      "company": "humans&",
      "core_problem": "Current AI development often lacks a human-centric approach, focusing on models over human relationships.",
      "technical_innovation": "Human-centric frontier AI lab reimagining AI architectures centered around people.",
      "technical_issue_mission": "Building frontier AI that fundamentally understands and enhances human relationships."
    },
    {
      "company": "DiversiFi.ai",
      "core_problem": "Fragmented and inefficient manual operations within Third-Party Logistics (3PL) providers.",
      "technical_innovation": "Optimized Warehouse Layer (OWL) - AI software providing bid optimization, carrier routing, and dynamic billing.",
      "technical_issue_mission": "Fixing the broken parts of the global logistics chain through AI-powered optimization."
    },
    {
      "company": "2501.ai",
      "core_problem": "Modern infrastructure management remains manual and complex, rather than being autonomous and self-thinking.",
      "technical_innovation": "The 2501 Operating System - an autonomous system that operates infrastructure like a human would.",
      "technical_issue_mission": "Building the operating system for fully autonomous digital infrastructure."
    },
    {
      "company": "Tensormesh",
      "core_problem": "Significant GPU waste due to the 'Amnesia Tax,' where LLMs repeatedly recompute KV caches for similar requests.",
      "technical_innovation": "LMCache - a persistent memory layer for AI that caches and reuses LLM state across multiple requests.",
      "technical_issue_mission": "Eliminating GPU waste and building a persistent state layer for large-scale AI inference."
    },
    {
      "company": "Peripheral Labs",
      "core_problem": "Traditional sports and live media broadcasting are limited to 2D formats with no interactivity or depth.",
      "technical_innovation": "Spatial intelligence and volumetric video tech that enables holographic 3D capture for live media.",
      "technical_issue_mission": "Transforming live media consumption through immersive volumetric video technology."
    },
    {
      "company": "Terranova",
      "core_problem": "Global environmental challenges like urban flooding and sea-level rise require massive infrastructure adaptation.",
      "technical_innovation": "Terraforming robots designed for large-scale environmental engineering and lifting infrastructure.",
      "technical_issue_mission": "Scaling a 'robot army' to perform large-scale environmental engineering and terraforming."
    },
    {
      "company": "Tessera Labs",
      "core_problem": "Enterprises struggle to deploy AI agents that can handle multi-step, complex internal workflows reliably.",
      "technical_innovation": "Agentic AI platform specifically tailored for complex enterprise operations and internal systems.",
      "technical_issue_mission": "Building the core platform for the next generation of enterprise AI agents."
    },
    {
      "company": "Icarus Robotics",
      "core_problem": "The lack of a reliable robotic labor force for space-based manufacturing and infrastructure maintenance.",
      "technical_innovation": "Autonomous robotic systems specifically engineered for operation in space environments.",
      "technical_issue_mission": "Building the foundational robotic labor force required for the future of space exploration."
    },
    {
      "company": "Preql AI",
      "core_problem": "Financial data is often messy and unstructured, making it difficult for finance teams to analyze without manual cleaning.",
      "technical_innovation": "Agentic data cleaning - an AI-powered platform that automatically cleans and structures financial data.",
      "technical_issue_mission": "Automating the cleaning and preparation of messy enterprise financial datasets."
    },
    {
      "company": "Orion Sleep",
      "core_problem": "Standard mattresses cannot adapt to an individual's changing temperature and comfort needs throughout the night.",
      "technical_innovation": "Temperature-regulated, adaptive sleep system that uses AI and sensors to optimize the sleep environment.",
      "technical_issue_mission": "Personalizing human sleep comfort at scale through real-time adaptive hardware."
    },
    {
      "company": "Altitude",
      "core_problem": "Clinician burnout and severe physician shortages caused by administrative and performance bottlenecks.",
      "technical_innovation": "Clinician-level execution platform that uses AI breakthroughs to elevate performance and provide coaching.",
      "technical_issue_mission": "Solving the clinician performance bottleneck to address the global physician shortage."
    },
    {
      "company": "Marble",
      "core_problem": "Tax research is an expensive, slow, and manual process for tax professionals.",
      "technical_innovation": "AI Tax Research Assistant designed to automate complex tax research and compliance workflows.",
      "technical_issue_mission": "Transforming the efficiency of tax research through specialized AI models."
    },
    {
      "company": "adaption",
      "core_problem": "Traditional AI models are 'static' and cannot easily adapt to new information without costly retraining.",
      "technical_innovation": "Adaptive AI platform that allows models to learn and adapt 'on the fly' based on new data.",
      "technical_issue_mission": "Building models that possess the technical capacity to continuously adapt and learn."
    },
    {
      "company": "NEOintralogistics",
      "core_problem": "Inefficient and manual flow of goods within warehouses and intralogistics centers.",
      "technical_innovation": "Specialized warehouse automation robots designed specifically for internal logistics flow.",
      "technical_issue_mission": "Developing the next generation of autonomous warehouse intralogistics robots."
    },
    {
      "company": "SENAI",
      "core_problem": "Enterprises struggle to derive intelligent, actionable insights from massive volumes of online video content.",
      "technical_innovation": "Online Video Intelligence platform using advanced AI for deep video content analysis and backend scalability.",
      "technical_issue_mission": "Designing scalable, cloud-native infrastructures for real-time video intelligence."
    },
    {
      "company": "Espresso Labs Inc.",
      "core_problem": "Businesses face manual IT operations and cybersecurity management complexities.",
      "technical_innovation": "AI Barista Platform - an AI-powered IT system that automates IT operations and CMMC compliance.",
      "technical_issue_mission": "Automating cybersecurity and IT operations using intelligent AI agents."
    }
];

async function authorizeGmail() {
    const creds = JSON.parse(fs.readFileSync('credential.json', 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const token = JSON.parse(fs.readFileSync('token.json', 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function createDraftWithAttachment(gmail: any, to: string, subject: string, bodyHTML: string) {
    const boundary = "foo_bar_baz";
    const attachmentBuffer = fs.readFileSync(RESUME_PATH);
    const attachmentBase64 = attachmentBuffer.toString('base64');

    const messageParts = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        bodyHTML,
        '',
        `--${boundary}`,
        'Content-Type: application/pdf; name="Rishav_Tarway_Resume.pdf"',
        'Content-Description: Rishav_Tarway_Resume.pdf',
        'Content-Disposition: attachment; filename="Rishav_Tarway_Resume.pdf"; size=' + attachmentBuffer.length,
        'Content-Transfer-Encoding: base64',
        '',
        attachmentBase64,
        `--${boundary}--`
    ];

    const message = messageParts.join('\r\n');
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw: encodedMessage } } });
}

async function callAI(prompt: string): Promise<any> {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.NVIDIA_API_KEY;
    const endpoint = process.env.OPENROUTER_API_KEY ? "https://openrouter.ai/api/v1/chat/completions" : "https://integrate.api.nvidia.com/v1/chat/completions";
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: process.env.OPENROUTER_API_KEY ? "google/gemini-2.0-flash-lite-001" : "meta/llama-3.1-70b-instruct",
            messages: [{ role: "user", content: prompt }],
            response_format: { type: "json_object" }
        })
    });
    const data = await response.json();
    return JSON.parse(data.choices[0].message.content);
}

async function generateDraft(companyData: any, contact: any): Promise<{ subject: string, body: string }> {
    const prompt = `
Generate a minimalist, human-like cold email for a YC founder as valid JSON.
YOU ARE RISHAV TARWAY. Write strictly in the FIRST PERSON ("I").
NO BOLDING. EXTREME SKIMMABILITY. 3 SHORT PARAGRAPHS ONLY.

Startup: "${companyData.company}"
Contact: "${contact.name}"
Innovation: "${companyData.technical_innovation}"
Problem: "${companyData.core_problem}"
Mission: "${companyData.technical_issue_mission}"

Structure:
1. Subject: ${contact.name.split(' ')[0]}, need a quick advice on ${companyData.company}'s tech
2. Para 1: I came across your work in ${companyData.company} and was really impressed by how you've tackled ${companyData.technical_innovation}. 
3. Para 2: My background in high-scale systems (IIIT Bangalore/MOSIP) and high-load performance (Classplus) aligns with your mission to solve ${companyData.core_problem}. Like my OpenPrinting PR #48, I solve problems with a broader, more strategic lens than just checking boxes.
4. Para 3: I'd genuinely love to hear your perspective on what makes someone successful in this role. Would you be open to a quick 17-minute coffee chat this week or next?
5. Closing: I understand you may have a packed schedule, but even passing this along to the concerned team would mean a lot.

Return JSON: {"subject": "...", "body": "paragraph1\\n\\nparagraph2\\n\\nparagraph3\\n\\nclosing"}`;

    const result = await callAI(prompt);
    
    // Use full URLs as requested to avoid spam filters
    const bodyWithLinks = `
        <p>${result.body.replace(/\n\n/g, '</p><p>')}</p>
        <p>Thank you so much!</p>
        <p>Resume (Drive): https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing</p>
        <p>Portfolio: https://my-portfolio-five-roan-36.vercel.app/</p>
        ${SIGNATURE_HTML}
    `;

    return { subject: result.subject, body: bodyWithLinks };
}

async function main() {
    const batch = JSON.parse(fs.readFileSync('batch_input.json', 'utf8'));
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth });

    for (const comp of batch.companies) {
        // Fuzzy matching to match "Sim" with "Sim Studio" etc.
        const research = RESEARCH_DATA.find(r => 
            comp.name.toLowerCase().includes(r.company.toLowerCase()) || 
            r.company.toLowerCase().includes(comp.name.toLowerCase())
        );
        if (!research) {
            console.log(`⚠️ No research found for ${comp.name}. Skipping.`);
            continue;
        }

        for (const contact of comp.contacts) {
            console.log(`✍️ Creating draft with attachment for ${contact.name}...`);
            try {
                const { subject, body } = await generateDraft(research, contact);
                await createDraftWithAttachment(gmail, contact.email, subject, body);
                console.log("✅ Draft created.");
            } catch (e: any) {
                console.error(`❌ Error drafting for ${contact.name}:`, e.message);
            }
            await new Promise(r => setTimeout(r, 1200));
        }
    }
}

main().catch(console.error);
