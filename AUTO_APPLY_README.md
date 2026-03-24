# Auto-Apply Workflow Documentation

This directory contains a fully automated workflow designed to fetch recent job postings from the "TechUprise Premium Insider Club" Telegram channel, use AI to generate highly customized, professional cold email drafts, and save them directly to your Gmail Drafts folder with your PDF resume and certificates attached.

## Setup Requirements

To use this workflow, ensure the following are present in the `JobPulse-AI` directory:
1. **`.env` file**: Must contain `OPENROUTER_API_KEY=your_key_here`. (This connects to the free `gemini-2.5-flash-lite` model for generating text).
2. **`credential.json` & `token.json`**: These are required to authenticate the script with your Google/Gmail account so it can create the drafts.
3. **Your 4 PDF Documents**: The script explicitly looks for and attaches the following 4 files:
   - `OpenSourceContributions.pdf`
   - `RishavTarway_IIITB_InternshipCertificate.pdf`
   - `RishavTarway-Resume .pdf`
   - `SRIP_CompletionLetter Certificate2025_IIITB.pdf`

## How to Run It Every Day

You only need to run ONE command to execute the entire workflow:

```bash
npx tsx auto_apply.ts
```

### What happens when you run this command?

1. **State Tracking**: The script looks at `auto_apply_state.json` to find the exact Message ID of the very last job it processed.
2. **Telegram Fetching**: It connects to Telegram, scans the chat, and downloads *only* the new messages posted after that specific ID.
3. **Email Parsing**: It extracts the emails from those new messages and logs them to `latest_jobs_to_apply.json` and a running master log `all_extracted_jobs_log.txt`.
4. **Manual Tasklist**: If a job posting contains a link (like a Google Form or LinkedIn link) instead of an email address, it will automatically append that job to `MANUAL_APPLY_TASKS.md` so you can review and apply to them later!
5. **State Update**: It immediately updates `auto_apply_state.json` with the new highest Message ID so it never processes the same job twice.
6. **AI Drafting**: It connects to OpenRouter and uses `gemini-2.5-flash-lite` to read the job description, extract the core technical focus, and write a customized 4-paragraph email (with zero commas or brackets) mapping your exact internships (Classplus, IIITB) to their needs.
7. **Gmail Upload**: It logs into your Gmail account via the API, builds the email, attaches your 4 PDFs, adds your HTML signature (with Codeforces/GitHub links), and saves it as a Draft.

### Managing Manual Applications
Check the `MANUAL_APPLY_TASKS.md` file regularly. The script automatically populates it with jobs that require you to fill out a web form or message someone on LinkedIn instead of sending a cold email.

### The Next Steps (Manual)
Once the script says "ALL DONE", simply open your **Gmail -> Drafts** folder. You will see the drafts waiting. Open them, verify they look good, click the arrow next to the "Send" button, and select **"Schedule send"** to set them for 8:30 AM!

## Troubleshooting

- **Telegram Authentication**: If you haven't run the script in a while, the Telegram API might prompt you in the terminal to enter a verification code (sent to your phone/Telegram app). Just type it in and hit enter.
- **Gmail Token Expiration**: If the Gmail API throws an authentication error, you may need to delete `token.json` and run the auth script again to generate a new token.
- **OpenRouter Errors**: If OpenRouter fails, the script will fall back to a "generic but professional" template so you don't lose the draft. Make sure your `.env` key is valid.