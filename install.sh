#!/bin/zsh
# 社員のMacで、これ1行だけで導入できるようにするための入口。
# 使い方(LINE等でこのまま送る):
#   curl -fsSL https://raw.githubusercontent.com/fukushima-cyber/mac-activity-report/main/install.sh | EMPLOYEE_NAME=<あなたの名前> ORG_ID=<組織ID> bash
set -euo pipefail

REPO_URL="https://github.com/fukushima-cyber/mac-activity-report.git"
DEST="$HOME/mac-activity-report"

if [ -d "$DEST/.git" ]; then
  echo "既に $DEST があります。更新します..."
  git -C "$DEST" pull --ff-only
else
  if ! command -v git >/dev/null 2>&1; then
    echo "gitが入っていません。Xcodeコマンドラインツールを先にインストールしてください: xcode-select --install"
    exit 1
  fi
  echo "$DEST にダウンロードします..."
  git clone "$REPO_URL" "$DEST"
fi

cd "$DEST"
exec ./agent/setup-employee-mac.sh
