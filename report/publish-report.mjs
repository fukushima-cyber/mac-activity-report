// AIが出した分析JSON(標準入力 or 引数のファイル)を受け取り、
// Notion(組織ごとのトークンでREST API直叩き)とダッシュボードへ書き込む。決定的処理・AI不使用。
import fs from "node:fs/promises";
import { upsertReportPage, timelineToBlocks } from "./notion-api.mjs";

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
const ORG_ID = process.env.ORG_ID;
const INGEST_API_KEY = process.env.INGEST_API_KEY;
const NOTION_REPORT_DB_URL = process.env.NOTION_REPORT_DB_URL;
const DATE = process.argv[2];
const INPUT_FILE = process.argv[3];

async function fetchNotionToken() {
  if (!INGEST_API_KEY) return null;
  const res = await fetch(`${DASHBOARD_URL}/api/notion-token`, {
    headers: { Authorization: `Bearer ${INGEST_API_KEY}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.token ?? null;
}

async function main() {
  if (!DATE || !INPUT_FILE) {
    console.error("使い方: node publish-report.mjs <DATE> <分析結果JSONファイル>");
    process.exit(1);
  }
  const raw = await fs.readFile(INPUT_FILE, "utf-8");
  let reports;
  try {
    reports = JSON.parse(raw);
  } catch {
    console.error("AIの出力がJSONとして解釈できませんでした。内容:", raw.slice(0, 500));
    process.exit(1);
  }
  if (!Array.isArray(reports) || reports.length === 0) {
    console.log("対象レポートなし");
    return;
  }

  const notionToken = await fetchNotionToken();
  if (!notionToken) {
    console.log("Notionトークンが未設定のため、Notionへの書き込みはスキップします(ダッシュボードの「設定」から登録できます)。");
  }

  for (const r of reports) {
    // ダッシュボードへ
    if (INGEST_API_KEY) {
      const res = await fetch(`${DASHBOARD_URL}/api/reports/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${INGEST_API_KEY}` },
        body: JSON.stringify({
          employee_slug: r.employee_slug,
          employee_name: r.employee_name,
          date: DATE,
          active_hours: r.active_hours,
          window_count: r.window_count,
          summary: r.summary,
          waste_notes: r.waste_notes,
          automation_notes: r.automation_notes,
          timeline: r.timeline,
        }),
      });
      console.log(`ダッシュボードへ送信(${r.employee_name}): ${res.ok ? "成功" : "失敗 " + res.status}`);
    }

    // Notionへ
    if (notionToken && NOTION_REPORT_DB_URL) {
      try {
        const children = timelineToBlocks(r.timeline ?? [], r.day_note);
        await upsertReportPage(notionToken, NOTION_REPORT_DB_URL, {
          titleValue: `${DATE}_${r.employee_slug}`,
          properties: {
            date: DATE,
            employeeName: r.employee_name,
            activeHours: r.active_hours,
            summary: r.summary,
            wasteNotes: r.waste_notes,
            automationNotes: r.automation_notes,
            windowCount: r.window_count,
          },
          children,
        });
        console.log(`Notionへ書き込み完了(${r.employee_name})`);
      } catch (err) {
        console.error(`Notion書き込み失敗(${r.employee_name}):`, err.message);
      }
    }
  }
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
