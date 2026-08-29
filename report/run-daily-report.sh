#!/bin/zsh
# あなたのMacだけで動かす。共有フォルダの当日分ログをAIで分析し、
# 分析結果(JSON)をNotion(組織ごとのトークン)とダッシュボードへ書き込む。
# Notionへの書き込み自体はAI不使用・決定的処理(publish-report.mjs)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

DATE="${1:-$(TZ=Asia/Tokyo date -v-1d +%Y-%m-%d)}" # 引数省略時は「前日分」を対象にする(朝9時に前日レポートを出すため)

export DASHBOARD_URL="https://log.bonkers.llc"
if [ -z "${ORG_ID:-}" ]; then
  echo "ORG_ID が report/.env に設定されていません。ダッシュボードにログインして「設定」を保存すると分かります。" >&2
  exit 1
fi
DASHBOARD_SETTINGS="$(curl -fsS "$DASHBOARD_URL/api/settings?org=$ORG_ID" 2>/dev/null || echo '{}')"
setting() {
  echo "$DASHBOARD_SETTINGS" | node -e "
    let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
      try{const j=JSON.parse(d);process.stdout.write(j['$1']||'')}catch{}
    })"
}

export SHARED_DRIVE_PATH="${SHARED_DRIVE_PATH:-$(setting shared_drive_path)}"
export SHARED_DRIVE_PATH="${SHARED_DRIVE_PATH:-$PROJECT_DIR/data}"
export NOTION_REPORT_DB_URL="${NOTION_REPORT_DB_URL:-$(setting notion_report_db_url)}"
export NOTION_APPS_DB_URL="${NOTION_APPS_DB_URL:-$(setting notion_apps_db_url)}"

PROMPT=$(sed \
  -e "s|{{DATE}}|$DATE|g" \
  -e "s|{{SHARED_DRIVE_PATH}}|$SHARED_DRIVE_PATH|g" \
  "$SCRIPT_DIR/daily-report-prompt.md")

cd "$PROJECT_DIR"

echo "=== ログを分析(AI、Notion等への書き込み権限は与えない) ==="
ANALYSIS_FILE="$(mktemp -t mac-activity-analysis).json"
claude -p "$PROMPT" --allowedTools "Read" > "$ANALYSIS_FILE"
# AIが前後に余計な文章を付けてしまった場合に備えて、最初の [ から最後の ] までを抜き出す
node -e "
const fs = require('fs');
const raw = fs.readFileSync('$ANALYSIS_FILE', 'utf-8');
const start = raw.indexOf('[');
const end = raw.lastIndexOf(']');
if (start === -1 || end === -1) { console.error('JSON配列が見つかりませんでした'); process.exit(1); }
fs.writeFileSync('$ANALYSIS_FILE', raw.slice(start, end + 1));
"

echo ""
echo "=== レポート本文をNotion・ダッシュボードへ送信 ==="
node "$SCRIPT_DIR/publish-report.mjs" "$DATE" "$ANALYSIS_FILE"
rm -f "$ANALYSIS_FILE"

echo ""
echo "=== 集計データ(アプリ別の稼働時間)をNotion・ダッシュボードへ送信 ==="
node "$SCRIPT_DIR/ingest-activity.mjs" "$DATE"
