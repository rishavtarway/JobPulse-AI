import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const client = new TelegramClient(Config.telegram);
  await client.connect();
  const batch = await client.getMessages("-1003338916645", 2, 0); // 0 gets latest
  if (batch.length > 0) {
    console.log("Absolute LATEST message ID is:", batch[0].id);
    if (batch[0].id > 3460300800) {
      console.log("YES, there are newer messages!");
    } else {
      console.log("NO, 3460300800 is precisely the latest message in the entire channel.");
    }
  }
  await client.disconnect();
}
main().catch(console.error);
