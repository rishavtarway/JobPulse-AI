#!/bin/zsh

# JobPulse-AI Auto-Push Script
# Saves all your local changes and pushes them to GitHub.

REPO_PATH="/Users/tarway/Documents/JobPulse-AI"
cd "$REPO_PATH" || exit

# Check if there are any changes
if [[ -n $(git status -s) ]]; then
  echo "🚀 Changes detected! Backing up to GitHub..."
  git add .
  git commit -m "Auto-backup: JobPulse-AI $(date +'%Y-%m-%d %H:%M:%S')"
  git push custom_repo main
  echo "✅ Push complete!"
else
  echo "😴 No changes detected. Skipping push."
fi
