#!/bin/zsh
# ダブルクリックで実行。毎日23:50にログ記録→翌9:00にNotionへレポートが自動で上がるようになる。
cd "$(dirname "$0")"
./agent/install.sh
./report/install.sh
echo ""
echo "有効化しました。このウィンドウは閉じて大丈夫です。"
read -r "?Enterキーで閉じます..."
