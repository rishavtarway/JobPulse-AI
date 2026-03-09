#!/bin/bash
pkill -f "tsx form_filler_server.ts" || true
sleep 1
npm run form-filler > /dev/null 2>&1 &
echo "Server Restarted"
