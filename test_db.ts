import fs from 'fs';
const apps = JSON.parse(fs.readFileSync('applications.json', 'utf8'));
const tortoise = apps.find((a: any) => a.telegramId === "3458203648");
const nodejs = apps.find((a: any) => a.telegramId === "3460300800");

console.log("Tortoise (3298) Entry:", tortoise ? "Yes, status: " + tortoise.status : "NO");
console.log("Nodejs (3300) Entry:", nodejs ? "Yes, status: " + nodejs.status : "NO");
