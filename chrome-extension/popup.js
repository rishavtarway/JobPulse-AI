const FORM_SERVER = 'http://127.0.0.1:3001';
const DASHBOARD = 'http://127.0.0.1:3000';

let selectedTask = null;
let serverOnline = false;

// ─────────────────────────────────────────────────────────────────
// Persistence — chrome-extension popups are ephemeral (every close
// destroys the DOM) so we cache the last scan + selections in
// `localStorage`, which IS persistent for extension pages across
// popup open/close and tab/window switches. No manifest change
// needed (localStorage on an extension page is not the page's
// content-script localStorage).
// ─────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'jobpulse_resume_state_v1';
const STORAGE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

function loadPersisted() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const state = JSON.parse(raw);
        if (!state || !state.savedAt) return null;
        if (Date.now() - state.savedAt > STORAGE_TTL_MS) {
            localStorage.removeItem(STORAGE_KEY);
            return null;
        }
        return state;
    } catch {
        return null;
    }
}

function savePersisted(patch) {
    try {
        const prev = loadPersisted() || {};
        const next = { ...prev, ...patch, savedAt: Date.now() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
        /* quota / serialisation errors — don't block UI */
    }
}

function clearPersisted() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ─────────────────────────────────────────────────────────────────
// Initialize on load
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fill-tab-btn').addEventListener('click', fillCurrentTab);
    document.getElementById('refresh-tasks-btn').addEventListener('click', loadTasks);
    document.getElementById('open-selected-btn').addEventListener('click', openAndFill);

    // Toggle UI Listeners
    document.getElementById('tab-filler').addEventListener('click', () => switchTab('filler'));
    document.getElementById('tab-resume').addEventListener('click', () => switchTab('resume'));

    // Resume Booster Listeners
    document.getElementById('scan-jd-btn').addEventListener('click', scanJobDescription);
    document.getElementById('optimize-resume-btn').addEventListener('click', boostResume);
    document.getElementById('download-pdf-btn').addEventListener('click', downloadOptimizedPdf);

    checkServer();
    loadTasks();
    restoreResumeState();
});

function switchTab(tab) {
    const fillerBtn = document.getElementById('tab-filler');
    const resumeBtn = document.getElementById('tab-resume');
    const slider = document.getElementById('toggle-slider');
    const modeFiller = document.getElementById('mode-filler');
    const modeResume = document.getElementById('mode-resume');

    if (tab === 'filler') {
        fillerBtn.classList.add('active');
        resumeBtn.classList.remove('active');
        slider.style.transform = 'translateX(0)';
        modeFiller.style.display = 'block';
        modeResume.style.display = 'none';
    } else {
        resumeBtn.classList.add('active');
        fillerBtn.classList.remove('active');
        slider.style.transform = 'translateX(100%)';
        modeFiller.style.display = 'none';
        modeResume.style.display = 'block';
    }
}

async function checkServer() {
    const label = document.getElementById('server-status');
    const btn = document.getElementById('fill-tab-btn');

    try {
        const res = await fetch(`${FORM_SERVER}/api/form-filler/status`);
        const data = await res.json();
        if (data.status === 'online') {
            label.style.background = '#C6F6D5';
            label.style.color = '#22543D';
            label.textContent = `Online (${data.fields} fields)`;
            serverOnline = true;
            btn.disabled = false;
        }
    } catch {
        label.style.background = '#FED7D7';
        label.style.color = '#822727';
        label.textContent = 'Server offline';
        serverOnline = false;
    }
}

async function loadTasks() {
    const list = document.getElementById('task-list');
    list.innerHTML = '<div class="empty">Loading...</div>';
    selectedTask = null;
    document.getElementById('open-selected-btn').style.display = 'none';

    try {
        const res = await fetch(`${DASHBOARD}/api/manual-tasks`);
        const tasks = await res.json();

        if (!tasks || tasks.length === 0) {
            list.innerHTML = '<div class="empty">No pending manual tasks.</div>';
            return;
        }

        list.innerHTML = '';
        tasks.slice(0, 10).forEach(task => {
            const safeLink = (task.link || '').startsWith('http') ? task.link : 'https://' + task.link;
            let domain = 'Unspecified';
            try { domain = new URL(safeLink).hostname; } catch { }

            const div = document.createElement('div');
            div.className = 'task-item';
            div.innerHTML = `
                <div class="task-domain">🌐 ${domain}</div>
                <div class="task-desc">${(task.description || 'Application').substring(0, 70)}...</div>
            `;
            div.dataset.url = safeLink;

            div.addEventListener('click', () => {
                document.querySelectorAll('.task-item').forEach(d => d.classList.remove('selected'));
                div.classList.add('selected');
                selectedTask = safeLink;
                document.getElementById('open-selected-btn').style.display = 'block';
            });

            list.appendChild(div);
        });
    } catch {
        list.innerHTML = '<div class="empty">Could not reach dashboard (Port 3000).</div>';
    }
}

// ─────────────────────────────────────────────────────────────────
// RESUME BOOSTER LOGIC
// ─────────────────────────────────────────────────────────────────

let currentJdText = "";
let currentKeywords = [];       // every keyword the AI returned
let currentSelectedSet = null;  // Set<string> — the ones the user *wants* used
let optimizedLatex = "";

function restoreResumeState() {
    const state = loadPersisted();
    if (!state) return;

    currentJdText = state.jdText || "";
    currentKeywords = Array.isArray(state.keywords) ? state.keywords : [];
    currentSelectedSet = new Set(Array.isArray(state.selected) ? state.selected : currentKeywords);
    optimizedLatex = state.optimizedLatex || "";

    const status = document.getElementById('jd-status');
    if (currentKeywords.length) {
        renderKeywords(currentKeywords, currentSelectedSet);
        document.getElementById('keyword-section').style.display = 'block';
        if (status) status.textContent = `✅ Restored last scan (${currentKeywords.length} keywords).`;
    }
    if (optimizedLatex) {
        const dl = document.getElementById('download-section');
        if (dl) dl.style.display = 'block';
    }
}

async function scanJobDescription() {
    const status = document.getElementById('jd-status');
    const scanBtn = document.getElementById('scan-jd-btn');

    status.textContent = "🔍 Extracting from page...";
    scanBtn.disabled = true;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'extract_jd' }, async (resp) => {
            if (chrome.runtime.lastError) {
                status.textContent = "❌ Extension updated. Please Refresh the page!";
                scanBtn.disabled = false;
                return;
            }

            if (!resp || !resp.jdText) {
                status.textContent = "❌ Failed to extract JD. Refresh page?";
                scanBtn.disabled = false;
                return;
            }

            currentJdText = resp.jdText;
            status.textContent = "🧠 Analyzing requirements...";

            try {
                const apiResp = await fetch(`${FORM_SERVER}/api/resume/analyze-jd`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    // Send the tab URL so the server can keep this JD as context
                    // for every form field on this page (auto-fill stays consistent).
                    body: JSON.stringify({ jdText: currentJdText, tabUrl: tabs[0].url })
                });
                const { keywords } = await apiResp.json();

                currentKeywords = Array.isArray(keywords) ? keywords : [];
                // NEW: every keyword starts SELECTED — user clicks to *deselect*,
                // not to select. Matches the user's expectation that "the AI
                // already analysed them, it should just use them".
                currentSelectedSet = new Set(currentKeywords);

                renderKeywords(currentKeywords, currentSelectedSet);
                status.textContent = `✅ Scan complete — ${currentKeywords.length} keywords auto-selected (click to deselect).`;
                document.getElementById('keyword-section').style.display = 'block';

                savePersisted({
                    jdText: currentJdText,
                    keywords: currentKeywords,
                    selected: Array.from(currentSelectedSet),
                    optimizedLatex: "",
                });
            } catch (e) {
                status.textContent = "❌ AI analysis failed.";
            } finally {
                scanBtn.disabled = false;
            }
        });
    });
}

function renderKeywords(keywords, selectedSet) {
    const list = document.getElementById('keyword-list');
    list.innerHTML = '';
    keywords.forEach(kw => {
        const span = document.createElement('span');
        span.style.cssText = `padding:4px 10px; border-radius:100px; font-size:10px; cursor:pointer; margin-bottom:4px; border: 1px solid rgba(0,0,0,0.06);`;
        span.textContent = kw;

        const isSelected = selectedSet.has(kw);
        applyPillStyle(span, isSelected);
        if (isSelected) span.classList.add('selected');

        span.onclick = () => {
            if (span.classList.contains('selected')) {
                span.classList.remove('selected');
                applyPillStyle(span, false);
                currentSelectedSet.delete(kw);
            } else {
                span.classList.add('selected');
                applyPillStyle(span, true);
                currentSelectedSet.add(kw);
            }
            savePersisted({ selected: Array.from(currentSelectedSet) });
        };
        list.appendChild(span);
    });
}

function applyPillStyle(span, isSelected) {
    if (isSelected) {
        span.style.background = 'var(--accent)';
        span.style.color = '#fff';
    } else {
        span.style.background = '#E2E8F0';
        span.style.color = 'var(--dark)';
    }
}

async function boostResume() {
    const selectedKws = currentSelectedSet ? Array.from(currentSelectedSet) : [];
    const boostBtn = document.getElementById('optimize-resume-btn');
    const status = document.getElementById('jd-status');

    if (!currentJdText) {
        status.textContent = "❌ Scan a JD first.";
        return;
    }
    if (selectedKws.length === 0) {
        status.textContent = "⚠️ No keywords selected — click at least one before boosting.";
        return;
    }

    status.textContent = `🚀 Optimising for ${selectedKws.length} keyword(s)…`;
    boostBtn.disabled = true;
    boostBtn.textContent = "⚙️ Processing...";

    try {
        // 1. Optimize Content
        const optResp = await fetch(`${FORM_SERVER}/api/resume/optimize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jdText: currentJdText, selectedKeywords: selectedKws })
        });
        const { skills, experience, projects } = await optResp.json();

        // 2. Generate PDF via Tectonic
        status.textContent = "📄 Compiling LaTeX to PDF...";
        const pdfResp = await fetch(`${FORM_SERVER}/api/resume/generate-pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skills, experience, projects })
        });

        if (!pdfResp.ok) throw new Error("Compilation Error");

        const { pdfUrl, latex } = await pdfResp.json();

        optimizedLatex = latex;
        document.getElementById('download-section').style.display = 'block';
        status.textContent = "✨ Resume Boosted!";

        // Copy LaTeX to clipboard
        navigator.clipboard.writeText(optimizedLatex);

        savePersisted({ optimizedLatex });
    } catch (e) {
        status.textContent = "❌ Optimization failed.";
    } finally {
        boostBtn.disabled = false;
        boostBtn.textContent = "✨ Boost My Resume";
    }
}

function downloadOptimizedPdf() {
    const url = `${FORM_SERVER}/optimized_resume.pdf?t=${Date.now()}`;
    chrome.tabs.create({ url: url });
    showStatus('📥 Opening PDF...', 'ok');
}

function fillCurrentTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'manual_fill' }, (r) => {
            if(chrome.runtime.lastError) {
                showStatus("❌ Please refresh the page first", "error");
            } else {
                showStatus("✨ Scanning...", "ok");
            }
        });
    });
}

function openAndFill() {
    if (!selectedTask) return;
    chrome.tabs.create({ url: selectedTask });
    showStatus("🚀 Opening format...", "ok");
}

// Global status line for Form Filler operations. Always writes to the
// always-visible #statusMsg (bottom of popup) — NOT to #jd-status (which
// lives inside #mode-resume and is display:none in Form Filler mode).
// Resume-booster flows write directly to #jd-status themselves.
function showStatus(msg, type) {
    const el = document.getElementById('statusMsg');
    if (!el) return;
    el.className = `status-msg ${type || ''}`.trim();
    el.textContent = msg;
    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => {
        el.textContent = '';
        el.className = 'status-msg';
    }, 3000);
}
