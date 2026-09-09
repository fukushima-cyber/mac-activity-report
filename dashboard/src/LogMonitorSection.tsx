import { useEffect, useState } from "react";
import { defaultMonitorConfig, type MonitorConfig } from "./server/log-monitor";

type Snapshot = { config: MonitorConfig; webhookConfigured: boolean; lastCheckedAt: string | null; lastNotifiedAt: string | null; lastError: string | null;
  employees: { slug: string; name: string; state: string; heartbeat_at: string | null; today_upload_at: string | null }[] };
async function request<T>(method = "GET", body?: unknown): Promise<T> {
  const response = await fetch("/api/log-monitor", { method, credentials: "include", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "ログ監視の取得に失敗しました");
  return data;
}
const labels: Record<string, string> = { ok: "受信あり", excluded: "対象外", outside_hours: "時間外", grace: "猶予時間内", collector_error: "収集・送信エラー", missing_today: "本日未着", stale: "受信・動作確認が途絶" };
const format = (value: string | null) => value ? new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : "未確認";
export function LogMonitorSection() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [config, setConfig] = useState<MonitorConfig>(defaultMonitorConfig);
  const [webhook, setWebhook] = useState("");
  const [removeWebhook, setRemoveWebhook] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const load = async () => { const data = await request<Snapshot>(); setSnapshot(data); setConfig(data.config); };
  useEffect(() => { load().catch((e) => setError(e.message)); }, []);
  const staleChecker = !snapshot?.lastCheckedAt || Date.now() - Date.parse(snapshot.lastCheckedAt) > 30 * 60_000;
  return <section className="log-monitor">
    <h2>ログ未着の通知</h2>
    {error && <p role="alert" className="error">{error}</p>}
    {snapshot && <>
      <p>最終自動確認（JST）: {format(snapshot.lastCheckedAt)} {config.enabled && staleChecker && <strong className="error">監視実行を確認できません</strong>}</p>
      {snapshot.lastError && <p role="alert" className="error">{snapshot.lastError}</p>}
      <form className="settings-form" onSubmit={async (event) => {
        event.preventDefault(); setBusy(true); setError(""); setSaved(false);
        try { await request("PUT", { config: { ...config, holidays: config.holidays.filter(Boolean) }, ...(removeWebhook ? { webhook: "" } : webhook ? { webhook } : {}) }); setWebhook(""); setRemoveWebhook(false); await load(); setSaved(true); }
        catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>
        <label className="monitor-check"><input type="checkbox" checked={config.enabled} onChange={(e) => setConfig({ ...config, enabled: e.target.checked })} />ログ未着の判定を有効にする</label>
        <fieldset><legend>対象曜日（JST）</legend><div className="monitor-days">{["日", "月", "火", "水", "木", "金", "土"].map((day, n) => <label key={day} className="monitor-check"><input type="checkbox" checked={config.weekdays.includes(n)} onChange={(e) => setConfig({ ...config, weekdays: e.target.checked ? [...config.weekdays, n] : config.weekdays.filter((d) => d !== n) })} />{day}</label>)}</div></fieldset>
        <div className="monitor-fields">
          <label>開始時刻（JST・時）<input type="number" min="0" max="23" value={config.startHour} onChange={(e) => setConfig({ ...config, startHour: Number(e.target.value) })} /></label>
          <label>終了時刻（JST・時）<input type="number" min="1" max="24" value={config.endHour} onChange={(e) => setConfig({ ...config, endHour: Number(e.target.value) })} /></label>
          <label>未着の猶予（分）<input type="number" min="60" max="720" value={config.graceMinutes} onChange={(e) => setConfig({ ...config, graceMinutes: Number(e.target.value) })} /></label>
        </div>
        <label>休業日（YYYY-MM-DD、カンマ区切り）<input value={config.holidays.join(",")} onChange={(e) => setConfig({ ...config, holidays: e.target.value.split(",").map((s) => s.trim()) })} /></label>
        <fieldset><legend>通知から除外する社員</legend><div className="monitor-days">{snapshot.employees.map((employee) => <label className="monitor-check" key={employee.slug}><input type="checkbox" checked={config.excludedSlugs.includes(employee.slug)} onChange={(e) => setConfig({ ...config, excludedSlugs: e.target.checked ? [...config.excludedSlugs, employee.slug] : config.excludedSlugs.filter((s) => s !== employee.slug) })} />{employee.name}</label>)}</div></fieldset>
        <label>Slack Webhook（{snapshot.webhookConfigured ? "設定済み・空欄で維持" : "未設定・通知なし"}）<input type="password" autoComplete="new-password" value={webhook} onChange={(e) => setWebhook(e.target.value)} disabled={removeWebhook} /></label>
        {snapshot.webhookConfigured && <label className="monitor-check"><input type="checkbox" checked={removeWebhook} onChange={(e) => setRemoveWebhook(e.target.checked)} />Slack通知先を削除</label>}
        <button disabled={busy}>保存</button>{saved && <span role="status">保存しました</span>}
      </form>
      <h3>受信状態（JST）</h3>
      <div className="monitor-table"><table><thead><tr><th>社員</th><th>状態</th><th>本日の最終受信</th><th>動作確認</th></tr></thead><tbody>{snapshot.employees.map((e) => <tr key={e.slug}><td>{e.name}</td><td>{labels[e.state] ?? e.state}</td><td>{format(e.today_upload_at)}</td><td>{format(e.heartbeat_at)}</td></tr>)}</tbody></table></div>
      <button className="ghost" type="button" disabled={busy} onClick={async () => { setBusy(true); try { await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>状態を更新</button>
    </>}
    {!snapshot && !error && <p>読み込み中...</p>}
  </section>;
}
