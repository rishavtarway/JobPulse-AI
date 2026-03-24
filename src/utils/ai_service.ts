import fetch from 'node-fetch';

export async function callAI(prompt: string, expectJson: boolean = false): Promise<any> {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

    if (!OPENROUTER_API_KEY && !NVIDIA_API_KEY) {
        console.error("   ❌ ERROR: No API keys found in .env");
        return null;
    }

    // High priority: NVIDIA Models (Elite precision)
    // Low priority: OpenRouter Fallbacks (Free tier)
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
                headers: {
                    "Authorization": `Bearer ${key}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": "https://github.com/rishavtarway/ApplyJobs",
                    "X-Title": "JobPulse AI"
                },
                body: JSON.stringify({
                    model: target.id,
                    messages: [{ role: "user", content: prompt }],
                    temperature: 0.1
                }),
                signal: AbortSignal.timeout(60000) // Increased to 60s for NVIDIA stability
            });

            if (response.status === 429) {
                console.log(`   ⚠️ Rate limited on ${target.id}, switching providers...`);
                currentIdx++; continue;
            }
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`API error: ${response.status} - ${errText}`);
            }

            const result = await (response.json() as any);
            const text = result.choices[0].message.content;

            if (!expectJson) return text;

            // Strict JSON cleanup
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
                try { return JSON.parse(cleaner); } catch (je2) { throw new Error("Invalid JSON structure"); }
            }
        } catch (e: any) {
            console.log(`   ⚠️ Model ${models[currentIdx].id} failed (${e.message}), trying next...`);
            currentIdx++;
        }
    }
    return null;
}
