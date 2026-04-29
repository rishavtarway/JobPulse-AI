import fs from 'fs';
import { google } from 'googleapis';

const OLD_ID = '18y1yNOP-C7Mw8_Japfeb9ihsfNk6YiwH';
const NEW_ID = '1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7';

async function authorizeGmail() {
    const creds = JSON.parse(fs.readFileSync('credential.json', 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, (redirect_uris || ['http://localhost'])[0]);
    const token = JSON.parse(fs.readFileSync('token.json', 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

function decodeBase64(data: string) {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function encodeBase64(data: string) {
    return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function updateGmailDrafts() {
    console.log(`\n📧 Connecting to Gmail to replace exact Drive ID in drafts...`);
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });

    const draftsRes = await gmail.users.drafts.list({ userId: 'me' });
    const drafts = draftsRes.data.drafts || [];
    
    let updatedCount = 0;
    for (const draft of drafts) {
        try {
            const rawDraft = await gmail.users.drafts.get({ userId: 'me', id: draft.id!, format: 'raw' });
            if (!rawDraft.data.message || !rawDraft.data.message.raw) continue;

            const decodedEmail = decodeBase64(rawDraft.data.message.raw);
            
            // Just check for the ID itself. This bypasses MIME encoding artifacts like =3D
            if (decodedEmail.includes(OLD_ID)) {
                const newEmailBody = decodedEmail.replaceAll(OLD_ID, NEW_ID);
                const encodedNewEmail = encodeBase64(newEmailBody);

                await gmail.users.drafts.update({
                    userId: 'me',
                    id: draft.id!,
                    requestBody: { message: { raw: encodedNewEmail } }
                });
                
                console.log(`   ✅ Updated Link in Draft: ${draft.id}`);
                updatedCount++;
            }
        } catch (e: any) {}
    }
    console.log(`\n🎉 Total Gmail drafts updated: ${updatedCount}\n`);
}

updateGmailDrafts().catch(console.error);
