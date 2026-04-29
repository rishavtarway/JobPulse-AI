import { TelegramClient } from './src/telegram/client';
import { Config } from './src/config';
import fs from 'fs';
import path from 'path';

const SINCE_DATE = new Date('2026-04-02T11:00:00+05:30');
const APPS_FILE = path.join(process.cwd(), 'applications.json');

async function fixLinks() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    
    try {
        console.log("📂 Loading applications.json...");
        const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));

        console.log("📡 Connecting to Telegram...");
        await client.connect();
        
        const techChat = { id: "-1003338916645", name: "TechUprise Premium" };
        
        let updateCount = 0;
        let lastFetchedId = 0;
        let keepFetching = true;
        let batchCounter = 0;

        while (keepFetching && batchCounter < 100) {
            const batch = await (client as any).getMessages(techChat.id, 50, lastFetchedId);
            if (!batch || batch.length === 0) break;

            batchCounter++;
            for (const m of batch) {
                lastFetchedId = m.id;

                const messageDate = m.date * 1000;
                if (new Date(messageDate) < SINCE_DATE) {
                    keepFetching = false;
                    continue;
                }

                const text = m.text || m.mediaCaption || "";
                if (!text.trim()) continue;

                // Find the entry in applications.json
                const appIndex = apps.findIndex((a: any) => a.telegramId === m.id.toString());
                if (appIndex !== -1) {
                    const links = text.match(/https?:\/\/[^\s]+/g) || [];
                    if (links.length > 0) {
                        apps[appIndex].link = links[0];
                        updateCount++;
                        if (updateCount % 10 === 0) console.log(`   🛠️ Updated ${updateCount} links...`);
                    }
                }
            }
        }

        console.log(`\n💾 Writing ${updateCount} updates to applications.json...`);
        fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
        
        console.log(`\n🏁 FIX COMPLETE! Total links restored: ${updateCount}`);

        await client.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ ERROR:', error);
        await client.disconnect();
        process.exit(1);
    }
}

fixLinks();
