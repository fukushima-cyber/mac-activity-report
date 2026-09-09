// 各社員のMacで実行する。ActivityWatch(ローカルのみ、APIキー不要)から
// 当日のウィンドウ操作ログを読み出し、ダッシュボードへ直接アップロードする
// (UPLOAD_TOKENが設定されている場合。docs/decisions/0003-direct-upload.md)。
// UPLOAD_TOKENが無ければ、従来通り共有フォルダ(Google Drive等)へJSONを書き出す(旧方式・後方互換)。
//
// 直接アップロード方式では、PC起動中に30分おきに呼ばれる前提で「今日＋過去2日分」をまとめて送る
// (docs/decisions/0004)。前回送信から中身が変わっていない日は送らない(logs/.uploaded/ のSHA-256で比較)。
// 送信に失敗した日は次回(30分後)に自然に再送される。特定の日だけ送り直す時は
// `node export-daily-log.mjs <YYYY-MM-DD>`(変更が無くても送るなら FORCE_UPLOAD=1 を付ける)。

import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

// agent/.env(またはコンパイル後は同ディレクトリの.env)があれば読み込む。
// 社員ごとの共有フォルダパス・氏名・トークンの設定用(ライブラリ追加なしの簡易実装)
const envPath = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
const UPLOAD_TOKEN = process.env.UPLOAD_TOKEN; // 設定されていれば直接アップロード方式(新)、無ければ共有フォルダ方式(旧)
const ORG_ID = process.env.ORG_ID;
const AW_HOST = process.env.AW_HOST ?? "http://localhost:5600";
const AW_EXE_PATH = process.env.AW_EXE_PATH; // Windows: インストーラーが.envに書く(自己修復でActivityWatchを起動するため)
const FORCE_UPLOAD = process.env.FORCE_UPLOAD === "1"; // 前回送信と同じ中身でも送る(手動の送り直し用)
const RECENT_DAYS = 3; // 今日を含めて何日分を毎回送るか
// USERはmacOS/Linux、USERNAME はWindowsの環境変数名
const EMPLOYEE_NAME = process.env.EMPLOYEE_NAME ?? process.env.USER ?? process.env.USERNAME ?? "unknown";
const MIN_DURATION_SECONDS = 3; // これ未満の瞬間的な切り替えはノイズとして除外

// アップロード方式でも、失敗時に何も残らないと困るのでローカルコピーは必ず書く。
// 保存先は、SHARED_DRIVE_PATHの明示指定があればそれを優先し(旧方式との混在設定を尊重)、
// 無ければアップロード方式は ./logs (実運用では ~/mac-activity-agent/logs)、
// 旧方式(共有フォルダ)はプロジェクト内の data/ をデフォルトにする(プロトタイプ用)。
const OUTPUT_DIR =
  process.env.SHARED_DRIVE_PATH ??
  process.env.OUTPUT_DIR ??
  (UPLOAD_TOKEN
    ? fileURLToPath(new URL("./logs", import.meta.url))
    : fileURLToPath(new URL("../data", import.meta.url)));

type AwEvent = {
  id: number;
  timestamp: string;
  duration: number;
  data: Record<string, unknown>;
};

type WindowEntry = {
  app: string;
  title: string;
  start: string;
  duration_seconds: number;
};

function jstDateRange(dateStr: string): { start: string; end: string } {
  const start = new Date(`${dateStr}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function todayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function yesterdayJst(): string {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000 - 24 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// 旧方式(共有フォルダ書き出し)専用。旧インストーラーは毎晩23:50に1回だけ実行するため、
// 正午より前に走ったら「PCがスリープしていて後追いで実行された」とみなして前日分を書き出す。
function defaultExportDate(): string {
  const now = new Date();
  const jstHour = new Date(now.getTime() + 9 * 60 * 60 * 1000).getUTCHours();
  return jstHour < 12 ? yesterdayJst() : todayJst();
}

// 直接アップロード方式用。JST基準で「今日」を含む直近count日を古い順に返す。
// 毎回過去分も送り直すことで、その日にPCを開かなかった・送信に失敗した日を次に開いた時に埋める。
export function recentJstDates(now: Date, count: number): string[] {
  const dates: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000 - i * 24 * 60 * 60 * 1000);
    dates.push(jst.toISOString().slice(0, 10));
  }
  return dates;
}

type Snapshot = {
  date: string;
  employee: string;
  active_seconds: number;
  window_count: number;
  windows: WindowEntry[];
  generated_at?: string;
};

// 「前回送った中身と同じか」の判定用。generated_at(実行時刻)は毎回変わるので含めない。
export function snapshotHash(report: Snapshot): string {
  const { date, employee, active_seconds, window_count, windows } = report;
  return createHash("sha256")
    .update(JSON.stringify({ date, employee, active_seconds, window_count, windows }))
    .digest("hex");
}

async function activityWatchReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${AW_HOST}/api/0/buckets/`, { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ActivityWatchが止まっていたら起動を試みる。Macは登録済みアプリ名で、WindowsはインストーラーがAW_EXE_PATHに書いたexeで。
// 止まっていた間の記録は存在しないので取り戻せないが、次回以降の空振りを防ぐ(ログイン項目/スタートアップ登録が本命で、こちらは保険)。
function tryStartActivityWatch(): boolean {
  try {
    if (process.platform === "darwin") {
      spawn("open", ["-ga", "ActivityWatch"], { stdio: "ignore", detached: true }).unref();
      return true;
    }
    if (process.platform === "win32" && AW_EXE_PATH && existsSync(AW_EXE_PATH)) {
      spawn(AW_EXE_PATH, [], { stdio: "ignore", detached: true, windowsHide: true }).unref();
      return true;
    }
  } catch {
    // 起動できなければ下の「接続できません」エラーに任せる
  }
  return false;
}

async function ensureActivityWatch(): Promise<void> {
  if (await activityWatchReachable()) return;
  console.log("ActivityWatchが動いていないため、起動を試みます...");
  if (!tryStartActivityWatch()) {
    throw new Error(`ActivityWatchに接続できません(${AW_HOST})。ActivityWatchを起動してください。`);
  }
  for (let i = 0; i < 12; i++) {
    // 起動直後はサーバーが立ち上がるまで数秒かかる。最大60秒待つ
    await new Promise((resolve) => setTimeout(resolve, 5000));
    if (await activityWatchReachable()) {
      console.log("ActivityWatchが起動しました。");
      return;
    }
  }
  throw new Error(`ActivityWatchを起動しましたが応答がありません(${AW_HOST})。アクセシビリティの許可を確認してください。`);
}

async function fetchBucketId(prefix: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${AW_HOST}/api/0/buckets/`, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    // ActivityWatchが起動していない/初回のアクセシビリティ許可待ちで応答が無い場合はここに来る
    throw new Error(
      `ActivityWatchに接続できません(${AW_HOST})。ActivityWatchが起動しているか確認してください: ${(err as Error).message}`
    );
  }
  if (!res.ok) throw new Error(`ActivityWatchに接続できません: ${res.status}`);
  const buckets = (await res.json()) as Record<string, { id: string }>;
  const found = Object.values(buckets).find((b) => b.id.startsWith(prefix));
  if (!found) throw new Error(`バケットが見つかりません: ${prefix}`);
  return found.id;
}

async function fetchEvents(bucketId: string, start: string, end: string): Promise<AwEvent[]> {
  const url = `${AW_HOST}/api/0/buckets/${bucketId}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=-1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`イベント取得に失敗しました: ${res.status}`);
  return (await res.json()) as AwEvent[];
}

function summarizeWindows(events: AwEvent[]): WindowEntry[] {
  const entries = events
    .map((e) => ({
      app: String(e.data.app ?? ""),
      title: String(e.data.title ?? ""),
      start: e.timestamp,
      duration_seconds: Math.round(e.duration),
    }))
    .filter((e) => e.duration_seconds >= MIN_DURATION_SECONDS)
    .sort((a, b) => a.start.localeCompare(b.start));
  return entries;
}

function activeSeconds(afkEvents: AwEvent[]): number {
  return Math.round(
    afkEvents
      .filter((e) => e.data.status === "not-afk")
      .reduce((sum, e) => sum + e.duration, 0)
  );
}

async function monitoringEnabled(): Promise<boolean> {
  if (!ORG_ID) return true; // 組織IDが無ければ従来通り動かす(後方互換)
  try {
    const res = await fetch(`${DASHBOARD_URL}/api/employees/by-slug/${encodeURIComponent(ORG_ID)}/${encodeURIComponent(EMPLOYEE_NAME)}/public`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return true;
    const json = (await res.json()) as { monitoring_enabled?: boolean };
    return json.monitoring_enabled !== false;
  } catch {
    return true; // ダッシュボードに繋がらない時は安全側(記録は続ける)に倒す
  }
}

// 共有されたばかりのGoogle Driveフォルダは、同期が完了する前に書き込むと
// 一時的なエラー(EAGAIN/「Unknown system error -11」等)を返すことがある。
// 数秒待って再試行すれば大抵成功するため、待機を挟みながら数回リトライする。
async function writeWithRetry(
  fs: typeof import("node:fs/promises"),
  outputDir: string,
  outPath: string,
  content: string,
  maxAttempts = 5
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(outPath, content, "utf-8");
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      const waitSeconds = attempt * 5; // 5s, 10s, 15s, 20s と少しずつ待つ
      console.log(
        `書き込みに失敗(試行${attempt}/${maxAttempts})、${waitSeconds}秒待って再試行します: ${(err as Error).message}`
      );
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
    }
  }
}

/**
 * サーバーからのHTTPステータスを見て、アップロードをリトライすべきか判定する純粋関数。
 * 5xx(サーバー側の一時的な問題)とネットワーク混雑を示す429は再試行の価値がある。
 * 400(形式不正)・401(トークン無効)・413(サイズ超過)は何度送っても結果が変わらないため再試行しない。
 */
export function shouldRetryUploadStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

const UPLOAD_RETRY_WAITS_SECONDS = [10, 20, 30]; // 最大4回試行(初回+3リトライ)

type UploadResult = { kind: "ok"; date: string; size: number } | { kind: "skipped" } | { kind: "gave_up" };

// ダッシュボードへ日次ログを直接アップロードする。5xx/429/ネットワーク失敗は待機を挟んで再試行し、
// 400/401/413は再試行しても無駄なので即座に諦めて分かりやすい日本語メッセージを出す。
async function uploadReport(body: string): Promise<UploadResult> {
  const maxAttempts = UPLOAD_RETRY_WAITS_SECONDS.length + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${DASHBOARD_URL}/api/logs/upload`, {
        signal: AbortSignal.timeout(30_000),
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPLOAD_TOKEN}`,
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (err) {
      if (attempt === maxAttempts) {
        console.error(`アップロードに失敗しました(ネットワークエラー): ${(err as Error).message}`);
        return { kind: "gave_up" };
      }
      const waitSeconds = UPLOAD_RETRY_WAITS_SECONDS[attempt - 1];
      console.log(
        `アップロードに失敗(試行${attempt}/${maxAttempts}、ネットワークエラー)、${waitSeconds}秒待って再試行します。`
      );
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    if (res.status === 401) {
      console.error("アップロードに失敗しました: トークンが無効です。ダッシュボードで再発行が必要です。");
      return { kind: "gave_up" };
    }
    if (res.status === 400) {
      const text = await res.text().catch(() => "");
      console.error(`アップロードに失敗しました(データ形式エラー、再試行しません): ${text}`);
      return { kind: "gave_up" };
    }
    if (res.status === 413) {
      console.error("アップロードに失敗しました: ログが大きすぎます(上限5MB)。再試行しません。");
      return { kind: "gave_up" };
    }

    if (shouldRetryUploadStatus(res.status)) {
      if (attempt === maxAttempts) {
        console.error(`アップロードに失敗しました(${res.status}、再試行上限に達しました)。`);
        return { kind: "gave_up" };
      }
      const waitSeconds = UPLOAD_RETRY_WAITS_SECONDS[attempt - 1];
      console.log(
        `アップロードに失敗(試行${attempt}/${maxAttempts}、ステータス${res.status})、${waitSeconds}秒待って再試行します。`
      );
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`アップロードに失敗しました(${res.status}、再試行しません): ${text}`);
      return { kind: "gave_up" };
    }

    const json = (await res.json()) as { ok?: boolean; date?: string; size?: number; skipped?: boolean };
    if (json.skipped) return { kind: "skipped" };
    if (json.ok !== true || typeof json.date !== "string" || typeof json.size !== "number") {
      console.error("アップロード応答を確認できません。送信済みにはしません。");
      return { kind: "gave_up" };
    }
    return { kind: "ok", date: json.date, size: json.size };
  }

  return { kind: "gave_up" };
}

export async function retrySavedUploads({ outputDir, employee, now, upload }: {
  outputDir: string;
  employee: string;
  now: Date;
  upload: (body: string) => Promise<UploadResult>;
}): Promise<number> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const dates = new Set(recentJstDates(now, 90));
  const recent = new Set(recentJstDates(now, RECENT_DAYS));
  let files: string[];
  try { files = await fs.readdir(outputDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let failed = 0;
  let attempted = 0;
  for (const file of files.sort()) {
    const date = file.slice(0, 10);
    if (file !== `${date}_${employee}.json` || !dates.has(date) || recent.has(date)) continue;
    try {
      const body = await fs.readFile(path.join(outputDir, file), "utf-8");
      const report = JSON.parse(body) as Snapshot;
      if (report.employee !== employee || report.date !== date || !Array.isArray(report.windows)) throw new Error("Saved log identity mismatch");
      const hash = snapshotHash(report);
      const hashPath = path.join(outputDir, ".uploaded", `${date}_${employee}.sha256`);
      const previous = await fs.readFile(hashPath, "utf-8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (previous === hash) continue;
      if (attempted >= 10) break;
      attempted++;
      const result = await upload(body);
      if (result.kind === "ok" && result.date === date) {
        await fs.mkdir(path.dirname(hashPath), { recursive: true });
        await fs.writeFile(hashPath, hash, "utf-8");
        console.log(`${date}: 保存済みログの再送完了`);
      } else if (result.kind !== "skipped") {
        failed++;
      }
    } catch (error) {
      failed++;
      console.error(`${date}: 保存済みログの再送失敗: ${(error as Error).message}`);
    }
  }
  return failed;
}

async function main() {
  if (!(await monitoringEnabled())) {
    console.log(`監視がオフに設定されているため、書き出しをスキップしました(${EMPLOYEE_NAME})。`);
    return;
  }

  // 日付を指定されたらその日だけ。指定が無ければ、直接アップロード方式は今日＋過去2日分、
  // 旧方式(共有フォルダ)は従来どおり1日分(23:50に1回だけ動く前提のため)。
  const explicitDate = process.argv[2];
  const dates = explicitDate ? [explicitDate] : UPLOAD_TOKEN ? recentJstDates(new Date(), RECENT_DAYS) : [defaultExportDate()];

  if (UPLOAD_TOKEN && !explicitDate) {
    const failed = await retrySavedUploads({ outputDir: OUTPUT_DIR, employee: EMPLOYEE_NAME, now: new Date(), upload: uploadReport });
    if (failed) process.exitCode = 1;
  }

  await ensureActivityWatch();
  const windowBucket = await fetchBucketId("aw-watcher-window_");
  const afkBucket = await fetchBucketId("aw-watcher-afk_");

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  let failed = 0;

  for (const date of dates) {
    const { start, end } = jstDateRange(date);
    const [windowEvents, afkEvents] = await Promise.all([
      fetchEvents(windowBucket, start, end),
      fetchEvents(afkBucket, start, end),
    ]);
    const windows = summarizeWindows(windowEvents);
    const active_seconds = activeSeconds(afkEvents);

    // PCを開いていない日など記録が全く無い日は送らない(空のレポートをAIに回さないため)
    if (windows.length === 0 && active_seconds === 0) {
      console.log(`${date}: 記録なし(スキップ)`);
      continue;
    }

    const report: Snapshot = {
      date,
      employee: EMPLOYEE_NAME,
      generated_at: new Date().toISOString(),
      active_seconds,
      window_count: windows.length,
      windows,
    };
    const content = JSON.stringify(report, null, 2);
    const summary = `稼働 ${(active_seconds / 3600).toFixed(1)}時間 / ウィンドウ切り替え ${windows.length}件`;

    // アップロード方式でも失敗時に何も残らないと困るので、ローカルコピーは常に書く。
    const outPath = path.join(OUTPUT_DIR, `${date}_${EMPLOYEE_NAME}.json`);
    await writeWithRetry(fs, OUTPUT_DIR, outPath, content);

    if (!UPLOAD_TOKEN) {
      console.log(`書き出し完了: ${outPath} (${summary})`);
      continue;
    }

    // 前回送った中身と同じなら送らない(30分おきに過去分も送り直すため、変更が無い日で通信・サーバー側の再処理を起こさない)。
    // ハッシュは送信が成功した時だけ書くので、失敗した日は次回また送られる。
    const hash = snapshotHash(report);
    const hashPath = path.join(OUTPUT_DIR, ".uploaded", `${date}_${EMPLOYEE_NAME}.sha256`);
    const lastHash = await fs.readFile(hashPath, "utf-8").catch(() => null);
    if (!FORCE_UPLOAD && lastHash === hash) {
      console.log(`${date}: 前回送信から変更なし(送信スキップ)`);
      continue;
    }

    const result = await uploadReport(JSON.stringify(report));
    if (result.kind === "ok" && result.date === date) {
      await fs.mkdir(path.dirname(hashPath), { recursive: true });
      await fs.writeFile(hashPath, hash, "utf-8");
      console.log(`${date}: アップロード完了 (${result.size} bytes、${summary})`);
    } else if (result.kind === "skipped") {
      console.log(`${date}: 監視オフのためスキップ`);
    } else {
      console.log(`${date}: ローカルには保存済み。次回の実行(30分後)に再送します: ${outPath}`);
      failed++;
    }
  }

  if (failed > 0) process.exitCode = 1;
}

// 直接実行された時だけmain()を走らせる(importされた時は走らせない。
// shouldRetryUploadStatus等の純粋関数だけをテストから安全にimportできるようにするため)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("エラー:", err.message);
    process.exit(1);
  });
}
