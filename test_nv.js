require('dotenv').config();
const nvidiaKey = process.env.NVIDIA_API_KEY;

async function testNv() {
    const response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: "Is this a job posting: 'We are hiring a software engineer'?" }], temperature: 0.1, max_tokens: 1024 })
    });
    console.log(await response.json());
}
testNv();
