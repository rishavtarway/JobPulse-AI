import { TelegramClient } from './src/telegram/client.js';
import { Config } from './src/config/index.js';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const config = Config.getInstance();
  const client = new TelegramClient(config.telegram);
  await client.connect();
  const msgs = await client.getMessages("-1003338916645", 1, 3466592256);
  console.log(JSON.stringify(msgs[0], null, 2));
  process.exit(0);
}
run();
