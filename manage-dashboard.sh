#!/bin/bash

# Configuration
PORT=3000
SERVER_PID_FILE=".server.pid"
TUNNEL_PID_FILE=".tunnel.pid"
TUNNEL_LOG="tunnel.log"

start() {
    echo "Checking if dashboard is already running..."
    if [ -f "$SERVER_PID_FILE" ] && kill -0 $(cat "$SERVER_PID_FILE") 2>/dev/null; then
        echo "✅ Dashboard is already running (PID: $(cat "$SERVER_PID_FILE"))."
    else
        echo "🚀 Starting Dashboard server..."
        nohup npm run dashboard > dashboard.log 2>&1 &
        echo $! > "$SERVER_PID_FILE"
        sleep 3
        echo "✅ Dashboard started."
    fi

    echo "Checking if tunnel is already running..."
    if [ -f "$TUNNEL_PID_FILE" ] && kill -0 $(cat "$TUNNEL_PID_FILE") 2>/dev/null; then
        echo "✅ Tunnel is already running."
    else
        echo "🌐 Starting stable tunnel (localhost.run)..."
        # Always use a fresh log for the tunnel to catch the URL
        > "$TUNNEL_LOG"
        nohup ssh -o StrictHostKeyChecking=no -R 80:localhost:$PORT nokey@localhost.run > "$TUNNEL_LOG" 2>&1 &
        echo $! > "$TUNNEL_PID_FILE"
        sleep 5
    fi

    echo "------------------------------------------------------"
    URL=$(grep -o 'https://[0-9a-z-]\+\.lhr\.life' "$TUNNEL_LOG" | head -n 1)
    if [ -z "$URL" ]; then
        # Fallback for different localhost.run domains
        URL=$(grep -o 'https://[0-9a-z-]\+\.localhost\.run' "$TUNNEL_LOG" | head -n 1)
    fi
    
    if [ -n "$URL" ]; then
        echo "🌍 Dashboard is PUBLICLY available at: $URL"
    else
        echo "⚠️  Tunnel starting... please run './manage-dashboard.sh status' in a few seconds to get the URL."
    fi
    echo "------------------------------------------------------"
}

stop() {
    echo "🛑 Stopping Tunnel..."
    if [ -f "$TUNNEL_PID_FILE" ]; then
        kill $(cat "$TUNNEL_PID_FILE") 2>/dev/null
        rm "$TUNNEL_PID_FILE"
        echo "✅ Tunnel stopped."
    else
        pkill -f "ssh.*localhost.run"
        echo "✅ Tunnel (pkill) stopped."
    fi

    echo "🛑 Stopping Dashboard server..."
    if [ -f "$SERVER_PID_FILE" ]; then
        kill $(cat "$SERVER_PID_FILE") 2>/dev/null
        rm "$SERVER_PID_FILE"
        echo "✅ Dashboard stopped."
    else
        pkill -f "tsx server.ts"
        echo "✅ Dashboard (pkill) stopped."
    fi
}

status() {
    if [ -f "$SERVER_PID_FILE" ] && kill -0 $(cat "$SERVER_PID_FILE") 2>/dev/null; then
        echo "✅ Dashboard: RUNNING (PID: $(cat "$SERVER_PID_FILE"))"
    else
        echo "❌ Dashboard: STOPPED"
    fi

    if [ -f "$TUNNEL_PID_FILE" ] && kill -0 $(cat "$TUNNEL_PID_FILE") 2>/dev/null; then
        echo "✅ Tunnel: RUNNING"
        URL=$(grep -o 'https://[0-9a-z-]\+\.lhr\.life' "$TUNNEL_LOG" | head -n 1)
        if [ -z "$URL" ]; then
            URL=$(grep -o 'https://[0-9a-z-]\+\.localhost\.run' "$TUNNEL_LOG" | head -n 1)
        fi
        if [ -n "$URL" ]; then
            echo "🔗 Public URL: $URL"
        fi
    else
        echo "❌ Tunnel: STOPPED"
    fi
}

case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    status)
        status
        ;;
    restart)
        stop
        sleep 2
        start
        ;;
    *)
        echo "Usage: $0 {start|stop|status|restart}"
        exit 1
esac
