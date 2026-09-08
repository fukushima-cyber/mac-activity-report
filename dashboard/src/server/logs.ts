// 直接アップロード方式(docs/decisions/0003)の純粋ロジック。
// Cloudflare固有の型・APIに依存しない(将来別のサーバーへ移設してもこのファイルはそのまま再利用できる)。
// Web Crypto(`crypto.getRandomValues` / `crypto.subtle`)はWorkers・Node18+・ブラウザ共通のグローバルAPIなので依存OK。

const TOKEN_PREFIX = "mal_"; // mac-activity-logs の略。トークンだと一目で分かるようにする
const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB

/** 社員専用・アップロード専用トークンを新規生成する(32バイトのランダム値をbase64url化) */
export function generateUploadToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + toBase64Url(bytes);
}

/** トークンをSHA-256でハッシュ化する。生の値はDBに保存しない */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(new Uint8Array(digest));
}

export type DailyLogValidation = { ok: true; date: string } | { ok: false; error: string };

/** 社員PCから届いた日次ログJSONが期待した形かを検証する */
export function validateDailyLog(body: unknown, expectedSlug: string): DailyLogValidation {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "JSONオブジェクトである必要があります" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.date !== "string" || !DATE_RE.test(b.date)) {
    return { ok: false, error: "dateはYYYY-MM-DD形式である必要があります" };
  }
  if (b.employee !== expectedSlug) {
    return { ok: false, error: "employeeがトークンの社員と一致しません" };
  }
  if (!Array.isArray(b.windows)) {
    return { ok: false, error: "windowsは配列である必要があります" };
  }
  if (typeof b.active_seconds !== "number") {
    return { ok: false, error: "active_secondsは数値である必要があります" };
  }
  if (typeof b.window_count !== "number") {
    return { ok: false, error: "window_countは数値である必要があります" };
  }

  return { ok: true, date: b.date };
}

/** ログ保存先のオブジェクトキー(R2でもローカルディスクでも同じ形を使う) */
export function storageKey(orgId: string, slug: string, date: string): string {
  return `orgs/${orgId}/logs/${slug}/${date}.json`;
}

/**
 * 保管期間の締切日(JST基準のYYYY-MM-DD)を返す。
 * この日付より前(<)のログは削除対象。
 */
export function retentionCutoffDate(now: Date, days: number): string {
  const jstMs = now.getTime() + 9 * 60 * 60 * 1000; // UTC→JSTへずらした仮想の時刻
  const jst = new Date(jstMs);
  jst.setUTCDate(jst.getUTCDate() - days);
  return jst.toISOString().slice(0, 10);
}

function toBase64Url(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triplet = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    result += BASE64URL_CHARS[(triplet >> 18) & 63];
    result += BASE64URL_CHARS[(triplet >> 12) & 63];
    result += b1 !== undefined ? BASE64URL_CHARS[(triplet >> 6) & 63] : "";
    result += b2 !== undefined ? BASE64URL_CHARS[triplet & 63] : "";
  }
  return result;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
