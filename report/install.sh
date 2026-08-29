#!/bin/zsh
# あなたのMac(管理者側)だけで実行する: 毎日20:30に自動でレポート生成→Notion投稿するよう登録する
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_SRC="$PROJECT_DIR/report/com.fukushima-cyber.mac-activity-report.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.fukushima-cyber.mac-activity-report.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "登録しました。毎日20:30に自動でレポートを生成し、Notionへ投稿します。"
echo "手動でテストする場合: launchctl start com.fukushima-cyber.mac-activity-report"
