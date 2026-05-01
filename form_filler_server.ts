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
// Per-provider session disable. If a provider returns a long retryDelay
// (e.g. "limit: 0" daily quota burned), we skip it until that time passes
// instead of sleeping 60s × N times on every subsequent call.
const providerDisabledUntil: Record<string, number> = {};
function isProviderDisabled(name: string): boolean {
    const until = providerDisabledUntil[name] || 0;
    return until > Date.now();
}
function disableProvider(name: string, ms: number, reason: string) {
    providerDisabledUntil[name] = Date.now() + ms;
    console.warn(`   🚫 Disabling ${name} for ${Math.round(ms / 1000)}s (${reason}).`);
}

type ChatProvider = {
    name: string;
    key: string;
    models: string[];
    endpoint: string;
    extraHeaders?: Record<string, string>;
};

async function tryOpenAIChatProvider(
    provider: ChatProvider,
    prompt: string,
    temperature: number,
): Promise<string | null> {
    if (isProviderDisabled(provider.name)) {
        console.log(`   ⏭️  Skipping ${provider.name} (session-disabled).`);
        return null;
    }
    for (const modelName of provider.models) {
        try {
            console.log(`🤖 AI Attempt: Using ${provider.name}:${modelName}...`);
            const response = await fetch(provider.endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${provider.key}`,
                    'Content-Type': 'application/json',
                    ...(provider.extraHeaders || {}),
                },
                body: JSON.stringify({
                    model: modelName,
                    messages: [{ role: 'user', content: prompt }],
                    temperature,
                }),
            });
            const data: any = await response.json().catch(() => ({}));

            if (response.status === 401) {
                console.log(`   ❌ Auth error on ${provider.name}. Disabling provider.`);
                disableProvider(provider.name, 60 * 60 * 1000, '401 auth');
                return null;
            }
            if (response.status === 429 || response.status === 402 || response.status === 503) {
                // Short disable; don't block the rest of the request on this provider.
                disableProvider(provider.name, 60 * 1000, `HTTP ${response.status}`);
                return null;
            }
            if (!response.ok) {
                console.warn(`   ⚠️  ${provider.name}:${modelName} HTTP ${response.status} — trying next model.`);
                continue;
            }
            const content = data.choices?.[0]?.message?.content?.trim();
            if (content) return content;
            console.warn(`   ⚠️  ${provider.name}:${modelName} empty content — trying next model.`);
        } catch (e: any) {
            console.error(`   ❌ ${provider.name}:${modelName} network error: ${e.message}`);
        }
    }
    return null;
}

// Direct Gemini with AGGRESSIVE bail. Single short retry ONLY if retryDelay <= 10s;
// if Google returns `limit: 0` or a long retryDelay, we disable Gemini for the
// rest of the session instead of sleeping 60s twice on every subsequent call.
async function tryGeminiDirect(prompt: string, temperature: number): Promise<string | null> {
    if (isProviderDisabled('gemini')) {
        console.log('   ⏭️  Skipping gemini (session-disabled).');
        return null;
    }
    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) return null;
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash-lite';

    for (let attempt = 0; attempt < 2; attempt++) {
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
                },
            );
            const data: any = await response.json().catch(() => ({}));
            if (data?.error) {
                const msg: string = data.error.message || JSON.stringify(data.error).slice(0, 240);
                const isRateLimit =
                    data.error.status === 'RESOURCE_EXHAUSTED' ||
                    data.error.code === 429 ||
                    /quota|rate/i.test(msg);
                // Parse retryDelay (e.g. "57.640797955s"). Google also embeds
                // "limit: 0" inside the message when daily quota is done.
                let retrySec = 0;
                for (const d of data.error.details || []) {
                    if (typeof d.retryDelay === 'string') {
                        const m = d.retryDelay.match(/(\d+(?:\.\d+)?)s/);
                        if (m) retrySec = parseFloat(m[1]);
                    }
                }
                const inMsg = msg.match(/retry in ([\d.]+)s/i);
                if (inMsg) retrySec = Math.max(retrySec, parseFloat(inMsg[1]));
                const dailyQuotaDone = /limit:\s*0/i.test(msg);

                if (isRateLimit && (dailyQuotaDone || retrySec >= 20)) {
                    // Don't sleep — disable for session so subsequent resumes also skip it instantly.
                    const disableMs = dailyQuotaDone
                        ? 6 * 60 * 60 * 1000 // 6h
                        : Math.ceil(retrySec * 1000) + 5_000;
                    disableProvider('gemini', disableMs, dailyQuotaDone ? 'daily quota (limit:0)' : `long retryDelay ${retrySec}s`);
                    return null;
                }
                if (isRateLimit && retrySec > 0 && retrySec <= 10 && attempt === 0) {
                    const waitMs = Math.ceil(retrySec * 1000) + 1_000;
                    console.warn(`   ⏳ Gemini short rate-limit (${retrySec}s). One quick retry…`);
                    await new Promise((r) => setTimeout(r, waitMs));
                    continue;
                }
                console.warn(`   ⚠️  Gemini API error: ${msg.slice(0, 160)}`);
                return null;
            }
            const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (content && content.trim()) return content.trim();
            console.warn('   ⚠️  Gemini returned empty content.');
            return null;
        } catch (e: any) {
            console.error(`   ❌ Gemini network error (attempt ${attempt + 1}): ${e.message}`);
            return null;
        }
    }
    return null;
}

// Primary callAI: try providers in speed/reliability order, fail fast.
// Groq (free, ~1s, Llama 3.3 70B) → Cerebras (free, ~1s) → NVIDIA 405b →
// Direct Gemini (short retry only) → OpenRouter.
async function callAI(messages: any[], temperature = 0.1): Promise<string> {
    const groqKey = process.env.GROQ_API_KEY;
    const cerebrasKey = process.env.CEREBRAS_API_KEY;
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;

    if (!groqKey && !cerebrasKey && !nvidiaKey && !geminiKey && !openrouterKey) {
        console.warn('⚠️  No AI API Keys found. Skipping LLM.');
        return 'UNKNOWN';
    }
    const prompt = messages.map((m) => m.content).join('\n\n---\n\n');

    // 1. Groq — fast free path. Llama 3.3 70B versatile typically <2s e2e.
    if (groqKey) {
        const out = await tryOpenAIChatProvider(
            {
                name: 'groq',
                key: groqKey,
                models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
                endpoint: 'https://api.groq.com/openai/v1/chat/completions',
            },
            prompt,
            temperature,
        );
        if (out) return out;
    }

    // 2. Cerebras — also very fast free tier.
    if (cerebrasKey) {
        const out = await tryOpenAIChatProvider(
            {
                name: 'cerebras',
                key: cerebrasKey,
                models: ['llama-3.3-70b', 'llama3.1-8b'],
                endpoint: 'https://api.cerebras.ai/v1/chat/completions',
            },
            prompt,
            temperature,
        );
        if (out) return out;
    }

    // 3. NVIDIA NIM. 405b is usually stable, 70b is faster but flakier.
    if (nvidiaKey) {
        const out = await tryOpenAIChatProvider(
            {
                name: 'nvidia',
                key: nvidiaKey,
                models: ['meta/llama-3.1-405b-instruct', 'meta/llama-3.1-70b-instruct'],
                endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
            },
            prompt,
            temperature,
        );
        if (out) return out;
    }

    // 4. Direct Gemini. Single short retry only; bails immediately on daily-quota.
    if (geminiKey) {
        const out = await tryGeminiDirect(prompt, temperature);
        if (out) return out;
    }

    // 5. OpenRouter — last resort.
    if (openrouterKey) {
        const out = await tryOpenAIChatProvider(
            {
                name: 'openrouter',
                key: openrouterKey,
                models: ['google/gemini-2.0-flash-lite-001'],
                endpoint: 'https://openrouter.ai/api/v1/chat/completions',
                extraHeaders: {
                    'HTTP-Referer': 'http://localhost:3000',
                    'X-OpenRouter-Title': 'JobPulse AI Optimizer',
                },
            },
            prompt,
            temperature,
        );
        if (out) return out;
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
    if (
        !process.env.GROQ_API_KEY &&
        !process.env.CEREBRAS_API_KEY &&
        !process.env.NVIDIA_API_KEY &&
        !process.env.GEMINI_API_KEY &&
        !OPENROUTER_API_KEY
    ) {
        console.warn('⚠️ No AI API Key (Groq / Cerebras / NVIDIA / Gemini / OpenRouter). Skipping LLM.');
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

// GET /api/resume/extract-fields — structured directory of every resume
// field the extension popup can offer as click-to-copy chips so the user
// can manually fill fields the auto-filler couldn't figure out.
app.get('/api/resume/extract-fields', (_req, res) => {
    res.json(RESUME_FIELD_DIRECTORY);
});

// GET /api/form-filler/status — check if online
app.get('/api/form-filler/status', (req, res) => {
    const data = loadResumeData();
    res.json({
        status: 'online',
        fields: Object.keys(data).length,
        llm_available: !!(
            process.env.GROQ_API_KEY ||
            process.env.CEREBRAS_API_KEY ||
            process.env.NVIDIA_API_KEY ||
            process.env.GEMINI_API_KEY ||
            OPENROUTER_API_KEY
        ),
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
// We generate FOUR sections (Objective + Skills + Experience + Projects)
// split by [SECTION_SEPARATOR] markers. The prompt enforces hard 1-page
// caps on bullet counts and lengths, strict bullet templates (user-
// specified), and the server re-prompts once if any user-selected keyword
// is missing from the generated output.

const OPTIMIZE_FORMAT_SPEC = `
OUTPUT EXACTLY FIVE SECTIONS separated by the literal marker [SECTION_SEPARATOR].
The order must be: LOCATION, then OBJECTIVE, then SKILLS, then EXPERIENCE, then PROJECTS.
Do NOT include the words "LOCATION", "OBJECTIVE", "SKILLS", "EXPERIENCE" or "PROJECTS" as headers — the template already has the headings (LOCATION is just used to overwrite the header city). Output ONLY the body LaTeX for each section.

═══════════════════════════════════════════════════════════════════
SECTION 0 — LOCATION (one short line, NOT LaTeX, just plain text).

Read the JD. Decide where Rishav should claim he's based for THIS application:
- If the JD says the role is in a specific city (e.g. "Hyderabad", "Bengaluru / Bangalore", "Mumbai", "Pune", "Chennai", "Gurugram", "Noida", "Delhi NCR", etc.) AND it implies on-site / hybrid / "must be based in" / "located in", emit the city as: "<City>, <State>, India" using the canonical state (Hyderabad → Telangana; Bengaluru → Karnataka; Mumbai/Pune → Maharashtra; Chennai → Tamil Nadu; Gurugram → Haryana; Noida → Uttar Pradesh; Delhi → Delhi).
- If the JD is fully Remote / WFH / "anywhere in India" / "PAN India" / says nothing about location, emit the literal token: DEFAULT
- If the JD lists multiple Indian cities, pick the FIRST one and use it.

Emit ONE LINE only. No quotes. No prose. Examples of valid output for this section:
"Hyderabad, Telangana, India"
"Bengaluru, Karnataka, India"
"DEFAULT"

═══════════════════════════════════════════════════════════════════
SECTION 1 — OBJECTIVE (raw LaTeX, exactly 1 sentence, <=260 chars).

Use this EXACT structure (replace angle-bracket placeholders):
Software Engineer with 1.5 years of internship experience in <TOP 3-4 STACK ITEMS FROM THE JD, comma-separated>, seeking full-time <EXACT ROLE TITLE FROM THE JD> roles with a focus on <1-2 JD-critical outcomes like "scalable backends" or "data-driven automation">.

Rules:
- <EXACT ROLE TITLE FROM THE JD> must come from the analysed JD (e.g. "Business Analyst Intern", "Frontend Developer", "ML Engineer"). Use the exact phrasing the JD used.
- <TOP 3-4 STACK ITEMS> must be the MOST JD-critical user-selected keywords or tech from Rishav's real skill list.
- Weave in at least 2 JD keywords naturally.
- No double-quotes. No markdown. One single line.

═══════════════════════════════════════════════════════════════════
SECTION 2 — SKILLS (raw LaTeX, MUST use exactly 7 lines, exactly this format):
\\textbf{Languages:} ...\\\\[1pt]
\\textbf{Web:} ...\\\\[1pt]
\\textbf{Mobile:} ...\\\\[1pt]
\\textbf{DB \\& Cloud:} ...\\\\[1pt]
\\textbf{Tools:} ...\\\\[1pt]
\\textbf{AI \\& APIs:} ...\\\\[1pt]
\\textbf{Core:} ...
Each line: <=90 chars after the category. Comma-separated, no trailing period.
Re-order / swap items so JD-critical tech is FIRST in each line.
Do NOT invent skills Rishav doesn't have — only re-prioritise real ones from his data.

═══════════════════════════════════════════════════════════════════
SECTION 3 — EXPERIENCE (raw LaTeX, exactly 5 roles in this order; format per role below):
Roles (fixed, in this order): IIIT Bangalore — MOSIP | Classplus | TechVastra | Testbook | Franchizerz.

For EACH role, output EXACTLY this block (replace placeholder text only):
{\\fontsize{8.4}{10.4}\\selectfont\\textbf{<ROLE TITLE>}\\hfill\\textit{<DATE RANGE>}}\\\\
{\\fontsize{8.4}{10.4}\\selectfont\\textbf{\\color{accentblue}<COMPANY>}\\hfill <LOCATION>}
\\begin{itemize}\\fontsize{8.4}{10.4}\\selectfont
  \\item <Bullet 1 tailored to JD, <=125 chars, ONE LINE>
  \\item <Bullet 2 tailored to JD, <=125 chars, ONE LINE>
  \\item <Bullet 3 tailored to JD, <=125 chars, ONE LINE>
\\end{itemize}
\\vspace{1pt}

BULLET-WRITING TEMPLATES — every bullet MUST follow one of these three shapes:
  Template A (metric-first):  "Achieved <X\\%> <outcome> for <who / feature> using <tech A>, <tech B>, and <tech C>."
  Template B (leadership):    "Led <initiative> which led to <X\\%> improvement in <metric / KPI>."
  Template C (build-verb):    "<Built | Developed | Shipped> <thing> that <did A, B, and C> using <X>, <Y>, and <Z>."

Rules for bullets:
- Exactly 3 bullets per role (no more, no less). The page is dense; 5 roles x 3 bullets fits one page.
- Each bullet MUST stay on a single line. Hard cap <=125 characters; aim for ~110.
  If the bullet is borderline, DROP adjectives / fillers ('successfully', 'effectively', 'in order to', 'various') instead of letting it wrap to two lines.
- Rotate templates A/B/C across the 3 bullets of a role so they don't all look the same.
- Rewrite to reflect JD priorities, but STAY TRUTHFUL to Rishav's actual work (no fabricated companies, dates, or projects).
- Always include a concrete metric (\\textbf{40\\%}, \\textbf{10k+ users}, PR \\#1234, \\textbf{60fps}, etc.) — use bold for the metric.
- Use \\textbf{metric\\%} / \\textbf{Nk+ users} / PR \\#NNNN (ALWAYS escape \\# and \\%).
- Start each bullet with a strong action verb (Achieved / Led / Developed / Built / Designed / Automated / Cut / Reduced / Scaled / Shipped / Integrated).
- Weave user-selected JD keywords across bullets so every selected keyword appears at least once across Experience + Projects + Skills + Objective.

═══════════════════════════════════════════════════════════════════
SECTION 4 — PROJECTS (raw LaTeX, exactly 4 projects in this order; format below):
Projects (fixed): Tech Stream Community | CoinWatch | ProResume | Scholar Track.

For EACH project output EXACTLY:
{\\fontsize{8.4}{10.4}\\selectfont\\textbf{<PROJECT NAME>}\\hfill\\href{<LIVE OR GITHUB URL>}{Live | GitHub}}\\\\
{\\fontsize{7.8}{9.6}\\selectfont\\textit{<TECH STACK, \\textbullet\\ separated>}}
\\begin{itemize}\\fontsize{8.4}{10.4}\\selectfont
  \\item <Bullet 1 tailored to JD, <=125 chars, ONE LINE>
  \\item <Bullet 2 tailored to JD, <=125 chars, ONE LINE>
\\end{itemize}
\\vspace{1pt}

PROJECT-BULLET TEMPLATE — follow this shape:
  "<Short Action Verb> <what> that <does A, B, and C> using <X>, <Y>, and <Z>. <Quantified success or adoption metric>."
Example: "Built a 60fps crypto portfolio tracker that supports live prices, multi-currency, and Supabase sync using React Native, Zustand, and CoinGecko API. Serves 500+ beta users."

Rules for projects:
- Exactly 2 bullets per project (tight — the page is already dense).
- Each bullet MUST stay on a single line. Hard cap <=125 characters; aim for ~110. Drop adjectives before letting it wrap.
- Links (URLs) are fixed, do not change them.
- Bullet 1 MUST follow the PROJECT-BULLET TEMPLATE (build-verb + tech stack + quantified success).
- Bullet 2 may be metric-first (Template A) or leadership (Template B) style.

═══════════════════════════════════════════════════════════════════
GLOBAL RULES:
- Output ONLY raw LaTeX across all five sections, split by [SECTION_SEPARATOR]. (Section 0 LOCATION is plain text — not LaTeX — but still split with the same marker.)
- NO markdown fences. NO "## Objective / ## Skills" headers. NO explanation text.
- NEVER USE MARKDOWN EMPHASIS. Specifically: never wrap text with **double asterisks** for bold or *single asterisks* for italic — these render literally in the PDF and instantly look AI-generated. Use \\textbf{...} for bold and \\emph{...} for italic instead. The ONLY acceptable asterisk in your output is inside an already-correct \\textbf{...} or \\emph{...} command, NEVER as a standalone markdown delimiter.
- Every user-selected keyword MUST appear at least once across the combined Objective + Skills + Experience + Projects.
- If a keyword does not naturally fit any real bullet, weave it into the Objective or the closest Skills line. Do NOT fabricate experience.
- Total output must FILL ONE A4 page using 9.5pt font; stay within the bullet counts above.
- NEVER use em-dash or en-dash characters. Always use two hyphens (--) instead.
- NEVER emit a bare # or %. PR numbers MUST be written as PR \\#1234. Percentages MUST be written as \\textbf{40\\%}.
- NEVER emit unicode bullet (\\u2022). Always use \\textbullet.
- NEVER emit smart quotes. Use straight ASCII ' and ".
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

// Structured directory of every resume field the extension's auto-filler
// may need. Exposed via GET /api/resume/extract-fields so the popup can
// render each as a one-click copy chip when the AI can't / doesn't know
// how to fill the field itself. Keep this hand-maintained and aligned
// with FIXED_RESUME_FACTS above.
const RESUME_FIELD_DIRECTORY = {
    identity: {
        full_name: 'Rishav Tarway',
        first_name: 'Rishav',
        last_name: 'Tarway',
        email: 'rishavtarway@gmail.com',
        phone: '+91-7004544142',
        phone_digits: '7004544142',
        country_code: '+91',
        address_city: 'Gurugram',
        address_state: 'Haryana',
        address_country: 'India',
        date_of_birth: '2004-05-11',
        gender: 'Male',
        nationality: 'Indian',
        linkedin: 'https://www.linkedin.com/in/rishav-tarway-fst/',
        github: 'https://github.com/rishavtarway',
        portfolio: 'https://my-portfolio-five-roan-36.vercel.app/',
        codeforces: 'https://codeforces.com/profile/NeonMagic',
    },
    education: {
        degree: 'B.Tech CSE (AI & ML)',
        university: 'Polaris School of Technology (Starex University)',
        cgpa: '8.85',
        graduation_year: '2027',
        start_year: '2023',
        high_school: 'DAV Cantt (Class XII 75%, 2022, Gaya)',
        secondary_school: 'DAV CRRC (Class X 80%, 2020, Gaya)',
    },
    skills_flat: [
        'Java', 'C++', 'JavaScript', 'TypeScript', 'Python', 'Go',
        'React', 'Next.js', 'Node.js', 'Express', 'Redux', 'REST APIs', 'Socket.io',
        'React Native', 'Expo SDK 51',
        'SQL', 'MongoDB', 'Redis', 'Supabase', 'AWS (S3, CloudFront)',
        'Git', 'Docker', 'Selenium', 'CI/CD', 'Cucumber BDD', 'OSS-Fuzz', 'ASAN',
        'Gemini API', 'GPT', 'CoinGecko API', 'Zustand',
        'OOP', 'DSA', 'System Design', 'ML', 'Fuzz Testing',
    ],
    skills_grouped: {
        languages: 'Java, C++, JavaScript, TypeScript, Python, Go',
        web: 'React, Next.js, Node.js, Express, Redux, REST APIs, Socket.io',
        mobile: 'React Native, Expo SDK 51',
        db_cloud: 'SQL, MongoDB, Redis, Supabase, AWS (S3, CloudFront)',
        tools: 'Git, Docker, Selenium, CI/CD, Cucumber BDD, OSS-Fuzz, ASAN',
        ai_apis: 'Gemini API, GPT, CoinGecko API, Zustand',
        core: 'OOP, DSA, System Design, ML, Fuzz Testing',
    },
    experience: [
        {
            role: 'Research Software Engineer Intern',
            company: 'IIIT Bangalore — MOSIP',
            dates: 'Jul 2025 – Oct 2025',
            location: 'Remote',
            bullets: [
                'Selenium + Java + Cucumber BDD test suites for national-government biometric identity systems',
                'PR #1370: automated multilingual UI navigation & eSignet IDP verification',
                'PR #543: fixed auto-logout bug during background sync',
            ],
        },
        {
            role: 'Software Engineer Intern',
            company: 'Classplus',
            dates: 'Nov 2024 – Jan 2025',
            location: 'Noida',
            bullets: [
                'Improved observability 40% via unique request-ID tracing across Express.js middleware',
                'Reduced API latency 25% for 10k+ concurrent users',
                'Async-local-storage error tracking improved production incident MTTR',
            ],
        },
        {
            role: 'Full Stack Developer Intern',
            company: 'TechVastra',
            dates: 'Sep 2024 – Nov 2024',
            location: 'Remote',
            bullets: [
                'Next.js + TypeScript web app with Android platform integration',
                'Boosted front-end perf 30% via React Hooks refactoring / memoisation',
                'Designed RESTful APIs handling 10k+ concurrent user data-sync operations',
            ],
        },
        {
            role: 'QA Automation Intern',
            company: 'Testbook',
            dates: 'Sep 2024 – Nov 2024',
            location: 'Noida',
            bullets: [
                'Selenium + ChromeDriver framework, 50% faster test execution',
                'Uncovered 30+ critical bugs; automated regression pipeline',
                'Cut regression testing time, faster sprint delivery cycles',
            ],
        },
        {
            role: 'Frontend Developer Intern',
            company: 'Franchizerz',
            dates: 'Jul 2024 – Dec 2024',
            location: 'Remote',
            bullets: [
                'Built Franchizerz.com UI with React + Next.js + REST APIs, modular OOP',
                'Lighthouse 68 → 92 via route-level code-splitting + lazy loading',
                'HTML5/CSS3 best practices, reusable component library',
            ],
        },
    ],
    projects: [
        {
            name: 'Tech Stream Community',
            url: 'https://techi-spott.vercel.app/',
            tech: 'React, Socket.io, MongoDB, AWS S3/CloudFront, Redis, Chart.js',
            bullets: [
                'Real-time chat: 500+ users, 99.9% uptime, live admin dashboard',
                'WebSocket scaling + rate-limiting, 500+ concurrent conns, <100ms latency',
                'Chart.js + Redis pub/sub analytics pipeline',
            ],
        },
        {
            name: 'CoinWatch',
            url: 'https://coinwatch-app-seven.vercel.app/',
            tech: 'React Native, Expo SDK 51, TypeScript, Zustand, Supabase, CoinGecko API',
            bullets: [
                'Live prices, 7-day sparklines, portfolio P&L, price alerts, multi-currency',
                'FlashList at 60fps; global market cap, BTC dominance, volume stats',
                'Supabase Postgres + Google OAuth cross-device cloud sync',
            ],
        },
        {
            name: 'ProResume',
            url: 'https://proresume-eight.vercel.app/',
            tech: 'React Native, Expo SDK 51, TypeScript, Supabase, Gemini API, Zustand',
            bullets: [
                'ATS-optimised builder: Gemini scoring, JD tailoring, cover-letter generation',
                'Kanban tracker (Saved / Applied / Interview / Rejected / Ghosted) + PDF export',
                'Master profile architecture, Supabase + Google OAuth cross-device sync',
            ],
        },
        {
            name: 'Scholar Track App',
            url: 'https://github.com/rishavtarway/Student-Database-System/',
            tech: 'Java, SQL, Docker, CI/CD',
            bullets: [
                '60% query boost via HashMap caching + SQL indexing',
                'Dockerized CI/CD zero-downtime deployments',
            ],
        },
    ],
    achievements: [
        'WoC 5.0 — OpenPrinting (go-avahi): selected contributor; built full fuzz-testing infra, 11 fuzz harnesses, CWE-401 16MB memory-leak fix, CWE-122 heap buffer overflow fix',
        '3 merged PRs in Stdlib.js (type safety & performance for 1M+ monthly users)',
        '2 merged PRs in OpenPrinting (CUPS driver bugs for enterprise Linux printing)',
        '1st Runner-Up — Hack With Uttarakhand (Team Code Heist), 36-hour AI resume generator',
    ],
    common_questions: {
        why_this_role:
            "I've spent the last 18 months building production-grade systems across 5 internships — shipping request-ID tracing at Classplus (observability +40%), automated BDD test suites at MOSIP (PR #1370 on multilingual IDP verification), and a 500-user real-time chat platform (Tech Stream Community). I want to apply that same ship-first mindset to the problems your team is solving.",
        why_us:
            'Your team ships real products at scale and cares about code quality + AI judgement — which matches how I work: I use AI tooling heavily but treat correctness, observability, and production-readiness as non-negotiables. The open-source PRs I land (OpenPrinting fuzz infra, OSS-Fuzz integration, Stdlib.js type safety) reflect that.',
        notice_period: 'Immediate — I am available to join full-time right away.',
        expected_salary: 'Open to market-competitive offers for the role and location.',
        willing_to_relocate: 'Yes — open to remote or on-site in any major Indian tech hub (Gurugram / Bengaluru / Hyderabad / Pune / NCR).',
        visa_status: 'Indian citizen, based in Gurugram. No visa needed for roles in India.',
        years_experience: '1.5 years of hands-on internship experience across full-stack, backend, QA automation, and open-source contributions.',
    },
} as const;

function stripFences(s: string): string {
    return String(s || '').replace(/```latex/ig, '').replace(/```/g, '').trim();
}

function splitFourSections(raw: string): {
    location: string;
    objective: string;
    skills: string;
    experience: string;
    projects: string;
} {
    const parts = String(raw || '').split(/\[SECTION_SEPARATOR\]/i);
    // The current prompt asks for FIVE sections (LOCATION, OBJECTIVE,
    // SKILLS, EXPERIENCE, PROJECTS). Older prompts / LLMs may emit only
    // 4 sections (no LOCATION) or 3 (no LOCATION + no OBJECTIVE). We
    // gracefully degrade to "" for the missing leading sections so the
    // template still compiles and the dashboard / popup never crashes.
    if (parts.length >= 5) {
        return {
            location: stripFences(parts[0] || '').replace(/^["']|["']$/g, '').trim(),
            objective: stripFences(parts[1] || ''),
            skills: stripFences(parts[2] || ''),
            experience: stripFences(parts[3] || ''),
            projects: stripFences(parts[4] || ''),
        };
    }
    if (parts.length >= 4) {
        return {
            location: '',
            objective: stripFences(parts[0] || ''),
            skills: stripFences(parts[1] || ''),
            experience: stripFences(parts[2] || ''),
            projects: stripFences(parts[3] || ''),
        };
    }
    return {
        location: '',
        objective: '',
        skills: stripFences(parts[0] || ''),
        experience: stripFences(parts[1] || ''),
        projects: stripFences(parts[2] || ''),
    };
}

const DEFAULT_LOCATION = 'Gurugram, Haryana, India';

// Decide the final location string injected into the resume header.
// Accepts the LLM's raw LOCATION section. If the model said "DEFAULT"
// (or anything that doesn't look like a real "<City>, …" string) we
// fall back to Rishav's actual location. Sanity-cap length so a
// runaway LLM can't blow up the header layout.
function pickLocation(llmLocation: string): string {
    const cleaned = String(llmLocation || '').replace(/[\r\n]+/g, ' ').trim();
    if (!cleaned) return DEFAULT_LOCATION;
    if (/^default$/i.test(cleaned)) return DEFAULT_LOCATION;
    // Must look like "<word>[, …]" with at least 2 chars total, no
    // LaTeX commands or special chars (this string is injected raw into
    // the header so any unescaped `&`, `#`, `%`, `$`, `_`, `^`, `~`,
    // `\`, `{`, `}` would silently break Tectonic compilation), max 60
    // chars (the header has limited width).
    if (cleaned.length > 60) return DEFAULT_LOCATION;
    if (/[\\{}&#%$_^~]/.test(cleaned)) return DEFAULT_LOCATION;
    if (!/[A-Za-z]/.test(cleaned)) return DEFAULT_LOCATION;
    return cleaned;
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

    console.log(`\n🚀 [Resume Optimization] Re-writing Objective + Skills + Experience + Projects for JD…`);
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
        let { location, objective, skills, experience, projects } = splitFourSections(raw);

        // Retry ONCE if the four LaTeX sections are incomplete. (LOCATION
        // is allowed to be empty — pickLocation() falls back to default.)
        //
        // IMPORTANT: We MUST NOT unconditionally overwrite on retry.
        // If the LLM returned only 3 LaTeX sections (back-compat),
        // objective is '' but skills / experience / projects are
        // potentially good. Only overwrite each section if the retry
        // produced a non-empty value; otherwise keep the first-pass
        // value. Mirrors the coverage-retry pattern below.
        const firstPassIncomplete =
            !objective || !skills || !experience || !projects;
        if (firstPassIncomplete) {
            console.warn(
                `   ⚠️  Incomplete sections on first pass (loc=${!!location}, obj=${!!objective}, skills=${!!skills}, exp=${!!experience}, proj=${!!projects}) — retrying once…`,
            );
            raw = await callAI([
                {
                    role: 'user',
                    content:
                        basePrompt +
                        '\n\nREMINDER: Output EXACTLY FIVE sections separated by [SECTION_SEPARATOR] in this order — LOCATION (one plain-text line), OBJECTIVE, SKILLS, EXPERIENCE, PROJECTS. Do NOT omit any. The OBJECTIVE is a single sentence opener that names the JD role.',
                },
            ]);
            const retried = splitFourSections(raw);
            location = retried.location || location;
            objective = retried.objective || objective;
            skills = retried.skills || skills;
            experience = retried.experience || experience;
            projects = retried.projects || projects;
        }

        // Keyword-coverage check across the combined output — re-prompt once if any missing
        if (kws.length) {
            const combined = `${objective}\n${skills}\n${experience}\n${projects}`;
            const missing = findMissingKeywords(kws, combined);
            if (missing.length) {
                console.warn(`   ⚠️  Missing ${missing.length}/${kws.length} keywords: ${missing.join(', ')} — re-prompting for coverage…`);
                const coveragePrompt = basePrompt + `

COVERAGE FAILURE — your previous answer omitted these keywords: ${missing.join(', ')}.
Re-emit ALL FIVE sections (LOCATION, OBJECTIVE, SKILLS, EXPERIENCE, PROJECTS), with every one of those keywords naturally woven into the closest real bullet, the Objective sentence, or a Skills line. Do NOT fabricate experience; if a keyword has no real fit, add it to the Objective or the relevant Skills line.`;
                const retryRaw = await callAI([{ role: 'user', content: coveragePrompt }]);
                const retry = splitFourSections(retryRaw);
                if (retry.skills && retry.experience && retry.projects) {
                    // Keep previous LOCATION / Objective if retry dropped them.
                    location = retry.location || location;
                    objective = retry.objective || objective;
                    skills = retry.skills;
                    experience = retry.experience;
                    projects = retry.projects;
                    const stillMissing = findMissingKeywords(
                        kws,
                        `${objective}\n${skills}\n${experience}\n${projects}`,
                    );
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

        const finalLocation = pickLocation(location);
        console.log(`   📍 Location: ${finalLocation}${finalLocation === DEFAULT_LOCATION ? ' (default — JD didn\'t require a specific city)' : ` (tailored from JD; LLM said '${location}')`}`);
        res.json({ location: finalLocation, objective, skills, experience, projects });
    } catch (e: any) {
        console.log('Optimize Error Triggered:', e.message);
        res.status(500).json({ error: 'Failed to optimize resume' });
    }
});

// Safely normalise LLM-generated LaTeX before injecting into the template.
// We CANNOT blanket-escape because the LLM intentionally emits real LaTeX
// commands (`\textbf`, `\item`, `\fontsize`, `\begin{itemize}`, etc.).
// We ONLY fix two classes of compile-breaking issues:
//   1. Unicode glyphs Helvetica T1 can't render (em-dash, en-dash,
//      bullet, smart quotes) — swap to LaTeX-safe equivalents.
//   2. Stray `#` and `%` that the model forgot to escape (e.g. "PR #1370"
//      instead of "PR \#1370"). The negative look-behind `(?<!\\)` makes
//      sure we do NOT double-escape `\#` / `\%` that were already correct.
function normalizeLlmLatex(s: string): string {
    let out = String(s || '');
    // Unicode → LaTeX-safe
    out = out.replace(/\u2014/g, '--');              // em-dash
    out = out.replace(/\u2013/g, '--');              // en-dash
    out = out.replace(/\u2212/g, '-');               // minus sign
    out = out.replace(/\u2012/g, '-');               // figure dash
    out = out.replace(/[\u2018\u2019\u201B]/g, "'"); // smart single quote
    out = out.replace(/[\u201C\u201D\u201F]/g, '"'); // smart double quote
    out = out.replace(/\u2022/g, '\\textbullet\\ '); // bullet
    out = out.replace(/\u2026/g, '\\ldots ');        // ellipsis
    out = out.replace(/\u00A0/g, ' ');               // nbsp
    out = out.replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width / BOM
    // Markdown emphasis → LaTeX. The LLM occasionally slips and emits
    // `**40%**` or `*frontend*` instead of `\textbf{}` / `\emph{}`. Those
    // asterisks render literally in the PDF and instantly read as "AI
    // generated". Convert markdown bold/italic to the proper LaTeX
    // commands. Use a function replacer so `$1` etc. aren't interpreted
    // specially. Inner text is non-empty and may not span newlines.
    out = out.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, (_m, inner) => `\\textbf{${inner}}`);
    out = out.replace(/(?<![\\*])\*([^*\n]+?)\*(?!\*)/g, (_m, inner) => `\\emph{${inner}}`);
    // Escape stray `#` and `%` ONLY when not already escaped.
    out = out.replace(/(?<!\\)#/g, '\\#');
    out = out.replace(/(?<!\\)%/g, '\\%');
    return out.trim();
}

// POST /api/resume/generate-pdf — Compile LaTeX to PDF via Tectonic
app.post('/api/resume/generate-pdf', async (req, res) => {
    const { objective, skills, experience, projects, location } = req.body;

    const templatePath = path.join(process.cwd(), 'resume_template.tex');
    let template = fs.readFileSync(templatePath, 'utf-8');

    // Normalise LLM output — fixes unicode glyphs + stray #/% only; does
    // NOT touch real LaTeX commands. Fallback for Objective so older
    // clients (without the Objective field) still render cleanly.
    const fallbackObjective =
        'Software Engineer with 1.5 years of internship experience in Full Stack (React, Node.js, TypeScript) and AI/ML, seeking full-time engineering roles.';
    const safeObjective = normalizeLlmLatex(objective || fallbackObjective);
    const safeSkills = normalizeLlmLatex(skills);
    const safeExp = normalizeLlmLatex(experience);
    const safeProj = normalizeLlmLatex(projects);
    // Location is plain text — pickLocation() already validated it server-
    // side during /optimize, but accept it raw here for direct callers and
    // re-validate so we never inject bare `{`/`\\` into the header.
    const safeLocation = pickLocation(typeof location === 'string' ? location : '');

    // Placeholder replacement. IMPORTANT: we pass a replacer FUNCTION (not a
    // plain string) because JavaScript's String.replace() interprets `$&`,
    // `$'`, `` $` ``, `$$` and `$1` specially inside a string replacement,
    // which can silently corrupt AI-generated LaTeX containing math-mode
    // notation like `$f'(x)$`. A function replacer bypasses that.
    const fullLatex = template
        .replace('{{LOCATION}}', () => safeLocation)
        .replace('{{OBJECTIVE}}', () => safeObjective)
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
        process.env.GROQ_API_KEY ? 'Groq' : null,
        process.env.CEREBRAS_API_KEY ? 'Cerebras' : null,
        process.env.NVIDIA_API_KEY ? 'NVIDIA' : null,
        process.env.GEMINI_API_KEY ? 'Gemini' : null,
        OPENROUTER_API_KEY ? 'OpenRouter' : null,
    ].filter(Boolean);
    console.log(`   AI Status: ${aiKeysPresent.length ? `Enabled — fallback order: ${aiKeysPresent.join(' → ')}` : 'Disabled (no keys)'}`);
});
