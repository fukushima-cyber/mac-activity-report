import type { D1Database } from "@cloudflare/workers-types";

export type MonitorConfig = {
  enabled: boolean; weekdays: number[]; startHour: number; endHour: number;
  graceMinutes: number; holidays: string[]; excludedSlugs: string[];
};
export const defaultMonitorConfig: MonitorConfig = { enabled: false, weekdays: [1, 2, 3, 4, 5], startHour: 9, endHour: 18, graceMinutes: 120, holidays: [], excludedSlugs: [] };
export function validateMonitorConfig(input: unknown): MonitorConfig {
  const c = input as MonitorConfig;
  if (!c || typeof c.enabled !== "boolean" || !Array.isArray(c.weekdays) || !c.weekdays.length || c.weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6) ||
    !Number.isInteger(c.startHour) || !Number.isInteger(c.endHour) || c.startHour < 0 || c.endHour > 24 || c.startHour >= c.endHour ||
    !Number.isInteger(c.graceMinutes) || c.graceMinutes < 60 || c.graceMinutes > 720 ||
    !Array.isArray(c.holidays) || c.holidays.length > 400 || c.holidays.some((d) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(`${d}T00:00:00Z`))) ||
    !Array.isArray(c.excludedSlugs) || c.excludedSlugs.length > 1000 || c.excludedSlugs.some((s) => typeof s !== "string" || s.length > 200 || !s)) throw new Error("通知設定の形式・時間・曜日を確認してください。");
  return { enabled: c.enabled, weekdays: [...new Set(c.weekdays)], startHour: c.startHour, endHour: c.endHour, graceMinutes: c.graceMinutes, holidays: [...new Set(c.holidays)], excludedSlugs: [...new Set(c.excludedSlugs)] };
}
export function validateSlackWebhook(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.port || url.username || url.password || url.search || url.hash || !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname)) throw new Error("Slack Incoming WebhookのURLを指定してください。");
  return url.href;
}
export type HealthRow = { slug: string; name: string; status: string; monitoring_enabled: number; has_token: number; added_at: string; heartbeat_at: string | null; collection_ok: number | null; today_upload_at: string | null };
export type MonitorRow = { config_json: string; webhook_url: string | null; enabled_at: string; notified_signature: string; last_checked_at: string | null; last_notified_at: string | null; last_error: string | null };
function timestamp(value: string | null) { return value ? Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`) : NaN; }
export function evaluateHealth(rows: HealthRow[], c: MonitorConfig, enabledAt: string, now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600_000), date = jst.toISOString().slice(0, 10);
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  const inWindow = c.enabled && c.weekdays.includes(jst.getUTCDay()) && !c.holidays.includes(date) && minutes >= c.startHour * 60 && minutes < c.endHour * 60;
  const start = Date.parse(`${date}T${String(c.startHour).padStart(2, "0")}:00:00+09:00`);
  const results = rows.map((r) => {
    let state = "ok";
    const graceStart = Math.max(start, timestamp(enabledAt) || start, timestamp(r.added_at) || start);
    const heartbeat = timestamp(r.heartbeat_at), uploaded = timestamp(r.today_upload_at);
    if (!c.enabled || r.monitoring_enabled !== 1 || c.excludedSlugs.includes(r.slug) || !r.has_token) state = "excluded";
    else if (!inWindow) state = "outside_hours";
    else if (now.getTime() - graceStart < c.graceMinutes * 60_000) state = "grace";
    else if (Number.isFinite(heartbeat) && now.getTime() - heartbeat < c.graceMinutes * 60_000 && r.collection_ok === 0) state = "collector_error";
    else if (!Number.isFinite(uploaded)) state = "missing_today";
    else if (now.getTime() - Math.max(Number.isFinite(heartbeat) ? heartbeat : 0, uploaded) >= c.graceMinutes * 60_000) state = "stale";
    return { slug: r.slug, name: r.name, state, heartbeat_at: r.heartbeat_at, today_upload_at: r.today_upload_at };
  });
  return { inWindow, date, employees: results, issues: results.filter((r) => ["collector_error", "missing_today", "stale"].includes(r.state)) };
}
export async function monitorSnapshot(db: D1Database, orgId: string, now = new Date()) {
  const stored = await db.prepare("SELECT * FROM log_monitor WHERE org_id = ?").bind(orgId).first<MonitorRow>();
  const config = stored ? validateMonitorConfig(JSON.parse(stored.config_json)) : defaultMonitorConfig;
  const date = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const { results } = await db.prepare(`SELECT e.slug, e.name, e.status, e.monitoring_enabled, e.added_at, (e.upload_token_hash IS NOT NULL) AS has_token,
    h.heartbeat_at, h.collection_ok, u.uploaded_at AS today_upload_at FROM employees e
    LEFT JOIN employee_log_health h ON h.org_id=e.org_id AND h.employee_slug=e.slug
    LEFT JOIN uploads u ON u.org_id=e.org_id AND u.employee_slug=e.slug AND u.date=? WHERE e.org_id=? ORDER BY e.slug`).bind(date, orgId).all<HealthRow>();
  return { stored, config, ...evaluateHealth(results, config, stored?.enabled_at ?? now.toISOString(), now) };
}
export async function runLogMonitor(db: D1Database, orgId: string, now = new Date(), send: typeof fetch = fetch) {
  const lease = crypto.randomUUID();
  const claimed = await db.prepare("UPDATE log_monitor SET lease_token=?, lease_until=? WHERE org_id=? AND lease_until < ?").bind(lease, now.getTime() + 120_000, orgId, now.getTime()).run();
  if (!claimed.meta.changes) return { status: "busy_or_unconfigured" };
  try {
    const snapshot = await monitorSnapshot(db, orgId, now);
    await db.prepare("UPDATE log_monitor SET last_checked_at=? WHERE org_id=? AND lease_token=?").bind(now.toISOString(), orgId, lease).run();
    if (!snapshot.inWindow || !snapshot.stored) return { status: "outside_hours" };
    const signature = JSON.stringify(snapshot.issues.map((r) => [r.slug, r.state]));
    const prior = snapshot.stored.notified_signature;
    if (signature === prior) return { status: "unchanged" };
    if (!snapshot.stored.webhook_url) return { status: "dashboard_only", count: snapshot.issues.length };
    // Initial healthy state needs no message. A later empty set is a recovery notice.
    const notify = Boolean(snapshot.issues.length || (prior && prior !== "[]"));
    if (notify) {
      const lines = snapshot.issues.slice(0, 30).map((r) => `${r.name.slice(0, 80)}: ${r.state === "collector_error" ? "収集・送信エラー" : r.state === "missing_today" ? "本日のログ未着" : "受信・動作確認が途絶"}`);
      const text = snapshot.issues.length ? `社員ログの確認が必要です（${snapshot.date} JST、${snapshot.issues.length}名）\n${lines.join("\n")}\n勤務状況の断定ではありません。PC・権限・ネットワークをご確認ください。` : "社員ログの要確認状態が解消しました。対象からの除外や設定変更による解消も含みます。";
      const safeText = text.slice(0, 2900);
      const response = await send(validateSlackWebhook(snapshot.stored.webhook_url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: safeText.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"), blocks: [{ type: "section", text: { type: "plain_text", text: safeText } }] }) });
      if (!response.ok || (await response.text()).trim() !== "ok") throw new Error("通知先への送信に失敗しました。次回再試行します。");
    }
    await db.prepare("UPDATE log_monitor SET notified_signature=?, last_notified_at=CASE WHEN ? THEN ? ELSE last_notified_at END, last_error=NULL WHERE org_id=? AND lease_token=?").bind(signature, notify ? 1 : 0, now.toISOString(), orgId, lease).run();
    return { status: "checked", count: snapshot.issues.length };
  } catch (error) {
    await db.prepare("UPDATE log_monitor SET last_error=? WHERE org_id=? AND lease_token=?").bind("通知または判定に失敗。設定・接続を確認してください。", orgId, lease).run();
    throw new Error("ログ監視の実行に失敗しました。");
  } finally {
    await db.prepare("UPDATE log_monitor SET lease_until=0, lease_token=NULL WHERE org_id=? AND lease_token=?").bind(orgId, lease).run();
  }
}
