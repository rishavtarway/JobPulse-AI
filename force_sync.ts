import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const client = new TelegramClient(Config.telegram);
  await client.connect();
  const chatId = -1003338916645;
  
  console.log("Attempting to explicitly fetch messages after 3300...");
  
  // Method 1: Search Chat Messages (bypasses history cache)
  try {
    const searchRes = await client.client.invoke({
      _: 'searchChatMessages',
      chat_id: chatId,
      query: '',
      sender_id: null,
      from_message_id: 0,
      offset: 0,
      limit: 10,
      filter: { _: 'searchMessagesFilterEmpty' }
    });
    console.log("Search LATEST:", searchRes.messages.map((m: any) => m.id));
  } catch (e: any) {
    console.log("Search method failed:", e.message);
  }

  // Method 2: Explicitly fetch 3301
  const id3301 = 3301 * 1048576;
  try {
    const messages = await client.client.invoke({
      _: 'getMessages',
      chat_id: chatId,
      message_ids: [id3301, id3301 + (1048576 * 1), id3301 + (1048576 * 2)]
    });
    const found = messages.messages.filter((m: any) => m != null && m._ === 'message');
    console.log("Explicit GET found IDs:", found.map((m: any) => m.id));
  } catch (e: any) {
    console.log("Explicit GET failed:", e.message);
  }
  
  await client.disconnect();
}
main().catch(console.error);
