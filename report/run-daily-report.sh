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

DEFAULT_SHARED_DRIVE_PATH="${SHARED_DRIVE_PATH:-$(setting shared_drive_path)}"
DEFAULT_SHARED_DRIVE_PATH="${DEFAULT_SHARED_DRIVE_PATH:-$PROJECT_DIR/data}"
export NOTION_REPORT_DB_URL="${NOTION_REPORT_DB_URL:-$(setting notion_report_db_url)}"

echo "=== 社員ごとの格納先パスから当日分ログを集約 ==="
COLLECTED_DIR="$(node "$SCRIPT_DIR/collect-employee-logs.mjs" "$DATE" "$DEFAULT_SHARED_DRIVE_PATH")"
trap 'rm -rf "$COLLECTED_DIR"' EXIT
export SHARED_DRIVE_PATH="$COLLECTED_DIR"

cd "$PROJECT_DIR"

echo "=== ログを分析(社員ごとに並列実行。AI、Notion等への書き込み権限は与えない) ==="
ANALYSIS_FILE="$(mktemp -t mac-activity-analysis).json"
node "$SCRIPT_DIR/analyze-parallel.mjs" "$DATE" "$SHARED_DRIVE_PATH" "$SCRIPT_DIR/daily-report-prompt.md" "$ANALYSIS_FILE"

echo ""
echo "=== レポート本文をNotion・ダッシュボードへ送信 ==="
node "$SCRIPT_DIR/publish-report.mjs" "$DATE" "$ANALYSIS_FILE"
rm -f "$ANALYSIS_FILE"

echo ""
echo "=== 集計データ(アプリ別の稼働時間)をダッシュボードへ送信 ==="
node "$SCRIPT_DIR/ingest-activity.mjs" "$DATE"
