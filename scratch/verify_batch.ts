import fs from 'fs';
import path from 'path';

const APPS_FILE = path.join(process.cwd(), 'applications.json');
const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

const processedIds = new Set();
for (const app of apps) {
    if (app.telegramId && app.telegramId.startsWith('batch56-')) {
        processedIds.add(app.telegramId.replace('batch56-', ''));
    }
}

const missing = [];
for (let i = 1; i <= 56; i++) {
    if (!processedIds.has(i.toString())) {
        missing.push(i);
    }
}

console.log("Missing IDs:", missing);
