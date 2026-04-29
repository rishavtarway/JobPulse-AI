import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    try {
        console.log(`Listing 30 most recent chats with names...`);
        // @ts-ignore
        const chats = await client.client.invoke({
            _: 'getChats',
            offset_order: '9223372036854775807',
            offset_chat_id: 0,
            limit: 30
        });
        
        for (const chatId of chats.chat_ids) {
            // @ts-ignore
            const chat = await client.client.invoke({
                _: 'getChat',
                chat_id: chatId
            });
            console.log(`ID: ${chat.id} | Name: ${chat.title} | Type: ${chat._}`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
