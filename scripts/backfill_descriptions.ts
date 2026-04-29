import fs from 'fs';
import path from 'path';

const LOG_FILE = 'discovery_history.log';
const APPS_FILE = 'applications.json';

function backfill() {
    if (!fs.existsSync(LOG_FILE)) {
        console.error('Log file not found.');
        return;
    }
    if (!fs.existsSync(APPS_FILE)) {
        console.error('Applications file not found.');
        return;
    }

    const logContent = fs.readFileSync(LOG_FILE, 'utf8');
    const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

    // Regex to extract ID and Content
    // [ID:3115319296] [Chan:TechUprise Premium] [Date:2026-03-25T18:03:14.000Z] ...
    const logEntries = logContent.split(/\[ID:(\d+)\]/);
    const idToText: Record<string, string> = {};

    for (let i = 1; i < logEntries.length; i += 2) {
        const id = logEntries[i];
        const rest = logEntries[i+1];
        if (!rest) continue;

        // Extract content after the meta brackets
        const contentMatch = rest.match(/\[Chan:.*?\]\s*\[Date:.*?\]\s*([\s\S]*?)(?=\[ID:|$)/);
        if (contentMatch) {
            idToText[id] = contentMatch[1].trim();
        }
    }

    console.log(`Parsed ${Object.keys(idToText).length} job descriptions from log.`);

    let updatedCount = 0;
    apps.forEach((app: any) => {
        const tid = app.telegramId;
        if (tid && idToText[tid]) {
            if (!app.jobDescription || app.jobDescription === '') {
                app.jobDescription = idToText[tid];
                updatedCount++;
            }
        }
        
        // Also handle cases where description is currently the draft but we want the original text
        // If type is telegram and status is applied, and description contains "SUBJECT:", it's likely a draft.
        if (app.type === 'telegram' && app.status === 'applied' && app.description?.includes('SUBJECT:')) {
            if (tid && idToText[tid]) {
                app.jobDescription = idToText[tid];
            }
        }
    });

    fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
    console.log(`Updated ${updatedCount} applications with original descriptions.`);
}

backfill();
