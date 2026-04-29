import { TelegramClient } from './src/telegram/client';
import { Config } from './src/config';
import fs from 'fs';
import path from 'path';

const SINCE_DATE = new Date('2026-04-02T11:00:00+05:30');
const SERVER_PORT = 3000;

async function sync() {
    const config = Config.getInstance();
    const client = new TelegramClient(config.telegram);
    
    try {
        console.log("📡 Connecting to Telegram for Syncing only...");
        await client.connect();
        
        const techChat = { id: "-1003338916645", name: "TechUprise Premium" };
        console.log(`📡 Targeting Channel: ${techChat.name} (ID: ${techChat.id})`);

        console.log(`🔍 Scanning from ${SINCE_DATE.toLocaleString()}...`);
        
        let syncCount = 0;
        let lastFetchedId = 0;
        let keepFetching = true;
        let batchCounter = 0;
        const seenIds = new Set<number>();

        while (keepFetching && batchCounter < 100) {
            const batch = await (client as any).getMessages(techChat.id, 50, lastFetchedId);
            if (!batch || batch.length === 0) break;

            batchCounter++;
            for (const m of batch) {
                if (seenIds.has(m.id)) continue;
                seenIds.add(m.id);
                lastFetchedId = m.id;

                const messageDate = m.date * 1000;
                if (new Date(messageDate) < SINCE_DATE) {
                    keepFetching = false;
                    continue;
                }

                const text = m.text || m.mediaCaption || "";
                if (!text.trim()) continue;

                const emails = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
                const links = text.match(/https?:\/\/[^\s]+/g) || [];
                
                if (emails.length > 0 || links.length > 0) {
                    const email = emails[0] || "";
                    const status = emails.length > 0 ? 'applied' : 'to_apply';

                    // Heuristic for Company
                    const lines = text.split('\n').filter((l: string) => l.trim().length > 0);
                    let company = lines[0].substring(0, 30).trim();
                    const companyMatch = text.match(/(?:Company|🏢|at)\s*[:\-]?\s*([A-Za-z0-9\s]+)/i);
                    if (companyMatch) company = companyMatch[1].trim();

                    await fetch(`http://127.0.0.1:${SERVER_PORT}/api/applications`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            company,
                            role: "Software Engineer",
                            channel: techChat.name,
                            telegramId: m.id.toString(),
                            email,
                            status,
                            type: 'telegram',
                            appliedDate: new Date(messageDate).toISOString(),
                            description: text
                        })
                    }).then(r => r.ok && syncCount++);
                    
                    if (syncCount % 10 === 0 && syncCount > 0) console.log(`   🔸 Synced ${syncCount} jobs...`);
                }
            }
        }

        console.log(`\n🏁 SYNC COMPLETE!`);
        console.log(`⭐ Total New Jobs Synced: ${syncCount}`);

        await client.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('❌ ERROR:', error);
        await client.disconnect();
        process.exit(1);
    }
}

sync();
