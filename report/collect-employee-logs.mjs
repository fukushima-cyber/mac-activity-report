// 対象日のログJSONを1つの一時フォルダへ集約する。
//
// 新方式(既定): INGEST_API_KEYが設定されていれば、ダッシュボードAPI(直接アップロード方式。
// docs/decisions/0003-direct-upload.md)から当日分を取得して実ファイルとして書き出す。
// 一覧取得(GET /api/logs)がネットワーク/HTTPエラーで失敗した場合は警告を出し、
// 例外を投げずに旧方式(Drive)へフォールバックする。個々のログ本文の取得に失敗した社員は
// 警告してスキップし、他の社員の取得は続ける(dashboard-logs.mjs参照)。
//
// 旧方式(フォールバック/移行期間の後方互換): 組織共通デフォルトのログフォルダ(SHARED_DRIVE_PATH)
// と、その親フォルダに並ぶ他のサブフォルダ(社員ごとに個別共有された格納先。例:
// 「ログ/テストログ」「ログ/ひえいログ」)を両方スキャンし、対象日のログJSONをシンボリックリンクで
// 集約する。ダッシュボード側から既に取得済みの社員は、同名ファイルの重複としてスキップする
// (通常の重複警告ではなく「ダッシュボード取得分を優先」と表示する)。
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
// 標準出力に集約先の一時フォルダの絶対パスを1行だけ出す(それ以外は全て標準エラーへ)。
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchDailyLogsFromDashboard } from "./dashboard-logs.mjs";

// OSの一時フォルダ(/tmp等)ではなく、このプロジェクト配下に一時フォルダを作る。
// claude -p はデフォルトでプロジェクトフォルダ外(/tmp含む)への読み取りを拒否するため、
// analyze-parallel.mjsがここのファイルを読めるようにするための対応。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOT = path.join(SCRIPT_DIR, ".tmp");

const [date, defaultSharedDrivePath, thirdArg] = process.argv.slice(2);
const scanSiblings = thirdArg === "--siblings" || process.env.SCAN_SIBLINGS === "1";
// 環境変数 ONLY_SLUGS(カンマ区切り)があれば、その社員のログだけを集約する
// (「レポートを作り直す必要がある社員・日」だけを処理する差分再生成用。run-daily-report.sh参照)
const onlySlugs = process.env.ONLY_SLUGS
  ? new Set(
      process.env.ONLY_SLUGS.split(",")
        .map((s) => s.trim().normalize("NFC"))
        .filter(Boolean)
    )
  : null;

if (!date || !defaultSharedDrivePath) {
  console.error("使い方: node collect-employee-logs.mjs <DATE> <DEFAULT_SHARED_DRIVE_PATH> [--siblings]");
  process.exit(1);
}

await fs.mkdir(TMP_ROOT, { recursive: true });
const tmpDir = await fs.mkdtemp(path.join(TMP_ROOT, "mac-activity-logs-"));

// ダッシュボードから取得済みのファイル名(NFC)。Driveスキャン側の重複判定で
// 「ダッシュボード取得分を優先」と表示するために使う
const dashboardFileNames = new Set();

const ingestApiKey = process.env.INGEST_API_KEY;
if (ingestApiKey) {
  const dashboardUrl = process.env.DASHBOARD_URL ?? "https://log.bonkers.llc";
  const result = await fetchDailyLogsFromDashboard({
    baseUrl: dashboardUrl,
    apiKey: ingestApiKey,
    date,
    destDir: tmpDir,
    onlySlugs,
  });
  if (result.ok) {
    for (const fileName of result.written) dashboardFileNames.add(fileName);
    console.error(`ダッシュボードから ${result.written.length} 人分を取得`);
  } else {
    console.error(`警告: ダッシュボードからの取得に失敗しました(${result.error})。Driveからの取得にフォールバックします`);
  }
}

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
    const destFileName = fileName.normalize("NFC");
    if (onlySlugs) {
      const slug = destFileName.slice(date.length + 1, -".json".length);
      if (!onlySlugs.has(slug)) continue;
    }
    const destPath = path.join(tmpDir, destFileName);
    try {
      await fs.access(destPath);
      if (dashboardFileNames.has(destFileName)) {
        console.error(`ダッシュボード取得分を優先: ${destPath} (Drive側は無視: ${srcPath})`);
      } else {
        const existingTarget = await fs.readlink(destPath).catch(() => null);
        console.error(
          `警告: 同名のログが複数見つかりました。先に見つかった方を使います: ${existingTarget ?? destPath} (無視: ${srcPath})`
        );
      }
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
