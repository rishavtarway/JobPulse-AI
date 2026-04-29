const result = "UNKNOWN";
let exp = "";
let proj = "";

if (result.includes('[SECTION_SEPARATOR]')) {
    const parts = result.split('[SECTION_SEPARATOR]');
    exp = parts[0] || "";
    proj = parts[1] || "";
} 
else if (result.includes('PROJECTS')) {
    const splitRegex = /(?:#+\s*PROJECTS|\*\*PROJECTS\*\*|PROJECTS\s*SECTION)/i;
    const parts = result.split(splitRegex);
    exp = parts[0] || "";
    proj = parts[1] || "";
}
else {
    exp = result;
}

try {
    exp = exp.replace(/```latex/ig, '').replace(/```/g, '').trim();
    proj = proj.replace(/```latex/ig, '').replace(/```/g, '').trim();
    console.log("Success", {exp, proj});
} catch(e) {
    console.log("Crash:", e.message);
}
