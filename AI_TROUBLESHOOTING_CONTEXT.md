# AI TROUBLESHOOTING & PROJECT CONTEXT

> **TO ANY FUTURE AI:** If you are reading this file, you have been given the complete context of the `telegram-mcp` Auto-Apply project built by Rishav Tarway. Do NOT ask the user to explain how the system works. Read this document thoroughly to understand the architecture, historical bugs, formatting rules, and API choices before attempting to fix any errors the user provides.

---

## 1. PROJECT ARCHITECTURE

This project is a localized Node.js/TypeScript automation pipeline designed to:
1. Scrape new job postings from a specific Telegram channel (`"TechUprise Premium Insider Club"`).
2. Filter the messages into "Email Applications" (has `@domain.com`) and "Manual Applications" (has `https://` like Google Forms/LinkedIn).
3. Use the **OpenRouter API** (`google/gemini-2.5-flash-lite`) to generate highly customized, professional cold email drafts.
4. Use the **Google/Gmail API** to automatically save those drafts into the user's Gmail `Drafts` folder with 4 specific PDF resumes/certificates attached.
5. Serve a local Express Web Dashboard (`server.ts` & `index.html`) so the user can trigger the script (`auto_apply.ts`) from their phone via local WiFi IP.

### Core Files
*   `server.ts`: The Express server that runs the web UI. Detects local IPv4 and serves on port 3000. Triggers `auto_apply.ts` as a child process.
*   `auto_apply.ts`: The master script. Handles Telegram extraction, OpenRouter text generation, and Gmail API drafting sequentially.
*   `public/index.html`: The frontend dashboard UI (dark mode, 3 tabs: Logs, Manual Tasks, History).
*   `auto_apply_state.json`: Critical state file containing `{"lastMessageId": 12345678}` to ensure deduplication.
*   `MANUAL_APPLY_TASKS.md`: Appends jobs that don't have emails so the user can manually apply.
*   `all_extracted_jobs_log.txt`: Master historical log of every job fetched.

---

## 2. STRICT EMAIL FORMATTING RULES

The user (Rishav Tarway) was *extremely* specific about how the generated emails must look. If you modify the OpenRouter prompt in `auto_apply.ts`, **DO NOT break these rules**:

1.  **NO COMMAS AND NO BRACKETS**: The user absolutely forbids the use of commas `,`, brackets `[]`, or parentheses `()` anywhere in the subject or body of the generated email.
2.  **Subject Line**: Must be formatted exactly as: `<Role Name> Application | <Catchy 3-word phrase about the company's focus> | Rishav Tarway`
3.  **Body Structure**: Exactly 5 paragraphs wrapped in `<p>` tags.
    *   **P1:** `Hi <Name/Team>` followed by `I hope you are doing well. My name is Rishav Tarway and I am reaching out because I have been following <Company> and appreciate the company's commitment to <focus extracted from job post>.`
    *   **P2:** Must dynamically map Rishav's experience (Classplus, IIIT Bangalore, Franchizerz, TechVastra) to the *specific* requirements of the job.
    *   **P3 (Open Source Flex):** Must include this exact string: `I recently had success contributing to OpenPrinting where I was selected for Winter of Code 5.0 and successfully merged my <a href="https://github.com/OpenPrinting/fuzzing/pull/48">recent PR #48 at OpenPrinting</a>. Writing extensive fuzzing functions to find edge cases is really driving my passion to learn the in depth architecture of software and find their vulnerabilities <add a few words tying this to their specific role>.`
    *   **P4:** `I would be more than happy to contribute and connect with the amazing team at <Company>. I have attached my resume along with this.`
    *   **P5:** `Thank you and I hope to hear from you soon!`
4.  **Signature**: The signature must be appended at the end using the hardcoded `SIGNATURE_HTML` constant, which includes 6 pipe-separated hyperlink tags (Resume, LinkedIn, GitHub, Portfolio, Open Source, Codeforces).
5.  **Attachments**: The script explicitly attaches 4 local PDFs (OpenSourceContributions.pdf, RishavTarway_IIITB_InternshipCertificate.pdf, RishavTarway-Resume .pdf, SRIP_CompletionLetter Certificate2025_IIITB.pdf).

---

## 3. HISTORICAL BUGS & HOW THEY WERE FIXED

If the user encounters an error, it might be a regression of one of these previously solved issues:

### A. Telegram Fetching Duplicates (The "Stuck at 0" bug)
*   **Issue:** The Telegram API caches responses. When fetching new jobs, the script used to fetch old jobs that had already been processed, resulting in duplicate Gmail drafts.
*   **Fix Applied:** In `auto_apply.ts`, we implemented strict deduplication using a `Set<number>()` to track `seenIdsThisSession`. Furthermore, we only append messages if `m.id > lastProcessedId`. We update `auto_apply_state.json` ONLY at the very end with the absolute highest `m.id` found in the batch.

### B. Gemini API Rate Limits (429 Errors)
*   **Issue:** The user's Google API key hit the "20 requests per day" free tier limit.
*   **Fix Applied:** We completely abandoned the `googleapis` generative AI package. We switched to **OpenRouter API** (`https://openrouter.ai/api/v1/chat/completions`) using the free `google/gemini-2.5-flash-lite` model. The key is stored in `.env` as `OPENROUTER_API_KEY`.

### C. Gmail "raw" Message Formatting
*   **Issue:** Generating valid MIME emails for the Gmail API is complex and prone to base64 encoding errors.
*   **Fix Applied:** We use the `nodemailer` package (`MailComposer`) to build the email object (with HTML body and file attachments). We then compile it to a Buffer and convert it to a web-safe base64 string (`.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')`). Do NOT manually construct the MIME strings.

### D. Missing Local IP on Server Startup
*   **Issue:** The server just printed `localhost:3000`, so the user didn't know what IP to type into their phone.
*   **Fix Applied:** `server.ts` uses the Node `os.networkInterfaces()` module to automatically find the active `IPv4` address (e.g. 192.168.x.x) and prints it explicitly on startup.

---

## 4. IF THE USER REPORTS AN ERROR...

**1. "Cannot find module / Failed to compile"**
Tell the user to run `npm install`. If it's a TSX error, ensure `tsx` is installed globally or they are running `npx tsx`.

**2. "Authentication failed for Gmail / 403 / access_denied"**
The `token.json` might have expired or the scope changed. Tell the user to:
1. Delete `token.json`
2. Run `npx tsx auth_gmail.ts` to re-authenticate and get a new token.

**3. "No new jobs found" but the user knows there are new jobs**
Check `auto_apply_state.json`. If the ID is somehow higher than the current Telegram messages, it will skip everything. You can have the user manually lower the `lastMessageId` in that JSON file by a few thousand to force it to re-scan recent history.

**4. "OpenRouter API failing / returning generic template"**
Check if `OPENROUTER_API_KEY` is present in `.env`. Ensure the model `google/gemini-2.5-flash-lite` is still available on OpenRouter. The script has a `try/catch` that defaults to a generic hardcoded string if the API fails—if all drafts look identical, the OpenRouter API call is failing.

**5. "PDFs not attaching"**
Ensure the exact filenames match the `ATTACHMENTS` array in `auto_apply.ts`. If the user renames their resume, the script must be updated.

---

*End of Context File. Use this knowledge to rapidly debug the user's issue.*