// 「レポートを作り直す必要がある社員・日」をダッシュボードに問い合わせる(docs/decisions/0004)。
// 判定はサーバー側(GET /api/logs/pending): その日のアップロードがレポートより新しい、またはレポートが無い。
// 社員PCは起動中30分おきに過去数日分を送り直すため、朝9時の1回きりでは「遅れて届いた分」を
// 取りこぼす。run-daily-report.sh が引数無しで呼ばれた時にこれを使い、該当する社員・日だけを処理する。
//
// 使い方: node report/pending-reports.mjs [遡る日数=3]
// 標準出力: 1行1日 "YYYY-MM-DD<TAB>slug1,slug2,..." (古い日付順)。今日(JST)は対象外(まだ途中なので)。
// 該当なしなら何も出さず終了コード0。API失敗は終了コード1(呼び出し側は従来の前日分処理へフォールバックする)。
const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
const INGEST_API_KEY = process.env.INGEST_API_KEY;
const DAYS = Number(process.argv[2]) || 3;

function jstDateOffset(daysAgo) {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000 - daysAgo * 24 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

async function main() {
  if (!INGEST_API_KEY) {
    console.error("INGEST_API_KEYが未設定です(report/.env)");
    process.exit(1);
  }
  const from = jstDateOffset(DAYS);
  const to = jstDateOffset(1);
  const url = `${DASHBOARD_URL}/api/logs/pending?from=${from}&to=${to}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${INGEST_API_KEY}` } });
  if (!res.ok) {
    console.error(`更新のある社員・日の取得に失敗しました: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const rows = await res.json();
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row.employee_slug);
  }
  for (const date of [...byDate.keys()].sort()) {
    process.stdout.write(`${date}\t${byDate.get(date).join(",")}\n`);
  }
  console.error(`更新のある社員・日: ${rows.length}件 (${from}〜${to})`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
