import * as fs from 'fs';
import * as path from 'path';

// 1. Defined before main to avoid ReferenceError
const loadEnv = () => {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      const envFile = fs.readFileSync(envPath, 'utf-8');
      envFile.split('\n').forEach(line => {
        const match = line.match(/^([^#=]+)=(.*)$/);
        if (match) {
          const key = match[1].trim();
          const value = match[2].trim().replace(/^["']|["']$/g, '');
          process.env[key] = value;
        }
      });
      console.log("✅ Environment loaded manually.");
    }
  } catch (error) {
    console.error("⚠️ Error reading .env:", error);
  }
};

async function main() {
  loadEnv();

  // Dynamic Imports based on your project structure
  const { TelegramClient } = await import('./src/telegram/client.js');
  const { Config } = await import('./src/config/index.js');

  // CONFIGURATION
  const SEARCH_QUERY = "TechUprise Premium Insider Club";
  const TARGET_EMAIL = "contact@blackshieldhq.com";

  // 1. Read existing file to find the last ID
  let existingContent = "";
  if (fs.existsSync('techuprise_recovery.txt')) {
    existingContent = fs.readFileSync('techuprise_recovery.txt', 'utf8');
  }

  // Find the message ID containing the target email
  const regex = new RegExp(`\\[ID:(\\d+)\\].*?${TARGET_EMAIL.replace('.', '\\.')}`, 'g');
  let match;
  let lastMatch;
  while ((match = regex.exec(existingContent)) !== null) {
      lastMatch = match;
  }

  if (!lastMatch) {
    console.error(`❌ Could not find message containing ${TARGET_EMAIL} in techuprise_recovery.txt`);
    process.exit(1);
  }

  const checkpointId = parseInt(lastMatch[1], 10);
  console.log(`✅ Found checkpoint message ID: ${checkpointId} (containing ${TARGET_EMAIL})`);

  // 3. Connect to Telegram to fetch new messages
  console.log("🚀 Connecting to Telegram...");
  const config = Config.getInstance();
  const client = new TelegramClient(config.telegram);
  await client.connect();

  console.log(`🔍 Searching for chat: "${SEARCH_QUERY}"...`);
  const chats = await client.getChats(100);
  const targetChat = chats.find(c =>
    c.title.toLowerCase().includes(SEARCH_QUERY.toLowerCase())
  );

  if (!targetChat) {
    console.error(`❌ No chat found matching: "${SEARCH_QUERY}"`);
    process.exit(1);
  }

  console.log(`✅ Found chat: ${targetChat.title} (ID: ${targetChat.id})`);
  console.log(`📥 Fetching messages NEWER than ID ${checkpointId}...`);

  let newMessages: any[] = [];
  let lastFetchedId = 0; // 0 means fetch from newest
  let keepFetching = true;

  while (keepFetching) {
    const batch = await client.getMessages(targetChat.id, 100, lastFetchedId);

    if (!batch || batch.length === 0) break;

    // We only want messages strictly newer (greater ID) than the checkpoint
    const inRange = batch.filter(m => m.id > checkpointId);
    newMessages = newMessages.concat(inRange);

    const oldestInBatch = batch[batch.length - 1];
    lastFetchedId = oldestInBatch.id;

    process.stdout.write(`   Processing batch (Oldest ID in batch: ${oldestInBatch.id})...\r`);

    // If the oldest message in this batch is older than or equal to our checkpoint, we've gone far enough back
    if (oldestInBatch.id <= checkpointId) {
      keepFetching = false;
    }

    await new Promise(r => setTimeout(r, 400));
  }

  // Sort chronologically (oldest to newest)
  newMessages.sort((a, b) => a.id - b.id);

  console.log(`\n🎉 Fetched ${newMessages.length} NEW messages.`);

  // 4. Save new messages to a completely new text file
  let newContent = `CLEAN RECOVERY: ${targetChat.title}\n`;
  newContent += `NEW MESSAGES FETCHED AFTER ID ${checkpointId} ON ${new Date().toISOString()}\n\n`;

  if (newMessages.length > 0) {
    newMessages.forEach(m => {
      const content = m.text || m.mediaCaption || "";
      if (content.trim()) {
          newContent += `[ID:${m.id}] [Date:${new Date(m.date * 1000).toISOString()}] ${content.replace(/\n/g, ' ')}\n\n`;
      }
    });
  }

  // Save to a fresh file
  fs.writeFileSync('new_techuprise_recovery.txt', newContent);
  console.log(`✅ Saved new messages cleanly to new_techuprise_recovery.txt.`);

  // 5. Parse only the NEW jobs with emails into new_parsed_jobs.json
  console.log(`🔍 Parsing new jobs for draft generation...`);

  const messageRegex = /\[ID:(\d+)\] \[Date:([^\]]+)\] (.*?)(?=\n\n\[ID:|\n\n---|(?:\n\n)?$)/gs;
  const parsedMessages: { id: string, date: string, text: string, email: string | null }[] = [];

  let textMatch;
  while ((textMatch = messageRegex.exec(newContent)) !== null) {
    const text = textMatch[3].trim();
    // Simple regex to grab the first email
    const emailMatch = text.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/i);

    if (emailMatch) {
      parsedMessages.push({
        id: textMatch[1],
        date: textMatch[2],
        text: text,
        email: emailMatch[1]
      });
    }
  }

  fs.writeFileSync('new_parsed_jobs.json', JSON.stringify(parsedMessages, null, 2));
  console.log(`✅ Extracted ${parsedMessages.length} NEW job postings with emails to new_parsed_jobs.json.`);
  process.exit(0);
}

main().catch(console.error);