import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new TelegramClient(Config.getInstance().telegram);
    await client.connect();
    console.log("Scanning 200 chats for TechUprise...");
    const chats = await client.getChats(200);
    const techChats = chats.filter(c => c.title?.toLowerCase().includes('techuprise'));
    if (techChats.length === 0) {
        console.log("No TechUprise chats found.");
    }
    for (const c of techChats) {
        console.log(`\n📡 CHAT: ${c.title} (${c.id})`);
        const msgs = await client.getMessages(c.id, 50);
        msgs.forEach(m => {
            const text = m.text || m.mediaCaption || "";
            if (text) {
                console.log(`   ID: ${m.id} | Date: ${new Date(m.date * 1000).toISOString()} | Text: ${text.substring(0, 50).replace(/\n/g, ' ')}`);
            }
        });
    }
    await client.disconnect();
}

run().catch(console.error);
