import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  verifyPassword,
  hashPassword,
  generateTempPassword,
  newSessionId,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from "./auth";
import { generateUploadToken, hashToken, retentionCutoffDate, storageKey, validateDailyLog, MAX_LOG_BYTES } from "./logs";
import { R2LogStorage } from "./storage";
import { monitorSnapshot, runLogMonitor, validateMonitorConfig, validateSlackWebhook } from "./log-monitor";

type Bindings = { DB: D1Database; LOGS: R2Bucket };
type Variables = { managerId: string; orgId: string };
const DEFAULT_RETENTION_DAYS = 90;

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// --- 認証不要 ---

app.post("/api/auth/signup", async (c) => {
  // 他社・他の人が、自分専用の組織を新規に作って使い始めるための入口
  const { org_name, email, password } = await c.req.json<{
    org_name: string;
    email: string;
    password: string;
  }>();
  if (!org_name?.trim() || !email?.trim() || !password || password.length < 8) {
    return c.json({ error: "組織名・メールアドレス・8文字以上のパスワードを入力してください" }, 400);
  }
  const orgId = crypto.randomUUID();
  const managerId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(orgId, org_name.trim()),
      c.env.DB.prepare("INSERT INTO managers (id, org_id, email, password_hash) VALUES (?, ?, ?, ?)").bind(
        managerId,
        orgId,
        email.trim(),
        passwordHash
      ),
    ]);
  } catch {
    return c.json({ error: "そのメールアドレスは既に使われています" }, 409);
  }
  const sessionId = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await c.env.DB.prepare("INSERT INTO sessions (id, manager_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionId, managerId, expiresAt)
    .run();
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const manager = await c.env.DB.prepare("SELECT id, password_hash FROM managers WHERE email = ?")
    .bind(email)
    .first<{ id: string; password_hash: string }>();
  if (!manager || !(await verifyPassword(password, manager.password_hash))) {
    return c.json({ error: "メールアドレスまたはパスワードが違います" }, 401);
  }
  const sessionId = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await c.env.DB.prepare("INSERT INTO sessions (id, manager_id, expires_at) VALUES (?, ?, ?)")
    .bind(sessionId, manager.id, expiresAt)
    .run();
  setCookie(c, SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
  return c.json({ ok: true });
});

// --- 認証ミドルウェア ---

const PUBLIC_PATHS = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/activity/ingest", // 独自のBearerトークンで別途チェックする
  "/api/reports/ingest", // 同上
];

// 各組織のINGEST_API_KEY(集計データ取り込み用トークン)からorg_idを解決する共通ヘルパー。
// 管理者Macのローカルスクリプト向けエンドポイント(集計取り込み・ログ一覧/取得・トークン再発行)で使う。
async function resolveIngestOrg(c: {
  env: Bindings;
  req: { header: (n: string) => string | undefined };
}): Promise<string | null> {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const secret = await c.env.DB.prepare("SELECT org_id FROM secrets WHERE key = 'ingest_token' AND value = ?")
    .bind(token)
    .first<{ org_id: string }>();
  return secret?.org_id ?? null;
}

async function resolveSession(c: { env: Bindings; req: { header: (n: string) => string | undefined } }, cookieValue: string | undefined) {
  if (!cookieValue) return null;
  const session = await c.env.DB.prepare(
    `SELECT s.manager_id as manager_id, s.expires_at as expires_at, m.org_id as org_id
     FROM sessions s JOIN managers m ON m.id = s.manager_id WHERE s.id = ?`
  )
    .bind(cookieValue)
    .first<{ manager_id: string; expires_at: string; org_id: string }>();
  if (!session || new Date(session.expires_at) < new Date()) return null;
  return session;
}

app.use("/api/*", async (c, next) => {
  const isPublicSettingsGet = c.req.path === "/api/settings" && c.req.method === "GET";
  const isPublicBySlug = c.req.path.match(/^\/api\/employees\/by-slug\/[^/]+\/[^/]+\/public$/);

  const isBearerNotionTokenGet = c.req.path === "/api/notion-token" && c.req.method === "GET";

  // 直接アップロード方式(docs/decisions/0003): 社員トークン/INGEST_API_KEYで自前認証する経路
  const isEmployeeLogUpload = c.req.path === "/api/logs/upload" && c.req.method === "POST";
  const isLogHeartbeat = c.req.path === "/api/logs/heartbeat" && c.req.method === "POST";
  const isMonitorCheck = c.req.path === "/api/log-monitor/check" && c.req.method === "POST";
  const isBearerLogsGet = /^\/api\/logs(\/|$)/.test(c.req.path) && c.req.method === "GET";
  const isBearerUploadTokenRotate =
    /^\/api\/employees\/by-slug\/[^/]+\/upload-token\/rotate$/.test(c.req.path) && c.req.method === "POST";
  const isBearerRetention = c.req.path === "/api/logs/retention" && c.req.method === "POST";

  if (
    PUBLIC_PATHS.includes(c.req.path) ||
    isPublicBySlug ||
    isBearerNotionTokenGet ||
    isEmployeeLogUpload ||
    isLogHeartbeat ||
    isMonitorCheck ||
    isBearerLogsGet ||
    isBearerUploadTokenRotate ||
    isBearerRetention
  )
    return next();

  if (isPublicSettingsGet) {
    // ログイン済みならセッションからorgを、未ログインなら?orgクエリを使う(社員のセットアップスクリプト用)
    const session = await resolveSession(c, getCookie(c, SESSION_COOKIE));
    if (session) {
      c.set("managerId", session.manager_id);
      c.set("orgId", session.org_id);
    }
    return next();
  }

  const sessionId = getCookie(c, SESSION_COOKIE);
  const session = await resolveSession(c, sessionId);
  if (!session) {
    deleteCookie(c, SESSION_COOKIE);
    return c.json({ error: "ログインが必要です" }, 401);
  }
  c.set("managerId", session.manager_id);
  c.set("orgId", session.org_id);
  return next();
});

app.post("/api/auth/logout", async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE);
  if (sessionId) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  deleteCookie(c, SESSION_COOKIE);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const manager = await c.env.DB.prepare(
    "SELECT m.email as email, o.name as org_name, o.id as org_id FROM managers m JOIN organizations o ON o.id = m.org_id WHERE m.id = ?"
  )
    .bind(c.get("managerId"))
    .first<{ email: string; org_name: string; org_id: string }>();
  return c.json({ email: manager?.email ?? null, org_name: manager?.org_name ?? null, org_id: manager?.org_id ?? null });
});

// --- 設定(共有ドライブのパス・Notionページ) ---

const SETTINGS_KEYS = ["shared_drive_path", "notion_report_db_url", "log_retention_days"] as const;

app.get("/api/settings", async (c) => {
  // 未ログインでも読める公開エンドポイント(社員のセットアップスクリプト用)なので、org指定が必須
  const orgId = c.get("orgId") ?? c.req.query("org");
  if (!orgId) return c.json({ error: "org(組織ID)が必要です" }, 400);
  const { results } = await c.env.DB.prepare("SELECT key, value FROM settings WHERE org_id = ?")
    .bind(orgId)
    .all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const row of results) map[row.key] = row.value;
  return c.json(map);
});

app.put("/api/settings", async (c) => {
  const orgId = c.get("orgId");
  const body = await c.req.json<Record<string, string>>();
  const stmts = SETTINGS_KEYS.filter((k) => k in body).map((k) =>
    c.env.DB.prepare(
      "INSERT INTO settings (org_id, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).bind(orgId, k, body[k])
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true });
});

// --- 集計データの取り込み(各組織の管理者Macから、組織ごとの独自トークンで送られてくる) ---

app.post("/api/ingest-token/rotate", async (c) => {
  const orgId = c.get("orgId");
  const token = generateTempPassword() + generateTempPassword();
  await c.env.DB.prepare(
    "INSERT INTO secrets (org_id, key, value) VALUES (?, 'ingest_token', ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value"
  )
    .bind(orgId, token)
    .run();
  return c.json({ token });
});

// --- Notion連携トークン(組織ごと。値は書き込み専用、読み出しでは設定済みかどうかだけ返す) ---

app.put("/api/notion-token", async (c) => {
  const { token } = await c.req.json<{ token: string }>();
  if (!token?.trim()) return c.json({ error: "トークンを入力してください" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO secrets (org_id, key, value) VALUES (?, 'notion_token', ?) ON CONFLICT(org_id, key) DO UPDATE SET value = excluded.value"
  )
    .bind(c.get("orgId"), token.trim())
    .run();
  return c.json({ ok: true });
});

app.get("/api/notion-token/status", async (c) => {
  const row = await c.env.DB.prepare("SELECT 1 as x FROM secrets WHERE org_id = ? AND key = 'notion_token'")
    .bind(c.get("orgId"))
    .first();
  return c.json({ configured: !!row });
});

// 管理者Macのローカルスクリプトが、自分のINGEST_API_KEYを使って実際のトークン値を取りに来る用。
// ?employee=<slug> を付けると、その社員に個別のNotion書き込み先が設定されていればそちらを優先して返す。
// 認証済みルートなので、この時に登録済みの氏名(name)も一緒に返す(表示名の正本はこちら経由でのみ取得する)。
app.get("/api/notion-token", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);

  const employeeSlug = c.req.query("employee");
  let name: string | null = null;
  if (employeeSlug) {
    const emp = await c.env.DB.prepare(
      "SELECT name, notion_token, notion_report_db_url FROM employees WHERE org_id = ? AND slug = ?"
    )
      .bind(orgId, employeeSlug)
      .first<{ name: string | null; notion_token: string | null; notion_report_db_url: string | null }>();
    name = emp?.name ?? null;
    if (emp?.notion_token) {
      return c.json({ token: emp.notion_token, report_db_url: emp.notion_report_db_url ?? null, name });
    }
  }

  const tokenRow = await c.env.DB.prepare("SELECT value FROM secrets WHERE org_id = ? AND key = 'notion_token'")
    .bind(orgId)
    .first<{ value: string }>();
  return c.json({ token: tokenRow?.value ?? null, report_db_url: null, name });
});

app.post("/api/activity/ingest", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const { employee_slug, date, apps } = await c.req.json<{
    employee_slug: string;
    date: string;
    apps: { app: string; seconds: number }[];
  }>();
  if (!employee_slug || !date || !Array.isArray(apps)) {
    return c.json({ error: "employee_slug, date, apps は必須です" }, 400);
  }
  const stmts = apps.map((a) =>
    c.env.DB.prepare(
      "INSERT INTO activity (org_id, employee_slug, date, app, seconds) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, employee_slug, date, app) DO UPDATE SET seconds = excluded.seconds"
    ).bind(orgId, employee_slug, date, a.app, a.seconds)
  );
  if (stmts.length) await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: stmts.length });
});

// --- レポート本文(要約・タイムライン)の取り込みと閲覧 ---

app.post("/api/reports/ingest", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const body = await c.req.json<{
    employee_slug: string;
    employee_name: string;
    date: string;
    active_hours?: number;
    window_count?: number;
    summary?: string;
    waste_notes?: string;
    automation_notes?: string;
    source_upload_version?: string;
    timeline?: { time_range: string; duration: string; main_app: string; description: string }[];
  }>();
  if (!body.employee_slug || !body.date) {
    return c.json({ error: "employee_slug, date は必須です" }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO reports (org_id, employee_slug, date, employee_name, active_hours, window_count, summary, waste_notes, automation_notes, timeline_json, source_upload_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(org_id, employee_slug, date) DO UPDATE SET
       employee_name = excluded.employee_name, active_hours = excluded.active_hours, window_count = excluded.window_count,
       summary = excluded.summary, waste_notes = excluded.waste_notes, automation_notes = excluded.automation_notes,
       timeline_json = excluded.timeline_json, source_upload_version = excluded.source_upload_version, updated_at = CURRENT_TIMESTAMP`
  )
    .bind(
      orgId,
      body.employee_slug,
      body.date,
      body.employee_name ?? body.employee_slug,
      body.active_hours ?? null,
      body.window_count ?? null,
      body.summary ?? null,
      body.waste_notes ?? null,
      body.automation_notes ?? null,
      JSON.stringify(body.timeline ?? []),
      body.source_upload_version ?? null
    )
    .run();
  return c.json({ ok: true });
});

app.get("/api/reports", async (c) => {
  const orgId = c.get("orgId");
  const employee = c.req.query("employee");
  const query = employee
    ? c.env.DB.prepare(
        "SELECT employee_slug, employee_name, date, active_hours, window_count FROM reports WHERE org_id = ? AND employee_slug = ? ORDER BY date DESC LIMIT 60"
      ).bind(orgId, employee)
    : c.env.DB.prepare(
        "SELECT employee_slug, employee_name, date, active_hours, window_count FROM reports WHERE org_id = ? ORDER BY date DESC LIMIT 60"
      ).bind(orgId);
  const { results } = await query.all();
  return c.json(results);
});

app.get("/api/reports/:slug/:date", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM reports WHERE org_id = ? AND employee_slug = ? AND date = ?")
    .bind(c.get("orgId"), c.req.param("slug"), c.req.param("date"))
    .first();
  if (!row) return c.json({ error: "見つかりません" }, 404);
  return c.json({ ...row, timeline: JSON.parse((row.timeline_json as string) || "[]") });
});

app.get("/api/activity/summary", async (c) => {
  const orgId = c.get("orgId");
  const employee = c.req.query("employee"); // 省略時は社内全体
  const days = Number(c.req.query("days") ?? "30");
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const query = employee
    ? c.env.DB.prepare(
        "SELECT app, SUM(seconds) as seconds FROM activity WHERE org_id = ? AND employee_slug = ? AND date >= ? GROUP BY app ORDER BY seconds DESC"
      ).bind(orgId, employee, since)
    : c.env.DB.prepare(
        "SELECT app, SUM(seconds) as seconds FROM activity WHERE org_id = ? AND date >= ? GROUP BY app ORDER BY seconds DESC"
      ).bind(orgId, since);
  const { results } = await query.all<{ app: string; seconds: number }>();
  const total = results.reduce((s, r) => s + r.seconds, 0);
  return c.json({ apps: results, total_seconds: total, days });
});

app.get("/api/activity/by-employee", async (c) => {
  const orgId = c.get("orgId");
  const days = Number(c.req.query("days") ?? "30");
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const { results } = await c.env.DB.prepare(
    `SELECT e.name as name, e.slug as slug, COALESCE(SUM(a.seconds), 0) as seconds
     FROM employees e
     LEFT JOIN activity a ON a.employee_slug = e.slug AND a.org_id = e.org_id AND a.date >= ?
     WHERE e.org_id = ?
     GROUP BY e.slug ORDER BY seconds DESC`
  )
    .bind(since, orgId)
    .all<{ name: string; slug: string; seconds: number }>();
  return c.json({ employees: results, days });
});

// --- 直接アップロード方式(docs/decisions/0003): 社員PCから日次ログを直接受け取る ---

app.get("/api/log-monitor", async (c) => {
  const snapshot = await monitorSnapshot(c.env.DB, c.get("orgId"));
  return c.json({ config: snapshot.config, employees: snapshot.employees, webhookConfigured: Boolean(snapshot.stored?.webhook_url),
    lastCheckedAt: snapshot.stored?.last_checked_at ?? null, lastNotifiedAt: snapshot.stored?.last_notified_at ?? null, lastError: snapshot.stored?.last_error ?? null });
});
app.put("/api/log-monitor", async (c) => {
  let config, webhook: string | undefined;
  try {
    const body = await c.req.json<{ config: unknown; webhook?: string }>();
    config = validateMonitorConfig(body.config);
    if (body.webhook !== undefined) webhook = body.webhook === "" ? "" : validateSlackWebhook(body.webhook);
  } catch { return c.json({ error: "通知設定またはSlack Webhookの形式を確認してください。" }, 400); }
  const previous = await monitorSnapshot(c.env.DB, c.get("orgId"));
  const enabledAt = !previous.config.enabled && config.enabled ? new Date().toISOString() : previous.stored?.enabled_at ?? new Date().toISOString();
  await c.env.DB.prepare(`INSERT INTO log_monitor (org_id, config_json, webhook_url, enabled_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id) DO UPDATE SET config_json=excluded.config_json,
    notified_signature=CASE WHEN COALESCE(log_monitor.webhook_url,'') != COALESCE(excluded.webhook_url,'') THEN '' ELSE log_monitor.notified_signature END,
    webhook_url=excluded.webhook_url, enabled_at=excluded.enabled_at`)
    .bind(c.get("orgId"), JSON.stringify(config), webhook === undefined ? previous.stored?.webhook_url ?? null : webhook || null, enabledAt).run();
  return c.json({ ok: true });
});
app.post("/api/log-monitor/check", async (c) => {
  const orgId = await resolveIngestOrg(c) ?? (await resolveSession(c, getCookie(c, SESSION_COOKIE)))?.org_id;
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  return c.json(await runLogMonitor(c.env.DB, orgId));
});
app.post("/api/logs/heartbeat", async (c) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer /, "");
  if (!token) return c.json({ error: "認証に失敗しました" }, 401);
  const employee = await c.env.DB.prepare("SELECT org_id, slug, monitoring_enabled FROM employees WHERE upload_token_hash=?")
    .bind(await hashToken(token)).first<{ org_id: string; slug: string; monitoring_enabled: number }>();
  if (!employee) return c.json({ error: "認証に失敗しました" }, 401);
  if (!employee.monitoring_enabled) return c.json({ skipped: true });
  let body;
  try { body = await c.req.json<{ collection_ok: boolean }>(); } catch { return c.json({ error: "形式が不正です" }, 400); }
  if (typeof body.collection_ok !== "boolean") return c.json({ error: "形式が不正です" }, 400);
  await c.env.DB.prepare(`INSERT INTO employee_log_health (org_id, employee_slug, heartbeat_at, collection_ok) VALUES (?, ?, ?, ?)
    ON CONFLICT(org_id, employee_slug) DO UPDATE SET heartbeat_at=excluded.heartbeat_at, collection_ok=excluded.collection_ok`)
    .bind(employee.org_id, employee.slug, new Date().toISOString(), body.collection_ok ? 1 : 0).run();
  return c.json({ ok: true });
});

// 社員PCの書き出しスクリプトが、社員専用・アップロード専用トークンで送ってくる。
// トークンはハッシュでしか照合しない(生の値はDBに残らない)。
app.post("/api/logs/upload", async (c) => {
  const auth = c.req.header("Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return c.json({ error: "認証に失敗しました" }, 401);
  const tokenHash = await hashToken(token);
  const employee = await c.env.DB.prepare(
    "SELECT org_id, slug, monitoring_enabled FROM employees WHERE upload_token_hash = ?"
  )
    .bind(tokenHash)
    .first<{ org_id: string; slug: string; monitoring_enabled: number }>();
  if (!employee) return c.json({ error: "認証に失敗しました" }, 401);

  if (employee.monitoring_enabled === 0) {
    // 監視オフの社員からは受け取らない(保存もしない)
    return c.json({ skipped: true, reason: "monitoring_off" });
  }

  const text = await c.req.text();
  const sizeBytes = new TextEncoder().encode(text).length;
  if (sizeBytes > MAX_LOG_BYTES) {
    return c.json({ error: "ログが大きすぎます(上限5MB)" }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return c.json({ error: "JSONとして解釈できません" }, 400);
  }

  const validation = validateDailyLog(body, employee.slug);
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const key = storageKey(employee.org_id, employee.slug, validation.date);
  const storage = new R2LogStorage(c.env.LOGS);
  await storage.put(key, text);

  await c.env.DB.prepare(
    `INSERT INTO uploads (org_id, employee_slug, date, storage_key, size, upload_version, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(org_id, employee_slug, date) DO UPDATE SET
       storage_key = excluded.storage_key, size = excluded.size, upload_version = excluded.upload_version, uploaded_at = CURRENT_TIMESTAMP`
  )
    .bind(employee.org_id, employee.slug, validation.date, key, sizeBytes, crypto.randomUUID())
    .run();

  return c.json({ ok: true, date: validation.date, size: sizeBytes });
});

// 管理者Mac側の集計スクリプトが、INGEST_API_KEYでその日のアップロード状況を取りに来る
app.get("/api/logs", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const date = c.req.query("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return c.json({ error: "date(YYYY-MM-DD)が必要です" }, 400);
  }
  const { results } = await c.env.DB.prepare(
    "SELECT employee_slug, date, size, uploaded_at FROM uploads WHERE org_id = ? AND date = ? ORDER BY employee_slug"
  )
    .bind(orgId, date)
    .all();
  return c.json(results);
});

// 集計サーバー(VPS)が「レポートを作り直す必要がある社員・日」を取りに来る(docs/decisions/0004)。
// 判定: アップロードの版が分析元の版と異なる、またはレポートがまだ無い。
// 版のない旧ログのみ時刻比較へフォールバックする。社員PCは起動中30分おきに過去数日分を送り直すため、
// 朝の1回きりの処理では取りこぼす「遅れて届いた分」をこれで拾う。
app.get("/api/logs/pending", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const from = c.req.query("from");
  const to = c.req.query("to");
  const isDate = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(from) || !isDate(to)) {
    return c.json({ error: "from/to(YYYY-MM-DD)が必要です" }, 400);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT u.employee_slug, u.date, u.uploaded_at, r.updated_at AS reported_at
       FROM uploads u
       LEFT JOIN reports r ON r.org_id = u.org_id AND r.employee_slug = u.employee_slug AND r.date = u.date
      WHERE u.org_id = ? AND u.date BETWEEN ? AND ?
        AND (r.updated_at IS NULL
          OR (u.upload_version IS NOT NULL AND u.upload_version IS NOT r.source_upload_version)
          OR (u.upload_version IS NULL AND u.uploaded_at > r.updated_at))
      ORDER BY u.date, u.employee_slug`
  )
    .bind(orgId, from, to)
    .all();
  return c.json(results);
});

// 同上。特定社員・特定日のログ本文(JSON)を取りに来る
app.get("/api/logs/:slug/:date", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const row = await c.env.DB.prepare(
    "SELECT storage_key, upload_version FROM uploads WHERE org_id = ? AND employee_slug = ? AND date = ?"
  )
    .bind(orgId, c.req.param("slug"), c.req.param("date"))
    .first<{ storage_key: string; upload_version: string | null }>();
  if (!row) return c.json({ error: "見つかりません" }, 404);
  const storage = new R2LogStorage(c.env.LOGS);
  const text = await storage.get(row.storage_key);
  if (text === null) return c.json({ error: "見つかりません" }, 404);
  return c.body(text, 200, {
    "Content-Type": "application/json",
    ...(row.upload_version ? { "X-Upload-Version": row.upload_version } : {}),
  });
});

// アップロードトークンの再発行。表示は1回だけ(以降サーバー側にはハッシュしか残らない)
app.post("/api/employees/:id/upload-token/rotate", async (c) => {
  const token = generateUploadToken();
  const tokenHash = await hashToken(token);
  const result = await c.env.DB.prepare(
    "UPDATE employees SET upload_token_hash = ?, upload_token_rotated_at = CURRENT_TIMESTAMP WHERE id = ? AND org_id = ?"
  )
    .bind(tokenHash, c.req.param("id"), c.get("orgId"))
    .run();
  // 存在しないidに対してトークンを返してしまわないよう、更新行数を確認する
  if (!result.meta.changes) return c.json({ error: "社員が見つかりません" }, 404);
  return c.json({ token });
});

// 同上。管理者スクリプトからslug指定で叩けるバージョン(INGEST_API_KEY認証)
app.post("/api/employees/by-slug/:slug/upload-token/rotate", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const token = generateUploadToken();
  const tokenHash = await hashToken(token);
  const result = await c.env.DB.prepare(
    "UPDATE employees SET upload_token_hash = ?, upload_token_rotated_at = CURRENT_TIMESTAMP WHERE slug = ? AND org_id = ?"
  )
    .bind(tokenHash, c.req.param("slug"), orgId)
    .run();
  // 存在しないslugに対してトークンを返してしまわないよう、更新行数を確認する
  if (!result.meta.changes) return c.json({ error: "社員が見つかりません" }, 404);
  return c.json({ token });
});

// --- マネージャー管理(ログイン中の人が、同じ組織内に招待できる) ---

app.get("/api/managers", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, email, created_at FROM managers WHERE org_id = ? ORDER BY created_at DESC"
  )
    .bind(c.get("orgId"))
    .all();
  return c.json(results);
});

app.post("/api/managers", async (c) => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email?.trim()) return c.json({ error: "メールアドレスを入力してください" }, 400);
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare("INSERT INTO managers (id, org_id, email, password_hash) VALUES (?, ?, ?, ?)")
      .bind(id, c.get("orgId"), email.trim(), passwordHash)
      .run();
  } catch {
    return c.json({ error: "そのメールアドレスは既に登録されています" }, 409);
  }
  return c.json({ id, email: email.trim(), tempPassword });
});

app.delete("/api/managers/:id", async (c) => {
  if (c.req.param("id") === c.get("managerId")) {
    return c.json({ error: "自分自身は削除できません" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM managers WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), c.get("orgId"))
    .run();
  return c.json({ ok: true });
});

// --- 社員管理 ---

app.get("/api/employees", async (c) => {
  // 各社員の最終アップロード(uploadsの最新1件)をLEFT JOINで一緒に返す。P4のUI(導入状況表示)用
  const { results } = await c.env.DB.prepare(
    `SELECT e.id as id, e.name as name, e.slug as slug, e.note as note, e.status as status,
            e.drive_path as drive_path, e.notion_page_url as notion_page_url,
            e.monitoring_enabled as monitoring_enabled, e.added_at as added_at,
            e.notion_report_db_url as notion_report_db_url, (e.notion_token IS NOT NULL) as has_notion_override,
            e.upload_token_rotated_at as upload_token_rotated_at, (e.upload_token_hash IS NOT NULL) as has_upload_token,
            u.uploaded_at as last_upload_at, u.date as last_upload_date
     FROM employees e
     LEFT JOIN (
       SELECT org_id, employee_slug, date, uploaded_at,
              ROW_NUMBER() OVER (PARTITION BY org_id, employee_slug ORDER BY uploaded_at DESC) as rn
       FROM uploads
     ) u ON u.org_id = e.org_id AND u.employee_slug = e.slug AND u.rn = 1
     WHERE e.org_id = ? ORDER BY e.added_at DESC`
  )
    .bind(c.get("orgId"))
    .all();
  return c.json(results);
});

// 社員本人のセットアップ・エクスポートスクリプトが認証無しで読む用(組織ID+自分のスラッグを指定して自分の格納先パス・監視オンオフを取得できる)
// 認証が無い公開エンドポイントなので、氏名(name)は含めない(取得はINGEST_API_KEYで認証する/api/notion-tokenへ)
app.get("/api/employees/by-slug/:orgId/:slug/public", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT drive_path, monitoring_enabled FROM employees WHERE org_id = ? AND slug = ?"
  )
    .bind(c.req.param("orgId"), c.req.param("slug"))
    .first<{ drive_path: string | null; monitoring_enabled: number }>();
  return c.json({
    drive_path: row?.drive_path ?? null,
    monitoring_enabled: row ? row.monitoring_enabled === 1 : true,
  });
});

app.patch("/api/employees/:id/monitoring", async (c) => {
  const { enabled } = await c.req.json<{ enabled: boolean }>();
  await c.env.DB.prepare("UPDATE employees SET monitoring_enabled = ? WHERE id = ? AND org_id = ?")
    .bind(enabled ? 1 : 0, c.req.param("id"), c.get("orgId"))
    .run();
  return c.json({ ok: true });
});

app.post("/api/employees", async (c) => {
  const orgId = c.get("orgId");
  const { name, note, drive_path, notion_page_url } = await c.req.json<{
    name: string;
    note?: string;
    drive_path?: string;
    notion_page_url?: string;
  }>();
  if (!name?.trim()) return c.json({ error: "名前を入力してください" }, 400);
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9぀-ヿ一-鿿]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      "INSERT INTO employees (id, org_id, name, slug, note, status, drive_path, notion_page_url) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)"
    )
      .bind(id, orgId, name.trim(), slug, note ?? null, drive_path ?? null, notion_page_url ?? null)
      .run();
  } catch {
    return c.json({ error: "同じ名前(スラッグ)の社員が既に登録されています" }, 409);
  }
  return c.json({
    id,
    name: name.trim(),
    slug,
    note: note ?? null,
    status: "pending",
    drive_path: drive_path ?? null,
    notion_page_url: notion_page_url ?? null,
  });
});

app.patch("/api/employees/:id", async (c) => {
  const body = await c.req.json<{
    name?: string;
    note?: string;
    drive_path?: string;
    notion_page_url?: string;
    notion_token?: string;
    notion_report_db_url?: string;
  }>();
  const fields = (
    ["name", "note", "drive_path", "notion_page_url", "notion_token", "notion_report_db_url"] as const
  ).filter((k) => k in body);
  if (!fields.length) return c.json({ error: "更新する項目がありません" }, 400);
  const setClause = fields.map((f) => `${f} = ?`).join(", ");
  await c.env.DB.prepare(`UPDATE employees SET ${setClause} WHERE id = ? AND org_id = ?`)
    .bind(...fields.map((f) => body[f] ?? null), c.req.param("id"), c.get("orgId"))
    .run();
  return c.json({ ok: true });
});

app.patch("/api/employees/:id/status", async (c) => {
  const { status } = await c.req.json<{ status: string }>();
  if (!["pending", "active"].includes(status)) return c.json({ error: "不正な値です" }, 400);
  await c.env.DB.prepare("UPDATE employees SET status = ? WHERE id = ? AND org_id = ?")
    .bind(status, c.req.param("id"), c.get("orgId"))
    .run();
  return c.json({ ok: true });
});

app.delete("/api/employees/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM employees WHERE id = ? AND org_id = ?")
    .bind(c.req.param("id"), c.get("orgId"))
    .run();
  return c.json({ ok: true });
});

// --- 生ログの保管期間管理(日次cron) ---
// 組織ごとの settings.log_retention_days(未設定なら既定90日)より古い日付のuploadsを、
// R2オブジェクトごと削除する。集計・レポート(D1のactivity/reports)は対象外で残す。
// 1組織分の削除処理。cron(scheduled)と、管理者スクリプトからのPOST /api/logs/retention の両方から使う。
// (Workers無料プランはcronがアカウント全体で5個までのため、cronが登録できない環境では
//  毎朝のレポート生成スクリプトがこのエンドポイントを叩いて同じ処理を行う)
async function runRetentionForOrg(env: Bindings, orgId: string, now = new Date()) {
  const storage = new R2LogStorage(env.LOGS);
  const settingRow = await env.DB.prepare(
    "SELECT value FROM settings WHERE org_id = ? AND key = 'log_retention_days'"
  )
    .bind(orgId)
    .first<{ value: string }>();
  const parsedDays = settingRow?.value ? Number(settingRow.value) : NaN;
  const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : DEFAULT_RETENTION_DAYS;
  const cutoff = retentionCutoffDate(now, days);

  const { results: expired } = await env.DB.prepare(
    "SELECT storage_key FROM uploads WHERE org_id = ? AND date < ?"
  )
    .bind(orgId, cutoff)
    .all<{ storage_key: string }>();

  for (const row of expired) {
    await storage.delete(row.storage_key);
  }
  if (expired.length) {
    await env.DB.prepare("DELETE FROM uploads WHERE org_id = ? AND date < ?").bind(orgId, cutoff).run();
  }
  console.log(`[retention] org=${orgId} days=${days} cutoff=${cutoff} deleted=${expired.length}`);
  return { days, cutoff, deleted: expired.length };
}

// 管理者Macの日次スクリプトから叩く(INGEST_API_KEY認証)。その組織の期限切れ生ログを削除する
app.post("/api/logs/retention", async (c) => {
  const orgId = await resolveIngestOrg(c);
  if (!orgId) return c.json({ error: "認証に失敗しました" }, 401);
  const result = await runRetentionForOrg(c.env, orgId);
  return c.json({ ok: true, ...result });
});

async function scheduled(_event: ScheduledEvent, env: Bindings): Promise<void> {
  const { results: orgs } = await env.DB.prepare("SELECT id FROM organizations").all<{ id: string }>();
  for (const org of orgs) {
    await runRetentionForOrg(env, org.id);
  }
}

export default { fetch: app.fetch, scheduled };
