import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import dns from 'node:dns';

dotenv.config();
if (typeof dns.setDefaultResultOrder === 'function') dns.setDefaultResultOrder('ipv4first');

const APPLICATIONS_FILE = path.join(process.cwd(), 'applications.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

async function authorizeGmail() {
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, (redirect_uris || ['http://localhost'])[0]);
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function main() {
    console.log('\n🗑️  DELETING OLD FOLLOW-UP DRAFTS...\n');

    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });

    // Search for all drafts with [Follow up] in subject
    const res = await gmail.users.drafts.list({ userId: 'me', q: 'subject:"[Follow up]"' });
    const drafts = res.data.drafts || [];

    console.log(`Found ${drafts.length} follow-up draft(s) to delete.`);

    let deleted = 0;
    for (const draft of drafts) {
        try {
            await gmail.users.drafts.delete({ userId: 'me', id: draft.id! });
            deleted++;
            console.log(`  🗑️  Deleted draft ${draft.id}`);
        } catch (e: any) {
            console.error(`  ❌ Failed to delete ${draft.id}: ${e.message}`);
        }
    }

    console.log(`\n✅ Deleted ${deleted}/${drafts.length} drafts.`);

    // Reset followedUp flags in applications.json
    const apps = JSON.parse(fs.readFileSync(APPLICATIONS_FILE, 'utf8'));
    let reset = 0;
    for (const app of apps) {
        if (app.followedUp) {
            delete app.followedUp;
            delete app.followUpDate;
            reset++;
        }
    }
    fs.writeFileSync(APPLICATIONS_FILE, JSON.stringify(apps, null, 2));
    console.log(`♻️  Reset followedUp flag on ${reset} application(s).`);
    console.log('\n✅ All done! Click "DRAFT FOLLOW-UPS" button in the dashboard to re-draft.\n');
}

main().catch(console.error);
