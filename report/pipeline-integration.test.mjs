import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const reportDir = fileURLToPath(new URL("./", import.meta.url));
const date = "2026-09-08";
const log = { employee: "fixture", date, active_seconds: 3600, window_count: 1, windows: [{ app: "Editor", title: "Test", start: `${date}T00:00:00Z`, duration_seconds: 3600 }] };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "report-cli-test-"));
  await fs.cp(reportDir, path.join(root, "report"), { recursive: true, filter: (src) => !src.includes(`${path.sep}.tmp`) && !src.endsWith(".env") });
  await fs.mkdir(path.join(root, "bin"));
  await fs.copyFile(path.join(reportDir, "test-fixtures/claude.mjs"), path.join(root, "bin/claude"));
  await fs.chmod(path.join(root, "bin/claude"), 0o755);
  const state = { fail: "", calls: [], source: "version-1", completed: null };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      const url = new URL(req.url, "http://test");
      const route = url.pathname;
      const reply = (data, status = 200, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(data)); };
      if (route === "/api/settings") return reply({});
      if (route === "/api/logs/pending") return reply(state.completed === state.source ? [] : [{ employee_slug: "fixture", date }]);
      if (route === "/api/logs") return reply([{ employee_slug: "fixture", date }]);
      if (route === `/api/logs/fixture/${date}`) return reply(log, 200, { "X-Upload-Version": state.source });
      if (route === "/api/notion-token") return reply({ token: "test-only", report_db_url: "11111111111111111111111111111111", name: "Fixture" });
      if (route === "/api/activity/ingest") {
        state.calls.push("activity");
        return reply({}, state.fail === "activity" ? 503 : 200);
      }
      if (route === "/api/reports/ingest") {
        state.calls.push("report");
        if (state.fail === "report") return reply({}, 503);
        state.completed = body.source_upload_version;
        return reply({ ok: true });
      }
      if (route === "/api/logs/retention") return reply({ deleted: 0, days: 90, cutoff: "2026-06-10" });
      if (route.endsWith("/query")) return reply({ results: [{ id: "fixture-page" }] });
      if (route.startsWith("/v1/databases/")) return reply({ properties: { 日付: { type: "title" }, 識別子: { type: "rich_text" } } });
      if (route.startsWith("/v1/pages/")) return reply({});
      if (route.endsWith("/children")) {
        if (req.method === "GET") return reply({ results: [], has_more: false });
        state.calls.push("notion");
        return reply({}, state.fail === "notion" ? 503 : 200);
      }
      reply({ error: `Unexpected fixture route: ${route}` }, 500);
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  t.after(async () => {
    if (server.listening) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await fs.rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  async function run(extraEnv = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn("bash", [path.join(root, "report/run-daily-report.sh")], {
        cwd: root,
        env: {
          PATH: `${path.join(root, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          ORG_ID: "fixture-org", INGEST_API_KEY: "test-only", DASHBOARD_URL: url, TEST_API_URL: url,
          NODE_OPTIONS: `--import=${pathToFileURL(path.join(reportDir, "test-fixtures/network.mjs")).href}`,
          ...extraEnv,
        },
      });
      let output = "";
      child.stdout.on("data", (c) => { output += c; });
      child.stderr.on("data", (c) => { output += c; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
    });
  }
  return { state, run, root };
}

test("real shell pipeline saves in order, forwards the version and does no work on rerun", async (t) => {
  const { state, run, root } = await fixture(t);
  const result = await run();
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(state.calls, ["activity", "notion", "report"]);
  assert.equal(state.completed, "version-1");
  state.calls.length = 0;
  const rerun = await run();
  assert.equal(rerun.code, 0, rerun.output);
  assert.deepEqual(state.calls, []);
  assert.deepEqual(await fs.readdir(path.join(root, "report/.tmp")), []);
});
for (const failure of ["activity", "notion", "report"]) {
  test(`real shell pipeline recovers after ${failure} failure`, async (t) => {
    const { state, run } = await fixture(t);
    state.fail = failure;
    const result = await run();
    assert.notEqual(result.code, 0, result.output);
    assert.equal(state.completed, null);
    if (failure !== "report") assert.equal(state.calls.includes("report"), false);
    state.fail = "";
    const retry = await run();
    assert.equal(retry.code, 0, retry.output);
    assert.equal(state.completed, "version-1");
  });
}
test("invalid analysis configuration cannot reach publication", async (t) => {
  const { state, run } = await fixture(t);
  const result = await run({ REPORT_CONCURRENCY: "-1" });
  assert.notEqual(result.code, 0);
  assert.deepEqual(state.calls, []);
});
