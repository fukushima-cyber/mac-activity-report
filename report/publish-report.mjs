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

async function fetchNotionToken(employeeSlug) {
  if (!INGEST_API_KEY) return { token: null, reportDbUrl: null };
  const url = new URL(`${DASHBOARD_URL}/api/notion-token`);
  if (employeeSlug) url.searchParams.set("employee", employeeSlug);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${INGEST_API_KEY}` } });
  if (!res.ok) return { token: null, reportDbUrl: null };
  const json = await res.json();
  return { token: json.token ?? null, reportDbUrl: json.report_db_url ?? null };
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

    // Notionへ(社員ごとの個別設定があればそちらを優先、無ければ組織共通)
    const { token: notionToken, reportDbUrl: employeeReportDbUrl } = await fetchNotionToken(r.employee_slug);
    const reportDbUrl = employeeReportDbUrl ?? NOTION_REPORT_DB_URL;
    if (!notionToken) {
      console.log(`Notionトークンが未設定のため、Notionへの書き込みはスキップします(${r.employee_name})。`);
    } else if (!reportDbUrl) {
      console.log(`Notionの書き込み先DBが未設定のため、スキップします(${r.employee_name})。`);
    } else {
      try {
        const children = timelineToBlocks(r.timeline ?? [], r.day_note);
        await upsertReportPage(notionToken, reportDbUrl, {
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
