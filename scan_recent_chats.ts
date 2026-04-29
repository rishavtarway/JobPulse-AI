import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const MIN_POSTED_DATE = new Date("2026-03-30T06:30:00.000Z").getTime();

    try {
        console.log(`Scanning top 30 most active chats for messages since Monday noon...`);
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
            
            const messages = await client.getMessages(chat.id.toString(), 10, 0);
            const recentMessages = messages.filter(m => (m.date * 1000) > MIN_POSTED_DATE);
            
            if (recentMessages.length > 0) {
                console.log(`\nChat: ${chat.title} (${chat.id}) - Found ${recentMessages.length} recent messages.`);
                for (const m of recentMessages) {
                    const text = m.text?.substring(0, 80).replace(/\n/g, ' ');
                    console.log(`  - [${new Date(m.date * 1000).toISOString()}] ${text}...`);
                }
            }
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
