import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import os from 'os';

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
// API: Trigger Script
// ============================================================
let currentChildProcess: any = null;

app.post('/api/stop', (req, res) => {
    if (currentChildProcess) {
        currentChildProcess.kill('SIGINT'); // Try nice kill first
        setTimeout(() => {
            if (isRunning) {
                currentChildProcess.kill('SIGKILL');
                isRunning = false;
                currentLogs.push('\n🛑 Process FORCE TERMINATED by user.\n');
            }
        }, 1000);
        res.json({ message: 'Stop signal sent' });
    } else {
        res.status(400).json({ error: 'No process is running' });
    }
});

app.post('/api/trigger', (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: 'Process is already running' });
    }

    isRunning = true;
    currentLogs = [];
    otpRequired = false;
    passwordRequired = false;
    pendingOtpResolve = null;
    pendingPasswordResolve = null;

    currentLogs.push('🚀 Starting Auto-Apply process...\n');

    // Spawn the child process with BROWSER_MODE so it knows to use the web OTP endpoint
    currentChildProcess = spawn('npx', ['tsx', 'auto_apply.ts'], {
        env: { ...process.env, BROWSER_MODE: '1', SERVER_PORT: String(PORT) },
        cwd: process.cwd()
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
