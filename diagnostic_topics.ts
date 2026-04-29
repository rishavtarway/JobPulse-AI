import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const targetChatId = "-1003338916645"; // TechUprise Premium
    
    try {
        console.log(`Checking chat info for ${targetChatId}...`);
        // @ts-ignore
        const chat = await client.client.invoke({ _: 'getChat', chat_id: parseInt(targetChatId) });
        console.log(`Chat Title: ${chat.title}`);
        console.log(`Last Message ID: ${chat.last_message?.id}`);
        
        // Check for topics
        if (chat.type._ === 'chatTypeSupergroup' && chat.type.is_forum) {
            console.log("THIS CHAT IS A FORUM (HAS TOPICS!)");
            // @ts-ignore
            const topics = await client.client.invoke({ _: 'getForumTopics', chat_id: parseInt(targetChatId), query: '', offset_date: 0, offset_message_id: 0, offset_forum_topic_id: 0, limit: 100 });
            console.log(`Found ${topics.total_count} topics.`);
            for (const topic of topics.topics) {
                console.log(`Topic: ${topic.info.name} (Thread ID: ${topic.info.message_thread_id})`);
            }
        } else {
            console.log("This chat is a regular channel/group.");
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
