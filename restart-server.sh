#!/bin/bash
export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin
# Kill any existing server processes
pkill -f "tsx server.ts" || true
pkill -f "tsx combined_server.ts" || true
pkill -f "tsx form_filler_server.ts" || true
sleep 1
# Start the combined server which manages both
npm start > server.log 2>&1 &
echo "Server Restarted"
