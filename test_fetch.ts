import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const client = new TelegramClient(Config.telegram);
  await client.connect();
  const batch = await client.getMessages("-1003338916645", 5, 0);
  for (const m of batch) {
    console.log(`\nID: ${m.id} | Date: ${new Date(m.date * 1000).toISOString()}`);
    console.log(`Text: ${(m.text || m.mediaCaption || "").substring(0, 100).replace(/\n/g, ' ')}...`);
  }
  await client.disconnect();
}
main().catch(console.error);
