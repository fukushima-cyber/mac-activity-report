// 組織共通デフォルトのログフォルダ(SHARED_DRIVE_PATH)と、その親フォルダに並ぶ他のサブフォルダ
// (社員ごとに個別共有された格納先。例: 「ログ/テストログ」「ログ/ひえいログ」)を両方スキャンし、
// 対象日のログJSONを1つの一時フォルダへシンボリックリンクで集約する。
//
// 社員ごとの個別格納先パスは、その社員自身のMac上でのローカルパス(agent/.env)であり、
// 福島さんのMac上には存在しない別のパスになる(Googleドライブのショートカット先IDがマシンごとに
// 異なるため)。そのため福島さんのMac側からは、DBの値をそのまま辿るのではなく、福島さんの
// Googleドライブ内で実際に見えている場所を直接スキャンする。
//
// 兄弟フォルダのスキャンは、設定済みの共有ドライブのパスが渡された時だけ行う(第3引数/環境変数で有効化)。
// プロジェクト内の data/ フォルダ(未設定時のフォールバック)を対象にリポジトリルート配下を
// スキャンしてしまわないようにするため。
//
// 使い方: node report/collect-employee-logs.mjs <DATE> <DEFAULT_SHARED_DRIVE_PATH> [--siblings]
// (環境変数 SCAN_SIBLINGS=1 でも同様に有効化できる)
// 標準出力に集約先の一時フォルダの絶対パスを1行だけ出す。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const [date, defaultSharedDrivePath, thirdArg] = process.argv.slice(2);
const scanSiblings = thirdArg === "--siblings" || process.env.SCAN_SIBLINGS === "1";

if (!date || !defaultSharedDrivePath) {
  console.error("使い方: node collect-employee-logs.mjs <DATE> <DEFAULT_SHARED_DRIVE_PATH> [--siblings]");
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
  files.sort(); // 実行ごとに順序が変わらないようにする
  for (const fileName of files) {
    const srcPath = path.join(dir, fileName);
    // 集約先のファイル名はNFCに揃える(Google DriveのマウントはNFDで名前を返すことがあり、
    // 同じ名前でも正規化形が違うと別ファイル扱いになって重複判定をすり抜けるため)
    const destPath = path.join(tmpDir, fileName.normalize("NFC"));
    try {
      await fs.access(destPath);
      const existingTarget = await fs.readlink(destPath).catch(() => null);
      console.error(
        `警告: 同名のログが複数見つかりました。先に見つかった方を使います: ${existingTarget ?? destPath} (無視: ${srcPath})`
      );
      continue; // 既に集約済み(同名ファイル)
    } catch {
      await fs.symlink(srcPath, destPath);
    }
  }
}

await collectFrom(defaultSharedDrivePath);

if (scanSiblings) {
  const parentDir = path.dirname(defaultSharedDrivePath);
  // Google Driveのマウントは readdir の結果をNFD(分解形)で返す一方、設定値はNFC(合成形)で
  // 書かれていることが多い。同じフォルダを「別物」と誤判定して二重スキャンしないよう、NFCに揃えて比較する
  const defaultNfc = path.resolve(defaultSharedDrivePath).normalize("NFC");
  try {
    const siblings = (await fs.readdir(parentDir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(parentDir, entry.name);
      if (path.resolve(dir).normalize("NFC") === defaultNfc) continue;
      await collectFrom(dir);
    }
  } catch {
    // 親フォルダが読めない → デフォルトフォルダの分だけで続行
  }
}

console.log(tmpDir);
