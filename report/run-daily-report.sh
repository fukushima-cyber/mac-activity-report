#!/usr/bin/env bash
# 管理者Mac、またはVPS(Linux)で動かす。ダッシュボードに届いた社員ログをAIで分析し、
# 分析結果(JSON)をNotion(組織ごとのトークン)とダッシュボードへ書き込む。
# Notionへの書き込み自体はAI不使用・決定的処理(publish-report.mjs)。
#
# 使い方:
#   run-daily-report.sh              … 「アップロードがレポートより新しい社員・日」だけを過去3日分から作り直す(cron用。docs/decisions/0004)
#   run-daily-report.sh YYYY-MM-DD   … その日を全員分で作り直す(手動用)
#
# 社員PCは起動中30分おきに過去数日分を送り直すので、朝の1回きりでは「遅れて届いた分」を取りこぼす。
# そのためcronは1日2回(9:00と13:00)動かし、毎回「作り直す必要がある社員・日」だけを処理する。
# 変更が無い人にはAI(claude -p)を回さないので、回数を増やしても費用は増えない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# 前日の日付を出す(macOSのBSD date と Linuxの GNU date で構文が違うため両対応)
yesterday_jst() {
  if date -v-1d >/dev/null 2>&1; then
    TZ=Asia/Tokyo date -v-1d +%Y-%m-%d # BSD date(macOS)
  else
    TZ=Asia/Tokyo date -d "yesterday" +%Y-%m-%d # GNU date(Linux)
  fi
}

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

# 兄弟フォルダのスキャン(旧・共有フォルダ方式のフォールバック)は、共有ドライブのパスが実際に設定されている時だけ行う
# ($PROJECT_DIR/data へのフォールバック時に、リポジトリルート配下を誤ってスキャンしないため)
SIBLINGS_FLAG=""
if [ -n "$RESOLVED_SHARED_DRIVE_PATH" ]; then
  SIBLINGS_FLAG="--siblings"
fi

# claude -p はプロジェクトフォルダ外の読み取りを拒否するため、プロジェクト直下で動かす
cd "$PROJECT_DIR"

# 処理中の一時ファイル(異常終了時もEXITトラップで消す)
CURRENT_COLLECTED_DIR=""
CURRENT_ANALYSIS_FILE=""
cleanup_current() {
  if [ -n "${CURRENT_COLLECTED_DIR:-}" ]; then rm -rf "$CURRENT_COLLECTED_DIR"; fi
  if [ -n "${CURRENT_ANALYSIS_FILE:-}" ]; then rm -f "$CURRENT_ANALYSIS_FILE"; fi
  CURRENT_COLLECTED_DIR=""
  CURRENT_ANALYSIS_FILE=""
  return 0
}
trap cleanup_current EXIT

# 1日分を処理する。第2引数(カンマ区切りのslug)があればその社員だけ、無ければ全員。
# 戻り値: 0=成功 / 1=集約失敗・全員分析失敗・送信失敗 / 2=一部の社員だけ失敗
run_for_date() {
  local DATE="$1"
  export ONLY_SLUGS="${2:-}"
  echo "===== ${DATE} (対象: ${ONLY_SLUGS:-全員}) ====="

  echo "=== 当日分ログを集約 ==="
  local COLLECTED_DIR
  if ! COLLECTED_DIR="$(node "$SCRIPT_DIR/collect-employee-logs.mjs" "$DATE" "$DEFAULT_SHARED_DRIVE_PATH" "$SIBLINGS_FLAG")"; then
    echo "ログの集約に失敗しました(${DATE})" >&2
    return 1
  fi
  CURRENT_COLLECTED_DIR="$COLLECTED_DIR"
  export SHARED_DRIVE_PATH="$COLLECTED_DIR"

  echo "=== ログを分析(社員ごとに並列実行。AI、Notion等への書き込み権限は与えない) ==="
  # mktempの-tオプションはBSD版(macOS)とGNU版(Linux)でテンプレートの書き方が違うため、
  # -tを使わず直接パスにXXXXXXを含める形(どちらの実装でも共通して動く)にする
  local ANALYSIS_FILE
  ANALYSIS_FILE="$(mktemp "${TMPDIR:-/tmp}/mac-activity-analysis.XXXXXX")"
  mv "$ANALYSIS_FILE" "$ANALYSIS_FILE.json"
  ANALYSIS_FILE="$ANALYSIS_FILE.json"
  CURRENT_ANALYSIS_FILE="$ANALYSIS_FILE"
  # analyze-parallel.mjsは一部/全員分の失敗を終了コード(1=全滅, 2=一部失敗)で伝える
  local ANALYZE_STATUS=0
  node "$SCRIPT_DIR/analyze-parallel.mjs" "$DATE" "$SHARED_DRIVE_PATH" "$SCRIPT_DIR/daily-report-prompt.md" "$ANALYSIS_FILE" || ANALYZE_STATUS=$?
  if [ "$ANALYZE_STATUS" -eq 1 ]; then
    echo "分析が全員分失敗したため、この日は中断します(${DATE})" >&2
    cleanup_current
    return 1
  fi

  echo ""
  echo "=== レポート本文をNotion・ダッシュボードへ送信 ==="
  if ! node "$SCRIPT_DIR/publish-report.mjs" "$DATE" "$ANALYSIS_FILE"; then
    echo "レポートの送信に失敗しました(${DATE})" >&2
    cleanup_current
    return 1
  fi

  echo ""
  echo "=== 集計データ(アプリ別の稼働時間)をダッシュボードへ送信 ==="
  node "$SCRIPT_DIR/ingest-activity.mjs" "$DATE" || echo "警告: 集計データの送信に失敗しました(${DATE})" >&2

  cleanup_current
  if [ "$ANALYZE_STATUS" -eq 2 ]; then
    echo "一部の社員の分析に失敗しました(${DATE}。レポートが無いままなので次回の実行で再試行されます)" >&2
    return 2
  fi
  return 0
}

OVERALL=0
note_status() {
  if [ "$1" -gt "$OVERALL" ]; then OVERALL=$1; fi
  return 0
}

if [ -n "${1:-}" ]; then
  run_for_date "$1" </dev/null || note_status $?
else
  PENDING=""
  if PENDING="$(node "$SCRIPT_DIR/pending-reports.mjs" 3)"; then
    if [ -z "$PENDING" ]; then
      echo "作り直しが必要な社員・日はありません(前回以降、新しいアップロードなし)"
    else
      while IFS=$'\t' read -r P_DATE P_SLUGS; do
        if [ -z "$P_DATE" ]; then continue; fi
        run_for_date "$P_DATE" "$P_SLUGS" </dev/null || note_status $?
      done <<< "$PENDING"
    fi
  else
    echo "警告: 作り直しが必要な社員・日の取得に失敗したため、従来どおり前日分を全員分で処理します" >&2
    run_for_date "$(yesterday_jst)" </dev/null || note_status $?
  fi
fi

echo ""
echo "=== 保管期間を過ぎた生ログの削除(ダッシュボード側) ==="
node "$SCRIPT_DIR/retention.mjs" || echo "警告: 生ログの削除処理に失敗しました(レポート自体は完了しています)" >&2

exit "$OVERALL"
