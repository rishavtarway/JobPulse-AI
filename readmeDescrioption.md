# Technical: JobPulse AI

> [!IMPORTANT]
> **Key Pitch:** This is a "Personal Productivity Ecosystem" designed to automate the high-friction parts of job hunting: discovery (Telegram scraping) and application (Auto-filling forms).

## 1. Core Technology Stack
*   **Frontend**: Vanilla HTML5, CSS3, Modern ES6+ JavaScript.
    *   *Why?*: Zero build-time, lightning fast, and demonstrates deep mastery of DOM manipulation without relying on framework abstractions (React/Vue).
*   **Backend**: Node.js (TypeScript/tsx) + Express.
    *   *API Pattern*: RESTful (GET for syncing state, PATCH for status updates, POST for triggering tasks).
*   **Automation**: 
    *   **Telegram Intelligence**: Scrapes unstructured text from channels.
    *   **AI Parsing**: Uses Large Language Models (LLMs) to turn text like "We are hiring SWEs at Google..." into `{ "company": "Google", "role": "SWE" }`.
*   **Browser Integration**: Chrome Extension + Local Node.js Bridge (port 3001).

---

## 2. Frontend & UI/UX Concepts (The "Wows")
*   **Bento Box Layout**: Modular design pattern that organizes the complexity into "cards." It’s a modern trend used by Apple/linear.app for visual clarity.
*   **Glassmorphism**: Used `backdrop-filter: blur(12px)` and semi-transparent backgrounds to give the dashboard a "premium glass" look.
*   **Sophisticated Sticky Navigation**:
    *   Implemented a **"Stacked Sticky"** system. The main header sticks at 0, the Discovery Source bar sticks at `100px`, and the current channel header sticks at `172px`.
    *   *Tech behind it*: Uses CSS `position: sticky` with calculated `top` offsets and `scroll-margin-top` to ensure anchors land exactly where the user can see them.
*   **Responsive Constraint**: Capped the main content at **800px-900px**. 
    *   *Why?*: To keep the "Reading Zone" centered and prevent right-side interaction elements (applied buttons/tags) from drifting out of view on ultra-wide monitors.

---

## 3. System Flow (How it works)
1.  **Discovery**: `auto_apply.ts` fetches messages from chosen Telegram channels.
2.  **Analysis**: The engine filters messages using keywords and AI, then saves them to `applications.json`.
3.  **Visualization**: The Dashboard (`index.html`) polls `/api/applications` to refresh the feed without a page reload.
4.  **Action**: The Chrome Extension detects job portals (Workday/Greenhouse) and pulls data from your local `resume_data.json` via the `form_filler_server.ts` to auto-fill the form fields.

---

## 4. Key Components to Mention
*   **`server.ts`**: The central orchestrator. It serves the UI and manages the JSON state.
*   **`applications.json`**: The "Single Source of Truth." Local-first storage for privacy and speed.
*   **`combined_server.ts`**: A wrapper that boots both the UI server (3000) and the Extension backend (3001) with one command.
*   **`yc_cold_email.ts`**: An agentic script that does deep research on startups to draft personalized cold emails.

---

## 5. Potential "How did you..." Questions
*   **"How do you sync logs in real-time?"**
    *   *Answer*: The backend streams process logs to an array. The frontend uses a recursive `setInterval` to "poll" the `/api/logs` endpoint and updates the terminal view using `innerHTML` increments.
*   **"How does the navigation work with so many jobs?"**
    *   *Answer*: I use a grouping algorithm in JavaScript that creates a "Map" of categories. These are rendered as anchor tags (`#ChannelName`). I use `scroll-behavior: smooth` for a premium transition.
*   **"Why JSON instead of a Database?"**
    *   *Answer*: For a personal tool, JSON is perfectly performant (sub-millisecond reads for 1000s of records) and offers zero-config portability (I can move the project folder and it just works).

---

> [!TIP]
> **Closing Thought:** Focus on the "Problem-Solution" fit. You had the problem of "Job Application Fatigue," and you built an end-to-end technical solution to solve it. That shows initiative and engineering maturity.
