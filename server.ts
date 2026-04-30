import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import os from 'os';
import dns from 'node:dns';

// Force IPv4-first DNS resolution to fix ENOTFOUND issues in Node.js 17+
if (typeof dns.setDefaultResultOrder === 'function') {
    dns.setDefaultResultOrder('ipv4first');
}

// Global error handlers to catch and log hidden crashes
process.on('uncaughtException', (err) => {
    console.error('\n🔥 CRITICAL UNCAUGHT EXCEPTION:');
    console.error(err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n⚠️ UNHANDLED PROMISE REJECTION:');
    console.error('Promise:', promise);
    console.error('Reason:', reason);
});

// Helper to get local IP address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'IP_NOT_FOUND';
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

let isRunning = false;
let isFollowUpRunning = false;
let currentLogs: string[] = [];
let pendingOtpResolve: ((code: string) => void) | null = null;
let pendingPasswordResolve: ((pw: string) => void) | null = null;
let otpRequired = false;
let passwordRequired = false;

// Helper to safely read a file
function safeReadFile(filename: string) {
    const filePath = path.join(process.cwd(), filename);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
    }
    return '';
}

function flexibleParseDate(dateStr: string): number {
    if (!dateStr) return 0;
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.getTime();

    // Handle "25/03/2026, 11:51:14 am" (D/M/YYYY)
    const match = dateStr.match(/(\d+)\/(\d+)\/(\d+)(?:,?\s+(.*))?/);
    if (match) {
        let day = parseInt(match[1]);
        let month = parseInt(match[2]) - 1;
        let year = parseInt(match[3]);
        let timePart = match[4];
        
        let h = 0, m = 0, s = 0;
        if (timePart) {
            // Check for am/pm or a.m./p.m.
            const ampmMatch = timePart.match(/([ap])\.?m\.?/i);
            const isPM = ampmMatch && ampmMatch[1].toLowerCase() === 'p';
            
            const hmsMatch = timePart.match(/(\d+):(\d+)(?::(\d+))?/);
            if (hmsMatch) {
                h = parseInt(hmsMatch[1]);
                m = parseInt(hmsMatch[2]);
                s = parseInt(hmsMatch[3] || '0');
                if (isPM && h < 12) h += 12;
                if (!isPM && h === 12) h = 0;
            }
        }
        return new Date(year, month, day, h, m, s).getTime();
    }
    return 0;
}

// ============================================================
// API: Manual Task List
// ============================================================
app.get('/api/manual-tasks', (req, res) => {
    const content = safeReadFile('MANUAL_APPLY_TASKS.md');
    const tasks: any[] = [];
    const blocks = content.split('### Job ID:');

    blocks.forEach(block => {
        if (block.trim() === '') return;

        const lines = block.trim().split('\n');
        const headerMatch = lines[0].match(/(\d+) \(Posted: (.*?)\)/);
        if (!headerMatch) return;

        const id = headerMatch[1];
        const date = headerMatch[2];

        let link = "";
        let description = "";
        const blockText = lines.slice(1).join('\n');

        // Strategy 1: Markdown link inside **Apply Here:** line → [text](url)
        const applyLineMatch = blockText.match(/\*\*Apply Here:\*\*[^\n]*\(([^)]+)\)/);
        if (applyLineMatch) link = applyLineMatch[1];

        // Strategy 2: Raw URL on the Apply Here line
        if (!link) {
            const rawUrlMatch = blockText.match(/\*\*Apply Here:\*\*\s*(https?:\/\/\S+)/);
            if (rawUrlMatch) link = rawUrlMatch[1].replace(/[)\].,]+$/, '');
        }

        // Strategy 3: Any markdown link in the block [text](url)
        if (!link) {
            const anyLinkMatch = blockText.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
            if (anyLinkMatch) link = anyLinkMatch[1];
        }

        // Strategy 4: Any bare http URL in the block
        if (!link) {
            const bareUrlMatch = blockText.match(/(https?:\/\/[^\s)\]]+)/);
            if (bareUrlMatch) link = bareUrlMatch[1].replace(/[)\].,]+$/, '');
        }

        // Description: collect blockquote lines (>), or fallback to any content lines
        const descLines = lines.filter(l => l.startsWith('>'));
        if (descLines.length > 0) {
            description = descLines.map(l => l.replace(/^>\s*/, '')).join('\n');
        } else {
            description = lines.slice(1)
                .filter(l => l.trim() && !l.startsWith('**') && l !== '---' && !l.startsWith('#'))
                .join('\n');
        }

        tasks.push({ id, date, link, description: description.trim() });
    });

    tasks.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
    res.json(tasks);
});

// ============================================================
// API: History
// ============================================================
app.get('/api/history', (req, res) => {
    const content = safeReadFile('all_extracted_jobs_log.txt');
    const lines = content.split('\n').filter(l => l.trim() !== '');
    res.json(lines.slice(-50).reverse());
});

// ============================================================
// API: Job Application Tracker
// ============================================================
const APPS_FILE = path.join(process.cwd(), 'applications.json');

function readApps() {
    try {
        if (fs.existsSync(APPS_FILE)) {
            return JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error reading applications.json:', e);
    }
    return [];
}

function writeApps(apps: any[]) {
    fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
}

// ============================================================
// API: Manual Job List (Filtered from Tracker)
// ============================================================
app.get('/api/manual-jobs', (req, res) => {
    // 1. Get from applications.json
    const apps = readApps();
    const jsonManual = apps.filter((a: any) => a.status === 'to_apply' || a.status === 'manual_review');

    // 2. Also parse from MANUAL_APPLY_TASKS.md (Legacy + Backups)
    const content = safeReadFile('MANUAL_APPLY_TASKS.md');
    const legacyTasks: any[] = [];
    
    // Split by sections first to find the date/batch info
    // Using lookahead so we keep the header in the resulting chunk for date extraction
    const sections = content.split(/(?=##.*Manual\s+Applications)/i);
    
    sections.forEach(section => {
        if (!section.trim()) return;
        
        const firstLine = section.split('\n')[0];
        const dateMatchHeader = firstLine.match(/\((.*?)\)/);
        const batchDate = dateMatchHeader ? dateMatchHeader[1] : null;
        
        const blocks = section.split('###');
        blocks.forEach((block, index) => {
            if (!block.trim() || block.startsWith(' Manual')) return;
            const lines = block.trim().split('\n');

            const headerMatch = lines[0].match(/(?:\[(.*?)\]\s*)?Job\s*ID:\s*(\d+)/i) || lines[0].match(/Job\s*ID:\s*(\d+)/i);
            if (!headerMatch) return;

            let channel = 'Telegram Group';
            let telegramId = '';

            if (headerMatch.length === 3 && headerMatch[1]) {
                channel = headerMatch[1];
                telegramId = headerMatch[2];
            } else {
                telegramId = headerMatch[1] || headerMatch[2];
            }

            // Fallback to batch date if channel is generic
            if (channel === 'Telegram Group' && batchDate) {
                channel = `Discovery: ${new Date(batchDate).toLocaleDateString()}`;
            }

            const dateMatch = block.match(/Posted:\s*(.*?)\)/) || block.match(/Need\s*\((.*?)\)/);

            let actualPostingVal = 0;
            if (dateMatch) {
                actualPostingVal = flexibleParseDate(dateMatch[1]);
            }

            let appliedDateVal = actualPostingVal > 0 ? actualPostingVal : 0;
            if (appliedDateVal <= 0 && batchDate) {
                const parsedBatch = flexibleParseDate(batchDate);
                if (parsedBatch > 0) appliedDateVal = parsedBatch;
            }
            
            if (appliedDateVal <= 0) appliedDateVal = Date.now();

            let postedDateStr = dateMatch ? dateMatch[1] : "";
            const dateStr = new Date(appliedDateVal).toISOString();
            const dateVal = appliedDateVal; // Ensure _timestamp matches

            // Extract Link
            let link = "";
            const linkMatch = block.match(/\*\*Apply Here:\*\*[^\n]*\(([^)]+)\)/i) || 
                            block.match(/\*\*Apply Here:\*\*\s*(https?:\/\/\S+)/i) ||
                            block.match(/(https?:\/\/\S+)/i);
            if (linkMatch) link = linkMatch[1].replace(/[)\].,]+$/, '');

            if (!link) return;

            // Extract Description
            const descMatch = block.match(/\*\*Description:\*\*([\s\S]*)/i);
            let description = descMatch ? descMatch[1].replace(/^>\s*/gm, '').trim() : '';
            if (description.includes('---')) description = description.split('---')[0].trim();

            legacyTasks.push({
                id: 'legacy-' + telegramId + '-' + Math.random().toString(36).substr(2, 9),
                telegramId,
                channel,
                company: 'Direct Portal',
                role: 'Manual Application',
                link,
                description,
                appliedDate: dateStr,
                _timestamp: dateVal, 
                status: 'to_apply',
                type: 'manual',
                notes: postedDateStr ? `Posted: ${postedDateStr}` : ""
            });
        });
    });

    // Merge and Deduplicate by Link (Check against ALL apps to avoid reapplying)
    const combined = [...jsonManual];
    const allSeenLinks = new Set(apps.map((a: any) => a.link).filter(Boolean));

    legacyTasks.reverse().forEach(task => {
        if (!allSeenLinks.has(task.link)) {
            // Stronger internship detection
            const isIntern = task.description.toLowerCase().includes('intern') || 
                            task.channel.toLowerCase().includes('intern');
            
            if (isIntern) {
                task.role = 'Internship Opportunity';
                task.company = task.company !== 'Direct Portal' ? task.company : 'Direct Internship';
            } else {
                task.role = 'Manual Application';
            }
            combined.push(task);
            allSeenLinks.add(task.link);
        }
    });

    combined.sort((a: any, b: any) => {
        const timeA = a._timestamp || (a.appliedDate ? new Date(a.appliedDate).getTime() : 0);
        const timeB = b._timestamp || (b.appliedDate ? new Date(b.appliedDate).getTime() : 0);
        return timeB - timeA;
    });

    console.log(`[ManualJobs] Final combined: ${combined.length}`);
    res.json(combined);
});

app.get('/api/applications', (req, res) => {
    res.json(readApps());
});

app.post('/api/applications', (req, res) => {
    const { 
        company, role, email, link, description, 
        jobDescription,
        status = 'applied', telegramId, channel, 
        type = 'telegram', appliedDate, _timestamp 
    } = req.body;
    if (!company) return res.status(400).json({ error: 'Company is required' });

    const apps = readApps();
    const newApp = {
        id: Date.now().toString(),
        telegramId: telegramId || null,
        channel: channel || null,
        company,
        role: role || 'Software Engineer',
        email: email || '',
        link: link || '',
        description: description || '',
        jobDescription: jobDescription || '',
        appliedDate: appliedDate || new Date().toISOString(),
        postedDate: req.body.postedDate || null,
        _timestamp: _timestamp || Date.now(),
        status, 
        type, 
        notes: ''
    };

    apps.push(newApp);
    writeApps(apps);
    res.json(newApp);
});

app.patch('/api/applications/:id', (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    const apps = readApps();
    const idx = apps.findIndex((a: any) => a.id === id);

    if (idx === -1) return res.status(404).json({ error: 'Application not found' });

    apps[idx] = { ...apps[idx], ...updates };
    writeApps(apps);
    res.json(apps[idx]);
});

app.delete('/api/applications/:id', (req, res) => {
    const { id } = req.params;
    let apps = readApps();
    apps = apps.filter((a: any) => a.id !== id);
    writeApps(apps);
    res.json({ success: true });
});

// ============================================================
// API: Trigger Script
// ============================================================
let currentChildProcess: any = null;

app.post('/api/stop', (req, res) => {
    if (currentChildProcess) {
        // Kill process group if possible
        if (process.platform !== 'win32') {
            try {
                // Kill processes named 'auto_apply.ts'
                execSync('pkill -f "auto_apply.ts"');
                // Kill processes holding a lock on td.binlog
                execSync('lsof -t /Users/tarway/Documents/JobPulse-AI/session/td.binlog | xargs kill -9');
            } catch (e) {
                console.error('Error during pkill/lsof cleanup:', e);
            }
        }
        currentChildProcess.kill('SIGINT'); // Try nice kill first
        setTimeout(() => {
            if (currentChildProcess) { // Check if it's still running after SIGINT
                currentChildProcess.kill('SIGKILL');
            }
            // Clean up state regardless of how it was killed
            isRunning = false;
            otpRequired = false;
            passwordRequired = false;
            pendingOtpResolve = null;
            pendingPasswordResolve = null;
            currentChildProcess = null;
            currentLogs.push('\n🛑 Process TERMINATED by user.\n');
        }, 2000); // Give it 2 seconds to respond to SIGINT
        res.json({ success: true, message: 'Process termination command broadcasted.' });
    } else {
        res.status(400).json({ error: 'No process is running' });
    }
});

app.post('/api/trigger', async (req, res) => {
    if (isRunning) {
        return res.json({ success: false, message: 'Process already in flight.' });
    }

    // 🛡️ Lock-file Protection: Forcefully clear any lingering discovery processes
    try {
        console.log('🧹 Cleaning up stale discovery instances and session locks...');
        // Kill by process name/pattern to catch orphaned node/tsx instances
        if (process.platform === 'darwin' || process.platform === 'linux') {
            try { execSync('pkill -f "auto_apply.ts"'); } catch (e) { } 
            // Also try to unlock the file specifically
            try { execSync('lsof -t /Users/tarway/Documents/JobPulse-AI/session/td.binlog | xargs kill -9'); } catch (e) { }
        }
    } catch (e) {
        console.error('⚠️ Cleanup error:', e);
    }

    isRunning = true;
    currentLogs = [`🚀 Discovery Agent Initiated internally at ${new Date().toLocaleString()}\n`];
    otpRequired = false;
    passwordRequired = false;
    pendingOtpResolve = null;
    pendingPasswordResolve = null;

    currentChildProcess = spawn('npx', ['tsx', 'auto_apply.ts'], {
        cwd: process.cwd(),
        env: { ...process.env, BROWSER_MODE: '1', SERVER_PORT: String(PORT) },
        shell: true
    });

    // Use line-buffering for cleaner output
    let stdoutBuffer = '';
    currentChildProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        // Flush lines
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        lines.forEach(line => {
            if (line) currentLogs.push(line + '\n');
        });
    });

    currentChildProcess.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        // Show ALL stderr — TDLib can be chatty but it helps debug hangs
        currentLogs.push(text);
    });

    currentChildProcess.on('close', (code: number | null) => {
        if (stdoutBuffer) currentLogs.push(stdoutBuffer + '\n');
        currentLogs.push(`\n✅ Process finished with exit code ${code}\n`);
        isRunning = false;
        otpRequired = false;
        passwordRequired = false;
        pendingOtpResolve = null;
        pendingPasswordResolve = null;
        currentChildProcess = null;
    });

    currentChildProcess.on('error', (err: Error) => {
        currentLogs.push(`\n❌ Failed to start process: ${err.message}\n`);
        isRunning = false;
        currentChildProcess = null;
    });

    res.json({ message: 'Process started' });
});

app.post('/api/trigger-yc', (req, res) => {
    if (isRunning) return res.status(400).json({ error: 'A process is already running' });
    if (!req.body.text) return res.status(400).json({ error: 'Text input is required' });

    isRunning = true;
    currentLogs = [];
    currentLogs.push('🚀 Starting Premium YC Cold Outreach process...\n');

    const tempFile = path.resolve(process.cwd(), 'temp_startups.txt');
    fs.writeFileSync(tempFile, req.body.text, 'utf8');

    currentChildProcess = spawn('npx', ['tsx', 'yc_cold_email.ts', tempFile], {
        env: { ...process.env, SERVER_PORT: String(PORT) },
        cwd: process.cwd()
    });

    let stdoutBuffer = '';
    currentChildProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        lines.forEach(line => { if (line) currentLogs.push(line + '\n'); });
    });

    currentChildProcess.stderr?.on('data', (data: Buffer) => {
        currentLogs.push(data.toString());
    });

    currentChildProcess.on('close', (code: number | null) => {
        if (stdoutBuffer) currentLogs.push(stdoutBuffer + '\n');
        currentLogs.push(`\n✅ YC Process finished with exit code ${code}\n`);
        try { fs.unlinkSync(tempFile); } catch (e) { } // Clean up
        isRunning = false;
        currentChildProcess = null;
    });

    currentChildProcess.on('error', (err: Error) => {
        currentLogs.push(`\n❌ Failed to start YC process: ${err.message}\n`);
        isRunning = false;
        currentChildProcess = null;
    });

    res.json({ message: 'YC Process started' });
});

// ============================================================
// API: NAS Community Auto-Scraper
// ============================================================
app.post('/api/trigger-nas', (req, res) => {
    if (isRunning) {
        return res.json({ success: false, message: 'Process already in flight.' });
    }

    isRunning = true;
    currentLogs = [`🚀 NAS Community Scraper Initiated at ${new Date().toLocaleString()}\n`];

    const cliArgs = ['tsx', 'fetch_nas_community.ts'];
    if (req.body && typeof req.body.limit === 'number' && req.body.limit > 0) {
        cliArgs.push('--limit', String(req.body.limit));
    }
    if (req.body && req.body.headless === true) {
        cliArgs.push('--headless');
    }
    // Customizable look-back window from the dashboard (hours).
    if (req.body && typeof req.body.maxAgeHours === 'number' && req.body.maxAgeHours > 0) {
        cliArgs.push('--max-age-hours', String(req.body.maxAgeHours));
    }

    currentChildProcess = spawn('npx', cliArgs, {
        cwd: process.cwd(),
        env: { ...process.env, SERVER_PORT: String(PORT) },
        shell: true,
    });

    let stdoutBuffer = '';
    currentChildProcess.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        lines.forEach((line: string) => { if (line) currentLogs.push(line + '\n'); });
    });

    currentChildProcess.stderr?.on('data', (data: Buffer) => {
        currentLogs.push(data.toString());
    });

    currentChildProcess.on('close', (code: number | null) => {
        if (stdoutBuffer) currentLogs.push(stdoutBuffer + '\n');
        currentLogs.push(`\n✅ NAS scraper finished with exit code ${code}\n`);
        isRunning = false;
        currentChildProcess = null;
    });

    currentChildProcess.on('error', (err: Error) => {
        currentLogs.push(`\n❌ Failed to start NAS scraper: ${err.message}\n`);
        isRunning = false;
        currentChildProcess = null;
    });

    res.json({ message: 'NAS scraper started' });
});

// ============================================================
// API: Follow-up Draft Generator
// ============================================================
app.post('/api/send-followups', (req, res) => {
    if (isFollowUpRunning) return res.status(400).json({ error: 'Follow-up process already running. Please wait.' });

    isFollowUpRunning = true;
    // Append to existing logs instead of replacing, so terminal shows content
    currentLogs.push(`\n🔄 Follow-up Draft Generator Initiated at ${new Date().toLocaleString()}\n`);
    isRunning = true;

    const child = spawn('npx', ['tsx', 'scripts/send_followups.ts'], {
        cwd: process.cwd(),
        env: { ...process.env },
        shell: true
    });

    let stdoutBuffer = '';
    child.stdout?.on('data', (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        lines.forEach((line: string) => { if (line) currentLogs.push(line + '\n'); });
    });

    child.stderr?.on('data', (data: Buffer) => {
        currentLogs.push(data.toString());
    });

    child.on('close', (code: number | null) => {
        if (stdoutBuffer) currentLogs.push(stdoutBuffer + '\n');
        currentLogs.push(`\n✅ Follow-up process finished with exit code ${code}\n`);
        isFollowUpRunning = false;
        isRunning = false;
    });

    child.on('error', (err: Error) => {
        currentLogs.push(`\n❌ Failed to start follow-up process: ${err.message}\n`);
        isFollowUpRunning = false;
        isRunning = false;
    });

    res.json({ message: 'Follow-up process started' });
});

// ============================================================
// API: Poll Logs + OTP Status

// ============================================================
app.get('/api/logs', (req, res) => {
    res.json({
        isRunning,
        logs: currentLogs.join(''),
        otpRequired,
        passwordRequired
    });
});

// ============================================================
// API: Submit OTP (called from browser dashboard)
// ============================================================
app.post('/api/submit-otp', (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'No OTP code provided' });

    if (pendingOtpResolve) {
        currentLogs.push(`🔑 OTP submitted: ${code}\n`);
        pendingOtpResolve(code.trim());
        pendingOtpResolve = null;
        otpRequired = false;
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No OTP is currently pending' });
    }
});

// ============================================================
// API: Submit 2FA Password
// ============================================================
app.post('/api/submit-password', (req, res) => {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'No password provided' });

    if (pendingPasswordResolve) {
        currentLogs.push(`🔐 2FA password submitted.\n`);
        pendingPasswordResolve(password.trim());
        pendingPasswordResolve = null;
        passwordRequired = false;
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'No password is currently pending' });
    }
});

// ============================================================
// Internal API: Used by auto_apply.ts when running in BROWSER_MODE
// ============================================================
app.post('/api/internal/request-otp', (req, res) => {
    otpRequired = true;
    currentLogs.push('\n⚠️  TELEGRAM OTP REQUIRED — Please enter the OTP code sent to your Telegram app in the box below.\n');

    const timeout = setTimeout(() => {
        if (pendingOtpResolve) {
            pendingOtpResolve('');
            pendingOtpResolve = null;
            otpRequired = false;
            currentLogs.push('❌ OTP timeout — no code entered within 2 minutes.\n');
        }
    }, 120_000);

    const waitForOtp = new Promise<string>((resolve) => {
        pendingOtpResolve = (code) => {
            clearTimeout(timeout);
            resolve(code);
        };
    });

    waitForOtp.then(code => {
        res.json({ code });
    });
});

app.post('/api/internal/request-password', (req, res) => {
    passwordRequired = true;
    currentLogs.push('\n🔐  2FA PASSWORD REQUIRED — Please enter your Telegram 2FA password below.\n');

    const timeout = setTimeout(() => {
        if (pendingPasswordResolve) {
            pendingPasswordResolve('');
            pendingPasswordResolve = null;
            passwordRequired = false;
        }
    }, 120_000);

    const waitForPassword = new Promise<string>((resolve) => {
        pendingPasswordResolve = (password) => {
            clearTimeout(timeout);
            resolve(password);
        };
    });

    waitForPassword.then(password => {
        res.json({ password });
    });
});

// ============================================================
// Static public dir
// ============================================================
const publicDir = path.join(process.cwd(), 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir);
}

app.listen(PORT, '0.0.0.0', () => {
    const localIp = getLocalIpAddress();
    console.log(`\n======================================================`);
    console.log(`🚀 WEB DASHBOARD RUNNING!`);
    console.log(`📱 Access it on your phone at: http://${localIp}:${PORT}`);
    console.log(`💻 Access it on your laptop at: http://localhost:${PORT}`);
    console.log(`======================================================\n`);
});
