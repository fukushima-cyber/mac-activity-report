#!/bin/zsh
# 各社員のMacで実行する: 毎日20:00に自動でログを書き出すよう登録する
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/agent/com.fukushima-cyber.mac-activity-export.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.fukushima-cyber.mac-activity-export.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "登録しました。毎日20:00に自動でログを書き出します。"
echo "手動でテストする場合: launchctl start com.fukushima-cyber.mac-activity-export"
