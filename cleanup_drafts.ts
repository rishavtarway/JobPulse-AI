import * as fs from 'fs';
import * as path from 'path';
import { google } from 'googleapis';

const TOKEN_PATH = 'token.json';
const CREDENTIALS_PATH = 'credential.json';

async function authorize() {
    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

async function cleanup() {
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    console.log("🧹 Cleaning up old drafts...");
    const res = await gmail.users.drafts.list({ userId: 'me', maxResults: 100 });
    const drafts = res.data.drafts || [];

    for (const d of drafts) {
        const draft = await gmail.users.drafts.get({ userId: 'me', id: d.id! });
        const body = JSON.stringify(draft.data);
        // Check if it's one of my drafts (contains signature components)
        if (body.includes("Rishav Tarway") && (body.includes("Runlayer") || body.includes("Ankar") || body.includes("1mind") || body.includes("Sim") || body.includes("Tutor Intelligence"))) {
            await gmail.users.drafts.delete({ userId: 'me', id: d.id! });
            console.log(`✅ Deleted draft ID: ${d.id}`);
        }
    }
    console.log("✨ Cleanup complete.");
}

cleanup().catch(console.error);
