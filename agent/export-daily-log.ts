// 各社員のMacで実行する。ActivityWatch(ローカルのみ、APIキー不要)から
// 当日のウィンドウ操作ログを読み出し、共有フォルダへJSONで書き出す。

import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

// agent/.env があれば読み込む(社員ごとの共有フォルダパス・氏名の設定用。ライブラリ追加なしの簡易実装)
const envPath = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const DASHBOARD_URL = "https://log.bonkers.llc";
const ORG_ID = process.env.ORG_ID;
const AW_HOST = process.env.AW_HOST ?? "http://localhost:5600";
const OUTPUT_DIR =
  process.env.SHARED_DRIVE_PATH ??
  fileURLToPath(new URL("../data", import.meta.url)); // 未設定時はプロジェクト内のdata/に書く(プロトタイプ用)
// USERはmacOS/Linux、USERNAME はWindowsの環境変数名
const EMPLOYEE_NAME = process.env.EMPLOYEE_NAME ?? process.env.USER ?? process.env.USERNAME ?? "unknown";
const MIN_DURATION_SECONDS = 3; // これ未満の瞬間的な切り替えはノイズとして除外

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

async function fetchBucketId(prefix: string): Promise<string> {
  const res = await fetch(`${AW_HOST}/api/0/buckets/`);
  if (!res.ok) throw new Error(`ActivityWatchに接続できません: ${res.status}`);
  const buckets = (await res.json()) as Record<string, { id: string }>;
  const found = Object.values(buckets).find((b) => b.id.startsWith(prefix));
  if (!found) throw new Error(`バケットが見つかりません: ${prefix}`);
  return found.id;
}

async function fetchEvents(bucketId: string, start: string, end: string): Promise<AwEvent[]> {
  const url = `${AW_HOST}/api/0/buckets/${bucketId}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=-1`;
  const res = await fetch(url);
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
    const res = await fetch(`${DASHBOARD_URL}/api/employees/by-slug/${ORG_ID}/${EMPLOYEE_NAME}/public`);
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

async function main() {
  if (!(await monitoringEnabled())) {
    console.log(`監視がオフに設定されているため、書き出しをスキップしました(${EMPLOYEE_NAME})。`);
    return;
  }

  const date = process.argv[2] ?? todayJst();
  const { start, end } = jstDateRange(date);

  const windowBucket = await fetchBucketId("aw-watcher-window_");
  const afkBucket = await fetchBucketId("aw-watcher-afk_");

  const [windowEvents, afkEvents] = await Promise.all([
    fetchEvents(windowBucket, start, end),
    fetchEvents(afkBucket, start, end),
  ]);

  const windows = summarizeWindows(windowEvents);
  const active_seconds = activeSeconds(afkEvents);

  const report = {
    date,
    employee: EMPLOYEE_NAME,
    generated_at: new Date().toISOString(),
    active_seconds,
    window_count: windows.length,
    windows,
  };

  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const outPath = path.join(OUTPUT_DIR, `${date}_${EMPLOYEE_NAME}.json`);
  await writeWithRetry(fs, OUTPUT_DIR, outPath, JSON.stringify(report, null, 2));

  console.log(`書き出し完了: ${outPath}`);
  console.log(`  稼働時間: ${(active_seconds / 3600).toFixed(1)}時間 / ウィンドウ切り替え: ${windows.length}件`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
