// 保管期間を過ぎた生ログをダッシュボード側(R2)から削除する(POST /api/logs/retention)。
// 集計・レポート(D1のactivity/reports)は対象外で残る。AI不使用・決定的処理のみ。
// Workers無料プランはcronがアカウント全体で5個までのため、cronの代わりに
// run-daily-report.shの最後からこのスクリプトを毎朝呼ぶ(docs/decisions/0003-direct-upload.md参照)。
// INGEST_API_KEYが未設定の場合は何もせず正常終了する(レポート自体は止めない)。
// 使い方: node report/retention.mjs
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
const INGEST_API_KEY = process.env.INGEST_API_KEY;

async function main() {
  if (!INGEST_API_KEY) {
    console.error("INGEST_API_KEYが未設定です(report/.env)。生ログの削除処理をスキップします。");
    return;
  }

  const res = await fetch(`${DASHBOARD_URL}/api/logs/retention`, {
    method: "POST",
    headers: { Authorization: `Bearer ${INGEST_API_KEY}` },
  });
  if (!res.ok) {
    console.error(`削除処理に失敗しました: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const json = await res.json();
  console.log(`削除: ${json.deleted} 件 (保管 ${json.days} 日、基準日 ${json.cutoff})`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
