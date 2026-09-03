// 組織共通デフォルトのログフォルダ(SHARED_DRIVE_PATH)と、その親フォルダに並ぶ他のサブフォルダ
// (社員ごとに個別共有された格納先。例: 「ログ/テストログ」「ログ/ひえいログ」)を両方スキャンし、
// 対象日のログJSONを1つの一時フォルダへシンボリックリンクで集約する。
//
// 社員ごとの個別格納先パスは、その社員自身のMac上でのローカルパス(agent/.env)であり、
// 福島さんのMac上には存在しない別のパスになる(Googleドライブのショートカット先IDがマシンごとに
// 異なるため)。そのため福島さんのMac側からは、DBの値をそのまま辿るのではなく、福島さんの
// Googleドライブ内で実際に見えている場所を直接スキャンする。
//
// 使い方: node report/collect-employee-logs.mjs <DATE> <DEFAULT_SHARED_DRIVE_PATH>
// 標準出力に集約先の一時フォルダの絶対パスを1行だけ出す。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [date, defaultSharedDrivePath] = process.argv.slice(2);

if (!date || !defaultSharedDrivePath) {
  console.error("使い方: node collect-employee-logs.mjs <DATE> <DEFAULT_SHARED_DRIVE_PATH>");
  process.exit(1);
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-activity-logs-"));

async function collectFrom(dir) {
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => f.startsWith(`${date}_`) && f.endsWith(".json"));
  } catch {
    return; // フォルダが無い/読めない → スキップ
  }
  for (const fileName of files) {
    const destPath = path.join(tmpDir, fileName);
    try {
      await fs.access(destPath);
      continue; // 既に集約済み(同名ファイル)
    } catch {
      await fs.symlink(path.join(dir, fileName), destPath);
    }
  }
}

await collectFrom(defaultSharedDrivePath);

const parentDir = path.dirname(defaultSharedDrivePath);
try {
  const siblings = await fs.readdir(parentDir, { withFileTypes: true });
  for (const entry of siblings) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(parentDir, entry.name);
    if (dir === defaultSharedDrivePath) continue;
    await collectFrom(dir);
  }
} catch {
  // 親フォルダが読めない → デフォルトフォルダの分だけで続行
}

console.log(tmpDir);
