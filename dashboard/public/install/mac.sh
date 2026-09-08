#!/bin/bash
# 社員のMacで1行だけ実行してもらうインストーラー(直接アップロード方式・新)。
# docs/decisions/0003-direct-upload.md 参照。git clone・npm installは不要。
#
# 使い方:
#   curl -fsSL https://log.bonkers.llc/install/mac.sh | bash -s -- <ORG_ID> <SLUG> <UPLOAD_TOKEN>
# または環境変数で:
#   ORG_ID=... EMPLOYEE_NAME=... UPLOAD_TOKEN=... curl -fsSL https://log.bonkers.llc/install/mac.sh | bash
#
# 何度実行してもよい(冪等): .env・export-daily-log.mjs・launchdジョブを上書きして最新化する。
set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-https://log.bonkers.llc}"
ORG_ID="${1:-${ORG_ID:-}}"
EMPLOYEE_NAME="${2:-${EMPLOYEE_NAME:-}}"
UPLOAD_TOKEN="${3:-${UPLOAD_TOKEN:-}}"

echo "=== Mac操作ログ収集ツール セットアップ(直接アップロード方式) ==="

# --- 0. macOSであることの確認 ---
if [ "$(uname)" != "Darwin" ]; then
  echo "エラー: このインストーラーはmacOS専用です。" >&2
  exit 1
fi

if [ -z "$ORG_ID" ] || [ -z "$EMPLOYEE_NAME" ] || [ -z "$UPLOAD_TOKEN" ]; then
  echo "エラー: ORG_ID・EMPLOYEE_NAME(社員スラッグ)・UPLOAD_TOKENが必要です。" >&2
  echo "ダッシュボードの「社員」画面で発行されたコマンドをそのまま実行してください。" >&2
  exit 1
fi

# --- 1. 保存先ディレクトリ(TCC回避のため~/Documents等の同期・保護フォルダは避ける) ---
AGENT_DIR="$HOME/mac-activity-agent"
mkdir -p "$AGENT_DIR"

# --- 2. Node.js ---
# Homebrewが無い(≒非エンジニアの私物Mac)場合でも詰まらないよう、
# 公式配布のポータブル版(tar.gz)を $AGENT_DIR 配下に展開して使う(システム全体へのインストール・sudo不要)。
resolve_node_bin() {
  if command -v node >/dev/null 2>&1; then
    command -v node
  elif [ -x /opt/homebrew/bin/node ]; then
    echo /opt/homebrew/bin/node
  elif [ -x /usr/local/bin/node ]; then
    echo /usr/local/bin/node
  fi
}

NODE_BIN="$(resolve_node_bin || true)"
if [ -n "$NODE_BIN" ]; then
  echo "Node.jsは導入済みです ($("$NODE_BIN" --version))。"
elif command -v brew >/dev/null 2>&1; then
  echo "Node.jsをインストールします..."
  brew install node
  NODE_BIN="$(resolve_node_bin || true)"
fi

if [ -z "$NODE_BIN" ]; then
  echo "Node.jsを自動ダウンロードして導入します(Homebrew不要・システムへは影響しません)..."
  NODE_RUNTIME_DIR="$AGENT_DIR/node-runtime"
  case "$(uname -m)" in
    arm64) NODE_PLATFORM="darwin-arm64" ;;
    x86_64) NODE_PLATFORM="darwin-x64" ;;
    *)
      echo "エラー: 未対応のアーキテクチャです ($(uname -m))。https://nodejs.org/ から手動でインストールしてから、もう一度この手順を実行してください。" >&2
      exit 1
      ;;
  esac
  NODE_MAJOR=22
  SHASUMS="$(curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/SHASUMS256.txt" 2>/dev/null || true)"
  NODE_TARBALL_NAME="$(printf '%s' "$SHASUMS" | grep -o "node-v${NODE_MAJOR}\.[0-9.]*-${NODE_PLATFORM}\.tar\.gz" | head -1)"
  if [ -z "$NODE_TARBALL_NAME" ]; then
    echo "エラー: Node.jsのダウンロード情報の取得に失敗しました(ネットワークを確認して、もう一度実行してください)。" >&2
    echo "うまくいかない場合は https://nodejs.org/ から手動でインストールしてください。" >&2
    exit 1
  fi
  mkdir -p "$NODE_RUNTIME_DIR"
  NODE_TMP_BASE="$(mktemp -t node-download)"
  NODE_TMP_TARBALL="${NODE_TMP_BASE}.tar.gz"
  rm -f "$NODE_TMP_BASE"
  curl -fsSL "https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/$NODE_TARBALL_NAME" -o "$NODE_TMP_TARBALL"
  tar -xzf "$NODE_TMP_TARBALL" -C "$NODE_RUNTIME_DIR" --strip-components=1
  rm -f "$NODE_TMP_TARBALL"
  NODE_BIN="$NODE_RUNTIME_DIR/bin/node"
  echo "Node.jsを導入しました ($("$NODE_BIN" --version) / $NODE_RUNTIME_DIR)。"
fi

# --- 3. ActivityWatch ---
# こちらもHomebrewが無ければ、GitHub公式リリースのdmgを直接ダウンロードして/Applicationsへ配置する。
if [ -d "/Applications/ActivityWatch.app" ]; then
  echo "ActivityWatchは導入済みです。"
elif command -v brew >/dev/null 2>&1; then
  echo "ActivityWatchをインストールします..."
  brew install --cask activitywatch
else
  echo "ActivityWatchを自動ダウンロードして導入します(Homebrew不要)..."
  AW_RELEASE_JSON="$(curl -fsSL https://api.github.com/repos/ActivityWatch/activitywatch/releases/latest 2>/dev/null || true)"
  AW_DMG_URL="$(printf '%s' "$AW_RELEASE_JSON" | grep -o 'https://[^"]*macos-x86_64\.dmg' | head -1)"
  if [ -z "$AW_DMG_URL" ]; then
    echo "エラー: ActivityWatchのダウンロード情報の取得に失敗しました(ネットワークを確認して、もう一度実行してください)。" >&2
    echo "うまくいかない場合は https://activitywatch.net/downloads/ から手動でインストールしてください。" >&2
    exit 1
  fi
  AW_TMP_BASE="$(mktemp -t activitywatch-download)"
  AW_TMP_DMG="${AW_TMP_BASE}.dmg"
  rm -f "$AW_TMP_BASE"
  curl -fsSL "$AW_DMG_URL" -o "$AW_TMP_DMG"
  AW_MOUNT_POINT="$(mktemp -d -t activitywatch-mount)"
  hdiutil attach "$AW_TMP_DMG" -mountpoint "$AW_MOUNT_POINT" -nobrowse -quiet
  cp -R "$AW_MOUNT_POINT/ActivityWatch.app" /Applications/
  hdiutil detach "$AW_MOUNT_POINT" -quiet
  rm -rf "$AW_MOUNT_POINT" "$AW_TMP_DMG"
  echo "ActivityWatchを導入しました。(Apple Siliconの場合、初回起動時にRosettaのインストールを求められることがあります。案内が出たら「インストール」を選んでください)"
fi

# --- 4. 書き出しスクリプトと.envの配置 ---
echo "書き出しスクリプトをダウンロードします..."
curl -fsSL "$DASHBOARD_URL/install/export-daily-log.mjs" -o "$AGENT_DIR/export-daily-log.mjs"

cat > "$AGENT_DIR/.env" <<EOF
ORG_ID=$ORG_ID
EMPLOYEE_NAME=$EMPLOYEE_NAME
UPLOAD_TOKEN=$UPLOAD_TOKEN
DASHBOARD_URL=$DASHBOARD_URL
EOF
chmod 600 "$AGENT_DIR/.env"
echo "設定を保存しました: $AGENT_DIR/.env (トークンは表示しません)"

# --- 5. launchd登録(PCが起動している間、30分おきに自動送信) ---
# 特定の時刻(旧: 毎日23:50)固定だと、その時間にPCを閉じている人のデータが取れない。
# 人によって稼働時間がバラバラなため、起動中は30分おきに「今日の分」を送り直す方式にする
# (同じ日付は上書きされる設計なので、何度送っても壊れない)。PCがスリープ/シャットダウン中は
# 実行されないが、次に開いた時にlaunchdが自動で追いつき実行する。
LOG_DIR="$HOME/Library/Logs/mac-activity-report"
mkdir -p "$LOG_DIR"
mkdir -p "$HOME/Library/LaunchAgents"

PLIST_LABEL="com.fukushima-cyber.mac-activity-export"
PLIST_DST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
LAUNCHD_PATH="$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$AGENT_DIR/export-daily-log.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$AGENT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/export.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/export.error.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$LAUNCHD_PATH</string>
  </dict>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl load "$PLIST_DST"
echo "PCが起動している間、30分おきに自動アップロードするジョブを登録しました。"

# --- 6. ActivityWatchをログイン項目に登録 & 起動 & アクセシビリティ許可の案内 ---
# 登録しないと再起動後にActivityWatchが止まったままになり、30分おきの送信が全部空振りする(docs/decisions/0004)。
# 送信スクリプト側にも「応答が無ければ起動する」自己修復があるが、ログイン項目への登録が本命。
echo "ActivityWatchをログイン項目に登録します(「\"ターミナル\"が\"System Events\"を制御することを許可」の確認が出たら「OK」を押してください)..."
if osascript -e 'tell application "System Events" to if not (exists login item "ActivityWatch") then make login item at end with properties {path:"/Applications/ActivityWatch.app"}' >/dev/null 2>&1; then
  echo "ActivityWatchをログイン項目に登録しました(再起動後も自動で起動します)。"
else
  echo "警告: ログイン項目への登録ができませんでした。「システム設定 → 一般 → ログイン項目」でActivityWatchを追加してください(送信ジョブ側でも起動を試みるので、そのままでも動きます)。"
fi
echo "ActivityWatchを起動します..."
open -a "ActivityWatch" 2>/dev/null || true
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
echo ""
echo "★ 手動でお願いしたいこと ★"
echo "  1. 開いた「プライバシーとセキュリティ → アクセシビリティ」の画面で"
echo "  2. リストに ActivityWatch(aw-watcher-window) があればチェックを入れて許可"
echo "  3. 無ければ「+」から追加して許可してください"
echo ""

# --- 7. 即時テスト実行 ---
echo "動作確認のため、今すぐ1回書き出しを実行します..."
if "$NODE_BIN" "$AGENT_DIR/export-daily-log.mjs"; then
  echo ""
  echo "セットアップ完了です。PCが起動している間、30分おきに自動でログをアップロードします。"
else
  echo ""
  echo "セットアップは完了しましたが、動作確認は失敗しました(上記のエラーを確認してください)。"
  echo "アクセシビリティの許可直後はActivityWatchの再起動が必要な場合があります。ActivityWatchを再起動してから、"
  echo "以下で手動テストしてください: $NODE_BIN $AGENT_DIR/export-daily-log.mjs"
fi
echo ""
echo "ログの出力先: $LOG_DIR/export.log (エラーは export.error.log)"
echo "手動でテストする場合: $NODE_BIN $AGENT_DIR/export-daily-log.mjs"
