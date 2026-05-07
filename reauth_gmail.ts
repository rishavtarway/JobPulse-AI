/**
 * One-shot Gmail OAuth re-auth helper.
 *
 *   1. Reads `credential.json` (downloaded from Google Cloud Console).
 *   2. Prints an auth URL — open it in your browser, sign in with the
 *      Gmail account you draft from, and paste the resulting code back
 *      into the terminal.
 *   3. Writes a fresh `token.json` so the NAS / Manual JD / Telegram
 *      scrapers can resume drafting.
 *
 * Trigger when the scrapers report `invalid_grant` / `unauthorized`.
 *
 *   rm token.json
 *   npx tsx reauth_gmail.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { google } from 'googleapis';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
];

async function main() {
  const credPath = path.join(process.cwd(), 'credential.json');
  const tokenPath = path.join(process.cwd(), 'token.json');
  if (!fs.existsSync(credPath)) {
    console.error('❌ Missing credential.json next to this script.');
    console.error('   Download OAuth credentials (Desktop type) from Google Cloud → APIs & Services → Credentials.');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(credPath, 'utf8'));
  const installed = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a fresh refresh_token even if we re-authorize the same account
    scope: SCOPES,
  });

  console.log('🔐  Open this URL in your browser, sign in, then paste the code back here:\n');
  console.log(authUrl + '\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise<string>((resolve) =>
    rl.question('📋  Paste the auth code: ', (a) => { rl.close(); resolve(a.trim()); })
  );

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
  console.log(`\n✅  Wrote ${tokenPath}. You can now re-run the scraper.`);
}

main().catch((err) => {
  console.error('\n💥  Re-auth failed:', err && err.message ? err.message : err);
  process.exit(1);
});
