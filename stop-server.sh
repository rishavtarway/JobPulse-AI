#!/bin/bash
# Stop all JobPulse system processes
echo "🛑 Stopping JobPulse Dashboard and Form-Filler..."
pkill -f "tsx combined_server.ts" || true
pkill -f "tsx server.ts" || true
pkill -f "tsx form_filler_server.ts" || true
pkill -f "tsx auto_apply.ts" || true
echo "✅ All servers stopped."
