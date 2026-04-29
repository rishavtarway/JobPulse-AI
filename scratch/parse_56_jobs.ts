import fs from 'fs';

const rawText = fs.readFileSync('scratch/raw_jobs.txt', 'utf8');

function parseJobs() {
    // Robust split: Look for "Number. " at the start of a line
    const blocks = rawText.split(/\n(?=\d+[\s\.]+\S+)/).map(b => b.trim()).filter(b => b.length > 0);

    console.log(`Initial Split found ${blocks.length} blocks.`);

    const extractedJobs = [];
    for (const block of blocks) {
        const idMatch = block.match(/^(\d+)/);
        const id = idMatch ? idMatch[1] : null;

        // Extract Email
        const emailMatches = block.matchAll(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/g);
        let email = null;
        for (const m of emailMatches) {
            if (!m[1].includes("example.com") && !m[1].includes("yourname")) {
                email = m[1];
                break; 
            }
        }

        // Extract Link
        const linkMatches = block.matchAll(/(https?:\/\/[^\s]+)/g);
        let link = null;
        for (const m of linkMatches) {
            const l = m[1].replace(/[.,:!]$/, "");
            if (!l.includes("linkedin.com/in/") && !l.includes("portfolio")) {
                link = l;
                break; 
            }
        }

        // Role extraction
        let role = "Software Engineer";
        if (block.toLowerCase().includes("ai engineer")) role = "AI Engineer";
        else if (block.toLowerCase().includes("support engineer")) role = "Support Engineer";
        else if (block.toLowerCase().includes("frontend engineer")) role = "Frontend Engineer";
        else if (block.toLowerCase().includes("backend developer")) role = "Backend Developer";
        else if (block.toLowerCase().includes("mobile app developer")) role = "Mobile App Developer";
        else if (block.toLowerCase().includes("data analyst")) role = "Data Analyst";
        else if (block.toLowerCase().includes("research engineer")) role = "Research Engineer";
        else if (block.toLowerCase().includes("qa")) role = "QA Engineer";
        else if (block.toLowerCase().includes("devops")) role = "DevOps Engineer";
        else if (block.toLowerCase().includes("business intern")) role = "Business Intern";
        else if (block.toLowerCase().includes("graphic designer")) role = "Graphic Designer";
        else if (block.toLowerCase().includes("product designer")) role = "Product Designer";
        else if (block.toLowerCase().includes("product manager")) role = "Product Manager";
        else if (block.toLowerCase().includes("data scientist")) role = "Data Scientist";
        
        if (block.toLowerCase().includes("intern") || block.toLowerCase().includes("trainee")) {
            if (!role.includes("Intern") && !role.includes("Trainee")) role += " Intern/Trainee";
        }

        // Extract Company
        let company = "Unknown";
        const companyPatterns = [
            /Company\s*-\s*([^\n]+)/i,
            /at\s+([^\n|,\n]+)/i,
            /hiring\s+at\s+([^\n|,\n]+)/i,
            /join\s+our\s+team\s+at\s+([^\n|,\n]+)/i
        ];
        
        for (const p of companyPatterns) {
            const m = block.match(p);
            if (m) {
                company = m[1].trim().split(' ')[0]; // Take first word as fallback
                break;
            }
        }
        
        // Manual company overrides based on IDs to ensure precision
        if (id === "1") company = "Quantal AI";
        if (id === "2") company = "Codilar";
        if (id === "3") company = "Amboras";
        if (id === "4") company = "Masterstroke Technosoft";
        if (id === "5") company = "Zeta-V";
        if (id === "6") company = "Prodevans";
        if (id === "7") company = "AU SFB";
        if (id === "8") company = "American Chase";
        if (id === "9") company = "Esme Consumer";
        if (id === "10") company = "Aspora";
        if (id === "11") company = "Blackwins Tech";
        if (id === "12") company = "Codersbrain";
        if (id === "13") company = "Techsopi";
        if (id === "14") company = "magicpin";
        if (id === "15") company = "TRUEiGTECH";
        if (id === "16") company = "Voleergo Solutions";
        if (id === "17") company = "PW Solutions";
        if (id === "18") company = "Astranova Mobility";
        if (id === "19") company = "Esme Consumer";
        if (id === "20") company = "ImagineArt";
        if (id === "21") company = "Swish";
        if (id === "22") company = "PW Solutions";
        if (id === "23") company = "IIT Indore";
        if (id === "24") company = "Logikality";
        if (id === "25") company = "Recklabs";
        if (id === "26") company = "Hiremyidea";
        if (id === "27") company = "Nected";
        if (id === "28") company = "Tesco";
        if (id === "29") company = "Svaantech";
        if (id === "30") company = "Pune Hiring";
        if (id === "31") company = "Mowito";
        if (id === "32") company = "PhotoGPT";
        if (id === "33") company = "Amboras";
        if (id === "34") company = "Technology Mindz";
        if (id === "35") company = "Sasken Technologies";
        if (id === "36") company = "HarshTech Automation";
        if (id === "37") company = "Forage AI";
        if (id === "38") company = "Celebal Technologies";
        if (id === "39") company = "Privado AI";
        if (id === "40") company = "Gurugram Hiring";
        if (id === "41") company = "Anakin";
        if (id === "42") company = "Antoc AI";
        if (id === "43") company = "Rhythmflows";
        if (id === "44") company = "Cloudjune";
        if (id === "45") company = "3N Performance";
        if (id === "46") company = "Oolka";
        if (id === "47") company = "noDevBuild";
        if (id === "48") company = "Dcodetech";
        if (id === "49") company = "Sun Technologies";
        if (id === "50") company = "Tata CLiQ";
        if (id === "51") company = "Staqu Technologies";
        if (id === "52") company = "Nature Global";
        if (id === "53") company = "LatentForce";
        if (id === "54") company = "Magicpin";
        if (id === "55") company = "Pranathi Software";
        if (id === "56") company = "Craon";

        // Subject
        const subjectMatch = block.match(/\(Subject:\s*([^\)]+)\)/i) || block.match(/Subject\s*Line:\s*([^\n]+)/i) || block.match(/Subject\s*:\s*([^\n]+)/i);
        const specificSubject = subjectMatch ? subjectMatch[1].trim().replace(/^["']|["']$/g, '') : null;

        extractedJobs.push({
            id,
            company,
            role,
            email,
            link,
            specificSubject,
            description: block.trim()
        });
    }

    fs.writeFileSync('jobs_batch_56.json', JSON.stringify(extractedJobs, null, 2));
    console.log(`Successfully parsed ${extractedJobs.length} jobs.`);
}

parseJobs();
