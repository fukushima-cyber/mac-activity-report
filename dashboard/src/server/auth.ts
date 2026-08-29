// 少人数(マネージャーのみ)の内部ツールのため、Web Crypto標準APIだけで
// パスワードハッシュ(PBKDF2)とセッションCookieを自前実装する。
// 判断理由: docs/decisions/0002-dashboard-auth.md 参照

const ITERATIONS = 100_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  return `${toHex(salt)}:${toHex(new Uint8Array(key))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  const salt = fromHex(saltHex);
  const key = await deriveKey(password, salt);
  return toHex(new Uint8Array(key)) === hashHex;
}

async function deriveKey(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

export function newSessionId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

const READABLE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"; // 紛らわしい文字(0,o,1,l,i)を除く

export function generateTempPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => READABLE_CHARS[b % READABLE_CHARS.length]).join("");
}

export const SESSION_COOKIE = "mad_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日
