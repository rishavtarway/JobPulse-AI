import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const targetChatId = "-1001409153549"; // TechUprise Premium
    
    try {
        console.log(`Fetching 20 newest messages from ${targetChatId}...`);
        const messages = await client.getMessages(targetChatId, 20, 0);
        for (const m of messages) {
            console.log(`ID: ${m.id} | Date: ${new Date(m.date * 1000).toISOString()} | Text: ${m.text?.substring(0, 50)}...`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
