require('dotenv').config();
const { fetch } = require('undici');

async function callAI() {
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    const prompt = `Act as an expert ATS (Applicant Tracking System) optimizer. 
Analyze the following Job Description and extract the top 15 most important technical keywords, soft skills, and specific requirements. 
Return ONLY a raw JSON array of strings. NO MARKDOWN. NO EXPLANATION. Just the array.
Example: ["Node.js", "React"]

JD Text: 
Required: Node.js, React.`;

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "google/gemma-2-9b-it:free",
            messages: [{ role: "user", content: prompt }]
        })
    });
    
    console.log("Status:", response.status);
    const text = await response.text();
    console.log("Body:", text);
}
callAI();
