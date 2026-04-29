import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

async function authorize() {
    const TOKEN_PATH = path.join(process.cwd(), 'token.json');
    const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    return oAuth2Client;
}

async function run() {
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });

    console.log("Listing drafts...");
    const res = await gmail.users.drafts.list({ userId: 'me' });
    const drafts = res.data.drafts || [];
    
    console.log(`Found ${drafts.length} drafts.`);
    for (const draft of drafts) {
        console.log(`Deleting draft ${draft.id}...`);
        await gmail.users.drafts.delete({ userId: 'me', id: draft.id });
    }
    console.log("All drafts deleted.");
}

run().catch(console.error);
