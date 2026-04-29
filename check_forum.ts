import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const targetChatId = "-1003338916645";

    try {
        console.log(`Getting detailed info for ${targetChatId}...`);
        // @ts-ignore
        const chat = await client.client.invoke({
            _: 'getChat',
            chat_id: parseInt(targetChatId)
        });
        console.log(`Chat: ${chat.title}`);
        console.log(`Is Forum: ${chat.is_forum}`);
        
        if (chat.is_forum) {
            console.log(`Getting topics...`);
            // @ts-ignore
            const topics = await client.client.invoke({
                _: 'getForumTopics',
                chat_id: parseInt(targetChatId),
                query: '',
                offset_date: 0,
                offset_chat_id: 0,
                offset_message_id: 0,
                limit: 20
            });
            for (const t of topics.topics) {
                console.log(`Topic ID: ${t.info.message_thread_id} | Name: ${t.info.name}`);
            }
        } else {
             const messages = await client.getMessages(targetChatId, 10, 0);
             for (const m of messages) {
                 const date = new Date(m.date * 1000).toISOString();
                 console.log(`ID: ${m.id} | Date: ${date} | Text: ${m.text?.substring(0, 50)}...`);
             }
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
