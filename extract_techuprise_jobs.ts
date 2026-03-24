import * as fs from 'fs';
import * as path from 'path';

const LOG_FILE = path.join(process.cwd(), 'all_extracted_jobs_log.txt');
const OUTPUT_FILE = path.join(process.cwd(), 'techuprise_premium_jobs_last_week.json');
const TARGET_CHANNEL = 'TechUprise Premium';
const START_DATE = new Date('2026-03-11T00:00:00.000Z');
const END_DATE = new Date('2026-03-18T23:59:59.000Z');

function extractJobs() {
    if (!fs.existsSync(LOG_FILE)) {
        console.error(`Log file not found: ${LOG_FILE}`);
        return;
    }

    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const jobEntries = content.split('\n\n');
    const filteredJobs: any[] = [];

    jobEntries.forEach(entry => {
        if (!entry.trim()) return;

        // Simplified Regex to extract ID, Channel, Date and Content
        const idMatch = entry.match(/\[ID:(\d+)\]/);
        const chanMatch = entry.match(/\[Chan:([^\]]+)\]/);
        const dateMatch = entry.match(/\[Date:([^\]]+)\]/);
        
        if (idMatch && chanMatch && dateMatch) {
            const id = idMatch[1];
            const channel = chanMatch[1].trim();
            const dateStr = dateMatch[1];
            const date = new Date(dateStr);
            
            // Extract the rest of the text after the headers
            const headerEndIndex = entry.indexOf(']') + 1; // End of ID
            const secondHeaderEndIndex = entry.indexOf(']', headerEndIndex) + 1; // End of Chan
            const thirdHeaderEndIndex = entry.indexOf(']', secondHeaderEndIndex) + 1; // End of Date
            const description = entry.substring(thirdHeaderEndIndex).trim();

            if (channel === TARGET_CHANNEL && date >= START_DATE && date <= END_DATE) {
                filteredJobs.push({
                    id,
                    channel,
                    date: dateStr,
                    description
                });
            }
        }
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(filteredJobs, null, 2));
    console.log(`Successfully extracted ${filteredJobs.length} jobs to ${OUTPUT_FILE}`);
}

extractJobs();
