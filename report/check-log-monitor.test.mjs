import test from "node:test";
import assert from "node:assert/strict";
import { checkLogMonitor } from "./check-log-monitor.mjs";
test("monitor check uses organization token without any LLM credentials", async () => {
  const result = await checkLogMonitor({ DASHBOARD_URL: "https://example.test", INGEST_API_KEY: "synthetic" }, async (url, init) => {
    assert.equal(url, "https://example.test/api/log-monitor/check"); assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer synthetic"); assert.equal(init.redirect, "error");
    return Response.json({ status: "unchanged" });
  });
  assert.equal(result.status, "unchanged");
});
test("monitor fails visibly for missing credentials or failed server", async () => {
  await assert.rejects(checkLogMonitor({}), /INGEST_API_KEY/);
  await assert.rejects(checkLogMonitor({ INGEST_API_KEY: "synthetic" }, async () => new Response("secret", { status: 503 })), /HTTP 503$/);
});
