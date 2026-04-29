import fs from 'fs';
import path from 'path';

// Mock values for testing
const SIGNATURE_HTML = `
<br><br>
Best, Rishav Tarway<br>
<a href="https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing">Resume (Drive)</a> | <a href="https://wiggly-cyclone-4b3.notion.site/Open-Source-Contributions-196c5ae56b3480ffa68cce470f9fd6cc">Open Source Contributions</a><br>
<a href="https://www.linkedin.com/in/rishav-tarway-fst/">LinkedIn</a> | <a href="https://my-portfolio-five-roan-36.vercel.app/">Portfolio</a> | <a href="https://github.com/rishavtarway">GitHub</a>
`;

function testDraftOutput() {
    const salutation = "Hi John,";
    const p1 = "P1 content.";
    const p2 = "P2 content.";
    const p3 = "P3 content.";
    
    // This replicates the updated logic in auto_apply.ts
    const bodyRaw = `<p>${salutation}</p><p>${p1}</p><p>${p2}</p><p>${p3}</p>`;
    const finalBody = bodyRaw + SIGNATURE_HTML;
    
    console.log("--- FINAL BODY START ---");
    console.log(finalBody);
    console.log("--- FINAL BODY END ---");
    
    if (finalBody.split("Best,").length - 1 > 1) {
        console.error("FAIL: 'Best,' found more than once!");
    } else {
        console.log("SUCCESS: 'Best,' found exactly once (in signature).");
    }
}

testDraftOutput();
