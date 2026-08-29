// Notion公式REST APIを直接叩く最小クライアント。組織ごとに発行されたトークンを使う。
// MCP/Claude Codeの個人アカウント接続に依存しないための実装。

const NOTION_VERSION = "2022-06-28";

export function toDashedId(idOrUrl) {
  // app.notion.com/p/<id> 形式にも、www.notion.so/Title-<id> のような通常のページURL形式にも対応する。
  // URL中に含まれる最後の32桁16進数(ハイフン有無どちらも可)をIDとみなす。
  const cleaned = idOrUrl.replace(/[?#].*$/, "");
  const matches = cleaned.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi);
  if (!matches || matches.length === 0) {
    throw new Error(`NotionのID/URLとして解釈できません: ${idOrUrl}`);
  }
  const hex = matches[matches.length - 1].replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rt(text) {
  return [{ type: "text", text: { content: String(text ?? "").slice(0, 2000) } }];
}

async function notionFetch(token, path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion API ${path} 失敗(${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function findPageByTitle(token, databaseId, titlePropertyName, titleValue) {
  const result = await notionFetch(token, `/databases/${toDashedId(databaseId)}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: titlePropertyName, title: { equals: titleValue } },
      page_size: 1,
    }),
  });
  return result.results[0]?.id ?? null;
}

export async function upsertReportPage(token, databaseId, { titleValue, properties, children }) {
  const existingId = await findPageByTitle(token, databaseId, "日付・社員", titleValue);
  const body = {
    properties: {
      "日付・社員": { title: rt(titleValue) },
      日付: { date: { start: properties.date } },
      社員: { rich_text: rt(properties.employeeName) },
      "稼働時間(h)": { number: properties.activeHours ?? null },
      作業内容の要約: { rich_text: rt(properties.summary) },
      "無駄・非効率が疑われる点": { rich_text: rt(properties.wasteNotes) },
      自動化できそうな作業: { rich_text: rt(properties.automationNotes) },
      ウィンドウ切替回数: { number: properties.windowCount ?? null },
    },
  };
  if (existingId) {
    await notionFetch(token, `/pages/${existingId}`, { method: "PATCH", body: JSON.stringify({ properties: body.properties }) });
    // 本文は一旦既存ブロックを取得して削除し、作り直す(シンプルさ優先)
    const existingBlocks = await notionFetch(token, `/blocks/${existingId}/children?page_size=100`);
    for (const block of existingBlocks.results) {
      await notionFetch(token, `/blocks/${block.id}`, { method: "DELETE" }).catch(() => {});
    }
    await notionFetch(token, `/blocks/${existingId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children }),
    });
    return existingId;
  }
  const created = await notionFetch(token, "/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: toDashedId(databaseId) }, ...body, children }),
  });
  return created.id;
}

export function timelineToBlocks(timeline, summaryText) {
  const tableRows = [
    {
      type: "table_row",
      table_row: { cells: [rt("時間帯"), rt("稼働"), rt("主なアプリ"), rt("何をしていたか")] },
    },
    ...timeline.map((t) => ({
      type: "table_row",
      table_row: { cells: [rt(t.time_range), rt(t.duration), rt(t.main_app), rt(t.description)] },
    })),
  ];
  const blocks = [
    {
      type: "heading_2",
      heading_2: { rich_text: rt("稼働タイムライン(JST)") },
    },
  ];
  if (timeline.length > 0) {
    blocks.push({
      type: "table",
      table: { table_width: 4, has_column_header: true, has_row_header: false, children: tableRows },
    });
  }
  if (summaryText) {
    blocks.push({ type: "paragraph", paragraph: { rich_text: rt(summaryText) } });
  }
  return blocks;
}

export async function createDatabase(token, parentPageId, title, properties) {
  const created = await notionFetch(token, "/databases", {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: toDashedId(parentPageId) },
      title: [{ type: "text", text: { content: title } }],
      properties,
    }),
  });
  return created;
}

export async function upsertAppRow(token, databaseId, { titleValue, date, employeeName, app, seconds }) {
  const existingId = await findPageByTitle(token, databaseId, "行タイトル", titleValue);
  const properties = {
    行タイトル: { title: rt(titleValue) },
    日付: { date: { start: date } },
    社員: { rich_text: rt(employeeName) },
    アプリ: { rich_text: rt(app) },
    秒数: { number: seconds },
  };
  if (existingId) {
    await notionFetch(token, `/pages/${existingId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    return existingId;
  }
  const created = await notionFetch(token, "/pages", {
    method: "POST",
    body: JSON.stringify({ parent: { database_id: toDashedId(databaseId) }, properties }),
  });
  return created.id;
}
