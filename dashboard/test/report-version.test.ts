import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/server/worker";
import { hashToken } from "../src/server/logs";

let sqlite: DatabaseSync;
let env: Parameters<typeof worker.fetch>[1];
const org = "78500bcc-7993-4a2f-a38e-7c79940ac721";
const objects = new Map<string, string>();
beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations).sort()) sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
  sqlite.prepare("INSERT INTO secrets (org_id, key, value) VALUES (?, 'ingest_token', 'ingest-test')").run(org);
  sqlite.prepare("INSERT INTO employees (id, org_id, name, slug, upload_token_hash) VALUES ('e', ?, 'Test', 'test', ?)")
    .run(org, await hashToken("upload-test"));
  objects.clear();
  env = {
    DB: {
      prepare(sql: string) {
        let values: SQLInputValue[] = [];
        return {
          bind(...args: SQLInputValue[]) { values = args; return this; },
          async first() { return sqlite.prepare(sql).get(...values) ?? null; },
          async all() { return { results: sqlite.prepare(sql).all(...values) }; },
          async run() { return { meta: sqlite.prepare(sql).run(...values) }; },
        };
      },
    },
    LOGS: {
      async put(key: string, body: string) { objects.set(key, body); },
      async get(key: string) { return objects.has(key) ? { text: async () => objects.get(key)! } : null; },
    },
  } as unknown as typeof env;
});
afterEach(() => sqlite.close());

async function request(path: string, body?: unknown, token = "ingest-test") {
  return worker.fetch(new Request(`https://example.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
}
async function upload(seconds = 60) {
  const res = await request("/api/logs/upload", {
    employee: "test", date: "2026-09-08", windows: [], active_seconds: seconds, window_count: 0,
  }, "upload-test");
  expect(res.status).toBe(200);
  const log = await request("/api/logs/test/2026-09-08");
  expect(log.status).toBe(200);
  return log.headers.get("X-Upload-Version");
}
async function pending() {
  const res = await request("/api/logs/pending?from=2026-09-01&to=2026-09-09");
  expect(res.status).toBe(200);
  return res.json();
}
it("new upload during analysis remains pending even with equal timestamps", async () => {
  const first = await upload();
  const second = await upload(120);
  expect(first).toBeTruthy();
  expect(first).not.toBe(second);
  const res = await request("/api/reports/ingest", {
    employee_slug: "test", date: "2026-09-08", source_upload_version: first,
  });
  expect(res.status).toBe(200);
  sqlite.exec("UPDATE uploads SET uploaded_at = '2026-09-09 00:00:00'; UPDATE reports SET updated_at = '2026-09-09 00:00:00'");
  expect(await pending()).toHaveLength(1);
  await request("/api/reports/ingest", { employee_slug: "test", date: "2026-09-08", source_upload_version: second });
  expect(await pending()).toEqual([]);
});
it("an old publisher cannot clear a versioned upload", async () => {
  await upload();
  await request("/api/reports/ingest", { employee_slug: "test", date: "2026-09-08" });
  expect(await pending()).toHaveLength(1);
});
it("legacy rows retain timestamp comparison until their next upload", async () => {
  await upload();
  await request("/api/reports/ingest", { employee_slug: "test", date: "2026-09-08" });
  sqlite.exec("UPDATE uploads SET upload_version = NULL, uploaded_at = '2026-09-08 00:00:00'; UPDATE reports SET updated_at = '2026-09-09 00:00:00'");
  expect(await pending()).toEqual([]);
});
it("log and pending reads reject unauthenticated callers", async () => {
  await upload();
  expect((await request("/api/logs/test/2026-09-08", undefined, "invalid")).status).toBe(401);
  expect((await request("/api/logs/pending?from=2026-09-01&to=2026-09-09", undefined, "invalid")).status).toBe(401);
});

it("another organization's valid token cannot read this employee's logs", async () => {
  await upload();
  sqlite.exec("INSERT INTO organizations (id, name) VALUES ('other-org', 'Other'); INSERT INTO secrets (org_id, key, value) VALUES ('other-org', 'ingest_token', 'other-key')");
  expect((await request("/api/logs/test/2026-09-08", undefined, "other-key")).status).toBe(404);
  const otherPending = await request("/api/logs/pending?from=2026-09-01&to=2026-09-09", undefined, "other-key");
  expect(otherPending.status).toBe(200);
  expect(await otherPending.json()).toEqual([]);
});

it("an upload-only token cannot publish reports", async () => {
  expect((await request("/api/reports/ingest", { employee_slug: "test", date: "2026-09-08" }, "upload-test")).status).toBe(401);
  expect(sqlite.prepare("SELECT COUNT(*) AS n FROM reports").get()?.n).toBe(0);
});

it("monitoring disabled rejects storage even for a valid employee token", async () => {
  sqlite.exec("UPDATE employees SET monitoring_enabled = 0");
  const response = await request("/api/logs/upload", { employee: "test", date: "2026-09-08", windows: [], active_seconds: 0, window_count: 0 }, "upload-test");
  expect(await response.json()).toMatchObject({ skipped: true });
  expect(objects.size).toBe(0);
  expect(await pending()).toEqual([]);
});
