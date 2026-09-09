export async function checkLogMonitor(env = process.env, fetchImpl = fetch) {
  if (!env.INGEST_API_KEY) throw new Error("INGEST_API_KEY is required");
  const url = new URL(env.DASHBOARD_URL || "https://log.bonkers.llc");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Dashboard URL must use HTTPS");
  const response = await fetchImpl(`${url.href.replace(/\/$/, "")}/api/log-monitor/check`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${env.INGEST_API_KEY}` },
  });
  if (!response.ok) throw new Error(`Log monitor failed: HTTP ${response.status}`);
  return response.json();
}
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkLogMonitor().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
