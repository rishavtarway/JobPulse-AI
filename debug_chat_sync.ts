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

    console.log(`Chat Found: ${targetChat.title} (${targetChat.id})`);

    // Force open the chat to sync
    try {
        // access internal tdl client
        // @ts-ignore
        await client.client.invoke({ _: 'openChat', chat_id: parseInt(targetChat.id) });
        console.log('Opened chat.');
    } catch (e: any) {
        console.error('openChat error', e.message);
    }

    // Also load chats just in case
    try {
        // @ts-ignore
        await client.client.invoke({ _: 'loadChats', chat_list: { _: 'chatListMain' }, limit: 100 });
    } catch (e) { }

    await new Promise(r => setTimeout(r, 2000));

    let messages = await client.getMessages(targetChat.id, 10);
    console.log(`Fetched ${messages.length} messages.`);
    for (const m of messages) {
        console.log(`ID: ${m.id}, Date: ${new Date(m.date * 1000).toISOString()}, Text: ${m.text?.substring(0, 50).replace(/\n/g, ' ')}`);
    }
    process.exit(0);
}

main().catch(console.error);
