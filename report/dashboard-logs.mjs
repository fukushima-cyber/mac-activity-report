// ダッシュボードAPI(直接アップロード方式。docs/decisions/0003-direct-upload.md)から、
// 指定日の全社員分のログ本文を取得して destDir へ実ファイルとして書き出す。
// collect-employee-logs.mjs から使う。fetchImpl を差し替えられるようにして、
// ネットワークに繋がずオフラインで単体テストできるようにしている。
//
// GET /api/logs?date=<date>            → [{ employee_slug, date, size, uploaded_at }, ...]
// GET /api/logs/<slug>/<date>          → そのログ本文(JSON文字列)。無ければ404
// いずれも Authorization: Bearer <INGEST_API_KEY> で認証する(report/ingest-activity.mjs と同じ形)。
import fs from "node:fs/promises";
import path from "node:path";

// onlySlugs(Set<string>、NFC)を渡すと、その社員のログだけを取得する(差分再生成用。run-daily-report.sh参照)。
export async function fetchDailyLogsFromDashboard({ baseUrl, apiKey, date, destDir, onlySlugs = null, fetchImpl = fetch }) {
  const headers = { Authorization: `Bearer ${apiKey}` };

  let listRes;
  try {
    listRes = await fetchImpl(`${baseUrl}/api/logs?date=${encodeURIComponent(date)}`, { headers, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return { ok: false, error: `一覧取得でネットワークエラー: ${err.message}` };
  }
  if (!listRes.ok) {
    return { ok: false, error: `一覧取得に失敗しました: ${listRes.status}` };
  }

  let rows;
  try {
    rows = await listRes.json();
  } catch (err) {
    return { ok: false, error: `一覧のJSON解釈に失敗しました: ${err.message}` };
  }
  if (onlySlugs) {
    rows = rows.filter((row) => onlySlugs.has(String(row.employee_slug).normalize("NFC")));
  }

  const written = [];
  const versions = Object.create(null);
  for (const row of rows) {
    const slug = row.employee_slug;
    let logRes;
    try {
      logRes = await fetchImpl(`${baseUrl}/api/logs/${encodeURIComponent(slug)}/${encodeURIComponent(date)}`, {
        headers, signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      console.error(`警告: ${slug}のログ取得でネットワークエラー(スキップ): ${err.message}`);
      continue;
    }
    if (!logRes.ok) {
      console.error(`警告: ${slug}のログ取得に失敗しました(スキップ): ${logRes.status}`);
      continue;
    }
    const text = await logRes.text();
    // 集約先の一時フォルダ側(collect-employee-logs.mjs)の命名・正規化(NFC)に合わせる
    const fileName = `${date}_${slug}.json`.normalize("NFC");
    const destPath = path.join(destDir, fileName);
    await fs.writeFile(destPath, text, "utf-8"); // シンボリックリンクではなく実ファイルとして書く(取得元がリモートのため)
    written.push(fileName);
    versions[slug] = logRes.headers.get("X-Upload-Version");
  }

  await fs.writeFile(path.join(destDir, ".source-versions.json"), JSON.stringify(versions));

  return { ok: true, written };
}
