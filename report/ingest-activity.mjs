// アプリ別の稼働秒数を集計し、ダッシュボード(Cloudflare、「集計」タブ用)へ送る。
// AI不使用・決定的な集計のみ。Notionへの書き込みは publish-report.mjs 側で
// 「社員稼働レポート」ページ内の「アプリ別内訳」としてまとめて行う(こちらはダッシュボード専用)。
// 使い方: node report/ingest-activity.mjs [YYYY-MM-DD]
import fs from "node:fs/promises";
import path from "node:path";
import { computeAppTotals } from "./aggregate-apps.mjs";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
const INGEST_API_KEY = process.env.INGEST_API_KEY;

function jstYesterday() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  jst.setUTCDate(jst.getUTCDate() - 1);
  return jst.toISOString().slice(0, 10);
}

async function fetchSetting(key) {
  const orgId = process.env.ORG_ID;
  if (!orgId) return null;
  const res = await fetch(`${DASHBOARD_URL}/api/settings?org=${encodeURIComponent(orgId)}`);
  if (!res.ok) return null;
  const json = await res.json();
  return json[key] ?? null;
}

async function main() {
  const date = process.argv[2] ?? jstYesterday();
  if (!INGEST_API_KEY) {
    console.error("INGEST_API_KEYが未設定です(report/.env)。ダッシュボードの「設定」からトークンを発行してください。集計送信をスキップします。");
    return;
  }

  const sharedDrivePath = process.env.SHARED_DRIVE_PATH ?? (await fetchSetting("shared_drive_path"));
  if (!sharedDrivePath) {
    console.error("共有フォルダのパスが分かりません。集計送信をスキップします。");
    return;
  }

  const files = (await fs.readdir(sharedDrivePath)).filter(
    (f) => f.startsWith(`${date}_`) && f.endsWith(".json")
  );
  if (files.length === 0) {
    console.log(`対象ログなし(${date})`);
    return;
  }

  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(path.join(sharedDrivePath, file), "utf-8"));
    const apps = computeAppTotals(raw.windows);

    const res = await fetch(`${DASHBOARD_URL}/api/activity/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_API_KEY}` },
      body: JSON.stringify({ employee_slug: raw.employee, date: raw.date, apps }),
    });
    if (!res.ok) {
      console.error(`送信失敗(${raw.employee}): ${res.status} ${await res.text()}`);
    } else {
      console.log(`送信完了: ${raw.employee} ${raw.date} (${apps.length}アプリ)`);
    }
  }
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
