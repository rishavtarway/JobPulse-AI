import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    // An emoji is 2 characters long: '🔥' is "\uD83D\uDD25"
    let text = "Hell" + "\uD83D"; // Dangling surrogate
    
    let prompt = `Is this a job? Text: "${text}"`;
    const response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: prompt }] })
    });
    console.log("Status:", response.status);
    console.log("Response:", await response.json());
}
run();
