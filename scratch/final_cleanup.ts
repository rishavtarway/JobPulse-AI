import fs from 'fs';
import path from 'path';

const APPS_FILE = path.join(process.cwd(), 'applications.json');
let apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

// 1. Remove the duplicate 55 with trailing dot
apps = apps.filter((a: any) => !(a.telegramId === 'batch56-55' && a.email.endsWith('.')));

// 2. Add missing #33 (Amboras)
const job33 = {
    id: Date.now().toString() + "33",
    company: "Amboras",
    role: "Frontend Engineer",
    email: "vaibhav@amboras.com",
    channel: "Batch Processor 56",
    telegramId: "batch56-33",
    status: "applied",
    type: "web",
    appliedDate: new Date().toISOString(),
    description: "Handled manually from sub-points"
};

if (!apps.some((a: any) => a.telegramId === 'batch56-33')) {
    apps.unshift(job33);
}

fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
console.log("Cleanup and addition of #33 complete.");
