# mac-activity-report

Mac操作ログ(アプリ・ウィンドウタイトル)を自動記録し、AIが日次で作業内容を要約してNotionにレポートするツール。

## 構成

2026-09-10の障害予防修正と、本番反映順・残る制約は [障害復旧の記録](docs/reliability-2026-09-10.md) を参照。

- `agent/` … 各社員のMacで動く記録側。ActivityWatch + 書き出しスクリプト。APIキー・ネットワーク送信なし
- `report/` … 管理者のMacだけで動く集計側。共有フォルダの当日分ログを読み、`claude -p`で要約してNotionへ投稿

## 直接アップロード方式(新・推奨)

Google共有ドライブの代わりに、社員PCから日次ログをダッシュボード(`log.bonkers.llc`)へ直接送る方式(詳細は`docs/decisions/0003-direct-upload.md`)。社員PCには**その社員専用・アップロード専用・無効化可能なトークン**(`mal_`から始まる文字列)を置き、サーバーには生の値でなくハッシュだけを保存する。APIは3つ: `POST /api/logs/upload`(社員トークンで、その日1人分のJSONを送る。監視オフの社員のデータは受け取らず捨てる)、`GET /api/logs?date=`(組織のINGEST_API_KEYで、指定日の全社員アップロード状況を一覧)、`GET /api/logs/:slug/:date`(同トークンで、特定社員・特定日のログ本文を取得)。トークンの発行・失効は「社員」画面の再発行ボタンから行う(値が見えるのは発行直後の1回だけ)。生ログはR2に90日(組織ごとに変更可)で自動削除され、集計・レポートは従来通りD1に残る。社員側のセットアップ手順は下の「導入(新方式・推奨)」を参照。

## 複数組織対応

[https://log.bonkers.llc](https://log.bonkers.llc) は他社・他の人も使える。トップの「新しい組織としてはじめる」から組織名・メール・パスワードでサインアップすると、その組織専用のデータ(社員・設定・集計)が作られる。組織間のデータは完全に分離されている。

各組織の管理者は、自分のMacで`report/`・`agent/`を使う際、`.env`に`ORG_ID`(ダッシュボードの「社員」画面のセットアップコマンドに含まれる)を設定する必要がある。

### 完全に無関係な他社がセットアップする手順

Notionへの書き込みは、Claude Codeの個人アカウント接続ではなく、**組織ごとに発行するNotion連携トークン**(Notion公式APIを直接使用)で行う。そのため、あなたのアカウントと一切関係の無い他社でも、以下の手順だけで独立して使える。

1. https://log.bonkers.llc で「新しい組織としてはじめる」からサインアップ
2. Notion(https://www.notion.so/profile/integrations )で新しく「連携」を作成し、トークンを取得
3. データベースを作りたい親ページをNotionで開き、「…」→「接続を追加」でその連携を共有し、ページのURLをコピー
4. `node report/setup-notion.mjs <トークン> <親ページのURL>` を実行 → 「社員稼働レポート」データベースが自動で作られる
5. ダッシュボードの「設定」で、共有ドライブのパス・上記データベースURL・Notionトークンを保存
6. `report/.env`に`ORG_ID`・`INGEST_API_KEY`(ダッシュボードで発行)を設定
7. 「社員」からメンバーを追加し、発行されたセットアップコマンドを各自のMacで実行

### 社員ごとにNotionの書き込み先を分けたい場合

組織共通のNotionアカウントとは別に、特定の社員だけ違うNotionアカウントへ書き込みたい場合(例: 別会社の協力者)は、「社員」画面のその人の行から「Notion書き込み先(個別)」にトークン・データベースURLを登録する。未設定の社員は組織共通のNotionが使われる。

## 設定の一元管理(ダッシュボード)

[https://log.bonkers.llc](https://log.bonkers.llc) で以下を管理する。

- **設定**: 共有ドライブのパス(全社共通のデフォルト)・Notion「社員稼働レポート」データベースのURL・集計データ取り込み用トークン
- **社員一覧**: 名前・メモ・**その人専用の格納先パス**(Google Driveのローカルマウント先はGoogleアカウントごとに変わるため、社員ごとに個別登録できる。未設定なら「設定」の共通パスにフォールバック)・NotionページURL・セットアップコマンド
- **集計**: どのアプリに時間を使っているか(社員ごと/社内全体、直近7・30・90日)

## 導入(新方式・推奨)

社員本人にダッシュボードの「社員」画面で発行されたコマンドをそのまま渡し、1行貼り付けて実行してもらうだけで完了する。**git clone・npm installは不要**(コンパイル済みの単一ファイルをダウンロードして使う)。

- **Mac**:
  ```
  curl -fsSL https://log.bonkers.llc/install/mac.sh | bash -s -- <ORG_ID> <SLUG> <UPLOAD_TOKEN>
  ```
- **Windows(PowerShell)**:
  ```
  $env:ORG_ID="<ORG_ID>"; $env:EMPLOYEE_NAME="<SLUG>"; $env:UPLOAD_TOKEN="<UPLOAD_TOKEN>"; irm https://log.bonkers.llc/install/windows.ps1 | iex
  ```

`<ORG_ID>`・`<SLUG>`・`<UPLOAD_TOKEN>`はダッシュボードの「社員」画面のセットアップコマンドに埋め込まれた状態で発行される(トークン単体を再発行したい場合は、管理者Macから `curl -X POST -H "Authorization: Bearer $INGEST_API_KEY" https://log.bonkers.llc/api/employees/by-slug/<SLUG>/upload-token/rotate` を実行する。値が見えるのはこの応答の1回だけ)。

インストーラーがやること: Node.js・ActivityWatchが無ければ導入(Homebrew/wingetが無い環境でも公式配布物を直接ダウンロードして導入)、ActivityWatchをログイン項目/スタートアップに登録、書き出しスクリプト(`export-daily-log.mjs`)と設定(`.env`、トークン含む)を `~/mac-activity-agent`(Windowsは `%LOCALAPPDATA%\mac-activity-agent`)に配置、PCが起動している間30分おきに「今日＋過去2日分」を自動アップロードするジョブを登録(Mac: launchd / Windows: タスクスケジューラ `MacActivityReport-Export`。前回から変更の無い日は送らない)、動作確認のため即座に1回実行。何度実行しても上書きされるだけなので再実行してよい。設計の理由は `docs/decisions/0004-frequent-upload-and-self-heal.md`。

- **Mac**: 実行の途中でシステム設定の「プライバシーとセキュリティ → アクセシビリティ」が自動で開く。リストの ActivityWatch(aw-watcher-window) にチェックを入れて許可すること(無ければ「+」で追加)
- **Windows**: 初回起動時にSmartScreen等の確認が出た場合は「実行」を選ぶ

ログの出力先: Mac `~/Library/Logs/mac-activity-report/export.log`(エラーは `export.error.log`)、Windows は `%LOCALAPPDATA%\mac-activity-agent\` 配下に手動実行時の出力が出る(タスクスケジューラの実行履歴からも確認可)。手動で再実行する場合は `node ~/mac-activity-agent/export-daily-log.mjs`(Windowsは `node "$env:LOCALAPPDATA\mac-activity-agent\export-daily-log.mjs"`)。

過去3日より前の未送信ログも、PC内(`~/mac-activity-agent/logs/`)に残っていれば直近90日分を照合し、1回につき最大10件再送する。送信成功済みの内容は再送しない。90日を超えた分やPC内にまだ書き出されていない日付は手動確認が必要。

## 旧方式(Google Drive)

Google共有ドライブ経由で社員PCから管理者と同期する、移行前の方式。新規導入では上の「直接アップロード方式」を使うこと。この方式は移行完了後に削除予定(PLAN.md参照)。

ダッシュボードで社員を追加すると、その人専用のセットアップコマンドがMac用・Windows用の両方が発行される(例: Mac `EMPLOYEE_NAME=tanaka ./agent/setup-employee-mac.sh` / Windows `$env:EMPLOYEE_NAME="tanaka"; $env:ORG_ID="<組織ID>"; powershell -ExecutionPolicy Bypass -File .\agent\setup-employee-windows.ps1`)。本人の環境に合う方を1回実行してもらう。こちらはリポジトリの`git clone`・`npm install`が必要。

ActivityWatch・Node.jsを自動インストールし、共有ドライブのパス(その人専用の登録があればそれ、無ければ全社共通のデフォルト)をダッシュボードから自動取得し、毎日23:50にログを書き出すジョブを登録する。

- **Mac**: Homebrewが必要。実行後、システム設定でアクセシビリティ権限の許可が必要
- **Windows**: wingetがあれば使い、無い環境(古いWindows・社内ポリシーでブロック等)ではGitHub/nodejs.orgから直接ダウンロードしてインストールする。スケジュールはタスクスケジューラ(`MacActivityReport-Export`というタスク名)に登録される。管理者側のレポート生成(`report/`)は引き続き福島さんのMacだけで動くため、社員がWindowsでも管理者側の対応は不要。zipでダウンロードしたコピーを使う場合、Windowsが「インターネットからダウンロードしたファイル」としてブロックすることがあるため、先に `Unblock-File -Path .\agent\*.ps1` を実行しておくとよい

## 管理者側のセットアップ(初回のみ)

このリポジトリ自体は `~/Documents`・`~/Desktop`・`~/Downloads`・iCloud Drive・Google Driveなどの同期フォルダの配下に置かないこと。macOSのプライバシー保護(TCC)により、launchdからのアクセスが無音で失敗し、気付かないまま自動実行が止まる。`~/Projects` など保護対象外の場所に置く(`agent/install.sh`・`report/install.sh`は該当する場所に置かれていると起動時にエラーで止まる)。

1. ダッシュボードの「設定」で共有ドライブのパス・NotionデータベースURLを保存し、「取り込み用トークンを発行」して表示された値を `report/.env` に `INGEST_API_KEY=<値>` として保存
2. `./report/install.sh` で毎日9:00(前日分)の自動レポート生成を登録(Notionへの要約書き込み＋ダッシュボードへの集計送信を両方行う)。実行ログは `~/Library/Logs/mac-activity-report/report.log`(エラーは `report.error.log`)に出力される
3. 手動で今すぐ試す場合: `./report/run-daily-report.sh [YYYY-MM-DD]`

## オンオフ切り替え(あなたのMac)

`自動レポート-ON.command` / `自動レポート-OFF.command` をダブルクリック。

## 主要リンク

- 社員管理ダッシュボード: https://log.bonkers.llc
- Notion「社員稼働レポート」: https://app.notion.com/p/5ce380b46fca43acb32c2ee3d9f5d2bb
  - 1人1日=1ページ。一覧で行(社員名)をクリックすると、その日の時間帯ごとのタイムライン・アプリ別内訳がページ本文に載っている
