import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const OLD_LINK = 'https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing';
const NEW_LINK = 'https://drive.google.com/file/d/1q4jKjMioZf2FoY_IhuFYvlxjg_2WBRZ7/view?usp=sharing';

const DIRECTORIES_TO_SCAN = [
    process.cwd(),
    path.join(process.cwd(), 'scripts'),
    path.join(process.cwd(), 'scratch')
];

function replaceInFiles() {
    console.log(`\n📂 1. Scanning local files to replace old resume link...`);
    let replacedCount = 0;

    for (const dir of DIRECTORIES_TO_SCAN) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        for (const file of files) {
            if (file.endsWith('.ts') || file.endsWith('.json')) {
                const filePath = path.join(dir, file);
                try {
                    let content = fs.readFileSync(filePath, 'utf8');
                    if (content.includes(OLD_LINK)) {
                        content = content.replaceAll(OLD_LINK, NEW_LINK);
                        fs.writeFileSync(filePath, content);
                        console.log(`   ✅ Updated ${filePath}`);
                        replacedCount++;
                    }
                } catch (e: any) {
                    // Ignore dirs or unreadable
                }
            }
        }
    }
    console.log(`   Total local files updated: ${replacedCount}\n`);
}

async function authorizeGmail() {
    const creds = JSON.parse(fs.readFileSync('credential.json', 'utf8'));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, (redirect_uris || ['http://localhost'])[0]);
    const token = JSON.parse(fs.readFileSync('token.json', 'utf8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
}

// Helper to decode Base64 URL safe
function decodeBase64(data: string) {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// Helper to encode Base64 URL safe
function encodeBase64(data: string) {
    return Buffer.from(data).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function updateGmailDrafts() {
    console.log(`\n📧 2. Connecting to Gmail to update existing drafts...`);
    const auth = await authorizeGmail();
    const gmail = google.gmail({ version: 'v1', auth: auth as any });

    // Try to fetch all recent drafts
    const draftsRes = await gmail.users.drafts.list({ userId: 'me' });
    const drafts = draftsRes.data.drafts || [];
    
    console.log(`   Found ${drafts.length} total drafts. Scanning for old link...`);

    let updatedCount = 0;
    for (const draft of drafts) {
        try {
            const rawDraft = await gmail.users.drafts.get({ userId: 'me', id: draft.id!, format: 'raw' });
            if (!rawDraft.data.message || !rawDraft.data.message.raw) continue;

            const decodedEmail = decodeBase64(rawDraft.data.message.raw);
            
            if (decodedEmail.includes(OLD_LINK)) {
                // Modify the link
                const newEmailBody = decodedEmail.replaceAll(OLD_LINK, NEW_LINK);
                const encodedNewEmail = encodeBase64(newEmailBody);

                // Update the draft
                await gmail.users.drafts.update({
                    userId: 'me',
                    id: draft.id!,
                    requestBody: {
                        message: {
                            raw: encodedNewEmail
                        }
                    }
                });
                
                console.log(`   ✅ Updated Draft ID: ${draft.id}`);
                updatedCount++;
            }
        } catch (e: any) {
            console.log(`   ⚠️ Failed to process draft ${draft.id}: ${e.message}`);
        }
    }

    console.log(`   Total Gmail drafts updated: ${updatedCount}\n`);
}

async function main() {
    replaceInFiles();
    await updateGmailDrafts();
}

main().catch(console.error);
