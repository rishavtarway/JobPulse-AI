/**
 * combined_server.ts
 * ─────────────────────────────────────────────────────────
 * One command to start everything:
 *   npm start
 *
 * This boots:
 *   1. The Web Dashboard (server.ts)  → port 3000
 *   2. The Form-Filler Backend        → port 3001 (for Chrome extension)
 *
 * Authentication:
 *   - If Telegram session is expired, the dashboard at port 3000 will
 *     show an OTP input box automatically. No terminal needed.
 *   - To force a fresh Telegram auth: npm run auth
 * ─────────────────────────────────────────────────────────
 */

import { spawn } from 'child_process';
import os from 'os';

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name] || []) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const ip = getLocalIpAddress();

console.log(`\n${'═'.repeat(56)}`);
console.log(`  🤖  AUTO-APPLY SYSTEM STARTING`);
console.log(`${'═'.repeat(56)}`);
console.log(`  📱 Dashboard (phone/browser): http://${ip}:3000`);
console.log(`  💻 Dashboard (local):         http://localhost:3000`);
console.log(`  🔌 Form-Filler (extension):   http://127.0.0.1:3001`);
console.log(`${'═'.repeat(56)}\n`);

// Start the main dashboard server
const dashboardServer = spawn('npx', ['tsx', 'server.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
});

dashboardServer.stdout?.on('data', (d: Buffer) => process.stdout.write(`[DASHBOARD] ${d}`));
dashboardServer.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (!text.includes('[INFO]') && !text.includes('DEBUG')) {
        process.stderr.write(`[DASHBOARD] ${text}`);
    }
});
dashboardServer.on('exit', (code: number | null) => {
    console.log(`\n[DASHBOARD] Server exited with code ${code}`);
    process.exit(code ?? 0);
});

// Start the form-filler server for the Chrome extension
const formFillerServer = spawn('npx', ['tsx', 'form_filler_server.ts'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd()
});

formFillerServer.stdout?.on('data', (d: Buffer) => process.stdout.write(`[FORM-FILLER] ${d}`));
formFillerServer.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (!text.includes('[INFO]') && !text.includes('DEBUG')) {
        process.stderr.write(`[FORM-FILLER] ${text}`);
    }
});
formFillerServer.on('exit', (code: number | null) => {
    console.log(`\n[FORM-FILLER] Server exited with code ${code}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n\n🛑 Shutting down all servers...');
    dashboardServer.kill();
    formFillerServer.kill();
    process.exit(0);
});

process.on('SIGTERM', () => {
    dashboardServer.kill();
    formFillerServer.kill();
    process.exit(0);
});
