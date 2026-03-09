/**
 * Super Advanced Auto-Filler Content Script
 * (c) 2026 Rishav Tarway | Google Gemini AI Powered
 */

const FORM_SERVER = 'http://127.0.0.1:3001';
const AF_ATTR = 'af-filled';
const CTA_PATTERNS = [
    'apply', 'apply now', 'register', 'apply on company site', 'express interest',
    'submit application', 'continue to apply', 'next', 'proceed', 'save and continue',
    'start your application', 'submit'
];
const CTA_BLOCKLIST = ['search', 'find', 'sign in', 'login', 'jobs', 'back to'];

let resumeCache = null;
let hasRunPass = false;
let fillSummary = [];

// ─────────────────────────────────────────────────────────────────
// PAGE ANALYSIS LOOP
// ─────────────────────────────────────────────────────────────────
async function analyzePageAndProceed() {
    if (hasRunPass) return;
    hasRunPass = true;

    // 1. Gather page context — include ARIA roles for complex forms like Google Forms and Microsoft Forms
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="file"]), textarea, select, [role="radio"], [role="checkbox"], [role="textbox"], [contenteditable="true"]'));
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const visibleInputs = inputs.filter(isVisible);

    // Filter out nav/search to determine if it's a REAL form
    const formInputs = visibleInputs.filter(el => {
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const nm = (el.name || '').toLowerCase();
        const id = (el.id || '').toLowerCase();
        const isSearch = ph.includes('search') || nm.includes('search') || id.includes('search') || ph.includes('find') || nm.includes('q');
        const inNav = el.closest('nav, header, [class*="nav"], [class*="header"], [class*="search-form"]');
        return !isSearch && !inNav;
    });

    const isObviousForm = fileInputs.length >= 1 || formInputs.length >= 2;

    if (isObviousForm) {
        console.log(`📝 Obvious form: ${formInputs.length} inputs. Procedding...`);
        return proceedAsForm(inputs, fileInputs);
    }

    // 2. Ambiguous page -> AI Analysis
    showStatusBadge('🧠 AI analyzing page structure...');
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"], input[type="submit"]'))
        .filter(isVisible)
        .map(b => ({ text: (b.textContent || b.value || '').trim() }))
        .filter(b => b.text.length > 2 && b.text.length < 50);

    const firstVisibleInput = formInputs[0];
    const inputsInfo = formInputs.map(el => (getLabel(el) || el.placeholder || el.name)).slice(0, 5).join(', ');

    try {
        const res = await fetch(`${FORM_SERVER}/api/form-filler/analyze-page`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pageText: document.body.innerText.substring(0, 4000),
                buttons: buttons.map(b => b.text),
                tabUrl: location.href,
                inputsFound: formInputs.length,
                topInputs: inputsInfo
            })
        });
        const data = await res.json();
        const action = data.action;

        if (action === 'IS_FORM') {
            return proceedAsForm(inputs, fileInputs);
        }

        if (action === 'SIGN_UP') {
            showStatusBadge('🔐 Account Setup detected...');
            // Proceed to fill default credentials automatically
            return proceedAsForm(inputs, fileInputs);
        }

        if (action !== 'UNKNOWN' && action.length > 1) {
            const clicked = clickButtonWithText(action);
            if (clicked) { hasRunPass = false; return; }
        }
    } catch (e) { console.warn('AI skip:', e.message); }

    // 3. Fallback to basic CTA
    const ctaClicked = tryClickCTA();
    if (!ctaClicked) {
        console.log('🤷 Page analysis inconclusive. No form or CTA found.');
    } else {
        hasRunPass = false;
    }
}

async function proceedAsForm(inputs, fileInputs) {
    if (fileInputs.length > 0) {
        for (const fi of fileInputs) {
            const label = (getLabel(fi) || '').toLowerCase();
            const nm = (fi.name || '').toLowerCase();
            const ctx = `${label} ${nm}`.toLowerCase();

            // If it's the only file input, OR it mentions resume/cv/cv/upload/attachment
            if (fileInputs.length === 1 || ctx.includes('resume') || ctx.includes('cv') || ctx.includes('upload') || ctx.includes('file')) {
                showStatusBadge(`📄 Uploading Resume to ${label || 'field'}...`);
                await uploadResumeToInput(fi);
                await sleep(1000);
            }
        }
    }
    await performDeterministicFill(inputs);
    showReviewPanel(fillSummary);
}

// ─────────────────────────────────────────────────────────────────
// FORM FILLER ENGINE
// ─────────────────────────────────────────────────────────────────
async function performDeterministicFill(inputs) {
    if (!resumeCache) {
        const res = await fetch(`${FORM_SERVER}/api/form-filler/cache`);
        resumeCache = await res.json();
    }
    const R = resumeCache;
    const avail = R.availability || {};
    const latestJob = (R.experience && R.experience[0]) || {};
    const edu = R.education || {};
    const unmapped = [];

    for (const el of inputs) {
        if (el.getAttribute(AF_ATTR)) continue;
        const inputName = (el.name || '').toLowerCase();
        const inputId = (el.id || '').toLowerCase();
        const ph = (el.getAttribute('placeholder') || '').toLowerCase();
        const label = (getLabel(el) || '').toLowerCase();
        const ctx = `${inputName} ${inputId} ${ph} ${label}`.toLowerCase();
        const inputType = (el.getAttribute('type') || el.tagName).toLowerCase();
        const options = getOptions(el, inputType, inputName);

        const has = (...terms) => terms.some(t => ctx.includes(t.toLowerCase()));
        const bestOption = (...keys) => options.find(o => keys.some(k => o.toLowerCase().includes(k.toLowerCase())));
        const exactOption = (val) => options.find(o => o.toLowerCase().trim() === val.toLowerCase().trim());

        // Fill logic based on mappings
        let value = null;

        if (has('first name', 'given name')) value = R.first_name;
        else if (has('last name', 'family name')) value = R.last_name;
        else if (has('full name', 'your name') || (has('name') && !has('company', 'employer'))) value = R.name;
        else if (has('email', 'e-mail')) value = R.email;
        else if (has('phone', 'mobile', 'contact', 'whatsapp')) value = R.phone_formatted || R.phone;
        else if (has('notice', 'available', 'earliest join')) value = exactOption('immediately') || bestOption('immediately', '1 month', '30 days') || 'Immediately';
        else if (has('linkedin')) value = R.linkedin;
        else if (has('github')) value = R.github;
        else if (has('portfolio', 'website')) value = R.portfolio;
        else if (has('city', 'location')) value = R.current_city;
        else if (has('college', 'university', 'school')) value = edu.institution_short || edu.institution;
        else if (has('degree')) value = edu.degree;
        else if (has('cgpa', 'gpa', 'grade')) value = edu.cgpa;
        else if (has('percentage')) value = R.cgpa_as_percentage || '84.9';
        else if (has('gender')) value = exactOption('male') || bestOption('male') || 'Male';
        else if (has('currently pursuing', 'studying') && inputType === 'checkbox') value = 'true';
        else if (has('pass', 'retype') && inputType === 'password') value = R.default_app_password;

        if (value) {
            const filled = await fillElement(el, String(value));
            if (filled) {
                stamp(el, value, 'det');
                fillSummary.push({ label: label || inputName, value, type: 'det' });
            }
        } else if (!has('search')) {
            unmapped.push({ id: el.id || (el.id = 'af-' + Math.random().toString(36).substring(7)), label: label || ph || inputName || 'Field', type: inputType, context: ctx.substring(0, 300), options });
        }
    }

    // AI Fallback for unmapped
    if (unmapped.length > 0) {
        showStatusBadge(`🧠 AI filling ${unmapped.length} tricky items...`);
        chrome.runtime.sendMessage({ action: 'fetch_llm_answers', fields: unmapped, tabUrl: location.href }, (resp) => {
            if (resp?.results) {
                resp.results.forEach(r => {
                    const el = document.getElementById(r.id);
                    if (el && r.answer && r.answer !== 'UNKNOWN_DATA') {
                        fillElement(el, r.answer).then(filled => {
                            if (filled) {
                                stamp(el, r.answer, 'llm');
                                fillSummary.push({ label: unmapped.find(f => f.id === r.id)?.label || r.id, value: r.answer, type: 'llm' });
                                showReviewPanel(fillSummary);
                            }
                        });
                    }
                });
            }
        });
    }
}

// ─────────────────────────────────────────────────────────────────
// ELEMENT FILLING (React/Sense ATS Optimized)
// ─────────────────────────────────────────────────────────────────
async function fillElement(el, value) {
    const tag = el.tagName.toUpperCase();
    const role = el.getAttribute('role');
    const type = (el.getAttribute('type') || tag || role || '').toLowerCase();

    el.focus();
    el.click();

    // 1. ARIA Radio/Checkbox (Common in Google Forms)
    if (role === 'radio' || role === 'checkbox') {
        const lbl = getLabel(el).toLowerCase();
        if (lbl === value.toLowerCase() || value.toLowerCase().includes(lbl) || lbl.includes(value.toLowerCase())) {
            el.click();
            return true;
        }
        // If this isn't the right option, find its sibling that is
        const container = el.closest('[role="listitem"], [class*="item"], [class*="question"]');
        if (container) {
            const others = container.querySelectorAll(`[role="${role}"]`);
            for (const o of others) {
                const oLbl = getLabel(o).toLowerCase();
                if (oLbl === value.toLowerCase() || value.toLowerCase().includes(oLbl) || oLbl.includes(value.toLowerCase())) {
                    o.click();
                    return true;
                }
            }
        }
    }

    if (tag === 'SELECT') {
        const opts = Array.from(el.options);
        const match = opts.find(o => o.text.trim().toLowerCase() === value.toLowerCase().trim()) ||
            opts.find(o => o.text.toLowerCase().includes(value.toLowerCase()));
        if (match) { el.value = match.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        return false;
    }

    if (type === 'checkbox' || type === 'radio') {
        const lbl = getLabel(el).toLowerCase();
        if (lbl === value.toLowerCase() || value.toLowerCase().includes(lbl)) {
            if (!el.checked) el.click();
            return true;
        }
        // Specific for radios with same name
        const name = el.getAttribute('name');
        if (name) {
            const others = document.querySelectorAll(`input[name="${name}"]`);
            for (const o of others) {
                const oLbl = getLabel(o).toLowerCase();
                if (oLbl === value.toLowerCase() || value.toLowerCase().includes(oLbl)) {
                    if (!o.checked) o.click();
                    return true;
                }
            }
        }
        return true;
    }

    // Default input filling
    const nativeSetter = Object.getOwnPropertyDescriptor(tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else if ('value' in el) el.value = value;
    else if (el.isContentEditable) el.innerText = value; // Support for contenteditable (e.g., MS forms)

    ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));

    if (el.value === '' && !el.isContentEditable) {
        el.click();
        await sleep(200);
        document.execCommand('insertText', false, value);
    }

    return true;
}

async function uploadResumeToInput(fileInput) {
    try {
        const res = await fetch(`${FORM_SERVER}/api/form-filler/resume`);
        const blob = await res.blob();
        const file = new File([blob], 'RishavTarway-Resume.pdf', { type: 'application/pdf' });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        // Some sites verify .value
        console.log('📄 Resume injected:', fileInput.files[0].name);
        return true;
    } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
// UI / REVIEW PANEL (CSP CLEAN)
// ─────────────────────────────────────────────────────────────────
function showReviewPanel(summary) {
    let panel = document.getElementById('af-review-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'af-review-panel';
        panel.style.cssText = `position:fixed;bottom:20px;right:20px;width:340px;background:#0f172a;color:white;border:1px solid #1e293b;border-radius:12px;z-index:9999999;box-shadow:0 10px 30px rgba(0,0,0,0.5);font-family:sans-serif;`;
    }

    const rows = summary.map(item => `
        <div style="padding:6px 12px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;font-size:12px">
            <span style="color:#94a3b8">${item.label.substring(0, 20)}</span>
            <span style="font-weight:600">${item.value.substring(0, 30)}</span>
        </div>
    `).join('');

    panel.innerHTML = `
        <div style="padding:10px 12px;background:#1e293b;font-weight:700;font-size:13px;display:flex;justify-content:space-between">
            <span>🚀 Apply Flow: ${summary.length} Fields</span>
            <span id="af-close" style="cursor:pointer">✕</span>
        </div>
        <div style="max-height:240px;overflow-y:auto">${rows}</div>
        <div style="padding:10px;text-align:center">
            <button id="af-refill" style="background:#3b82f6;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px">↻ Refill</button>
        </div>
    `;

    document.body.appendChild(panel);
    document.getElementById('af-close').addEventListener('click', () => panel.remove());
    document.getElementById('af-refill').addEventListener('click', () => { hasRunPass = false; panel.remove(); analyzePageAndProceed(); });
}

// ─────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────
function clickButtonWithText(text) {
    const btn = Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
        const val = (el.textContent || el.value || '').trim().toLowerCase();
        return isVisible(el) && (val === text.toLowerCase() || val.includes(text.toLowerCase()));
    });
    if (btn) {
        btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => { btn.click(); btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); }, 500);
        return true;
    }
    return false;
}

function tryClickCTA() {
    for (const pattern of CTA_PATTERNS) {
        const btns = Array.from(document.querySelectorAll('button, a, input[type="submit"]')).filter(isVisible);
        const match = btns.find(btn => (btn.textContent || btn.value || '').toLowerCase().includes(pattern));
        if (match) {
            match.click();
            return true;
        }
    }
    return false;
}

function getLabel(el) {
    const id = el.id;
    // 1. Standard label[for]
    if (id) {
        const lbl = document.querySelector(`label[for="${id}"]`);
        if (lbl) return lbl.textContent.trim();
    }
    // 2. Parent label
    const parentLbl = el.closest('label');
    if (parentLbl) return parentLbl.textContent.trim();

    // 3. ARIA label
    const al = el.getAttribute('aria-label');
    if (al) return al.trim();

    // 4. ARIA labelledby
    const ab = el.getAttribute('aria-labelledby');
    if (ab) {
        const lbl = document.getElementById(ab);
        if (lbl) return lbl.textContent.trim();
    }

    // 5. Parent container heading (Common in Google Forms / complex React apps / Microsoft Forms)
    const container = el.closest('[role="listitem"], [class*="item"], fieldset, [class*="question"], [data-automation-id="questionItem"], .office-form-question');
    if (container) {
        const heading = container.querySelector('[role="heading"], [class*="title"], [class*="label"], strong, b, span.text-format-content, [data-automation-id="questionTitle"]');
        if (heading) return heading.textContent.trim();
    }

    // 6. Closest previous text
    const nearby = el.previousElementSibling;
    if (nearby && (nearby.tagName === 'LABEL' || nearby.tagName === 'SPAN' || nearby.tagName === 'DIV')) return nearby.textContent.trim();

    // 7. General up-tree search for common MS Forms / React wrappers
    let walk = el.parentElement;
    let fallbackText = '';
    let steps = 0;
    while (walk && walk !== document.body && steps < 5) {
        let maybeHeading = walk.querySelector('[class*="question-title"], [class*="QuestionTitle"], [class*="questionText"], span.text-format-content');
        if (maybeHeading && !maybeHeading.contains(el)) {
            fallbackText = maybeHeading.textContent.trim();
            break;
        }
        walk = walk.parentElement;
        steps++;
    }
    if (fallbackText) return fallbackText;

    return '';
}

function getOptions(el, type, name) {
    if (el.tagName === 'SELECT') return Array.from(el.options).map(o => o.text.trim());

    // Check by container (Useful for radios/checkboxes in frameworks)
    const container = el.closest('[role="listitem"], [role="group"], [class*="item"], [class*="question"]');
    if (container) {
        // Standard inputs
        const inputs = Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
        if (inputs.length > 0) return inputs.map(i => getLabel(i).trim());
        // ARIA roles
        const aria = Array.from(container.querySelectorAll('[role="radio"], [role="checkbox"]'));
        if (aria.length > 0) return aria.map(a => getLabel(a).trim());
    }

    if (type === 'radio' && name) return Array.from(document.querySelectorAll(`input[name="${name}"]`)).map(r => getLabel(r).trim());
    return [];
}

function isVisible(el) {
    const s = window.getComputedStyle(el);
    // Relaxed for form inputs: permit opacity: 0 since many libraries mask them
    return s.display !== 'none' && s.visibility !== 'hidden';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stamp(el, val, type) {
    el.setAttribute(AF_ATTR, type);
    el.style.border = `2px solid ${type === 'det' ? '#10b981' : '#3b82f6'}`;
}

function showStatusBadge(msg) {
    let b = document.getElementById('af-status');
    if (!b) {
        b = document.createElement('div');
        b.id = 'af-status';
        b.style.cssText = `position:fixed;top:10px;left:50%;transform:translateX(-50%);background:black;color:white;padding:8px 16px;z-index:999999;border-radius:20px;font-size:12px;`;
        document.body.appendChild(b);
    }
    b.textContent = msg;
    setTimeout(() => b.remove(), 4000);
}

// Auto-run on load
if (document.readyState === 'complete') analyzePageAndProceed();
else window.addEventListener('load', analyzePageAndProceed);

// Listen for manual trigger
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'manual_fill') {
        hasRunPass = false;
        analyzePageAndProceed();
        sendResponse({ status: 'started' });
    }
});
