// Notion公式REST APIを直接叩く最小クライアント。組織ごとに発行されたトークンを使う。
// MCP/Claude Codeの個人アカウント接続に依存しないための実装。
// 1列目(タイトル列)は「日付」で中身は YYYY-MM-DD の日付文字列だけ、2列目「社員」に表示名を持つ。
// 上書き判定用の安定した識別子(KEY_PROPERTY)はタイトルと独立して持っており、
// 社員名を変更してもタイトルは変わるが識別子は変わらないため、重複ページが生まれない。

const NOTION_VERSION = "2022-06-28";
const TITLE_PROPERTY = "日付";
// 旧レイアウトのタイトル列名(移行処理でのみ参照する)
const LEGACY_TITLE_PROPERTY = "日付・社員";
export const KEY_PROPERTY = "識別子";

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

export async function findPageByKey(token, databaseId, keyValue) {
  const result = await notionFetch(token, `/databases/${toDashedId(databaseId)}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: KEY_PROPERTY, rich_text: { equals: keyValue } },
      page_size: 1,
    }),
  });
  return result.results[0]?.id ?? null;
}

// DBのスキーマを新レイアウトへ揃えるための処理。プロセス内で同じDBに対して
// 何度も確認しに行かないよう、確認済みのdatabaseIdをキャッシュしておく。
// 新規に作られたDB(setup-notion.mjs経由)は最初から新形式なので、ここでは何もPATCHしない。
const schemaEnsuredDbIds = new Set();

// pageのproperties一覧から、type==="title"のプロパティ名とその値を取り出す。
// タイトル列の名前は移行前後で変わりうるため、名前ではなくtypeで探す。
function findTitleProperty(properties) {
  for (const [name, value] of Object.entries(properties ?? {})) {
    if (value?.type === "title") return { name, value };
  }
  return null;
}

function plainTextOf(richTextArray) {
  return (richTextArray ?? []).map((t) => t.plain_text ?? "").join("");
}

export async function ensureSchema(token, databaseId) {
  const dashedId = toDashedId(databaseId);
  if (schemaEnsuredDbIds.has(dashedId)) return;

  let changed = false;
  const db = await notionFetch(token, `/databases/${dashedId}`);
  const titleProp = findTitleProperty(db.properties);
  const titleName = titleProp?.name;

  // a〜b: 識別子列が無ければ追加
  if (!db.properties?.[KEY_PROPERTY]) {
    await notionFetch(token, `/databases/${dashedId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { [KEY_PROPERTY]: { rich_text: {} } } }),
    });
    console.log(`Notion DBに「${KEY_PROPERTY}」列を追加しました`);
    changed = true;
  }

  // c: 旧・日付型の「日付」列(タイトルとは別物)が残っていれば削除する(承認済み)
  const legacyDateProp = db.properties?.["日付"];
  if (legacyDateProp && legacyDateProp.type === "date") {
    await notionFetch(token, `/databases/${dashedId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { 日付: null } }),
    });
    console.log("Notion DBの旧「日付」列(日付型)を削除しました");
    changed = true;
  }

  // d: タイトル列名が「日付」でなければリネーム(cで名前を空けた後に行う)
  if (titleName && titleName !== TITLE_PROPERTY) {
    await notionFetch(token, `/databases/${dashedId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: { [titleName]: { name: TITLE_PROPERTY } } }),
    });
    console.log(`Notion DBのタイトル列を「${titleName}」から「${TITLE_PROPERTY}」へ改名しました`);
    changed = true;
  }

  // e: 旧形式だった場合のみ、既存ページのタイトル/識別子を新形式へ一括移行する
  if (changed) {
    let migratedCount = 0;
    let cursor = undefined;
    do {
      const query = await notionFetch(token, `/databases/${dashedId}/query`, {
        method: "POST",
        body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
      });
      for (const page of query.results) {
        const pageTitleProp = findTitleProperty(page.properties);
        const title = plainTextOf(pageTitleProp?.value?.title);
        const key = plainTextOf(page.properties?.[KEY_PROPERTY]?.rich_text);

        let newTitle = null;
        let derivedKey = null;
        const m1 = title.match(/^(\d{4}-\d{2}-\d{2})_(.+)$/);
        const m2 = title.match(/^(\d{4}-\d{2}-\d{2}) .+$/);
        const m3 = title.match(/^\d{4}-\d{2}-\d{2}$/);
        if (m1) {
          newTitle = m1[1];
          derivedKey = title;
        } else if (m2) {
          newTitle = m2[1];
          derivedKey = key || null;
        } else if (m3) {
          newTitle = title;
          derivedKey = key || null;
        } else {
          console.log(`形式不明のためスキップ: ${title}`);
          continue;
        }

        if (newTitle !== title || (derivedKey && derivedKey !== key)) {
          await notionFetch(token, `/pages/${page.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              properties: {
                [TITLE_PROPERTY]: { title: rt(newTitle) },
                ...(derivedKey ? { [KEY_PROPERTY]: { rich_text: rt(derivedKey) } } : {}),
              },
            }),
          });
          migratedCount += 1;
        }
      }
      cursor = query.has_more ? query.next_cursor : undefined;
    } while (cursor);
    if (migratedCount > 0) {
      console.log(`既存ページ ${migratedCount} 件のタイトル/識別子を新形式に揃えました`);
    }
  }

  schemaEnsuredDbIds.add(dashedId);
}

// 互換用エイリアス(旧名での呼び出しに対応)
export const ensureKeyProperty = ensureSchema;

export async function upsertReportPage(token, databaseId, { keyValue, titleValue, properties, children }) {
  if (!keyValue) {
    throw new Error("keyValue は必須です");
  }
  await ensureSchema(token, databaseId);
  let existingId = await findPageByKey(token, databaseId, keyValue);
  // 旧形式ではタイトル自体が識別子だったため、識別子列が未設定の既存ページはタイトル一致でも見つける。
  // ensureSchemaが既にタイトル列を「日付」へ揃えているので、ここでのプロパティ名はTITLE_PROPERTYで良い。
  // 見つかった場合はこのあとのPATCHで新形式のタイトル+識別子へ移行される。
  if (!existingId) {
    existingId = await findPageByTitle(token, databaseId, TITLE_PROPERTY, keyValue);
  }
  const body = {
    properties: {
      [TITLE_PROPERTY]: { title: rt(titleValue) },
      [KEY_PROPERTY]: { rich_text: rt(keyValue) },
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

function formatHours(seconds) {
  return (seconds / 3600).toFixed(1) + "h";
}

export function timelineToBlocks(timeline, summaryText, appTotals) {
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

  if (appTotals && appTotals.length > 0) {
    const sorted = [...appTotals].sort((a, b) => b.seconds - a.seconds);
    blocks.push({ type: "heading_2", heading_2: { rich_text: rt("アプリ別内訳") } });
    blocks.push({
      type: "table",
      table: {
        table_width: 2,
        has_column_header: true,
        has_row_header: false,
        children: [
          { type: "table_row", table_row: { cells: [rt("アプリ"), rt("稼働時間")] } },
          ...sorted.map((a) => ({
            type: "table_row",
            table_row: { cells: [rt(a.app), rt(formatHours(a.seconds))] },
          })),
        ],
      },
    });
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

