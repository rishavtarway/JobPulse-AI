import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import os from 'os';

// Helper to get local IP address
function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
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

// Helper to safely read a file
function safeReadFile(filename: string) {
    const filePath = path.join(process.cwd(), filename);
    if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, 'utf8');
    }
    return '';
}

// API to get the manual tasklist
app.get('/api/manual-tasks', (req, res) => {
    const content = safeReadFile('MANUAL_APPLY_TASKS.md');
    // Basic Markdown parsing to JSON for the frontend
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
        let isDesc = false;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes('**Apply Here:**')) {
                const linkMatch = line.match(/\[(.*?)\]/);
                if (linkMatch) link = linkMatch[1];
            } else if (line.includes('**Description:**')) {
                isDesc = true;
            } else if (isDesc && line.startsWith('>')) {
                description += line.replace(/^>\s*/, '') + '\n';
            } else if (line === '---') {
                isDesc = false;
            }
        }

        tasks.push({ id, date, link, description: description.trim() });
    });

    // Sort newest first
    tasks.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    res.json(tasks);
});

// API to get recent history from master log
app.get('/api/history', (req, res) => {
    const content = safeReadFile('all_extracted_jobs_log.txt');
    const lines = content.split('\n').filter(l => l.trim() !== '');
    // Return last 50 lines to keep it fast
    res.json(lines.slice(-50).reverse());
});

// API to trigger the script
app.post('/api/trigger', (req, res) => {
    if (isRunning) {
        return res.status(400).json({ error: 'Process is already running' });
    }

    isRunning = true;
    currentLogs = [];

    // We run the auto_apply.ts script as a child process
    const process = exec('npx tsx auto_apply.ts');

    process.stdout?.on('data', (data) => {
        currentLogs.push(data.toString());
    });

    process.stderr?.on('data', (data) => {
        currentLogs.push(`ERROR: ${data.toString()}`);
    });

    process.on('close', (code) => {
        currentLogs.push(`\nProcess finished with exit code ${code}`);
        isRunning = false;
    });

    res.json({ message: 'Process started' });
});

// API to poll logs
app.get('/api/logs', (req, res) => {
    res.json({ isRunning, logs: currentLogs.join('') });
});

// Create public dir if it doesn't exist
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
