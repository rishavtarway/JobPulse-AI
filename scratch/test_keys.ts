import dotenv from 'dotenv';
dotenv.config();

async function testOpenRouter() {
    const key = process.env.OPENROUTER_API_KEY;
    console.log(`Checking OpenRouter Key: ${key?.substring(0, 10)}...`);
    
    // Try Llama 3.1 8b as it's usually free and robust
    const models = [
        'google/gemini-2.0-flash-lite-001',
        'meta-llama/llama-3.1-8b-instruct:free'
    ];

    for (const model of models) {
        try {
            console.log(`Testing ${model}...`);
            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${key}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: 'Say hello' }]
                })
            });
            const data: any = await res.json();
            if (data.error) {
                console.log(`❌ ${model} failed: ${JSON.stringify(data.error)}`);
            } else {
                console.log(`✅ ${model} success: ${data.choices[0].message.content}`);
            }
        } catch (e: any) {
            console.log(`❌ ${model} error: ${e.message}`);
        }
    }
}

testOpenRouter();
