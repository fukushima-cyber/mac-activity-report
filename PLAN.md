# PLAN: 直接アップロード方式への移行(docs/decisions/0003)

セッションを跨ぐ作業のバトン。完了したら[x]にする。各フェーズは「実装→型/構文チェック→実データ確認→4点報告」で閉じる。

## P1 サーバー(ダッシュボード Worker)
- [x] D1 migration 0007: `employees.upload_token_hash`、`uploads`(org_id, employee_slug, date, r2_key, size, uploaded_at)、`settings.log_retention_days`
- [x] wrangler.jsonc に R2 バケット `mac-activity-logs` を binding `LOGS` で追加(名前は環境変数化しない。移設時は同名で作る)
- [x] `POST /api/logs/upload` (Bearer=社員トークン): JSON検証(date, employee=トークンの社員)、R2へ `orgs/<org>/logs/<slug>/<date>.json`、`uploads` upsert
- [x] `GET /api/logs?date=` / `GET /api/logs/:slug/:date` (Bearer=INGEST_API_KEY): 一覧とダウンロード
- [x] `POST /api/employees/:id/upload-token/rotate` (セッション): 新トークンを1回だけ返す(表示後は取り出せない)
- [x] 保管期間超過のR2オブジェクトと`uploads`行の削除。cronは無料プランの上限(5個/アカウント)で登録不可のため、`POST /api/logs/retention`(INGEST_API_KEY)を用意し、P3で`run-daily-report.sh`から毎朝呼ぶ
- [x] 既存の `/api/activity/ingest` `/api/reports/ingest` は変更なし

## P2 社員側(agent)
- [x] `export-daily-log.ts`: `UPLOAD_TOKEN` があればダッシュボードへPOST(5xx/ネットワーク失敗はリトライ)、無ければ従来のDrive書き出し
- [x] ワンライナー導入: `curl -fsSL https://log.bonkers.llc/install/mac.sh | bash -s -- <org> <slug> <token>` 相当(Windowsは `irm ... | iex`)。git clone不要。`export-daily-log.ts`を`tsc`で単一の`.mjs`にコンパイルし`dashboard/public/install/`から配信、Mac/Windowsインストーラーはダッシュボードの静的ファイルとして新規作成(既存の`agent/setup-employee-*`は旧方式用として温存)
- [x] macOS: アクセシビリティ設定画面を直接開き、1枚案内を出す

## P3 管理者側(report)
- [x] `collect-employee-logs.mjs`: 当日分をダッシュボードAPI(`report/dashboard-logs.mjs`)から取得して一時フォルダへ実ファイルで書き出し。一覧取得が失敗した時だけDriveスキャンにフォールバック(0件の日はDriveも通常通りスキャン)。ダッシュボード取得分とDriveの同名は前者を優先
- [x] `run-daily-report.sh`: 最後に`report/retention.mjs`(POST /api/logs/retention)を呼ぶ。launchd経由で通しテスト済み(2026-09-04)

## P4 ダッシュボードUI
- [x] 社員一覧に「導入状況」(未発行/未導入/稼働中(日付)/停止中(日付)=JST暦日で3日超)
- [x] 「導入コマンドを発行/再発行」(トークンは1回だけ表示)と、新しい導入コマンド(Mac/Windows)のコピー。旧方式(Drive)のコマンドはトグルで温存
- [ ] 設定に「生ログの保管日数」

## P5 文書・移設・検証
- [x] `docs/runbook-migrate-account.md`(別Cloudflareアカウントへの移設手順: D1 export/import、R2コピー、ドメイン)
- [x] README更新(Drive手順を「旧方式」に降格)
- [ ] ひえいさんでパイロット: 新コマンドで再導入→夜間アップロード→翌朝レポート、を実データで確認
- [ ] 全員移行後: Drive経路の削除を別タスクとして起票

## P6 イレギュラーな稼働でも取りこぼさない(docs/decisions/0004)
- [x] 社員PC: 23:50固定 → 起動中30分おき(Mac: launchd StartInterval / Windows: 30分繰り返し)。今日＋過去2日分を送り、変更の無い日は送らない
- [x] 社員PC: ActivityWatchをログイン項目/スタートアップに登録。送信スクリプトは応答が無ければ起動して待つ
- [x] サーバー: `GET /api/logs/pending` で「アップロードがレポートより新しい社員・日」だけを作り直す。VPS cronは9:00と13:00
- [x] Windows: 30分繰り返しの期間を有限(10年)に、node.exeの窓を出さない(VBScript経由)
- [ ] 導入済みの小林さん・ひえいさんに再実行を案内(旧23:50ジョブが新方式に置き換わる)
- [ ] Windows実機での確認(小林さんの再実行時): タスク登録エラーが出ないこと、窓が出ないこと、export.logに30分おきの記録が付くこと
