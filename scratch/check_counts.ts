import fs from 'fs';
import path from 'path';

const APPS_FILE = path.join(process.cwd(), 'applications.json');
const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

const batch56 = apps.filter((app: any) => app.telegramId && app.telegramId.startsWith('batch56-'));

const emails = batch56.filter((app: any) => app.email && app.email.length > 0);
const links = batch56.filter((app: any) => app.link && app.link.length > 0);
const phoneOnly = batch56.filter((app: any) => !app.email && !app.link && app.notes?.includes("Phone"));

console.log(`Total Batch 56: ${batch56.length}`);
console.log(`Emails: ${emails.length}`);
console.log(`Links: ${links.length}`);
console.log(`Phone Only: ${phoneOnly.length}`);

console.log("\nDetails of all 56 IDs:");
const ids = batch56.map((app: any) => app.telegramId.replace('batch56-', '')).sort((a,b) => parseInt(a)-parseInt(b));
console.log(ids.join(', '));
