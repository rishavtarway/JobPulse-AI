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

        // Helper to check if any parent/ancestor has educational context
        let isEduContext = false;
        let p = el.parentElement;
        for(let i=0; i<5 && p; i++) {
            const pCtx = `${p.id} ${p.className} ${p.getAttribute('aria-label') || ''}`.toLowerCase();
            if (pCtx.includes('edu') || pCtx.includes('school') || pCtx.includes('college') || pCtx.includes('university') || pCtx.includes('academic')) {
                isEduContext = true; break;
            }
            p = p.parentElement;
        }

        // Deterministic logic for critical fields
        let value = null;

        // 1. Check for College/University FIRST to avoid 'name' collision
        // Expanded keywords and context checking
        if (has('college', 'university', 'school', 'educational institution', 'institute', 'academic institution') || (isEduContext && has('name'))) {
             value = edu.institution_short || edu.institution;
        } 
        // 2. Personal Identity
        else if (has('first name', 'given name') && !isEduContext) value = R.first_name;
        else if (has('last name', 'family name', 'surname') && !isEduContext) value = R.last_name;
        else if ((has('full name', 'your name') || (has('name') && !has('company', 'employer', 'org', 'current', 'previous'))) && !isEduContext) value = R.name;
        
        // 3. Contact Info
        else if (has('email', 'e-mail')) value = R.email;
        else if (has('phone', 'mobile', 'contact', 'whatsapp', 'tel')) value = R.phone_formatted || R.phone;
        
        // 4. Professional Links
        else if (has('linkedin')) value = R.linkedin;
        else if (has('github')) value = R.github;
        else if (has('portfolio', 'website', 'personal site', 'url')) value = R.portfolio;
        
        // 5. Work preferences / Status
        else if (has('notice', 'available', 'earliest join', 'availability')) value = exactOption('immediately') || bestOption('immediately', '1 month', '30 days') || 'Immediately';
        else if (has('city', 'location', 'address')) value = R.current_city;
        else if (has('degree', 'major', 'graduation')) value = edu.degree;
        else if (has('cgpa', 'gpa', 'grade', 'marks')) value = edu.cgpa;
        else if (has('percentage')) value = R.cgpa_as_percentage || '84.9';
        
        // 6. Demographics
        else if (has('gender')) value = exactOption('male') || bestOption('male') || 'Male';
        else if (has('currently pursuing', 'studying', 'enrolled') && (inputType === 'checkbox' || inputType === 'radio')) value = 'Yes';
        
        // 7. Security / Account
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
        if (isOptionMatch(lbl, value)) {
            el.click();
            return true;
        }
        // If this isn't the right option, find its sibling that is
        const container = el.closest('[role="listitem"], [class*="item"], [class*="question"]');
        if (container) {
            const others = container.querySelectorAll(`[role="${role}"]`);
            for (const o of others) {
                const oLbl = getLabel(o).toLowerCase();
                if (isOptionMatch(oLbl, value)) {
                    o.click();
                    return true;
                }
            }
        }
    }

    if (tag === 'SELECT') {
        const opts = Array.from(el.options);
        const match = opts.find(o => isOptionMatch(o.text, value));
        if (match) { el.value = match.value; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
        return false;
    }

    if (type === 'checkbox' || type === 'radio') {
        const lbl = getLabel(el).toLowerCase();
        if (isOptionMatch(lbl, value)) {
            if (!el.checked) el.click();
            return true;
        }
        // Specific for radios with same name
        const name = el.getAttribute('name');
        if (name) {
            const others = document.querySelectorAll(`input[name="${name}"]`);
            for (const o of others) {
                const oLbl = getLabel(o).toLowerCase();
                if (isOptionMatch(oLbl, value)) {
                    if (!o.checked) o.click();
                    return true;
                }
            }
        }
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
        panel.style.cssText = `position:fixed;bottom:20px;right:20px;width:380px;max-height:80vh;background:#0f172a;color:white;border:1px solid #1e293b;border-radius:12px;z-index:9999999;box-shadow:0 10px 30px rgba(0,0,0,0.5);font-family:sans-serif;display:flex;flex-direction:column;`;
    }

    const rows = summary.map(item => `
        <div style="padding:6px 12px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;font-size:12px">
            <span style="color:#94a3b8">${item.label.substring(0, 20)}</span>
            <span style="font-weight:600">${item.value.substring(0, 30)}</span>
        </div>
    `).join('');

    panel.innerHTML = `
        <div style="padding:10px 12px;background:#1e293b;font-weight:700;font-size:13px;display:flex;justify-content:space-between;flex-shrink:0">
            <span>🚀 Apply Flow: ${summary.length} Fields</span>
            <span id="af-close" style="cursor:pointer">✕</span>
        </div>
        <div style="max-height:200px;overflow-y:auto;flex-shrink:0">${rows}</div>
        <div style="padding:8px 12px;background:#1e293b;font-size:11px;font-weight:700;color:#94a3b8;display:flex;justify-content:space-between;align-items:center;border-top:1px solid #334155;flex-shrink:0">
            <span>📋 Quick-Copy Fields</span>
            <input id="af-chip-search" placeholder="filter…" style="background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:2px 6px;border-radius:4px;font-size:10px;width:90px;outline:none" />
        </div>
        <div id="af-chip-list" style="overflow-y:auto;flex:1;padding:6px;contain:layout style;will-change:scroll-position">
            <div style="text-align:center;padding:14px;font-size:11px;color:#64748b">Loading copy chips…</div>
        </div>
        <div style="padding:10px;text-align:center;flex-shrink:0;border-top:1px solid #1e293b">
            <button id="af-refill" style="background:#3b82f6;color:white;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px">↻ Refill</button>
        </div>
    `;

    document.body.appendChild(panel);
    document.getElementById('af-close').addEventListener('click', () => panel.remove());
    document.getElementById('af-refill').addEventListener('click', () => { hasRunPass = false; panel.remove(); analyzePageAndProceed(); });
    loadCopyChipsIntoPanel();
}

// ─────────────────────────────────────────────────────────────────
// Copy chips inside the bottom auto-fill panel — same data the popup
// shows, but rendered in-page so the user can scroll through it
// without leaving the page they're applying on. Uses event delegation
// (one listener for all chips) and CSS containment to keep scroll
// smooth on long field lists.
// ─────────────────────────────────────────────────────────────────
let _afChipsCache = [];
async function loadCopyChipsIntoPanel() {
    const list = document.getElementById('af-chip-list');
    const search = document.getElementById('af-chip-search');
    if (!list) return;
    try {
        const r = await fetch(`${FORM_SERVER}/api/resume/extract-fields`);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        _afChipsCache = afFlattenFieldDirectory(data);
        afRenderChips(_afChipsCache);
    } catch (e) {
        list.innerHTML = `<div style="text-align:center;padding:14px;font-size:11px;color:#fca5a5">Failed to load fields (${(e && e.message) || e}).<br/>Is form_filler_server.ts running on :3001?</div>`;
        return;
    }
    if (search && !search._wired) {
        search._wired = true;
        let timer = null;
        search.addEventListener('input', () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                const q = (search.value || '').toLowerCase().trim();
                if (!q) { afRenderChips(_afChipsCache); return; }
                afRenderChips(_afChipsCache.filter(c =>
                    c.label.toLowerCase().includes(q) ||
                    c.value.toLowerCase().includes(q) ||
                    c.group.toLowerCase().includes(q)
                ));
            }, 100);
        });
    }
}
function afFlattenFieldDirectory(data) {
    const chips = [];
    if (!data || typeof data !== 'object') return chips;
    for (const groupKey of ['identity', 'education', 'skills_grouped', 'common_questions']) {
        const group = data[groupKey];
        if (!group || typeof group !== 'object') continue;
        const groupLabel = ({identity:'Identity',education:'Education',skills_grouped:'Skills (grouped)',common_questions:'Common Q&A'}[groupKey] || groupKey);
        for (const [k, v] of Object.entries(group)) {
            if (typeof v !== 'string' || !v.trim()) continue;
            chips.push({ group: groupLabel, label: String(k).replace(/_/g, ' ').replace(/\b\w/g, m => m.toUpperCase()), value: v });
        }
    }
    if (Array.isArray(data.skills_flat)) data.skills_flat.forEach(s => { if (typeof s === 'string' && s.trim()) chips.push({ group: 'Skills', label: s, value: s }); });
    if (Array.isArray(data.experience)) {
        data.experience.forEach(exp => {
            const header = `${exp.role || ''} — ${exp.company || ''} (${exp.dates || ''})`.trim();
            if (exp.role || exp.company) chips.push({ group: 'Experience', label: `${exp.company || 'Role'} · header`, value: header });
            if (exp.dates) chips.push({ group: 'Experience', label: `${exp.company || 'Role'} · dates`, value: exp.dates });
            if (exp.location) chips.push({ group: 'Experience', label: `${exp.company || 'Role'} · location`, value: exp.location });
            (exp.bullets || []).forEach((b, i) => chips.push({ group: 'Experience', label: `${exp.company || 'Role'} · bullet ${i + 1}`, value: b }));
        });
    }
    if (Array.isArray(data.projects)) {
        data.projects.forEach(p => {
            const header = `${p.name || ''} — ${p.tech || ''}`.trim();
            if (p.name) chips.push({ group: 'Projects', label: `${p.name} · header`, value: header });
            if (p.tech) chips.push({ group: 'Projects', label: `${p.name} · stack`, value: p.tech });
            if (p.url) chips.push({ group: 'Projects', label: `${p.name} · URL`, value: p.url });
            (p.bullets || []).forEach((b, i) => chips.push({ group: 'Projects', label: `${p.name} · bullet ${i + 1}`, value: b }));
        });
    }
    if (Array.isArray(data.achievements)) data.achievements.forEach((a, i) => { if (typeof a === 'string' && a.trim()) chips.push({ group: 'Achievements', label: `#${i + 1}`, value: a }); });
    return chips;
}
function afRenderChips(chips) {
    const list = document.getElementById('af-chip-list');
    if (!list) return;
    if (!chips.length) { list.innerHTML = '<div style="text-align:center;padding:14px;font-size:11px;color:#64748b">No matching fields.</div>'; return; }
    const byGroup = {};
    chips.forEach(c => { (byGroup[c.group] = byGroup[c.group] || []).push(c); });
    const html = Object.entries(byGroup).map(([groupName, gChips]) => {
        const inner = gChips.map((c, idx) => {
            const valEsc = String(c.value).replace(/"/g, '&quot;').replace(/</g, '&lt;');
            const preview = c.value.length > 70 ? c.value.slice(0, 67) + '…' : c.value;
            const previewEsc = preview.replace(/</g, '&lt;');
            return `<div class="af-chip" data-cfv="${groupName}::${idx}" title="Click to copy · ${valEsc}" style="cursor:pointer;padding:5px 7px;margin:0 0 3px 0;background:#1e293b;border:1px solid #334155;border-radius:5px;font-size:11px;line-height:1.3;color:#e2e8f0;transition:background .15s">
                <div style="font-weight:700;color:#94a3b8;font-size:9px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:1px">${c.label}</div>
                <div style="word-break:break-word">${previewEsc}</div>
            </div>`;
        }).join('');
        return `<div style="margin-bottom:8px"><div style="font-size:10px;font-weight:800;color:#fb923c;text-transform:uppercase;letter-spacing:.05em;margin:4px 0 4px 2px">${groupName}</div>${inner}</div>`;
    }).join('');
    list.innerHTML = html;

    if (list._afChipHandler) list.removeEventListener('click', list._afChipHandler);
    list._afChipHandler = async (ev) => {
        const el = ev.target.closest && ev.target.closest('.af-chip');
        if (!el || !list.contains(el)) return;
        const [groupName, idxStr] = (el.getAttribute('data-cfv') || '').split('::');
        const idx = parseInt(idxStr, 10);
        const value = (byGroup[groupName] || [])[idx]?.value || '';
        try {
            await navigator.clipboard.writeText(value);
            const prev = el.style.background;
            el.style.background = '#166534';
            setTimeout(() => { el.style.background = prev || '#1e293b'; }, 500);
        } catch {}
    };
    list.addEventListener('click', list._afChipHandler);
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
    const container = el.closest('[role="listitem"], [class*="item"], fieldset, [class*="question"], [data-automation-id="questionItem"], .office-form-question, .Qr7Oae');
    if (container) {
        const heading = container.querySelector('[role="heading"], [class*="title"], [class*="label"], strong, b, span.text-format-content, [data-automation-id="questionTitle"], .M7e69c');
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

function isOptionMatch(label, value) {
    const l = label.toLowerCase().trim();
    const v = value.toLowerCase().trim();
    if (l === v || l.includes(v) || v.includes(l)) return true;

    // Fuzzy boolean matches
    if (v === 'yes' || v === 'true') {
        const positives = ['yes', 'yep', 'true', 'agree', 'i ', 'correct'];
        return positives.some(p => l === p || l.startsWith(p));
    }
    if (v === 'no' || v === 'false') {
        const negatives = ['no', 'nope', 'false', 'disagree', 'incorrect'];
        return negatives.some(n => l === n || l.startsWith(n));
    }
    return false;
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

// Auto-run has been disabled. The extension now waits for manual triggers from the popup.
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'manual_fill') {
        hasRunPass = false;
        analyzePageAndProceed();
        sendResponse({ status: 'started' });
    }
    
    if (req.action === 'extract_jd') {
        // Extraction logic for modern ATS
        const containers = [
            '.job-description', '#job-description', '[class*="description"]', 
            '.posting-description', '.job-detail', '.description__text', 
            '.jd-description', '[id*="jobDesc"]', '.jobs-description-content',
            '[class*="JobDescription"]', 'article', 'main'
        ];
        
        let jdText = "";
        for (const sel of containers) {
            const el = document.querySelector(sel);
            if (el && el.innerText.length > 300) {
                jdText = el.innerText;
                break;
            }
        }
        
        // Fallback: Use longest body text if no container found
        if (!jdText) jdText = document.body.innerText.substring(0, 10000);
        
        sendResponse({ jdText: jdText.substring(0, 15000) });
    }
});
