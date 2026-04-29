import { TelegramClient } from '../src/telegram/client.js';
import { Config } from '../src/config/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function checkMessage() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    try {
        await client.connect();
        
        const channelId = "-1003338916645";
        console.log("Fetching messages for", channelId);
        const messages = await client.getMessages(channelId, 50, 0);
        
        console.log("Last 50 messages:");
        for (const m of messages) {
            const seqId = Number(m.id) >> 20;
            console.log(`ID: ${m.id}, Seq: ${seqId}, Date: ${new Date(m.date * 1000).toISOString()}`);
        }
    } catch (e: any) {
        console.error("Error:", e.message);
    } finally {
        // @ts-ignore
        if (client.client) await client.client.close();
    }
}

checkMessage();
