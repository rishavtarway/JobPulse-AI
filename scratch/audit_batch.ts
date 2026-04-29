import fs from 'fs';
import path from 'path';

const APPS_FILE = path.join(process.cwd(), 'applications.json');
const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

const batch56 = apps.filter((app: any) => app.telegramId && app.telegramId.startsWith('batch56-'));

// Sort by ID
batch56.sort((a: any, b: any) => {
    const idA = parseInt(a.telegramId.replace('batch56-', ''));
    const idB = parseInt(b.telegramId.replace('batch56-', ''));
    return idA - idB;
});

console.log("ID | Company | Email | Status");
console.log("---|---|---|---");
batch56.forEach((app: any) => {
    const id = app.telegramId.replace('batch56-', '');
    console.log(`${id} | ${app.company} | ${app.email || 'N/A'} | ${app.status}`);
});
