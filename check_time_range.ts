import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const targetChatId = "-1001409153549"; // Jobs | Internships
    
    try {
        console.log(`Getting history for ${targetChatId} to find 12:00 PM posts...`);
        // Scan back 100 messages
        const messages = await client.getMessages(targetChatId, 5, 0);
        for (const m of messages) {
            const date = new Date(m.date * 1000).toISOString();
            console.log(`ID: ${m.id} | Date: ${date} | Text: ${m.text?.substring(0, 50)}...`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
