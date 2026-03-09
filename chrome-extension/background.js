// background.js — Extension Service Worker

const FORM_SERVER = 'http://127.0.0.1:3001';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

    // ── Open multiple tabs ─────────────────────────────────────────────────────
    if (request.action === 'open_tabs') {
        const urls = request.urls || [];
        const valid = urls.filter(url => {
            try { new URL(url); return true; } catch { return false; }
        });
        if (valid.length === 0) {
            sendResponse({ status: false, error: 'No valid URLs provided' });
            return true;
        }
        valid.forEach(url => chrome.tabs.create({ url, active: false }));
        sendResponse({ status: true, opened: valid.length });
        return true;
    }

    // ── Fetch LLM answers for unmapped form fields ─────────────────────────────
    if (request.action === 'fetch_llm_answers') {
        const { fields, tabUrl } = request;

        fetch(`${FORM_SERVER}/api/form-filler/llm-fallback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields, tabUrl })
        })
            .then(res => {
                if (!res.ok) throw new Error(`Server responded ${res.status}`);
                return res.json();
            })
            .then(data => sendResponse(data))
            .catch(err => {
                console.error('[Background] LLM fetch failed:', err.message);
                sendResponse({ results: [], error: err.message });
            });

        return true; // Keep message channel open for async response
    }

    // ── Save a single learned field answer ─────────────────────────────────────
    if (request.action === 'save_answer') {
        fetch(`${FORM_SERVER}/api/form-filler/save-answer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: request.key, answer: request.answer })
        })
            .then(res => res.json())
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    // ── Update a specific resume field ─────────────────────────────────────────
    if (request.action === 'update_field') {
        fetch(`${FORM_SERVER}/api/form-filler/update-field`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: request.path, value: request.value })
        })
            .then(res => res.json())
            .then(data => sendResponse(data))
            .catch(err => sendResponse({ error: err.message }));
        return true;
    }

    return false;
});
