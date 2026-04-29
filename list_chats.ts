import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    try {
        console.log(`Listing all chats...`);
        const chats = await client.getChats(100);
        for (const c of chats) {
            console.log(`ID: ${c.id} | Name: ${c.name} | Type: ${c.type}`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
