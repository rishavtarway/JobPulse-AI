import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const targetChatId = "-1003684316624"; // Auto uploading

    try {
        console.log(`Getting exact latest message via getChat for ${targetChatId}...`);
        // @ts-ignore
        const chat = await client.client.invoke({
            _: 'getChat',
            chat_id: parseInt(targetChatId)
        });
        console.log(`Chat Title: ${chat.title}`);
        console.log(`Last Message Object:`, JSON.stringify(chat.last_message, null, 2));
        
        if (chat.last_message) {
             const date = new Date(chat.last_message.date * 1000).toISOString();
             console.log(`Latest ID: ${chat.last_message.id} | Date: ${date}`);
        }

        console.log(`\nFetching history with limit 5...`);
        const messages = await client.getMessages(targetChatId, 5, 0);
        for (const m of messages) {
             const date = new Date(m.date * 1000).toISOString();
             console.log(`History ID: ${m.id} | Date: ${date}`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
