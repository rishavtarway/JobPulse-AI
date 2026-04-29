import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

async function authorizeGmail() {
  const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
  const TOKEN_PATH = path.join(process.cwd(), 'token.json');
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
  return oAuth2Client;
}

async function run() {
  console.log("🔍 Scanning for today's Gmail drafts...");
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: 'v1', auth: auth as any });

  const res = await gmail.users.drafts.list({ userId: 'me' });
  const drafts = res.data.drafts || [];
  
  const today = new Date();
  today.setHours(0,0,0,0); // midnight today
  
  let deletedCount = 0;
  for (const draft of drafts) {
      if (draft.id && draft.message && draft.message.id) {
          const msg = await gmail.users.messages.get({ userId: 'me', id: draft.message.id, format: 'metadata' });
          const internalDate = parseInt(msg.data.internalDate || '0');
          if (internalDate >= today.getTime()) { // Created today
              await gmail.users.drafts.delete({ userId: 'me', id: draft.id });
              deletedCount++;
              console.log(`🗑️ Deleted draft created today: ${draft.id}`);
          }
      }
  }
  console.log(`✅ Finished cleaning up. Successfully deleted ${deletedCount} drafts from today.`);
}

run();
