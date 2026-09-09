import test from "node:test";
import assert from "node:assert/strict";
import { publishReports } from "./publish-pipeline.mjs";
import { validateAnalysis } from "./report-validation.mjs";
import { replacePageBody, timelineToBlocks } from "./notion-api.mjs";

test("Notion failure leaves that employee pending and continues other employees", async () => {
  const calls = [];
  await assert.rejects(publishReports([{ employee_slug: "a" }, { employee_slug: "b" }], {
    notionConfig: async () => ({ token: "test", reportDbUrl: "db" }),
    publishNotion: async (r) => { calls.push(`notion:${r.employee_slug}`); if (r.employee_slug === "a") throw new Error("503"); },
    publishDashboard: async (r) => { calls.push(`dashboard:${r.employee_slug}`); },
    onError: () => {},
  }), /pending: a/);
  assert.deepEqual(calls, ["notion:a", "notion:b", "dashboard:b"]);
});

test("config read failure is not mistaken for unconfigured Notion", async () => {
  let committed = false;
  await assert.rejects(publishReports([{ employee_slug: "a" }], {
    notionConfig: async () => { throw new Error("401"); },
    publishDashboard: async () => { committed = true; },
    onError: () => {},
  }));
  assert.equal(committed, false);
});

test("dashboard failure propagates after Notion succeeds", async () => {
  await assert.rejects(publishReports([{ employee_slug: "a" }], {
    notionConfig: async () => ({ token: "test", reportDbUrl: "db" }),
    publishNotion: async () => {},
    publishDashboard: async () => { throw new Error("503"); },
    onError: () => {},
  }), /pending: a/);
});

test("Notion without a database is not marked complete", async () => {
  await assert.rejects(publishReports([{ employee_slug: "a" }], {
    notionConfig: async () => ({ token: "test" }),
    publishDashboard: async () => assert.fail("must stay pending"),
    onError: () => {},
  }));
});

test("intentionally unconfigured Notion permits dashboard-only reporting", async () => {
  let committed = false;
  await publishReports([{ employee_slug: "a" }], {
    notionConfig: async () => ({ token: null }),
    publishDashboard: async () => { committed = true; },
  });
  assert.equal(committed, true);
});

test("a Notion destination without credentials stays pending", async () => {
  await assert.rejects(publishReports([{ employee_slug: "a" }], {
    notionConfig: async () => ({ token: null, reportDbUrl: "db" }),
    publishDashboard: async () => assert.fail("must stay pending"),
    onError: () => {},
  }));
});

const valid = { employee_slug: "a", active_hours: 1, window_count: 1, timeline: [] };
test("AI output cannot overwrite another employee or silently return no report", () => {
  assert.equal(validateAnalysis([valid], "a")[0], valid);
  assert.throws(() => validateAnalysis([valid], "b"));
  assert.throws(() => validateAnalysis([], "a"));
  assert.throws(() => validateAnalysis([valid, valid], "a"));
});
test("invalid AI metrics and timeline are rejected before publication", () => {
  for (const change of [{ active_hours: NaN }, { active_hours: 25 }, { window_count: -1 }, { window_count: 1.5 }, { timeline: null }, { timeline: [{}] }]) {
    assert.throws(() => validateAnalysis([{ ...valid, ...change }], "a"));
  }
});

test("body append failure never deletes the old Notion body", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    calls.push(options.method ?? "GET");
    if (!options.method) return Response.json({ results: [{ id: "old" }], has_more: false });
    return new Response("unavailable", { status: 503 });
  });
  await assert.rejects(replacePageBody("test", "page", [{ type: "paragraph" }]), /503/);
  assert.deepEqual(calls, ["GET", "PATCH"]);
});

test("body replacement reads every page and appends all batches before deleting", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const method = options.method ?? "GET";
    calls.push(method);
    if (method === "GET") {
      return Response.json(String(url).includes("start_cursor=")
        ? { results: [{ id: "old2" }], has_more: false }
        : { results: [{ id: "old1" }], has_more: true, next_cursor: "cursor" });
    }
    if (method === "PATCH") assert.ok(JSON.parse(options.body).children.length <= 100);
    return Response.json({});
  });
  await replacePageBody("test", "page", Array.from({ length: 101 }, () => ({ type: "paragraph" })));
  assert.deepEqual(calls, ["GET", "GET", "PATCH", "PATCH", "DELETE", "DELETE"]);
});

test("failed old-block deletion is surfaced, not reported as success", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (!options.method) return Response.json({ results: [{ id: "old" }], has_more: false });
    return options.method === "DELETE" ? new Response("failed", { status: 500 }) : Response.json({});
  });
  await assert.rejects(replacePageBody("test", "page", [{ type: "paragraph" }]), /500/);
});

test("large timelines and app lists split without dropping rows", () => {
  const timeline = Array.from({ length: 205 }, (_, i) => ({ time_range: String(i), duration: "1m", main_app: "app", description: "work" }));
  const apps = Array.from({ length: 150 }, (_, i) => ({ app: `app${i}`, seconds: 60 }));
  const tables = timelineToBlocks(timeline, "day", apps).filter((b) => b.type === "table");
  assert.ok(tables.every((t) => t.table.children.length <= 100));
  assert.equal(tables.filter((t) => t.table.table_width === 4).reduce((n, t) => n + t.table.children.length - 1, 0), 205);
  assert.equal(tables.filter((t) => t.table.table_width === 2).reduce((n, t) => n + t.table.children.length - 1, 0), 150);
});
