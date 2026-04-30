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
    const geminiKey = process.env.GEMINI_API_KEY;
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    if (!geminiKey && !nvidiaKey && !openrouterKey) {
        console.warn('⚠️ No AI API Keys found (Gemini / NVIDIA / OpenRouter). Skipping LLM.');
        return 'UNKNOWN';
    }

    // ── Direct Gemini (preferred) — matches the NAS scraper's pattern.
    // Handles 429 with backoff based on Google's `retryDelay` so the free-tier
    // RPM cap doesn't cascade into empty results.
    if (geminiKey) {
        const prompt = messages.map((m) => m.content).join('\n\n---\n\n');
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                console.log(`🤖 AI Attempt: Using gemini:${geminiModel}...`);
                const response = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: { temperature },
                        }),
                    }
                );
                const data: any = await response.json();
                if (data?.error) {
                    const status = data.error.status || data.error.code;
                    const msg: string = data.error.message || JSON.stringify(data.error).slice(0, 240);
                    const isRateLimit =
                        status === 'RESOURCE_EXHAUSTED' ||
                        data.error.code === 429 ||
                        /quota|rate/i.test(msg);
                    if (isRateLimit && attempt < 2) {
                        let waitMs = 35_000;
                        for (const d of data.error.details || []) {
                            if (d.retryDelay && typeof d.retryDelay === 'string') {
                                const m = d.retryDelay.match(/(\d+(?:\.\d+)?)s/);
                                if (m) waitMs = Math.ceil(parseFloat(m[1]) * 1000) + 2_000;
                            }
                        }
                        const inMsg = msg.match(/retry in ([\d.]+)s/i);
                        if (inMsg) waitMs = Math.ceil(parseFloat(inMsg[1]) * 1000) + 2_000;
                        console.warn(`   ⏳ Gemini rate-limited (attempt ${attempt + 1}/3). Sleeping ${(waitMs / 1000).toFixed(1)}s then retrying…`);
                        await new Promise((r) => setTimeout(r, waitMs));
                        continue;
                    }
                    console.warn(`   ⚠️ Gemini API error: ${msg}`);
                    break;
                }
                const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (content && content.trim()) return content.trim();
                console.warn(`   ⚠️ Gemini returned empty content — falling through.`);
                break;
            } catch (e: any) {
                console.error(`   ❌ Gemini call failed (attempt ${attempt + 1}):`, e.message);
                break;
            }
        }
    }

    const providers = [];
    if (openrouterKey) {
        // Only include models confirmed to work on OpenRouter today.
        // Removed `gemini-2.0-pro-exp-02-05:free` (returns 400 "not a valid
        // model ID") and `gemma-2-9b-it:free` (returns 404 "No endpoints
        // found"). Keep the stable flash-lite id.
        providers.push({
            name: 'openrouter',
            key: openrouterKey,
            models: [
                "google/gemini-2.0-flash-lite-001",
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
    if (!process.env.GEMINI_API_KEY && !process.env.NVIDIA_API_KEY && !OPENROUTER_API_KEY) {
        console.warn('⚠️ No AI API Key (Gemini / NVIDIA / OpenRouter). Skipping LLM.');
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
    res.json({
        status: 'online',
        fields: Object.keys(data).length,
        llm_available: !!(process.env.GEMINI_API_KEY || process.env.NVIDIA_API_KEY || OPENROUTER_API_KEY),
    });
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
//
// New template (main.tex-style, a4paper 9.5pt, two-column, strict 1 page).
// We generate THREE sections (Skills + Experience + Projects) split by
// [SECTION_SEPARATOR] markers. The prompt enforces hard 1-page caps on
// bullet counts and lengths, and the server re-prompts once if any
// user-selected keyword is missing from the generated output.

const OPTIMIZE_FORMAT_SPEC = `
OUTPUT EXACTLY THREE SECTIONS separated by the literal marker [SECTION_SEPARATOR].
The order must be: SKILLS, then EXPERIENCE, then PROJECTS.
Do NOT include the word "SKILLS", "EXPERIENCE" or "PROJECTS" as a header — the template already has the headings. Output ONLY the body LaTeX for each section.

═══════════════════════════════════════════════════════════════════
SECTION 1 — SKILLS (raw LaTeX, MUST use exactly 7 lines, exactly this format):
\\textbf{Languages:} ...\\\\[1pt]
\\textbf{Web:} ...\\\\[1pt]
\\textbf{Mobile:} ...\\\\[1pt]
\\textbf{DB \\& Cloud:} ...\\\\[1pt]
\\textbf{Tools:} ...\\\\[1pt]
\\textbf{AI \\& APIs:} ...\\\\[1pt]
\\textbf{Core:} ...
Each line: ≤90 chars after the category. Comma-separated, no trailing period.
Re-order / swap items so JD-critical tech is FIRST in each line.
Do NOT invent skills Rishav doesn't have — only re-prioritise real ones from his data.

═══════════════════════════════════════════════════════════════════
SECTION 2 — EXPERIENCE (raw LaTeX, exactly 5 roles in this order; format per role below):
Roles (fixed, in this order): IIIT Bangalore — MOSIP | Classplus | TechVastra | Testbook | Franchizerz.

For EACH role, output EXACTLY this block (replace placeholder text only):
{\\fontsize{8.8}{11}\\selectfont\\textbf{<ROLE TITLE>}\\hfill\\textit{<DATE RANGE>}}\\\\
{\\fontsize{8.8}{11}\\selectfont\\textbf{\\color{accentblue}<COMPANY>}\\hfill <LOCATION>}
\\begin{itemize}\\fontsize{8.8}{11}\\selectfont
  \\item <Bullet 1 tailored to JD, ≤140 chars>
  \\item <Bullet 2 tailored to JD, ≤140 chars>
  \\item <Bullet 3 tailored to JD, ≤140 chars>
\\end{itemize}
\\vspace{4pt}

Rules for bullets:
- Exactly 3 bullets per role (no more, no less).
- Each bullet ≤140 characters.
- Rewrite to reflect JD priorities, but STAY TRUTHFUL to Rishav's actual work.
- Use \\textbf{metric}% / \\textbf{Nk+ users} / PR \\#NNNN where real.
- Start each bullet with a strong action verb.

═══════════════════════════════════════════════════════════════════
SECTION 3 — PROJECTS (raw LaTeX, exactly 4 projects in this order; format below):
Projects (fixed): Tech Stream Community | CoinWatch | ProResume | Scholar Track.

For EACH project output EXACTLY:
{\\fontsize{8.8}{11}\\selectfont\\textbf{<PROJECT NAME>}\\hfill\\href{<LIVE OR GITHUB URL>}{Live | GitHub}}\\\\
{\\fontsize{8.2}{10}\\selectfont\\textit{<TECH STACK, \\textbullet\\ separated>}}
\\begin{itemize}\\fontsize{8.8}{11}\\selectfont
  \\item <Bullet 1 tailored to JD, ≤140 chars>
  \\item <Bullet 2 tailored to JD, ≤140 chars>
\\end{itemize}
\\vspace{4pt}

Rules for projects:
- Exactly 2 bullets per project.
- Each bullet ≤140 chars.
- Links (URLs) are fixed — do not change them.

═══════════════════════════════════════════════════════════════════
GLOBAL RULES:
- Output ONLY raw LaTeX across all three sections, split by [SECTION_SEPARATOR].
- NO markdown fences. NO "## Skills" headers. NO explanation text.
- Every user-selected keyword MUST appear at least once across the output.
- If a keyword does not naturally fit any real bullet, weave it into the closest Skills line — do NOT fabricate experience.
- Total output must fit ONE A4 page using 9.5pt font; stay within the bullet counts above.
`;

const FIXED_RESUME_FACTS = `
RISHAV TARWAY — RESUME FACTS (authoritative, do not contradict):

SKILLS (master list — re-prioritise, don't fabricate):
- Languages: Java, C++, JavaScript, TypeScript, Python, Go
- Web: React, Next.js, Node.js, Express, Redux, REST APIs, Socket.io
- Mobile: React Native, Expo SDK 51
- DB & Cloud: SQL, MongoDB, Redis, Supabase, AWS (S3, CloudFront)
- Tools: Git, Docker, Selenium, CI/CD, Cucumber BDD, OSS-Fuzz, ASAN
- AI & APIs: Gemini API, GPT, CoinGecko API, Zustand
- Core: OOP, DSA, System Design, ML, Fuzz Testing

EXPERIENCE (ordered most-recent first):
1. Research SWE Intern — IIIT Bangalore — MOSIP — Jul–Oct 2025 — Remote
   - Selenium + Java + Cucumber BDD test suites for national government biometric identity systems
   - PR #1370: automated multilingual UI navigation & eSignet IDP verification
   - PR #543: fixed auto-logout bug during background sync
2. Software Engineer Intern — Classplus — Nov 2024 – Jan 2025 — Noida
   - Improved observability 40% via unique request-ID tracing across Express.js middleware
   - Reduced API latency 25% for 10k+ concurrent users
   - Async-local-storage error tracking improved production incident MTTR
3. Full Stack Developer Intern — TechVastra — Sep–Nov 2024 — Remote
   - Next.js + TypeScript web app with Android platform integration
   - Boosted front-end perf 30% via React Hooks refactoring / memoisation
   - Designed RESTful APIs handling 10k+ concurrent user data sync operations
4. QA Automation Intern — Testbook — Sep–Nov 2024 — Noida
   - Selenium + ChromeDriver framework, 50% faster test execution
   - Uncovered 30+ critical bugs; automated regression pipeline
   - Cut regression testing time, faster sprint delivery cycles
5. Frontend Developer Intern — Franchizerz — Jul–Dec 2024 — Remote
   - Built Franchizerz.com UI with React + Next.js + REST APIs, modular OOP
   - Lighthouse 68 → 92 via route-level code-splitting + lazy loading
   - HTML5/CSS3 best practices, reusable component library

PROJECTS:
1. Tech Stream Community (https://techi-spott.vercel.app/) — React, Socket.io, MongoDB, AWS S3/CloudFront, Redis, Chart.js
   - Real-time chat: 500+ users, 99.9% uptime, live admin dashboard
   - WebSocket scaling + rate-limiting, 500+ concurrent conns, <100ms latency
   - Chart.js + Redis pub/sub analytics pipeline
2. CoinWatch (https://coinwatch-app-seven.vercel.app/) — React Native, Expo SDK 51, TypeScript, Zustand, Supabase, CoinGecko API
   - Live prices, 7-day sparklines, portfolio P&L, price alerts, multi-currency
   - FlashList at 60fps; global market cap, BTC dominance, volume stats
   - Supabase Postgres + Google OAuth cross-device cloud sync
3. ProResume (https://proresume-eight.vercel.app/) — React Native, Expo SDK 51, TypeScript, Supabase, Gemini API, Zustand
   - ATS-optimised builder: Gemini scoring, JD tailoring, cover letter gen
   - Kanban tracker (Saved/Applied/Interview/Rejected/Ghosted) + PDF export
   - Master profile architecture, Supabase + Google OAuth cross-device sync
4. Scholar Track App (https://github.com/rishavtarway/Student-Database-System/) — Java, SQL, Docker, CI/CD
   - 60% query boost via HashMap caching + SQL indexing
   - Dockerized CI/CD zero-downtime deployments
`;

function stripFences(s: string): string {
    return String(s || '').replace(/```latex/ig, '').replace(/```/g, '').trim();
}

function splitThreeSections(raw: string): { skills: string; experience: string; projects: string } {
    const parts = String(raw || '').split(/\[SECTION_SEPARATOR\]/i);
    return {
        skills: stripFences(parts[0] || ''),
        experience: stripFences(parts[1] || ''),
        projects: stripFences(parts[2] || ''),
    };
}

function findMissingKeywords(selected: string[], combined: string): string[] {
    const haystack = combined.toLowerCase();
    return (selected || []).filter((kw) => {
        const needle = String(kw || '').trim().toLowerCase();
        if (!needle) return false;
        return !haystack.includes(needle);
    });
}

app.post('/api/resume/optimize', async (req, res) => {
    const { jdText, selectedKeywords } = req.body;
    const kws: string[] = Array.isArray(selectedKeywords) ? selectedKeywords : [];

    console.log(`\n🚀 [Resume Optimization] Re-writing Skills + Experience + Projects for JD…`);
    console.log(`   Selected keywords (${kws.length}): ${kws.join(', ')}`);

    const basePrompt = `Act as a senior career coach + LaTeX expert tailoring Rishav Tarway's one-page resume to the JD below.

${FIXED_RESUME_FACTS}

KEYWORDS THAT MUST APPEAR (user-selected, ALL must be woven in):
${kws.length ? kws.map((k) => `- ${k}`).join('\n') : '(none — still rewrite for JD fit)'}

JOB DESCRIPTION:
${safeSlice(jdText || '', 2500)}

${OPTIMIZE_FORMAT_SPEC}`;

    try {
        let raw = await callAI([{ role: 'user', content: basePrompt }]);
        let { skills, experience, projects } = splitThreeSections(raw);

        // Retry ONCE if sections are incomplete
        if (!skills || !experience || !projects) {
            console.warn(`   ⚠️  Incomplete sections on first pass (skills=${!!skills}, exp=${!!experience}, proj=${!!projects}) — retrying once…`);
            raw = await callAI([{ role: 'user', content: basePrompt + '\n\nREMINDER: Output THREE sections separated by [SECTION_SEPARATOR]. Do NOT omit any.' }]);
            ({ skills, experience, projects } = splitThreeSections(raw));
        }

        // Keyword-coverage check across the combined output — re-prompt once if any missing
        if (kws.length) {
            const combined = `${skills}\n${experience}\n${projects}`;
            const missing = findMissingKeywords(kws, combined);
            if (missing.length) {
                console.warn(`   ⚠️  Missing ${missing.length}/${kws.length} keywords: ${missing.join(', ')} — re-prompting for coverage…`);
                const coveragePrompt = basePrompt + `

COVERAGE FAILURE — your previous answer omitted these keywords: ${missing.join(', ')}.
Re-emit ALL THREE sections, with every one of those keywords naturally woven into the closest real bullet (or Skills line). Do NOT fabricate experience; if a keyword has no real fit, add it to the relevant Skills line.`;
                const retryRaw = await callAI([{ role: 'user', content: coveragePrompt }]);
                const retry = splitThreeSections(retryRaw);
                if (retry.skills && retry.experience && retry.projects) {
                    skills = retry.skills;
                    experience = retry.experience;
                    projects = retry.projects;
                    const stillMissing = findMissingKeywords(kws, `${skills}\n${experience}\n${projects}`);
                    if (stillMissing.length) {
                        console.warn(`   ⚠️  Still missing after retry: ${stillMissing.join(', ')} (proceeding anyway).`);
                    } else {
                        console.log(`   ✅ All ${kws.length} keywords covered after retry.`);
                    }
                }
            } else {
                console.log(`   ✅ All ${kws.length} keywords covered on first pass.`);
            }
        }

        res.json({ skills, experience, projects });
    } catch (e: any) {
        console.log('Optimize Error Triggered:', e.message);
        res.status(500).json({ error: 'Failed to optimize resume' });
    }
});

// POST /api/resume/generate-pdf — Compile LaTeX to PDF via Tectonic
app.post('/api/resume/generate-pdf', async (req, res) => {
    const { skills, experience, projects } = req.body;

    const templatePath = path.join(process.cwd(), 'resume_template.tex');
    let template = fs.readFileSync(templatePath, 'utf-8');

    // The optimise endpoint already emits raw LaTeX per section (with \textbf,
    // \item, \#, \& etc. already escaped) so we do NOT re-sanitize — doing so
    // would double-escape valid LaTeX commands and break compilation.
    const safeSkills = String(skills || '').trim();
    const safeExp = String(experience || '').trim();
    const safeProj = String(projects || '').trim();

    // Placeholder replacement. IMPORTANT: we pass a replacer FUNCTION (not a
    // plain string) because JavaScript's String.replace() interprets `$&`,
    // `$'`, `` $` ``, `$$` and `$1` specially inside a string replacement,
    // which can silently corrupt AI-generated LaTeX containing math-mode
    // notation like `$f'(x)$`. A function replacer bypasses that.
    const fullLatex = template
        .replace('{{SKILLS}}', () => safeSkills)
        .replace('{{EXPERIENCE}}', () => safeExp)
        .replace('{{PROJECTS}}', () => safeProj);

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
    const aiKeysPresent = [
        process.env.GEMINI_API_KEY ? 'Gemini' : null,
        process.env.NVIDIA_API_KEY ? 'NVIDIA' : null,
        OPENROUTER_API_KEY ? 'OpenRouter' : null,
    ].filter(Boolean);
    console.log(`   AI Status: ${aiKeysPresent.length ? `Enabled (${aiKeysPresent.join(', ')})` : 'Disabled (no keys)'}`);
});
