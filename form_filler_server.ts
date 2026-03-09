import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = 3001;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '50mb' }));

// ─────────────────────────────────────────────────────────────────
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

// ── LLM WRAPPER ──────────────────────────────────────────────────
async function callAI(messages: any[], temperature = 0.1) {
    if (!OPENROUTER_API_KEY) {
        console.warn('⚠️ No OpenRouter API Key. Skipping LLM.');
        return 'UNKNOWN';
    }

    const fallbackModels = ["openrouter/free", "google/gemma-3-27b-it:free", "mistralai/mistral-7b-instruct:free", "meta-llama/llama-3.2-1b-instruct:free"];
    let currentModelIdx = 0;
    const prompt = messages.map(m => m.content).join('\n\n---\n\n');

    while (currentModelIdx < fallbackModels.length) {
        try {
            console.log(`🤖 AI: Using OpenRouter API (${fallbackModels[currentModelIdx]})`);
            const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:3000",
                    "X-OpenRouter-Title": "Auto Apply Bot Form Filler"
                },
                body: JSON.stringify({
                    model: fallbackModels[currentModelIdx],
                    messages: [{ role: "user", content: prompt }]
                })
            });

            if (response.status === 429 || response.status === 402) {
                console.log(`   ⏳ Model ${fallbackModels[currentModelIdx]} rate-limited (${response.status}). Switching model...`);
                currentModelIdx++;
                continue;
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Status ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            return data.choices[0].message.content.trim() || 'UNKNOWN';
        } catch (e: any) {
            console.error('[OpenRouter API Error]:', e.message);
            currentModelIdx++;
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

    const sysPrompt = `You are a high-fidelity Form Filler for Rishav Tarway.
Rishav's Full Resume Data: ${JSON.stringify(resumeData)}

Goal: Given a form field, return ONLY the best answer based on the resume. 
Rules:
1. Return JUST the value. No explanation. No quotes. No prefix.
2. If it is a dropdown, you MUST return EXACTLY ONE of the listed options (copy character-for-character).
3. For date fields, return YYYY-MM-DD format OR the readable date (e.g. March 2026) based on the field type.
4. For textarea/long form questions, write at least 2 sentences with specific details from Rishav's background. If the question is about why you want to join the company, write about how the company's work aligns with Rishav's background in AI/ML and identity systems. 
5. If you genuinely cannot answer from the resume (e.g. personal status questions like 'Are you a fellow?', 'How did you hear about us?'), return exactly: UNKNOWN_DATA
6. NEVER make up facts. For YES/NO questions, only answer if the resume provides context, else return UNKNOWN_DATA.`;

    const userPrompt = `
Field Label: "${fieldLabel}"
Field Type: "${fieldType}"
Context (Placeholder/Nearby text): "${fieldContext}"
Options (if Select/Radio): ${JSON.stringify(options)}
Page URL: ${pageUrl}`;

    try {
        const answer = await callAI([
            { role: 'system', content: sysPrompt },
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

// GET /api/form-filler/resume — serve local resume PDF for upload injection
app.get('/api/form-filler/resume', (req, res) => {
    const data = loadResumeData();
    // Try configured path first, then common locations
    const candidates = [
        data.resume_local_path,
        path.join(process.cwd(), 'RishavTarway-Resume .pdf'),
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

// POST /api/form-filler/analyze-page — AI decides what button to click or action to take
app.post('/api/form-filler/analyze-page', async (req, res) => {
    const { pageText, buttons, tabUrl, inputsFound, topInputs } = req.body;
    if (!pageText) return res.status(400).json({ action: 'UNKNOWN' });

    console.log(`\n🔍 [Page Analysis] ${tabUrl}`);
    console.log(`   Real Inputs: ${inputsFound}, Buttons: ${buttons?.length || 0}`);

    if (!OPENROUTER_API_KEY) return res.json({ action: 'UNKNOWN' });

    const prompt = `You are navigating a job portal for Rishav Tarway.
Current URL: ${tabUrl}
Inputs visible: ${topInputs || 'None'}
Buttons available: ${JSON.stringify(buttons)}

DECISION RULES:
1. If this is a Job Description page and there is an "Apply", "Apply Now", "Register" button, return that exact button text.
2. If this is a Login or Account Creation page, return the EXACT text of the social login button (e.g. "Sign in with Google", "Sign in with LinkedIn"). If only email/password, return: SIGN_UP.
3. If this is already the Application Form (asking for Name, Email, Resume, etc.), return exactly: IS_FORM.
4. If there is a "Continue", "Next", or "Apply with LinkedIn" button on a non-form page, return that text.
5. Otherwise: UNKNOWN.

Output ONLY the decision.`;

    try {
        const action = await callAI([
            { role: 'user', content: prompt }
        ]);
        console.log(`   🎯 AI Decision: ${action}`);
        res.json({ action });
    } catch (e) {
        console.error('[Analysis Error]:', (e as Error).message);
        res.json({ action: 'UNKNOWN' });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Form-Filler Server running at http://localhost:${PORT}`);
    console.log(`   AI Status: ${OPENROUTER_API_KEY ? 'Enabled' : 'Disabled (Key missing)'}`);
});
