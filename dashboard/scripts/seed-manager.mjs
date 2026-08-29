// マネージャーアカウントを追加する。使い方: node scripts/seed-manager.mjs <email> <password> [--remote]
import { webcrypto as crypto } from "node:crypto";
import { execFileSync } from "node:child_process";

const [, , email, password, flag] = process.argv;
if (!email || !password) {
  console.error("使い方: node scripts/seed-manager.mjs <email> <password> [--remote]");
  process.exit(1);
}

const ITERATIONS = 100_000;

function toHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

const hash = await hashPassword(password);
const id = crypto.randomUUID();
const sql = `INSERT INTO managers (id, email, password_hash) VALUES ('${id}', '${email.replace(/'/g, "''")}', '${hash}') ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash;`;

const args = ["d1", "execute", "mac-activity-dashboard-db", flag === "--remote" ? "--remote" : "--local", "--command", sql];
execFileSync("npx", ["wrangler", ...args], { stdio: "inherit" });
console.log(`マネージャー ${email} を登録しました。`);
