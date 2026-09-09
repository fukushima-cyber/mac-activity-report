import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchDailyLogsFromDashboard } from "./dashboard-logs.mjs";

test("collector carries the downloaded snapshot version, not a later list version", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "report-source-test-"));
  try {
    const result = await fetchDailyLogsFromDashboard({
      baseUrl: "https://example.test", apiKey: "test", date: "2026-09-08", destDir: dir,
      fetchImpl: async (url) => String(url).includes("?date=")
        ? Response.json([{ employee_slug: "test", upload_version: "list-version" }])
        : new Response('{"employee":"test"}', { headers: { "X-Upload-Version": "download-version" } }),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, ".source-versions.json"), "utf8")), { test: "download-version" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
