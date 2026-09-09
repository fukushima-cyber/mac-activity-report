import { afterEach, beforeEach, expect, it } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import worker from "../src/server/worker";
import { hashToken } from "../src/server/logs";
import { defaultMonitorConfig, runLogMonitor, monitorSnapshot } from "../src/server/log-monitor";

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

const monitorNow = new Date("2026-09-10T03:00:00Z");
function setupMonitor() {
  sqlite.prepare("INSERT INTO log_monitor (org_id, config_json, webhook_url, enabled_at) VALUES (?, ?, ?, ?)")
    .run(org, JSON.stringify({ ...defaultMonitorConfig, enabled: true }), "https://hooks.slack.com/services/T/B/synthetic", "2026-09-01T00:00:00Z");
  sqlite.exec("UPDATE employees SET added_at='2026-09-01 00:00:00'");
}
it("heartbeat identity comes from employee token and cannot be used for manager operations", async () => {
  expect((await request("/api/logs/heartbeat", { collection_ok: true, employee_slug: "someone-else" }, "upload-test")).status).toBe(200);
  expect(sqlite.prepare("SELECT employee_slug FROM employee_log_health").get()?.employee_slug).toBe("test");
  expect((await request("/api/logs/heartbeat", { collection_ok: true }, "ingest-test")).status).toBe(401);
  expect((await request("/api/log-monitor/check", {}, "upload-test")).status).toBe(401);
  sqlite.exec("UPDATE employees SET monitoring_enabled=0; DELETE FROM employee_log_health");
  expect(await (await request("/api/logs/heartbeat", { collection_ok: true }, "upload-test")).json()).toMatchObject({ skipped: true });
  expect(sqlite.prepare("SELECT COUNT(*) AS n FROM employee_log_health").get()?.n).toBe(0);
});
it("monitor sends once per changed state and sends one recovery notice", async () => {
  setupMonitor(); const sent: string[] = [];
  const send: typeof fetch = async (_url, init) => { sent.push(String(init?.body)); return new Response("ok"); };
  await runLogMonitor(env!.DB, org, monitorNow, send);
  await runLogMonitor(env!.DB, org, monitorNow, send);
  expect(sent).toHaveLength(1); expect(sent[0]).toContain("本日のログ未着");
  sqlite.prepare("INSERT INTO uploads (org_id, employee_slug, date, storage_key, size, uploaded_at) VALUES (?, 'test', '2026-09-10', 'test-key', 1, '2026-09-10 02:50:00')").run(org);
  await runLogMonitor(env!.DB, org, monitorNow, send);
  await runLogMonitor(env!.DB, org, monitorNow, send);
  expect(sent).toHaveLength(2); expect(sent[1]).toContain("解消");
});
it("failed notification retries and concurrent checks are leased", async () => {
  setupMonitor(); let calls = 0;
  await expect(runLogMonitor(env!.DB, org, monitorNow, async () => new Response("error", { status: 503 }))).rejects.toThrow();
  expect(sqlite.prepare("SELECT notified_signature FROM log_monitor").get()?.notified_signature).toBe("");
  const send: typeof fetch = async () => {
    calls++;
    expect((await runLogMonitor(env!.DB, org, monitorNow, async () => { throw new Error("must not send"); })).status).toBe("busy_or_unconfigured");
    return new Response("ok");
  };
  await runLogMonitor(env!.DB, org, monitorNow, send); expect(calls).toBe(1);
  expect(sqlite.prepare("SELECT last_error FROM log_monitor").get()?.last_error).toBeNull();
});
it("monitor reads are organization-scoped and old uploads do not count as today's logs", async () => {
  setupMonitor(); await upload();
  expect((await monitorSnapshot(env!.DB, org, monitorNow)).issues).toHaveLength(1);
  expect((await monitorSnapshot(env!.DB, "other-org", monitorNow)).employees).toEqual([]);
  const response = await request("/api/settings?org=" + org);
  expect(JSON.stringify(await response.json())).not.toContain("synthetic");
});
it("manager settings preserve the webhook on ordinary edits and never return its value", async () => {
  sqlite.prepare("INSERT INTO managers (id, org_id, email, password_hash) VALUES ('monitor-admin', ?, 'synthetic@example.test', 'not-used')").run(org);
  sqlite.exec("INSERT INTO sessions (id, manager_id, expires_at) VALUES ('monitor-session', 'monitor-admin', '2099-01-01T00:00:00Z')");
  const admin = (method: string, body?: unknown) => worker.fetch(new Request("https://example.test/api/log-monitor", { method, headers: { Cookie: "mad_session=monitor-session", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
  const config = { ...defaultMonitorConfig, enabled: true };
  expect((await admin("PUT", { config, webhook: "https://hooks.slack.com/services/T/B/private-value" })).status).toBe(200);
  expect((await admin("PUT", { config: { ...config, graceMinutes: 180 } })).status).toBe(200);
  const data = await (await admin("GET")).json() as { webhookConfigured: boolean };
  expect(data.webhookConfigured).toBe(true); expect(JSON.stringify(data)).not.toContain("private-value");
  expect(sqlite.prepare("SELECT webhook_url FROM log_monitor").get()?.webhook_url).toContain("private-value");
  expect((await admin("PUT", { config, webhook: "https://example.test/private" })).status).toBe(400);
  expect((await request("/api/log-monitor")).status).toBe(401);
});
