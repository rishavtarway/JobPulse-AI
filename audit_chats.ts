import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';

dotenv.config();

async function run() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    await client.connect();

    try {
        console.log("Listing all chats for this account...");
        // @ts-ignore
        const chats = await client.client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, limit: 100 });
        
        console.log("------------------------------------------------------------------");
        console.log("ID".padEnd(20) + " | " + "Last Msg Date".padEnd(25) + " | " + "Title");
        console.log("------------------------------------------------------------------");
        
        for (const chatId of chats.chat_ids) {
            // @ts-ignore
            const chat = await client.client.invoke({ _: 'getChat', chat_id: chatId });
            const lastDate = chat.last_message ? new Date(chat.last_message.date * 1000).toISOString() : "N/A";
            console.log(`${chat.id.toString().padEnd(20)} | ${lastDate.padEnd(25)} | ${chat.title}`);
        }
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
    } finally {
        await client.disconnect();
    }
}

run().catch(console.error);
