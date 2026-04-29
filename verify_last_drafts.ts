const { google } = require('googleapis');
const { authorizeGmail } = require('./auth');

async function verify() {
  const auth = await authorizeGmail();
  const gmail = google.gmail({ version: 'v1', auth: auth });
  const drafts = await gmail.users.drafts.list({ userId: 'me', maxResults: 4 });
  
  if (!drafts.data.drafts) {
    console.log("No drafts found.");
    return;
  }

  for (const d of drafts.data.drafts) {
    const draft = await gmail.users.drafts.get({ userId: 'me', id: d.id });
    const parts = draft.data.message.payload.parts;
    let body = "";
    if (parts) {
      const htmlPart = parts.find(p => p.mimeType === 'text/html');
      if (htmlPart) {
        body = Buffer.from(htmlPart.body.data, 'base64').toString();
      }
    }
    console.log(`\n--- DRAFT ID: ${d.id} ---`);
    console.log(`Subject: ${draft.data.message.payload.headers.find(h => h.name === 'Subject').value}`);
    console.log(`Body HTML: ${body}`);
  }
}

verify();
