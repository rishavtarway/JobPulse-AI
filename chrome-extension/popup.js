const FORM_SERVER = 'http://127.0.0.1:3001';
const DASHBOARD = 'http://127.0.0.1:3000';

let selectedTask = null;
let serverOnline = false;

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('fill-tab-btn').addEventListener('click', fillCurrentTab);
    document.getElementById('refresh-tasks-btn').addEventListener('click', loadTasks);
    document.getElementById('open-selected-btn').addEventListener('click', openAndFill);
    document.getElementById('openTabsBtn').addEventListener('click', openCustomTabs);

    checkServer();
    loadTasks();
});

async function checkServer() {
    const dot = document.getElementById('server-dot');
    const label = document.getElementById('server-status');
    const btn = document.getElementById('fill-tab-btn');

    try {
        const res = await fetch(`${FORM_SERVER}/api/form-filler/status`);
        const data = await res.json();
        if (data.status === 'online') {
            dot.className = 'status-dot green';
            label.textContent = `AI Mode: Online (${data.fields} fields)`;
            serverOnline = true;
            btn.disabled = false;
        }
    } catch {
        dot.className = 'status-dot red';
        label.textContent = 'Server offline (Port 3001)';
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

function fillCurrentTab() {
    if (!serverOnline) return showStatus('AI Server is offline', 'err');
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) return;
        chrome.tabs.sendMessage(tabs[0].id, { action: 'manual_fill' }, (response) => {
            if (chrome.runtime.lastError) {
                showStatus('Reload the page first!', 'err');
            } else {
                showStatus('✨ Analyzing & Filling...', 'ok');
                setTimeout(() => window.close(), 1000);
            }
        });
    });
}

function openAndFill() {
    if (!selectedTask) return;
    chrome.runtime.sendMessage({ action: 'open_tabs', urls: [selectedTask] }, (response) => {
        if (response && response.status) {
            showStatus(`🚀 Opening: ${selectedTask.substring(0, 30)}...`, 'ok');
            setTimeout(() => window.close(), 1200);
        }
    });
}

function openCustomTabs() {
    const urls = document.getElementById('urlsInput').value.split('\n').map(u => u.trim()).filter(u => u.length > 5);
    if (urls.length === 0) return showStatus('Enter some URLs!', 'err');
    chrome.runtime.sendMessage({ action: 'open_tabs', urls: urls }, () => {
        showStatus(`🚀 Processing ${urls.length} tabs...`, 'ok');
        setTimeout(() => window.close(), 1200);
    });
}

function showStatus(msg, type) {
    const el = document.getElementById('statusMsg');
    el.className = `status-msg ${type}`;
    el.textContent = msg;
    setTimeout(() => { el.textContent = ''; el.className = 'status-msg'; }, 3000);
}
