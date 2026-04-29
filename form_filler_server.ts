import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import dns from 'node:dns';

// Force IPv4-first DNS resolution to fix ENOTFOUND issues in Node.js 17+
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────
function safeSlice(text: string, length: number): string {
    if (!text) return "";
    const chars = Array.from(text);
    if (chars.length <= length) return text;
    return chars.slice(0, length).join('');
}

// Load resume data (always fresh from disk)
// ─────────────────────────────────────────────────────────────────
const resumeDataPath = path.join(process.cwd(), 'resume_data.json');

function loadResumeData(): Record<string, any> {
    try {
        return JSON.parse(fs.readFileSync(resumeDataPath, 'utf-8'));
    } catch {
        return {};
    }
}

function saveResumeData(data: Record<string, any>) {
    fs.writeFileSync(resumeDataPath, JSON.stringify(data, null, 2));
}

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

// ─────────────────────────────────────────────────────────────────
// Per-tab Job-Description cache
// Keeps the JD we last analysed for each tab URL host so every
// askLLM() call gets the same JD context without the extension
// having to re-send it for each field. Bounded LRU.
// ─────────────────────────────────────────────────────────────────
interface JdEntry {
    jdText: string;
    keywords: string[];
    savedAt: number;
}

const JD_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const jdCache = new Map<string, JdEntry>();

function jdCacheKey(url: string): string {
    if (!url) return '';
    try {
        const u = new URL(url);
        // Include path so two job postings on the same site are kept separately,
        // but drop query/hash to keep keys stable across page state.
        return `${u.host}${u.pathname}`;
    } catch {
        return url;
    }
}

function setJdContext(url: string, jdText: string, keywords: string[] = []) {
    const key = jdCacheKey(url);
    if (!key) return;
    jdCache.set(key, { jdText: jdText || '', keywords: keywords || [], savedAt: Date.now() });
    // Trim to the 50 most recent.
    if (jdCache.size > 50) {
        const oldestKey = [...jdCache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0]?.[0];
        if (oldestKey) jdCache.delete(oldestKey);
    }
}

function getJdContext(url: string): JdEntry | null {
    const key = jdCacheKey(url);
    if (!key) return null;
    const entry = jdCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.savedAt > JD_CACHE_TTL_MS) {
        jdCache.delete(key);
        return null;
    }
    return entry;
}

// ── LLM WRAPPER ──────────────────────────────────────────────────
async function callAI(messages: any[], temperature = 0.1) {
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    if (!nvidiaKey && !openrouterKey) {
        console.warn('⚠️ No AI API Keys found (NVIDIA or OpenRouter). Skipping LLM.');
        return 'UNKNOWN';
    }

    const providers = [];
    if (openrouterKey) {
        providers.push({
            name: 'openrouter',
            key: openrouterKey,
            models: [
                "google/gemini-2.0-flash-lite-001",
                "google/gemini-2.0-pro-exp-02-05:free",
                "google/gemma-2-9b-it:free"
            ],
            endpoint: "https://openrouter.ai/api/v1/chat/completions"
        });
    }
    if (nvidiaKey) {
        providers.push({
            name: 'nvidia',
            key: nvidiaKey,
            models: [
                "meta/llama-3.1-70b-instruct",
                "meta/llama-3.1-405b-instruct"
            ],
            endpoint: "https://integrate.api.nvidia.com/v1/chat/completions"
        });
    }

    const prompt = messages.map(m => m.content).join('\n\n---\n\n');

    for (const provider of providers) {
        for (const modelName of provider.models) {
            try {
                console.log(`🤖 AI Attempt: Using ${provider.name}:${modelName}...`);
                const response = await fetch(provider.endpoint, {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${provider.key}`,
                        "Content-Type": "application/json",
                        ...(provider.name === 'openrouter' ? {
                            "HTTP-Referer": "http://localhost:3000",
                            "X-OpenRouter-Title": "JobPulse AI Optimizer"
                        } : {})
                    },
                    body: JSON.stringify({
                        model: modelName,
                        messages: [{ role: "user", content: prompt }],
                        // Keep it simple to avoid 400s
                    })
                });

                const data: any = await response.json();

                if (response.status === 401 || (data.error && data.error.code === 401) || (typeof data.error?.message === 'string' && data.error.message.includes('User not found'))) {
                    console.log(`   ❌ Auth Error on ${provider.name}. Skipping provider.`);
                    break; // Skip to next provider
                }

                if (response.status === 429 || response.status === 402 || response.status === 503) {
                    console.log(`   ⏳ Rate limit on ${modelName}. Switching...`);
                    continue;
                }

                if (!response.ok) {
                    throw new Error(`Status ${response.status} - ${JSON.stringify(data.error || data)}`);
                }

                const content = data.choices?.[0]?.message?.content?.trim();
                if (content) return content;
                
                throw new Error("Empty response from model");
            } catch (e: any) {
                console.error(`   ❌ Model ${modelName} failed:`, e.message);
                // Continue to next model
            }
        }
    }

    return 'UNKNOWN';
}

// ─────────────────────────────────────────────────────────────────
// LLM: Ask AI to answer a form field using full resume context
// ─────────────────────────────────────────────────────────────────
async function askLLM(
    fieldLabel: string,
    fieldType: string,
    fieldContext: string,
    options: string[] = [],
    resumeData: Record<string, any>,
    pageUrl: string = '',
    retryCount = 0
): Promise<string> {
    if (!OPENROUTER_API_KEY) {
        console.warn('⚠️ No AI API Key. Skipping LLM.');
        return 'UNKNOWN_DATA';
    }

    const sysPrompt = `You are filling job application forms on behalf of Rishav Tarway. You know everything about him from his resume below.

RISHAV'S COMPLETE PROFILE:
- Name: Rishav Tarway | Email: rishavtarway@gmail.com | Phone: +91-7004544142 | Location: Gurugram, Haryana, India
- Education: B.Tech CSE (AI & ML), Polaris School of Technology (Starex University), CGPA 8.85, 2023-2027, Gurugram
- Total Experience: 19 months across 5 internships
- Internships:
  1. Research SWE Intern at IIIT Bangalore (MOSIP), Jul-Oct 2025 - Selenium, Java, Cucumber BDD for national biometric identity systems. PR #1370 automated multilingual UI and eSignet IDP verification. PR #543 fixed auto-logout bug during background sync.
  2. Software Engineer Intern at Classplus, Nov 2024-Jan 2025 - Improved observability 40% via unique request ID tracing across Express.js middleware. Reduced API latency 25% for 10k+ concurrent users.
  3. Full Stack Developer Intern at TechVastra, Sep-Nov 2024 - Next.js + TypeScript with Android integration. Boosted frontend performance 30% via React Hooks refactoring. RESTful APIs for 10k+ concurrent sync operations.
  4. QA Automation Intern at Testbook, Sep-Nov 2024 - Selenium + ChromeDriver framework 50% faster. Uncovered 30+ critical bugs.
  5. Frontend Developer Intern at Franchizerz, Jul-Dec 2024 - React + Next.js UI. Lighthouse score from 68 to 92 via code-splitting and lazy loading.
- Skills: Java, C++, JavaScript, TypeScript, Python, Go | React, Next.js, Node.js, Express, Redux, Socket.io | React Native, Expo SDK 51 | MongoDB, SQL, Redis, Supabase, AWS (S3, CloudFront) | Git, Docker, Selenium, Cucumber BDD, OSS-Fuzz, ASAN | Gemini API, GPT, Zustand | OOP, DSA, System Design, ML, Fuzz Testing
- Projects: Tech Stream Community (React, Socket.io, MongoDB, AWS, Redis - 500+ users, 99.9% uptime), CoinWatch (React Native, Expo, Supabase, CoinGecko API - 60fps crypto tracker), ProResume (React Native, Gemini AI, Supabase - ATS optimised resume builder with Kanban job tracker), Scholar Track App (Java, SQL, Docker - 60% query boost).
- Open Source / Achievements: WoC 5.0 at OpenPrinting (go-avahi) - built full OSS-Fuzz infrastructure, 11 fuzz harnesses, found and fixed CWE-401 (16MB memory leak) and CWE-122 (heap buffer overflow); 3 Merged PRs in Stdlib.js; 2 Merged PRs in OpenPrinting; 1st Runner-Up Hack With Uttarakhand.
- LinkedIn: https://www.linkedin.com/in/rishav-tarway-fst/ | GitHub: https://github.com/rishavtarway | Portfolio: https://my-portfolio-five-roan-36.vercel.app/

RULES FOR SHORT FIELDS (name, email, phone, dropdown, radio, date, number):
1. Return ONLY the exact value. No explanation, no quotes, no extra words.
2. For dropdowns/radio, pick EXACTLY one of the listed options (copy it character for character).
3. For college/university fields return: Polaris School of Technology (Starex University)
4. For CGPA return: 8.85
5. For date fields return YYYY-MM-DD or readable date based on what makes sense.
6. If genuinely unknown (e.g. "How did you hear about us?"), return: UNKNOWN_DATA

RULES FOR LONG-FORM / TEXTAREA FIELDS (cover letter, motivation, about yourself, why this role, etc.):
Write EXACTLY 3 paragraphs. Each paragraph is 1 to 2 sentences MAXIMUM.
STRICT FORMAT REQUIREMENTS:
- NO quotation marks anywhere in the text
- NO double dashes (--) between words. Use a comma or a full stop instead.
- NO AI-sounding phrases like "I am passionate", "I am excited to", "leverage my skills", "synergize", "dynamic", "thrilled"
- NO em dashes used to separate phrases; use commas instead
- Write like a confident, precise engineer, not a motivational speaker
- Use specific numbers and technologies from the resume, not vague claims
- Each paragraph must feel like a different human wrote it naturally, not like a template

PARAGRAPH STRUCTURE for long-form:
- Para 1 (1-2 sentences): Directly address the question using your most relevant experience or project. Name the specific company/technology/outcome.
- Para 2 (1-2 sentences): Show depth by referencing a second relevant experience, open source work, or technical achievement with a real metric.
- Para 3 (1-2 sentences): Close with what you bring to the specific role or team, grounded in a concrete skill or project outcome.

NEVER make up facts not in the resume. If the question is completely unrelated to the resume (e.g. personal preferences, fun facts), return UNKNOWN_DATA.`;

    // ── Inject JD context for THIS tab so the LLM keeps the same job in mind
    //     across every field on the page (fixes the "extension forgets context"
    //     issue when answering long-form questions like "Why this role?").
    const jdEntry = getJdContext(pageUrl);
    let jdBlock = '';
    if (jdEntry && jdEntry.jdText) {
        jdBlock = `\n\nCURRENT JOB DESCRIPTION YOU ARE APPLYING TO (use this to tailor every long-form answer):\n${safeSlice(jdEntry.jdText, 2400)}`;
        if (jdEntry.keywords && jdEntry.keywords.length) {
            jdBlock += `\n\nKEY REQUIREMENTS THE EMPLOYER CARES ABOUT (weave these into long-form answers naturally): ${jdEntry.keywords.slice(0, 12).join(', ')}`;
        }
    }


    const userPrompt = `
Field Label: "${fieldLabel}"
Field Type: "${fieldType}"
Context (Placeholder/Nearby text): "${fieldContext}"
Options (if Select/Radio): ${JSON.stringify(options)}
Page URL: ${pageUrl}`;

    try {
        const answer = await callAI([
            { role: 'system', content: sysPrompt + jdBlock },
            { role: 'user', content: userPrompt }
        ]);

        if (answer === 'UNKNOWN') return 'UNKNOWN_DATA';
        console.log(`  🤖 AI Answer for "${fieldLabel}": "${answer}"`);
        return answer;
    } catch {
        return 'UNKNOWN_DATA';
    }
}

// ─────────────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────────────

// GET /api/form-filler/cache — return full resume data to extension
app.get('/api/form-filler/cache', (req, res) => {
    const data = loadResumeData();
    res.json(data);
});

// GET /api/form-filler/status — check if online
app.get('/api/form-filler/status', (req, res) => {
    const data = loadResumeData();
    res.json({ status: 'online', fields: Object.keys(data).length, llm_available: !!(OPENROUTER_API_KEY) });
});

// GET /api/form-filler/jd-context — does the server have JD context for THIS tab?
app.get('/api/form-filler/jd-context', (req, res) => {
    const url = (req.query.url as string) || '';
    const entry = getJdContext(url);
    if (!entry) return res.json({ cached: false });
    res.json({
        cached: true,
        keywords: entry.keywords,
        savedAt: entry.savedAt,
        jdLength: entry.jdText.length,
    });
});

// GET /api/form-filler/resume — serve local resume PDF for upload injection
app.get('/api/form-filler/resume', (req, res) => {
    const data = loadResumeData();
    // Try configured path first, then common locations
    const candidates = [
        data.resume_local_path,
        path.join(process.cwd(), 'RishavTarway-Resume.pdf'),
        path.join(process.cwd(), 'RishavTarway-Resume.pdf'),
        path.join(process.cwd(), 'resume.pdf'),
    ].filter(Boolean);

    const found = candidates.find(p => p && fs.existsSync(p));
    if (!found) {
        console.error('❌ Resume PDF not found. Set resume_local_path in resume_data.json');
        return res.status(404).json({ error: 'Resume PDF not found on server' });
    }

    const filename = path.basename(found);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    console.log(`📄 Serving resume: ${found}`);
    res.sendFile(found);
});

// POST /api/form-filler/ask — ask LLM for a specific field
app.post('/api/form-filler/ask', async (req, res) => {
    const { label, type, context, options, url } = req.body;
    const resumeData = loadResumeData();
    const answer = await askLLM(label, type, context, options, resumeData, url);
    res.json({ answer });
});

// POST /api/form-filler/llm-fallback — Batch ask for extension
app.post('/api/form-filler/llm-fallback', async (req, res) => {
    const { fields, tabUrl } = req.body;
    const resumeData = loadResumeData();
    const results = [];

    console.log(`🧠 [LLM Fallback] Processing ${fields?.length || 0} fields for ${tabUrl}`);

    for (const field of (fields || [])) {
        const answer = await askLLM(field.label, field.type, field.context, field.options, resumeData, tabUrl);
        results.push({ id: field.id, answer });
    }

    res.json({ results });
});

// POST /api/form-filler/save-learned — save manually filled answers back to resume_data
app.post('/api/form-filler/save-learned', (req, res) => {
    const { answers, sourceUrl } = req.body;
    if (!answers) return res.status(400).json({ error: 'No answers provided' });

    const data = loadResumeData();
    if (!data._learned_answers) data._learned_answers = {};

    Object.entries(answers).forEach(([lbl, val]) => {
        if (val && val !== 'UNKNOWN_DATA') {
            data._learned_answers[lbl.toLowerCase()] = { value: val, url: sourceUrl, date: new Date().toISOString() };
        }
    });

    saveResumeData(data);
    console.log(`💾 Saved ${Object.keys(answers).length} learned fields from ${sourceUrl}`);
    res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
// RESUME BOOSTER ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// POST /api/resume/analyze-jd — Extract keywords from JD
app.post('/api/resume/analyze-jd', async (req, res) => {
    const { jdText, tabUrl } = req.body;
    if (!jdText) return res.status(400).json({ error: 'No JD text provided' });

    console.log(`\n🔍 [JD Analysis] Scanning for keywords...`);
    const prompt = `Act as an expert ATS (Applicant Tracking System) optimizer. 
Analyze the following Job Description and extract the top 15 most important technical keywords, soft skills, and specific requirements. 
Return ONLY a raw JSON array of strings. NO MARKDOWN. NO EXPLANATION. Just the array.
Example: ["Node.js", "React"]

JD Text: 
${safeSlice(jdText, 2000)}`;

    try {
        const result = await callAI([{ role: 'user', content: prompt }]);
        // Extract array from possible markdown blocks
        let keywords: string[] = [];
        
        try {
            const startIdx = result.indexOf('[');
            const endIdx = result.lastIndexOf(']');
            if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
                const arrayStr = result.substring(startIdx, endIdx + 1);
                keywords = JSON.parse(arrayStr);
            } else {
                throw new Error("No array brackets found in AI output");
            }
        } catch(e) {
            console.log("JSON Parse fallback triggered:", result);
            // Emergency fallback splitting, removing extra markdown/quotes
            keywords = result
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .replace(/[\[\]"'\n]/g, ',')
                .split(',')
                .map((s: string) => s.trim())
                .filter((s: string) => s.length > 2 && s.toUpperCase() !== 'UNKNOWN')
                .slice(0, 15);
        }

        if (keywords.length === 0) {
            keywords = ["Engineering", "Backend", "Frontend", "System Design", "Agile"]; // Hard failsafe
        }

        // Persist JD + keywords for this tab so subsequent /api/form-filler/ask
        // calls answer with the *same* job in mind. Fixes the "extension forgets
        // context about me / the role" issue when filling forms.
        if (tabUrl) {
            setJdContext(tabUrl, jdText, keywords);
            console.log(`   🧠 JD context cached for ${tabUrl}`);
        }

        res.json({ keywords });
    } catch (e: any) {
        console.error("Analyze JD Error:", e.message);
        res.status(500).json({ error: 'Failed to analyze JD' });
    }
});

// POST /api/resume/optimize — AI optimizes resume for JD (Generates LaTeX)
app.post('/api/resume/optimize', async (req, res) => {
    const { jdText, selectedKeywords } = req.body;
    const resumeData = loadResumeData();

    console.log(`\n🚀 [Resume Optimization] Re-writing bullet points...`);
    
    const prompt = `Act as a senior career coach and LaTeX expert. 
Given the Job Description below and Rishav Tarway's resume data, rewrite his "Experience" and "Projects" sections into LaTeX code for the FAANGPath resume template.

FORMAT RULES:
1. EXPERIENCE SECTION:
   For each job, use the rSubsection environment:
   \begin{rSubsection}{Company Name}{Date Range}{Role Name}{Location}
      \item \textbf{High-impact bullet point} weaving in keywords and metrics.
   \end{rSubsection}

2. PROJECTS SECTION:
   Use this format for EACH project item:
   \item \textbf{Project Title.} {Project description including tech stack and impact. Use quantifiable metrics where possible.}

3. KEYWORDS TO WEAVE IN: ${selectedKeywords.join(', ')}

4. OUTPUT REQUIREMENTS:
   - Provide the EXPERIENCE section first, followed by the PROJECTS section.
   - Separate them with exactly: [SECTION_SEPARATOR]
   - Use ONLY valid LaTeX. No markdown code blocks. No extra text.

Resume Data: ${JSON.stringify(resumeData)}
JD: ${safeSlice(jdText, 2500)}`;

    try {
        const result = await callAI([{ role: 'user', content: prompt }]);
        
        let exp = "";
        let proj = "";
        
        // Try exact separator
        if (result.includes('[SECTION_SEPARATOR]')) {
            const parts = result.split('[SECTION_SEPARATOR]');
            exp = parts[0] || "";
            proj = parts[1] || "";
        } 
        // Fallback: models might use Markdown headers or just split naturally
        else if (result.includes('PROJECTS')) {
            const splitRegex = /(?:#+\s*PROJECTS|\*\*PROJECTS\*\*|PROJECTS\s*SECTION)/i;
            const parts = result.split(splitRegex);
            exp = parts[0] || "";
            proj = parts[1] || "";
        }
        else {
            console.error("AI did not separate sections properly. Raw output:", result);
            // Put everything in exp as a last resort
            exp = result;
        }

        // Strip any wrapping markdown code blocks the AI might aggressively wrap it in
        exp = exp.replace(/```latex/ig, '').replace(/```/g, '').trim();
        proj = proj.replace(/```latex/ig, '').replace(/```/g, '').trim();

        res.json({ experience: exp, projects: proj });
    } catch (e: any) {
        console.log("Optimize Error Triggered:", e.message);
        res.status(500).json({ error: 'Failed to optimize resume' });
    }
});

// POST /api/resume/generate-pdf — Compile LaTeX to PDF via Tectonic
app.post('/api/resume/generate-pdf', async (req, res) => {
    const { experience, projects } = req.body;
    
    const templatePath = path.join(process.cwd(), 'resume_template.tex');
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Robust Sanitize for LaTeX
    const sanitizeLatex = (str: string): string => {
        return str
            .replace(/(?<!\\)%/g, '\\%')
            .replace(/(?<!\\)&/g, '\\&')
            .replace(/(?<!\\)\$/g, '\\$')
            .replace(/(?<!\\)_/g, '\\_')
            .replace(/(?<!\\)#/g, '\\#');
    };

    const safeExp = sanitizeLatex(experience || '');
    const safeProj = sanitizeLatex(projects || '');

    // Simple placeholder replacement
    const fullLatex = template
        .replace('{{EXPERIENCE}}', safeExp)
        .replace('{{PROJECTS}}', safeProj);

    const tempTexPath = path.join(process.cwd(), 'temp_resume.tex');
    const tempPdfPath = path.join(process.cwd(), 'temp_resume.pdf');
    
    fs.writeFileSync(tempTexPath, fullLatex);

    console.log(`\n⚙️ [PDF Generation] Compiling with Tectonic...`);
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execPromise = promisify(exec);

    try {
        const homebrewPath = '/opt/homebrew/bin:/usr/local/bin:';
        await execPromise(`tectonic ${tempTexPath}`, {
            env: { ...process.env, PATH: homebrewPath + process.env.PATH }
        });
        const pdfBuffer = fs.readFileSync(tempPdfPath);
        
        // Save to public folder for direct access if needed
        const publicPdfPath = path.join(process.cwd(), 'public', 'optimized_resume.pdf');
        fs.writeFileSync(publicPdfPath, pdfBuffer);

        res.json({ 
            success: true, 
            pdfUrl: '/optimized_resume.pdf',
            latex: fullLatex 
        });
    } catch (e: any) {
        console.error('❌ Tectonic Error:', e.message);
        res.status(500).json({ error: 'LaTeX compilation failed: ' + e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Form-Filler Server running at http://localhost:${PORT}`);
    console.log(`   AI Status: ${OPENROUTER_API_KEY ? 'Enabled' : 'Disabled (Key missing)'}`);
});
