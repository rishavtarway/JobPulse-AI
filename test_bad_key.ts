import dotenv from 'dotenv';
async function test() {
    const response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer undefined`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: "test" }] })
    });
    console.log(await response.json());
}
test();
