import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    const targetChatId = "-1003338916645"; // TechUprise Premium
    const targetMsgId = 3191865344; // Human ID 2977
    
    try {
        console.log(`Fetching message ${targetMsgId} from ${targetChatId}...`);
        // @ts-ignore
        const message = await client.client.invoke({ 
            _: 'getMessage', 
            chat_id: parseInt(targetChatId), 
            message_id: targetMsgId
        });
        
        console.log("-----------------------------------------");
        console.log(`Date: ${new Date(message.date * 1000).toISOString()}`);
        console.log(`Text: ${message.content?.text?.text || message.content?.caption?.text || "NO_TEXT"}`);
        console.log("-----------------------------------------");
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
