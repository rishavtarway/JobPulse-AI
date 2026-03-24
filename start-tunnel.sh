#!/bin/bash

# Port for the dashboard
PORT=3000

echo "🚀 Starting Tunnel for Dashboard on port $PORT..."

# Option 1: Ngrok (if configured)
if command -v ngrok &> /dev/null; then
    echo "Using ngrok..."
    ngrok http $PORT --log=stdout > ngrok.log 2>&1 &
    sleep 5
    URL=$(grep -o 'https://[0-9a-z-]\+\.ngrok-free\.app' ngrok.log | head -n 1)
    if [ -n "$URL" ]; then
        echo "✅ Dashboard available at: $URL"
        exit 0
    fi
fi

# Option 2: SSH Tunneling (Fallback)
echo "Falling back to SSH tunneling (pinggy.io)..."
ssh -o StrictHostKeyChecking=no -R 80:localhost:$PORT a.pinggy.io
