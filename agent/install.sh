#!/bin/zsh
# 各社員のMacで実行する: 毎日20:00に自動でログを書き出すよう登録する
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# macOSのプライバシー保護(TCC)は、~/Documents・~/Desktop・~/Downloads・iCloud Drive・
# Google Drive等のクラウド同期フォルダ配下を、launchdから起動したプロセスにはユーザーの
# 明示許可なしにアクセスさせない。launchdジョブは無音で失敗する(エラーが画面に出ない)ため、
# 気付かないまま毎日記録が止まり続ける事故になりやすい。事前にここで止める。
for protected in "$HOME/Documents" "$HOME/Desktop" "$HOME/Downloads" "$HOME/Library/CloudStorage" "$HOME/Library/Mobile Documents"; do
  if [[ "$PROJECT_DIR" == "$protected"* ]]; then
    echo "エラー: このツールが $protected 配下に置かれています。" >&2
    echo "macOSのプライバシー保護(TCC)により、launchdからのアクセスができず自動実行が無音で失敗するため、" >&2
    echo "~/Projects など保護対象外の場所へこのフォルダを移動してから、もう一度実行してください。" >&2
    exit 1
  fi
done

PLIST_SRC="$PROJECT_DIR/agent/com.fukushima-cyber.mac-activity-export.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.fukushima-cyber.mac-activity-export.plist"
LOG_DIR="$HOME/Library/Logs/mac-activity-report"

mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

PROJECT_DIR_ESCAPED="$(printf '%s' "$PROJECT_DIR" | sed 's/[&|]/\\&/g')"
LOG_DIR_ESCAPED="$(printf '%s' "$LOG_DIR" | sed 's/[&|]/\\&/g')"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR_ESCAPED|g" -e "s|__LOG_DIR__|$LOG_DIR_ESCAPED|g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"

echo "登録しました。毎日20:00に自動でログを書き出します。"
echo "手動でテストする場合: launchctl start com.fukushima-cyber.mac-activity-export"
echo "ログの出力先: $LOG_DIR/export.log (エラーは export.error.log)"
