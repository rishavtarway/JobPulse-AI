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
        console.log(`Getting forum topics for ${targetChatId}...`);
        // @ts-ignore
        const result = await client.client.invoke({
            _: 'getForumTopics',
            chat_id: parseInt(targetChatId),
            query: '',
            offset_date: 0,
            offset_chat_id: 0,
            offset_message_id: 0,
            limit: 50
        });
        
        console.log(`Found ${result.total_count} topics.`);
        for (const t of result.topics) {
            console.log(`Topic ID: ${t.info.message_thread_id} | Name: ${t.info.name}`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
