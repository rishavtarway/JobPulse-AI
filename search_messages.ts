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
        console.log(`Searching for all messages in the last 24 hours in ${targetChatId}...`);
        const now = Math.floor(Date.now() / 1000);
        const yesterday = now - 24 * 3600;
        
        // Use searchChatMessages to find EVERYTHING
        // @ts-ignore
        const result = await client.client.invoke({ 
            _: 'searchChatMessages', 
            chat_id: parseInt(targetChatId), 
            query: '', 
            sender_id: null,
            from_message_id: 0,
            offset: 0,
            limit: 100,
            filter: null,
            message_thread_id: 0
        });
        
        console.log(`Found ${result.messages.length} messages in search.`);
        for (const m of result.messages) {
            const date = new Date(m.date * 1000).toISOString();
            console.log(`ID: ${m.id} | Date: ${date} | Text: ${m.content?.text?.text?.substring(0, 50) || m.content?.caption?.text?.substring(0, 50) || "NO_TEXT"}`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
