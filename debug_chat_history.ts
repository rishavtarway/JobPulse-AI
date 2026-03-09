import { Config } from './src/config/index.js';
import { TelegramClient } from './src/telegram/client.js';

async function main() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);

    await client.connect();

    const chats = await client.getChats(100);
    const targetChat = chats.find(c => c.title.toLowerCase().includes("TechUprise Premium Insider Club".toLowerCase()));

    if (!targetChat) {
        console.error("Chat not found!");
        process.exit(1);
    }

    // Fetch the absolute newest message first
    let firstBatch = await client.getMessages(targetChat.id, 1, 0);
    let latestMessageId = firstBatch[0]?.id;
    console.log(`Latest ID: ${latestMessageId}`);

    // Now fetch older messages using the latest ID as from_message_id
    let messages = await client.getMessages(targetChat.id, 50, latestMessageId);
    console.log(`Fetched ${messages.length} older messages starting from ${latestMessageId}.`);
    for (let i = 0; i < Math.min(messages.length, 5); i++) {
        const m = messages[i];
        console.log(`ID: ${m.id}, Date: ${new Date(m.date * 1000).toISOString()}, Text: ${m.text?.substring(0, 50).replace(/\n/g, ' ')}`);
    }
    process.exit(0);
}

main().catch(console.error);
