import dotenv from 'dotenv';
dotenv.config();

function safeSlice(text: string, length: number): string {
  if (!text) return "";
  const chars = Array.from(text);
  if (chars.length <= length) return text;
  return chars.slice(0, length).join('');
}

async function run() {
    const nvidiaKey = process.env.NVIDIA_API_KEY;
    // This string contains a fire emoji at the boundary
    let text = "Important Update 🔥"; 
    // Truncating at exactly where the emoji is (index 17 is the start of 🔥)
    let truncated = safeSlice(text, 17);
    console.log("Truncated text:", truncated);
    
    let prompt = `Is this a job? Text: "${truncated}"`;
    const response = await fetch(`https://integrate.api.nvidia.com/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: "meta/llama-3.1-70b-instruct", messages: [{ role: "user", content: prompt }] })
    });
    console.log("Status:", response.status);
    const data = await response.json();
    console.log("Response:", JSON.stringify(data, null, 2));
    
    if (response.status === 200) {
        console.log("✅ Fix Verified: NVIDIA API accepted the truncated string!");
    } else {
        console.log("❌ Fix Failed: NVIDIA API returned an error.");
    }
}
run();
