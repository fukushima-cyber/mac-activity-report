#!/bin/zsh
# ダブルクリックで実行。自動記録・自動レポートを止める(ActivityWatch自体は動いたままだが、共有フォルダへの書き出しとNotion投稿が止まる)。
LOG_PLIST="$HOME/Library/LaunchAgents/com.fukushima-cyber.mac-activity-export.plist"
REPORT_PLIST="$HOME/Library/LaunchAgents/com.fukushima-cyber.mac-activity-report.plist"

launchctl unload "$LOG_PLIST" 2>/dev/null || true
launchctl unload "$REPORT_PLIST" 2>/dev/null || true

echo "停止しました。再開する時は「自動レポート-ON.command」をダブルクリックしてください。"
read -r "?Enterキーで閉じます..."
