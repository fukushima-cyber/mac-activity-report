# 別のCloudflareアカウントへ移設する手順

このシステムのCloudflare資源はコードにアカウントIDを持たず、すべて`dashboard/wrangler.jsonc`と下記コマンドから再現できる。移設先で同じ名前の資源を作り、データを移し、デプロイし直すだけで動く。

対象資源(すべて`dashboard/`配下の設定に名前で書かれている):

| 資源 | 名前 | 中身 |
|---|---|---|
| Worker | `kado` | ダッシュボード本体(API+画面) |
| D1 | `mac-activity-dashboard-db` | 組織・社員・設定・集計・レポート・アップロード索引 |
| R2 | `mac-activity-logs` | 社員PCからの生ログ(1人1日1ファイル) |
| 独自ドメイン | `log.bonkers.llc` | `bonkers.llc`のDNSゾーンに紐づく |
| シークレット | なし(組織ごとのトークンはD1内) | — |

## 0. 前提

- 移設先アカウントに`wrangler login`できること(移設作業中だけ、手元の`~/.wrangler`のログイン先を切り替える)
- 移設中は旧アカウント側を止めない。切替が終わってから旧側を削除する

## 1. 移設先に資源を作る

```bash
cd dashboard
npx wrangler d1 create mac-activity-dashboard-db
```

出力された`database_id`で`wrangler.jsonc`の`d1_databases[0].database_id`を書き換える(これが唯一の「アカウント固有の値」)。

```bash
npx wrangler r2 bucket create mac-activity-logs
npx wrangler d1 migrations apply mac-activity-dashboard-db --remote
```

## 2. データを移す

### D1(旧→新)

旧アカウントにログインした状態で:

```bash
npx wrangler d1 export mac-activity-dashboard-db --remote --output=/tmp/mac-activity-db.sql --no-schema
```

新アカウントにログインし直して:

```bash
npx wrangler d1 execute mac-activity-dashboard-db --remote --file=/tmp/mac-activity-db.sql
```

`--no-schema`でデータだけを出し、スキーマは1.のmigrationsで作る(二重定義を避ける)。

### R2(旧→新)

R2はS3互換なので`rclone`でコピーできる。旧・新それぞれのアカウントで「R2 APIトークン(オブジェクト読み書き)」を発行し、`rclone config`で2つのリモート(例: `r2old`, `r2new`)を作ってから:

```bash
rclone copy r2old:mac-activity-logs r2new:mac-activity-logs --progress
```

生ログは保管期間(既定90日)で消えるデータなので、移設のタイミングによっては「コピーせず、移設後の分だけ新側に溜める」判断でもよい。

## 3. デプロイ

新アカウントにログインした状態で:

```bash
cd dashboard && npm run build && npx wrangler deploy
```

## 4. ドメイン

- `bonkers.llc`のゾーンが移設先アカウントにもある場合: `wrangler.jsonc`の`routes`はそのままでデプロイ時に自動で紐づく
- ゾーンが無い場合: `routes`を外して`*.workers.dev`のURLで公開し、DNS側で`log.bonkers.llc`をそのURLへCNAMEする。社員PCの`.env`に入っている`DASHBOARD_URL`は`log.bonkers.llc`のままなので、CNAMEが切り替われば社員側の再設定は不要

## 5. 切替後の確認

- `https://log.bonkers.llc`にログインでき、社員一覧・レポートが見える
- `report/.env`の`INGEST_API_KEY`はD1内のトークンと対になっているので、D1を移していれば変更不要。念のため`./report/run-daily-report.sh <昨日の日付>`を1回手動実行して通ることを確認
- 社員PC側は何もしなくてよい(トークンもD1内のハッシュと対なので有効なまま)

## 6. 旧側の後始末

数日問題なく動いたら、旧アカウントの`kado` Worker・D1・R2を削除する。先にR2を空にしないとバケットは消せない。
