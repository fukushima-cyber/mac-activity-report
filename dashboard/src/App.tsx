import { useEffect, useState } from "react";
import "./App.css";

type Manager = {
  id: string;
  email: string;
  created_at: string;
};

type Employee = {
  id: string;
  name: string;
  slug: string;
  note: string | null;
  status: "pending" | "active";
  drive_path: string | null;
  notion_page_url: string | null;
  notion_report_db_url: string | null;
  has_notion_override: number;
  monitoring_enabled: number;
  added_at: string;
};

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...opts?.headers },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `エラー(${res.status})`);
  }
  return res.json();
}

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      } else {
        await api("/api/auth/signup", {
          method: "POST",
          body: JSON.stringify({ org_name: orgName, email, password }),
        });
      }
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "失敗しました");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>社員稼働レポート管理</h1>
        {mode === "signup" && (
          <label>
            組織名(会社名・屋号など)
            <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
          </label>
        )}
        <label>
          メールアドレス
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          パスワード
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === "signup" ? 8 : undefined}
            required
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? "処理中..." : mode === "login" ? "ログイン" : "組織を新規作成"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setMode(mode === "login" ? "signup" : "login");
            setError(null);
          }}
        >
          {mode === "login" ? "新しい組織としてはじめる" : "ログインに戻る"}
        </button>
      </form>
    </div>
  );
}

type Settings = {
  shared_drive_path?: string;
  notion_report_db_url?: string;
  notion_apps_db_url?: string;
};

function SettingsSection() {
  const [settings, setSettings] = useState<Settings>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ingestToken, setIngestToken] = useState<string | null>(null);
  const [notionTokenConfigured, setNotionTokenConfigured] = useState(false);
  const [notionTokenInput, setNotionTokenInput] = useState("");
  const [notionTokenSaved, setNotionTokenSaved] = useState(false);

  useEffect(() => {
    api<Settings>("/api/settings").then(setSettings).catch((e) => setError(e.message));
    api<{ configured: boolean }>("/api/notion-token/status")
      .then((r) => setNotionTokenConfigured(r.configured))
      .catch(() => {});
  }, []);

  const saveNotionToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notionTokenInput.trim()) return;
    try {
      await api("/api/notion-token", { method: "PUT", body: JSON.stringify({ token: notionTokenInput.trim() }) });
      setNotionTokenConfigured(true);
      setNotionTokenInput("");
      setNotionTokenSaved(true);
      setTimeout(() => setNotionTokenSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    }
  };

  const rotateToken = async () => {
    if (!confirm("取り込み用トークンを新しく発行します。今使っているreport/.envのトークンは無効になります。よろしいですか?")) return;
    const { token } = await api<{ token: string }>("/api/ingest-token/rotate", { method: "POST" });
    setIngestToken(token);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    }
  };

  return (
    <section className="add-form">
      <h2>基本設定</h2>
      <form className="settings-form" onSubmit={save}>
        <label>
          共有ドライブのパス(Google Driveの、社員のログを集めるフォルダ)
          <input
            placeholder="/Users/xxx/Google Drive/.../社員稼働ログ/テストログ"
            value={settings.shared_drive_path ?? ""}
            onChange={(e) => setSettings({ ...settings, shared_drive_path: e.target.value })}
          />
        </label>
        <label>
          Notion「社員稼働レポート」データベースのURL
          <input
            placeholder="https://app.notion.com/p/..."
            value={settings.notion_report_db_url ?? ""}
            onChange={(e) => setSettings({ ...settings, notion_report_db_url: e.target.value })}
          />
        </label>
        <label>
          Notion「アプリ別集計」データベースのURL
          <input
            placeholder="https://app.notion.com/p/..."
            value={settings.notion_apps_db_url ?? ""}
            onChange={(e) => setSettings({ ...settings, notion_apps_db_url: e.target.value })}
          />
        </label>
        <button type="submit">保存</button>
        {saved && <span className="saved-badge">保存しました</span>}
      </form>
      {error && <p className="error">{error}</p>}
      <p className="hint">
        共有ドライブのパスは、社員のセットアップコマンドが自動で読み込みます(セットアップ時に手入力する必要がなくなります)。NotionのURLは、日次レポート生成スクリプトがどのデータベースに書き込むかの参照先です。1人1日=1ページで、ページを開くと時間帯ごとのタイムラインが載ります。
      </p>

      <hr className="divider" />
      <p className="hint">
        <strong>Notion連携: {notionTokenConfigured ? "設定済み" : "未設定"}</strong>
        <br />
        Notionで「連携(インテグレーション)」を作成し、対象のデータベース2つ(社員稼働レポート・アプリ別集計)にその連携を共有した上で、発行されたトークンをここに貼り付けてください。このトークンだけで、あなたの組織専用にNotionへ書き込めるようになります(あなた個人のNotionアカウントに依存しません)。
      </p>
      <form className="settings-form" onSubmit={saveNotionToken}>
        <label>
          Notion連携トークン
          <input
            type="password"
            placeholder="ntn_..."
            value={notionTokenInput}
            onChange={(e) => setNotionTokenInput(e.target.value)}
          />
        </label>
        <button type="submit">保存</button>
        {notionTokenSaved && <span className="saved-badge">保存しました</span>}
      </form>

      <hr className="divider" />
      <p className="hint">
        下の管理者用Mac(report/.env)のトークンは、集計データ・レポート本文をこのダッシュボードへ送るため、またNotionトークンを取得するために使います。発行し直すと古いトークンは使えなくなります。
      </p>
      {ingestToken ? (
        <div className="callout">
          <p>
            発行しました。<code>report/.env</code> に <code>INGEST_API_KEY=&lt;下の値&gt;</code> として保存してください(この画面を閉じると二度と表示されません)。
          </p>
          <div className="command-row">
            <code>{ingestToken}</code>
          </div>
          <button className="ghost" onClick={() => setIngestToken(null)}>
            閉じる
          </button>
        </div>
      ) : (
        <button type="button" className="ghost" onClick={rotateToken}>
          取り込み用トークンを発行
        </button>
      )}
    </section>
  );
}

function ManagerSection({ myEmail }: { myEmail: string }) {
  const [managers, setManagers] = useState<Manager[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<{ email: string; tempPassword: string } | null>(null);

  const load = () => api<Manager[]>("/api/managers").then(setManagers).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await api<Manager & { tempPassword: string }>("/api/managers", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setEmail("");
      setInvited({ email: created.email, tempPassword: created.tempPassword });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "招待に失敗しました");
    }
  };

  const remove = async (m: Manager) => {
    if (!confirm(`${m.email} のログイン権限を削除しますか?`)) return;
    try {
      await api(`/api/managers/${m.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "削除に失敗しました");
    }
  };

  return (
    <section className="add-form">
      <h2>ログイン権限を発行</h2>

      {invited && (
        <div className="callout">
          <p>
            <strong>{invited.email}</strong> を招待しました。下の一時パスワードを本人に伝えてください(この画面を閉じると二度と表示されません)。
          </p>
          <div className="command-row">
            <code>{invited.tempPassword}</code>
          </div>
          <button className="ghost" onClick={() => setInvited(null)}>
            閉じる
          </button>
        </div>
      )}

      <form onSubmit={invite}>
        <input
          type="email"
          placeholder="マネージャーのメールアドレス"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <button type="submit">権限を発行</button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="manager-list">
        {managers.map((m) => (
          <li key={m.id}>
            <span>{m.email}</span>
            {m.email !== myEmail && (
              <button className="ghost small danger" onClick={() => remove(m)}>
                削除
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatHours(seconds: number): string {
  return (seconds / 3600).toFixed(1) + "h";
}

function AnalyticsSection({ employees }: { employees: Employee[] }) {
  const [target, setTarget] = useState("__all__");
  const [days, setDays] = useState(30);
  const [apps, setApps] = useState<{ app: string; seconds: number }[]>([]);
  const [total, setTotal] = useState(0);
  const [byEmployee, setByEmployee] = useState<{ name: string; slug: string; seconds: number }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const employeeParam = target === "__all__" ? "" : `&employee=${encodeURIComponent(target)}`;
    api<{ apps: typeof apps; total_seconds: number }>(`/api/activity/summary?days=${days}${employeeParam}`)
      .then((r) => {
        setApps(r.apps);
        setTotal(r.total_seconds);
      })
      .catch((e) => setError(e.message));
    api<{ employees: typeof byEmployee }>(`/api/activity/by-employee?days=${days}`)
      .then((r) => setByEmployee(r.employees))
      .catch((e) => setError(e.message));
  }, [target, days]);

  const maxAppSeconds = Math.max(1, ...apps.map((a) => a.seconds));
  const maxEmployeeSeconds = Math.max(1, ...byEmployee.map((e) => e.seconds));

  return (
    <section className="add-form">
      <h2>アプリ別の利用時間</h2>
      <div className="analytics-controls">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="__all__">社内全体</option>
          {employees.map((emp) => (
            <option key={emp.slug} value={emp.slug}>
              {emp.name}
            </option>
          ))}
        </select>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>直近7日</option>
          <option value={30}>直近30日</option>
          <option value={90}>直近90日</option>
        </select>
      </div>
      {error && <p className="error">{error}</p>}

      <p className="hint">合計 {formatHours(total)}(直近{days}日・{target === "__all__" ? "社内全体" : "選択した社員"})</p>

      <div className="bar-list">
        {apps.length === 0 && <p className="empty">まだ集計データがありません(日次レポート生成後に反映されます)</p>}
        {apps.map((a) => (
          <div className="bar-row" key={a.app}>
            <span className="bar-label">{a.app}</span>
            <div className="bar-track">
              <div className="bar-fill" style={{ width: `${(a.seconds / maxAppSeconds) * 100}%` }} />
            </div>
            <span className="bar-value">{formatHours(a.seconds)}</span>
          </div>
        ))}
      </div>

      {target === "__all__" && byEmployee.length > 0 && (
        <>
          <h2 style={{ marginTop: "1.5rem" }}>社員別の稼働時間</h2>
          <div className="bar-list">
            {byEmployee.map((e) => (
              <div className="bar-row" key={e.slug}>
                <span className="bar-label">{e.name}</span>
                <div className="bar-track">
                  <div className="bar-fill alt" style={{ width: `${(e.seconds / maxEmployeeSeconds) * 100}%` }} />
                </div>
                <span className="bar-value">{formatHours(e.seconds)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function EmployeesSection({
  employees,
  load,
  orgId,
}: {
  employees: Employee[];
  load: () => void;
  orgId: string;
}) {
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [drivePath, setDrivePath] = useState("");
  const [notionPageUrl, setNotionPageUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Employee | null>(null);
  const [copied, setCopied] = useState(false);

  const addEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const created = await api<Employee>("/api/employees", {
        method: "POST",
        body: JSON.stringify({ name, note, drive_path: drivePath, notion_page_url: notionPageUrl }),
      });
      setName("");
      setNote("");
      setDrivePath("");
      setNotionPageUrl("");
      setJustAdded(created);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "追加に失敗しました");
    }
  };

  const toggleStatus = async (emp: Employee) => {
    const next = emp.status === "pending" ? "active" : "pending";
    await api(`/api/employees/${emp.id}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: next }),
    });
    load();
  };

  const toggleMonitoring = async (emp: Employee) => {
    const enabling = emp.monitoring_enabled !== 1;
    if (!enabling && !confirm(`${emp.name} の監視をオフにしますか?(次回のログ書き出しから記録が止まります)`)) return;
    await api(`/api/employees/${emp.id}/monitoring`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: enabling }),
    });
    load();
  };

  const remove = async (emp: Employee) => {
    if (!confirm(`${emp.name} を削除しますか?`)) return;
    await api(`/api/employees/${emp.id}`, { method: "DELETE" });
    load();
  };

  const editField = async (
    emp: Employee,
    field: "drive_path" | "notion_page_url" | "notion_report_db_url",
    label: string
  ) => {
    const value = prompt(`${emp.name} の${label}`, emp[field] ?? "");
    if (value === null) return;
    await api(`/api/employees/${emp.id}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) });
    load();
  };

  // Notionトークンは秘密情報なので、現在値を画面に出さず常に空欄から入力させる
  const editNotionTokenOverride = async (emp: Employee) => {
    const value = prompt(
      `${emp.name} 専用のNotion連携トークン(組織共通ではなく、この人だけ別のNotionアカウントに書き込みたい場合に設定)`,
      ""
    );
    if (value === null || !value.trim()) return;
    await api(`/api/employees/${emp.id}`, {
      method: "PATCH",
      body: JSON.stringify({ notion_token: value.trim() }),
    });
    load();
  };

  const setupCommand = (slug: string) =>
    `cd mac-activity-report && EMPLOYEE_NAME=${slug} ORG_ID=${orgId} ./agent/setup-employee-mac.sh`;

  const copyCommand = async (slug: string) => {
    await navigator.clipboard.writeText(setupCommand(slug));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      {justAdded && (
        <div className="callout">
          <p>
            <strong>{justAdded.name}</strong> を追加しました。本人のMacで、下のコマンドを1回実行してもらってください。
          </p>
          <div className="command-row">
            <code>{setupCommand(justAdded.slug)}</code>
            <button onClick={() => copyCommand(justAdded.slug)}>{copied ? "コピー済み" : "コピー"}</button>
          </div>
          <button className="ghost" onClick={() => setJustAdded(null)}>
            閉じる
          </button>
        </div>
      )}

      <section className="add-form">
        <h2>社員を追加</h2>
        <form onSubmit={addEmployee} className="multi-row-form">
          <div className="form-row">
            <input placeholder="名前(例: 田中太郎)" value={name} onChange={(e) => setName(e.target.value)} required />
            <input placeholder="メモ(任意)" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="form-row">
            <input
              placeholder="格納先パス(本人のGoogle Driveの共有フォルダ。任意・後で編集可)"
              value={drivePath}
              onChange={(e) => setDrivePath(e.target.value)}
            />
            <input
              placeholder="NotionページURL(任意・後で編集可)"
              value={notionPageUrl}
              onChange={(e) => setNotionPageUrl(e.target.value)}
            />
            <button type="submit">追加</button>
          </div>
        </form>
        {error && <p className="error">{error}</p>}
      </section>

      <section>
        <h2>社員一覧({employees.length}名)</h2>
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>メモ</th>
              <th>状態</th>
              <th>監視</th>
              <th>格納先パス</th>
              <th>Notionページ</th>
              <th>Notion書き込み先(個別)</th>
              <th>セットアップコマンド</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {employees.map((emp) => (
              <tr key={emp.id}>
                <td>{emp.name}</td>
                <td>{emp.note ?? "-"}</td>
                <td>
                  <button className={`status-badge ${emp.status}`} onClick={() => toggleStatus(emp)}>
                    {emp.status === "active" ? "導入済み" : "未導入"}
                  </button>
                </td>
                <td>
                  <button
                    className={`status-badge ${emp.monitoring_enabled === 1 ? "active" : "pending"}`}
                    onClick={() => toggleMonitoring(emp)}
                  >
                    {emp.monitoring_enabled === 1 ? "監視中" : "オフ"}
                  </button>
                </td>
                <td className="truncate-cell" title={emp.drive_path ?? ""}>
                  <button className="ghost small" onClick={() => editField(emp, "drive_path", "格納先パス")}>
                    {emp.drive_path ? "編集" : "登録"}
                  </button>
                </td>
                <td>
                  {emp.notion_page_url ? (
                    <a href={emp.notion_page_url} target="_blank" rel="noreferrer">
                      開く
                    </a>
                  ) : null}{" "}
                  <button className="ghost small" onClick={() => editField(emp, "notion_page_url", "NotionページURL")}>
                    {emp.notion_page_url ? "編集" : "登録"}
                  </button>
                </td>
                <td className="truncate-cell" title={emp.notion_report_db_url ?? ""}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", alignItems: "flex-start" }}>
                    <span className={`status-badge ${emp.has_notion_override ? "active" : "pending"}`}>
                      {emp.has_notion_override ? "個別設定あり" : "組織共通"}
                    </span>
                    <button className="ghost small" onClick={() => editNotionTokenOverride(emp)}>
                      トークン登録
                    </button>
                    <button
                      className="ghost small"
                      onClick={() => editField(emp, "notion_report_db_url", "個別のNotion書き込み先データベースURL")}
                    >
                      {emp.notion_report_db_url ? "書き込み先DB編集" : "書き込み先DB登録"}
                    </button>
                  </div>
                </td>
                <td>
                  <button className="ghost small" onClick={() => copyCommand(emp.slug)}>
                    コマンドをコピー
                  </button>
                </td>
                <td>
                  <button className="ghost small danger" onClick={() => remove(emp)}>
                    削除
                  </button>
                </td>
              </tr>
            ))}
            {employees.length === 0 && (
              <tr>
                <td colSpan={9} className="empty">
                  まだ社員が登録されていません
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="table-hint">
          状態バッジをクリックすると「導入済み / 未導入」を、監視バッジをクリックすると「監視中 / オフ」を切り替えられます(オフにすると次回のログ書き出しから記録が止まります)
        </p>
      </section>
    </div>
  );
}

type ReportListItem = {
  employee_slug: string;
  employee_name: string;
  date: string;
  active_hours: number | null;
  window_count: number | null;
};

type ReportDetail = ReportListItem & {
  summary: string | null;
  waste_notes: string | null;
  automation_notes: string | null;
  timeline: { time_range: string; duration: string; main_app: string; description: string }[];
};

function ReportsSection({ employees }: { employees: Employee[] }) {
  const [target, setTarget] = useState("__all__");
  const [list, setList] = useState<ReportListItem[]>([]);
  const [selected, setSelected] = useState<ReportDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = target === "__all__" ? "" : `?employee=${encodeURIComponent(target)}`;
    api<ReportListItem[]>(`/api/reports${q}`).then(setList).catch((e) => setError(e.message));
    setSelected(null);
  }, [target]);

  const open = (r: ReportListItem) => {
    api<ReportDetail>(`/api/reports/${encodeURIComponent(r.employee_slug)}/${encodeURIComponent(r.date)}`)
      .then(setSelected)
      .catch((e) => setError(e.message));
  };

  return (
    <section className="add-form">
      <h2>日次レポート</h2>
      <div className="analytics-controls">
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="__all__">社内全体</option>
          {employees.map((emp) => (
            <option key={emp.slug} value={emp.slug}>
              {emp.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}

      <div className="report-layout">
        <ul className="report-list">
          {list.map((r) => (
            <li key={`${r.employee_slug}_${r.date}`}>
              <button
                className={selected?.date === r.date && selected?.employee_slug === r.employee_slug ? "active" : ""}
                onClick={() => open(r)}
              >
                <strong>{r.date}</strong>
                <span>{r.employee_name}</span>
                <span className="muted">
                  {r.active_hours != null ? `${r.active_hours}h` : "-"} / {r.window_count ?? "-"}回
                </span>
              </button>
            </li>
          ))}
          {list.length === 0 && <p className="empty">まだレポートがありません(日次レポート生成後に反映されます)</p>}
        </ul>

        <div className="report-detail">
          {!selected && <p className="empty">左の一覧からレポートを選んでください</p>}
          {selected && (
            <>
              <h3>
                {selected.employee_name} — {selected.date}
              </h3>
              <p className="muted">
                稼働時間 {selected.active_hours != null ? `${selected.active_hours}h` : "不明"} / ウィンドウ切替{" "}
                {selected.window_count ?? "不明"}回
              </p>

              {selected.summary && (
                <>
                  <h4>作業内容の要約</h4>
                  <p>{selected.summary}</p>
                </>
              )}
              {selected.waste_notes && (
                <>
                  <h4>無駄・非効率が疑われる点</h4>
                  <p>{selected.waste_notes}</p>
                </>
              )}
              {selected.automation_notes && (
                <>
                  <h4>自動化できそうな作業</h4>
                  <p>{selected.automation_notes}</p>
                </>
              )}
              {selected.timeline?.length > 0 && (
                <>
                  <h4>タイムライン</h4>
                  <table className="timeline-table">
                    <thead>
                      <tr>
                        <th>時間帯</th>
                        <th>稼働</th>
                        <th>主なアプリ</th>
                        <th>何をしていたか</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.timeline.map((t, i) => (
                        <tr key={i}>
                          <td>{t.time_range}</td>
                          <td>{t.duration}</td>
                          <td>{t.main_app}</td>
                          <td>{t.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}

type Tab = "settings" | "employees" | "reports" | "analytics" | "managers";

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  settings: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2.4" fill="currentColor" stroke="none" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="15" cy="16" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  ),
  employees: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c0-3 2.5-5.4 5.5-5.4s5.5 2.4 5.5 5.4" />
      <path d="M16 5.6a3.2 3.2 0 0 1 0 4.9" />
      <path d="M17.5 13.9c1.8 0.8 3 2.6 3 5.1" />
    </svg>
  ),
  reports: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3.5h9l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z" />
      <path d="M8.5 12h7M8.5 15.5h7M8.5 8.5h3" />
    </svg>
  ),
  analytics: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <line x1="5" y1="20" x2="5" y2="12" />
      <line x1="12" y1="20" x2="12" y2="5" />
      <line x1="19" y1="20" x2="19" y2="9" />
    </svg>
  ),
  managers: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.5l7 2.8v5.2c0 4.6-3 7.6-7 9-4-1.4-7-4.4-7-9V6.3z" />
      <path d="M9.2 11.8l2 2 3.6-3.8" />
    </svg>
  ),
};

const TABS: { key: Tab; label: string; desc: string }[] = [
  { key: "settings", label: "設定", desc: "ログの集約先と、日次レポートの書き込み先を設定します" },
  { key: "employees", label: "社員", desc: "記録対象の社員と、各Macのセットアップ状況・監視オンオフを管理します" },
  { key: "reports", label: "レポート", desc: "社員ごとの日次レポート(要約・タイムライン)をここで閲覧できます" },
  { key: "analytics", label: "集計", desc: "どのアプリに時間を使っているか" },
  { key: "managers", label: "マネージャー", desc: "このダッシュボードにログインできる人を管理します" },
];

function EmployeeDashboard({
  email,
  orgName,
  orgId,
  onLogout,
}: {
  email: string;
  orgName: string;
  orgId: string;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>("employees");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [notionReportUrl, setNotionReportUrl] = useState<string | null>(null);

  const load = () => api<Employee[]>("/api/employees").then(setEmployees).catch(() => {});

  useEffect(() => {
    load();
    api<Settings>("/api/settings")
      .then((s) => setNotionReportUrl(s.notion_report_db_url ?? null))
      .catch(() => {});
  }, []);

  return (
    <div className="dashboard-layout">
      <nav className="sidebar">
        <h1>社員稼働
          <br />
          レポート管理
        </h1>
        <p className="sidebar-domain">{orgName}</p>
        <ul>
          {TABS.map((t) => (
            <li key={t.key}>
              <button className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
                {TAB_ICONS[t.key]}
                {t.label}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <span>{email}</span>
          <button
            className="ghost small"
            onClick={async () => {
              await api("/api/auth/logout", { method: "POST" });
              onLogout();
            }}
          >
            ログアウト
          </button>
        </div>
      </nav>

      <main className="dashboard-content">
        <header className="page-header">
          <h1>{TABS.find((t) => t.key === tab)?.label}</h1>
          <p>{TABS.find((t) => t.key === tab)?.desc}</p>
        </header>
        {tab === "settings" && <SettingsSection />}
        {tab === "employees" && <EmployeesSection employees={employees} load={load} orgId={orgId} />}
        {tab === "reports" && <ReportsSection employees={employees} />}
        {tab === "analytics" && <AnalyticsSection employees={employees} />}
        {tab === "managers" && <ManagerSection myEmail={email} />}

        {notionReportUrl && (
          <p className="notion-link">
            日次レポートの中身は{" "}
            <a href={notionReportUrl} target="_blank" rel="noreferrer">
              Notion「社員稼働レポート」
            </a>{" "}
            で確認してください。
          </p>
        )}
      </main>
    </div>
  );
}

type Me = { email: string | null; org_name: string | null; org_id: string | null };

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);

  const refresh = () => api<Me>("/api/me").then(setMe).catch(() => setMe(null)).finally(() => setChecked(true));

  useEffect(() => {
    refresh();
  }, []);

  if (!checked) return null;

  return me?.email && me.org_name && me.org_id ? (
    <EmployeeDashboard
      email={me.email}
      orgName={me.org_name}
      orgId={me.org_id}
      onLogout={() => setMe(null)}
    />
  ) : (
    <LoginForm onLoggedIn={refresh} />
  );
}
