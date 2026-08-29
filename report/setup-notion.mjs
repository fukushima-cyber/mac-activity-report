// 他社・他の人が、自分のNotionワークスペースに「社員稼働レポート」「アプリ別集計」を
// 自動で作るための初回セットアップスクリプト。AI不使用。
//
// 使い方:
//   1. Notionで「連携(インテグレーション)」を新規作成し、トークンを取得
//      https://www.notion.so/profile/integrations
//   2. データベースを作りたい親ページを開き、右上「…」→「接続を追加」でその連携を共有
//   3. その親ページのURLをコピー
//   4. node report/setup-notion.mjs <トークン> <親ページのURL>
import { createDatabase } from "./notion-api.mjs";

const [, , token, parentPageUrl] = process.argv;
if (!token || !parentPageUrl) {
  console.error("使い方: node report/setup-notion.mjs <Notionトークン> <親ページのURL>");
  process.exit(1);
}

async function main() {
  const reportDb = await createDatabase(token, parentPageUrl, "社員稼働レポート", {
    "日付・社員": { title: {} },
    日付: { date: {} },
    社員: { rich_text: {} },
    "稼働時間(h)": { number: {} },
    作業内容の要約: { rich_text: {} },
    "無駄・非効率が疑われる点": { rich_text: {} },
    自動化できそうな作業: { rich_text: {} },
    ウィンドウ切替回数: { number: {} },
  });
  console.log("「社員稼働レポート」を作成しました:");
  console.log(`  ${reportDb.url}`);

  const appsDb = await createDatabase(token, parentPageUrl, "アプリ別集計", {
    行タイトル: { title: {} },
    日付: { date: {} },
    社員: { rich_text: {} },
    アプリ: { rich_text: {} },
    秒数: { number: {} },
  });
  console.log("「アプリ別集計」を作成しました:");
  console.log(`  ${appsDb.url}`);

  console.log("");
  console.log("次の手順:");
  console.log("1. ダッシュボード(https://log.bonkers.llc)の「設定」で、上の2つのURLとNotionトークンを保存してください");
  console.log("2. Notion側で「アプリ別集計」を開き、お好みで「アプリ別」「社員別」のチャートビューを手動で追加すると見やすくなります(自動作成はできません)");
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
