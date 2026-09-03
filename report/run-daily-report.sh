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

RESOLVED_SHARED_DRIVE_PATH="${SHARED_DRIVE_PATH:-$(setting shared_drive_path)}"
DEFAULT_SHARED_DRIVE_PATH="${RESOLVED_SHARED_DRIVE_PATH:-$PROJECT_DIR/data}"
export NOTION_REPORT_DB_URL="${NOTION_REPORT_DB_URL:-$(setting notion_report_db_url)}"

echo "=== 社員ごとの格納先パスから当日分ログを集約 ==="
# 兄弟フォルダのスキャンは、共有ドライブのパスが実際に設定されている時だけ行う
# ($PROJECT_DIR/data へのフォールバック時に、リポジトリルート配下を誤ってスキャンしないため)
SIBLINGS_FLAG=""
if [ -n "$RESOLVED_SHARED_DRIVE_PATH" ]; then
  SIBLINGS_FLAG="--siblings"
fi
COLLECTED_DIR="$(node "$SCRIPT_DIR/collect-employee-logs.mjs" "$DATE" "$DEFAULT_SHARED_DRIVE_PATH" "$SIBLINGS_FLAG")"
trap 'rm -rf "$COLLECTED_DIR"' EXIT
export SHARED_DRIVE_PATH="$COLLECTED_DIR"

cd "$PROJECT_DIR"

echo "=== ログを分析(社員ごとに並列実行。AI、Notion等への書き込み権限は与えない) ==="
ANALYSIS_FILE="$(mktemp -t mac-activity-analysis).json"
# analyze-parallel.mjsは一部/全員分の失敗を終了コード(1=全滅, 2=一部失敗)で伝えるため、
# set -eで即終了させず、いったん自分で拾ってから続行するかどうかを判断する
set +e
node "$SCRIPT_DIR/analyze-parallel.mjs" "$DATE" "$SHARED_DRIVE_PATH" "$SCRIPT_DIR/daily-report-prompt.md" "$ANALYSIS_FILE"
ANALYZE_STATUS=$?
set -e
if [ "$ANALYZE_STATUS" -eq 1 ]; then
  echo "分析が全員分失敗したため中断します" >&2
  exit 1
fi

echo ""
echo "=== レポート本文をNotion・ダッシュボードへ送信 ==="
node "$SCRIPT_DIR/publish-report.mjs" "$DATE" "$ANALYSIS_FILE"
rm -f "$ANALYSIS_FILE"

echo ""
echo "=== 集計データ(アプリ別の稼働時間)をダッシュボードへ送信 ==="
node "$SCRIPT_DIR/ingest-activity.mjs" "$DATE"

if [ "$ANALYZE_STATUS" -eq 2 ]; then
  echo "一部の社員の分析に失敗しました(上のログ参照)" >&2
  exit 2
fi
