import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';

const CREDENTIALS_PATH = path.join(process.cwd(), 'credential.json');
const TOKEN_PATH = path.join(process.cwd(), 'token.json');

async function test() {
  console.log('--- GMAIL DRAFT TEST ---');
  
  if (!fs.existsSync(CREDENTIALS_PATH)) { console.error('Missing credentials.json'); return; }
  if (!fs.existsSync(TOKEN_PATH)) { console.error('Missing token.json'); return; }

  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  const credentials = JSON.parse(content);
  const clientSecret = credentials.installed?.client_secret || credentials.web?.client_secret;
  const clientId = credentials.installed?.client_id || credentials.web?.client_id;
  const redirectUris = credentials.installed?.redirect_uris || credentials.web?.redirect_uris || ['http://localhost'];

  const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUris[0]);
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  oAuth2Client.setCredentials(token);

  const gmail = google.gmail({ version: 'v1', auth: oAuth2Client });

  try {
    console.log('Verifying connection (getProfile)...');
    const profile = await gmail.users.getProfile({ userId: 'me' });
    console.log('✅ Connection verified! Email:', profile.data.emailAddress);

    console.log('Creating test draft...');
    const res = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: {
        message: {
          raw: Buffer.from(
            "To: test@example.com\r\n" +
            "Subject: Test Draft\r\n\r\n" +
            "This is a test draft."
          ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        }
      }
    });
    console.log('✅ Draft created successfully! ID:', res.data.id);
  } catch (err: any) {
    console.error('❌ FAILED:', err.message);
    if (err.response) {
      console.error('Error Details:', JSON.stringify(err.response.data, null, 2));
    }
  }
}

test();
