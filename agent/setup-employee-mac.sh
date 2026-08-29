#!/bin/zsh
# 社員のMac1台につき1回、これを実行してもらうだけでセットアップ完了する。
# 依存: Homebrew（無ければ案内して終了）。ActivityWatch・Node.jsを自動インストールし、
# 毎日20:00にログを共有フォルダへ書き出すジョブを登録する。
# APIキー・Notion・Claudeとの通信は一切行わない。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Mac操作ログ収集ツール セットアップ ==="

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrewが入っていません。先に https://brew.sh の手順でインストールしてから、もう一度実行してください。"
  exit 1
fi

if ! ls /Applications | grep -qi "ActivityWatch"; then
  echo "ActivityWatchをインストールします..."
  brew install --cask activitywatch
else
  echo "ActivityWatchは導入済みです。"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.jsをインストールします..."
  brew install node
else
  echo "Node.jsは導入済みです ($(node --version))。"
fi

echo "依存パッケージをインストールします..."
cd "$PROJECT_DIR" && npm install

if [ ! -f "$PROJECT_DIR/agent/.env" ]; then
  echo ""
  DASHBOARD_URL="https://log.bonkers.llc"
  EMP_NAME="${EMPLOYEE_NAME:-}"
  ORG_ID="${ORG_ID:-}"
  SHARED_PATH=""
  if [ -z "$ORG_ID" ]; then
    echo "ORG_ID が指定されていません。ダッシュボードの「社員」で発行されたセットアップコマンドをそのまま実行してください。"
    read "ORG_ID?組織ID: "
  fi
  if [ -n "$EMP_NAME" ] && [ -n "$ORG_ID" ]; then
    # ダッシュボードで、この人専用に登録された格納先パスを優先して使う
    SHARED_PATH="$(curl -fsS "$DASHBOARD_URL/api/employees/by-slug/$ORG_ID/$EMP_NAME/public" 2>/dev/null | node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const j=JSON.parse(d);process.stdout.write(j.drive_path||'')}catch{}
      })" || true)"
  fi
  if [ -z "$SHARED_PATH" ] && [ -n "$ORG_ID" ]; then
    # 個人別の登録が無ければ、組織共通のデフォルト設定にフォールバック
    SHARED_PATH="$(curl -fsS "$DASHBOARD_URL/api/settings?org=$ORG_ID" 2>/dev/null | node -e "
      let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
        try{const j=JSON.parse(d);process.stdout.write(j.shared_drive_path||'')}catch{}
      })" || true)"
  fi
  if [ -n "$SHARED_PATH" ]; then
    echo "共有フォルダのパスをダッシュボード($DASHBOARD_URL)から自動取得しました: $SHARED_PATH"
  else
    echo "共有フォルダのパスを設定してください。"
    read "SHARED_PATH?共有フォルダのフルパス(例: /Users/xxx/Google Drive/社員稼働ログ): "
  fi
  if [ -z "$EMP_NAME" ]; then
    read "EMP_NAME?あなたの名前(半角英数、例: tanaka): "
  fi
  cat > "$PROJECT_DIR/agent/.env" <<EOF
SHARED_DRIVE_PATH=$SHARED_PATH
EMPLOYEE_NAME=$EMP_NAME
ORG_ID=$ORG_ID
EOF
  echo ".envを作成しました。"
fi

echo "ActivityWatchを起動します(初回はアクセシビリティ権限の許可が必要です)..."
open -a "ActivityWatch"
echo ""
echo "★ 手動でお願いしたいこと ★"
echo "  システム設定 → プライバシーとセキュリティ → アクセシビリティ で"
echo "  ActivityWatch(aw-watcher-window)を許可してください。"
echo ""

"$SCRIPT_DIR/install.sh"

echo ""
echo "セットアップ完了です。毎日23:50に自動でログが共有フォルダへ書き出されます。"
