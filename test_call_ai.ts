import dotenv from 'dotenv';
dotenv.config();
async function callAI(prompt: string, jsonFlag = false): Promise<any> {
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    const model = { provider: 'nvidia', name: 'meta/llama-3.1-70b-instruct' };
    
    console.log(`🤖 [Querying ${model.provider}: ${model.name}]...`);
    let response;
    try {
        response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: model.name, messages: [{ role: "user", content: prompt }], temperature: 0.1, max_tokens: 1024 })
        });
        
        const data: any = await response.json();
        console.log("RESPONSE:", JSON.stringify(data, null, 2));
    } catch (e) {
        console.log("ERROR:", e.message);
    }
}

callAI(`Is this a job/internship/career opening of ANY KIND (engineering, marketing, HR, operations, etc.)? Ignore generic news, ads for courses, or channel announcements. Reply ONLY YES or NO.\nText: "Hiring Software Engineer at Google"`);
