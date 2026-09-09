# 他社導入

社内資料を含まない配布用パッケージは[company-ops-starter](https://github.com/fukushima-cyber/company-ops-starter)です。会社ごとの初期設定、Notion DB作成、接続診断、議事録ジョブとレポートの起動をまとめています。

このリポジトリのレポート単体では、従来のClaude CLI設定を維持しつつ次の環境変数でAPI接続へ切り替えられます。

- `REPORT_LLM_PROVIDER`: `openai-compatible`または`anthropic`。未設定は従来のClaude CLI。
- `REPORT_LLM_BASE_URL`: APIベースURL（例: `https://api.openai.com/v1`）。HTTPS必須、localhostのみHTTP可。
- `REPORT_LLM_MODEL` / `REPORT_LLM_API_KEY`: 導入先のモデルとキー。
- `NOTION_TOKEN` + `NOTION_REPORT_DB_URL`: 導入先で保持するNotion認証を優先。表示名は従来どおり認証済みダッシュボードから取得。
- `REPORT_DASHBOARD_ONLY=1`: 旧共有ドライブの探索・フォールバックを無効化。
- `REPORT_RETENTION_ENABLED=0`: このレポート実行元からの古いログ削除を無効化。ダッシュボードの別スケジュールには影響しない。

API方式は社員ログをテキストとして指定LLMへ送り、ツール実行を許可しません。従来の分析結果バリデーション、Notion保存後のダッシュボード完了登録、失敗時の再処理をそのまま利用します。LLMの分析内容自体の正確性は各社で受入確認してください。

OpenAI互換とAnthropicの両経路について、実Bash処理とローカルHTTPモックを組み合わせ、ログ取得・分析・ローカルNotion認証・完了登録まで検証しています。新規会社の実認証・実Notionの受入は未実施です。
