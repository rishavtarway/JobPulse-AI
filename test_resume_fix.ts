const FORM_SERVER = 'http://127.0.0.1:3001';

async function testResume() {
    try {
        console.log("🔍 Testing JD Analysis...");
        const jdText = "We are looking for a Node.js and React developer with experience in AWS.";
        const analyzeResp = await fetch(`${FORM_SERVER}/api/resume/analyze-jd`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jdText })
        });
        const analyzeData: any = await analyzeResp.json();
        console.log("Keywords:", analyzeData.keywords);

        console.log("\n🚀 Testing Optimization...");
        const optResp = await fetch(`${FORM_SERVER}/api/resume/optimize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jdText, selectedKeywords: analyzeData.keywords })
        });
        const optData: any = await optResp.json();
        console.log("Experience Sample (first 200 chars):", (optData.experience || "").substring(0, 200));

        if (optData.experience) {
            console.log("\n📄 Testing PDF Generation...");
            const pdfResp = await fetch(`${FORM_SERVER}/api/resume/generate-pdf`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ experience: optData.experience, projects: optData.projects })
            });
            const pdfData: any = await pdfResp.json();
            console.log("PDF Result:", pdfData);
        }
    } catch (e: any) {
        console.error("Test Error:", e.message);
    }
}

testResume();
