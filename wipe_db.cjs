const fs = require('fs');
let apps = JSON.parse(fs.readFileSync('applications.json', 'utf8'));
const originalLen = apps.length;
apps = apps.filter(app => !['3460300800', '3458203648'].includes(app.telegramId));
fs.writeFileSync('applications.json', JSON.stringify(apps, null, 2));
console.log('Removed', originalLen - apps.length, 'entries from database!');
