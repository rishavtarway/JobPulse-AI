import fs from 'fs';
import path from 'path';

const APPS_FILE = path.join(process.cwd(), 'applications.json');
const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

const batch56 = apps.filter((app: any) => app.telegramId && app.telegramId.startsWith('batch56-'));

const applied = batch56.filter((app: any) => app.status === 'applied');
const toApply = batch56.filter((app: any) => app.status === 'to_apply');

console.log(`Applied: ${applied.length}`);
console.log(`To Apply: ${toApply.length}`);

console.log("\nApplied Companies:");
console.log(applied.map((a: any) => `${a.telegramId}: ${a.company}`).join(', '));

console.log("\nTo Apply Companies:");
console.log(toApply.map((a: any) => `${a.telegramId}: ${a.company}`).join(', '));
