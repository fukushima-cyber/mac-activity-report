// アプリ別の稼働秒数を集計し、ダッシュボード(Cloudflare)へ送る。AI不使用・決定的な集計のみ。
// 使い方: node report/ingest-activity.mjs [YYYY-MM-DD]
import fs from "node:fs/promises";
import path from "node:path";
import { upsertAppRow } from "./notion-api.mjs";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
const INGEST_API_KEY = process.env.INGEST_API_KEY;
const NOTION_APPS_DB_URL = process.env.NOTION_APPS_DB_URL;

async function fetchNotionToken() {
  if (!INGEST_API_KEY) return null;
  const res = await fetch(`${DASHBOARD_URL}/api/notion-token`, {
    headers: { Authorization: `Bearer ${INGEST_API_KEY}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.token ?? null;
}

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

  const notionToken = await fetchNotionToken();

  for (const file of files) {
    const raw = JSON.parse(await fs.readFile(path.join(sharedDrivePath, file), "utf-8"));
    const totals = new Map();
    for (const w of raw.windows ?? []) {
      const app = w.app || "(不明)";
      totals.set(app, (totals.get(app) ?? 0) + Math.round(w.duration_seconds ?? 0));
    }
    const apps = Array.from(totals, ([app, seconds]) => ({ app, seconds }));

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

    if (notionToken && NOTION_APPS_DB_URL) {
      for (const { app, seconds } of apps) {
        try {
          await upsertAppRow(notionToken, NOTION_APPS_DB_URL, {
            titleValue: `${raw.date}_${raw.employee}_${app}`,
            date: raw.date,
            employeeName: raw.employee,
            app,
            seconds,
          });
        } catch (err) {
          console.error(`Notion「アプリ別集計」書き込み失敗(${raw.employee}/${app}):`, err.message);
        }
      }
      console.log(`Notion「アプリ別集計」へ書き込み完了: ${raw.employee}`);
    }
  }
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
