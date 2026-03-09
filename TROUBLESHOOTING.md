# 🛠️ Ultra-Deep Troubleshooting & System Architecture Guide

This guide is designed for anyone—from a student with zero coding knowledge to an AI model—to understand, debug, and master the **Auto-Apply Bot** ecosystem. It breaks down the system layer-by-layer, from the raw Telegram data extraction to the AI decision-making logic.

---

## 🏗️ 1. Architecture Overview (The Big Picture)

The system is a "Pipeline" where data flows through four distinct layers:

1.  **Extraction Layer (`auto_apply.ts`)**: Uses the **TDLib (Telegram Database Library)** to connect to your Telegram account, scan specific job channels, and find messages containing recruiters' emails or application links.
2.  **Intelligence Layer (OpenRouter/Gemini)**: The extracted job description is sent to an LLM (Large Language Model). The AI acts as a "Matching Engine," comparing the job requirements against your `resume_data.json` to write a high-conversion, personalized cover letter.
3.  **Action Layer (Gmail API)**: The personalized email is pushed directly into your **Gmail Drafts** folder as a pre-populated, formatted HTML email with your Resume PDF attached.
4.  **Tracking Layer (Web Dashboard)**: Every application is logged into a local Database (`applications.json`) and displayed on a local Web Interface (`localhost:3000`) where you can track interview rounds.

---

## 🤖 2. The AI matching Algorithm (Core Logic)

When the bot "reads" a job, it doesn't just copy-paste. It follows a specific algorithm:

*   **Step A: Entity Extraction**: It identifies the **Company Name** and **Recruiter Name** (using `extractName` logic).
*   **Step B: Contextual Synthesis**: It feeds your entire resume JSON to the AI with a strict prompt: *"Identify the top 3 technical skills this job needs that match Rishav's background."*
*   **Step C: Multi-Model Fallback (The Failover Engine)**:
    *   If `Model A (openrouter/free)` is busy, the script catches the `429` error.
    *   It immediately hot-swaps the model ID to `Model B (gemma-3)`.
    *   If that fails, it tries `Model C (mistral)` or `Model D (llama)`.
    *   This ensures the process NEVER stops even if one AI provider is down.

---

## 🌐 3. Web Form Filling (The Chrome Extension)

Standard autofill fails on modern sites like **Microsoft Forms** or **Lever**. Our extension uses "Contextual DOM Analysis":

*   **The Problem**: Microsoft Forms hides labels and uses `div` wrappers without standard "name" attributes.
*   **Our Solution**: The `content.js` script performs an "Up-Tree Search." It finds a textbox, then looks at the `aria-label` or goes up 3 levels in the HTML to find a `span` with the `data-automation-id="questionTitle"`.
*   **Insertion**: It doesn't just set `.value`. It triggers `input` and `change` events manually to fool the website's React/Angular framework into thinking a human typed the data.

---

## 📮 4. Gmail Connection (OAuth 2.0)

Your connection to Gmail uses **OAuth 2.0 Credentials**. 
*   **Security**: We never see your password. Google gives us a "Refresh Token."
*   **Token Expiry**: If your app is in "Testing Mode" in the Google Cloud Console, your `token.json` expires every **7 days**. 
*   **The Fix**: Run `npx tsx auth_gmail.ts` to log in again and generate a fresh Token.

---

## 🚨 5. Common Errors & "Zero-Knowledge" Fixes

### "invalid_grant" (The #1 Error)
*   **What it means**: Your 7-day Gmail token has expired.
*   **The Fix**: Delete `token.json` and run `npx tsx auth_gmail.ts`. Click the link, sign in, and paste the code.

### "429: Rate Limit Hit" or "402: Payment Required" (OpenRouter)
*   **What it means**: The free AI model you are using has too many users right now.
*   **The Fix**: Nothing! The code now handles this automatically. It will switch models and sleep for 15 seconds. Just let the script keep running.

### "Bot is not fetching 70+ jobs"
*   **What it means**: The bot thinks it already processed those jobs.
*   **The Fix**: Open `auto_apply_state.json`. Change the `lastMessageId` number to a much smaller number (like `2540000000`). This "rewinds" the bot's memory so it looks at older messages.

### "Extension is not filling the form"
*   **What it means**: The Form-Filler backend is likely off.
*   **The Fix**: Ensure your terminal says `🚀 Form-Filler Server running at http://localhost:3001`. If it's not running, type `npm run form-filler`.

---

## 🛠️ 6. Technology Stack for Developers

*   **Runtime**: Node.js (with `tsx` for TypeScript execution).
*   **Backend**: Express.js (Port 3000 for Dashboard, Port 3001 for Filler).
*   **Frontend**: Vanilla HTML/CSS/JS (Zero dependencies for maximum speed).
*   **Telegram Protocol**: MTProto (via `tdl` and `prebuilt-tdlib`).
*   **AI Access**: OpenRouter API (REST via `fetch`).
*   **Email Protocol**: SMTP/Gmail API (via `googleapis` and `nodemailer`).

---

## 👨‍💻 7. Final Sanity Check for Success
1.  Check `.env` for `OPENROUTER_API_KEY` and `TELEGRAM_API_ID`.
2.  Ensure `resume_data.json` is accurate (this is the AI's primary knowledge source).
3.  Check `applications.json` to see your history.
4.  Run `npm start` to launch the whole command center at once.
