// 社員ごとに個別の claude -p 呼び出しで分析し、複数人を同時並行(既定4人)で処理する。
// 1回のプロンプトに全員分の生ログを積む方式だと、人数が増えるほどコンテキストが
// 膨らみ実行時間・トークン消費が線形以上に増えるため、1人分ずつに分割して並列化している。
// 1人の失敗(壊れたログ等・API側の一時的な過負荷等)が他の人の結果を巻き込まないよう、
// 失敗した人は数回リトライしてもダメならスキップして続行する。ただしclaudeコマンド自体が
// 存在しない(ENOENT)場合はリトライしても直らないため即座に諦める。
//
// 終了コードの意味: 0=全員成功 / 1=対象0人 or 全員失敗(マージ結果が空) / 2=一部の人だけ失敗(部分的成功)
//
// 使い方: node report/analyze-parallel.mjs <DATE> <COLLECTED_DIR> <PROMPT_TEMPLATE_PATH> <OUTPUT_FILE>
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const [date, collectedDir, promptTemplatePath, outputFile] = process.argv.slice(2);
if (!date || !collectedDir || !promptTemplatePath || !outputFile) {
  console.error("使い方: node analyze-parallel.mjs <DATE> <COLLECTED_DIR> <PROMPT_TEMPLATE_PATH> <OUTPUT_FILE>");
  process.exit(1);
}

const CONCURRENCY = Number(process.env.REPORT_CONCURRENCY) || 4;
const MAX_BUFFER_BYTES = 1024 * 1024 * 20;
const TIMEOUT_MS = (Number(process.env.REPORT_ANALYSIS_TIMEOUT_SEC) || 600) * 1000;

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// claude -p の標準出力をJSON配列として解釈する。
// 前後に説明文が混ざることがあるため、まず全体をそのままparseし、失敗したら[..]部分の切り出しへフォールバックする。
// 単一オブジェクト(employee_slugを持つ)で返ってきた場合は配列へ包む。
function extractJsonArray(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start === -1 || end === -1) throw new Error("JSON配列が見つかりませんでした");
    parsed = JSON.parse(raw.slice(start, end + 1));
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof parsed.employee_slug === "string") {
    parsed = [parsed];
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => x && typeof x.employee_slug === "string")) {
    throw new Error("社員レポートの形式ではありません(employee_slugが無い要素があります)");
  }
  return parsed;
}

// execFileはstdioオプションを無視するため、実際のstdio制御(stdin閉じ・タイムアウトでのkill)にはspawnを使う。
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", prompt, "--allowedTools", "Read"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      const err = new Error(`claude -p がタイムアウトしました(${TIMEOUT_MS / 1000}秒)`);
      err.code = "ETIMEDOUT";
      err.stdout = stdout;
      err.stderr = stderr;
      settled = true;
      reject(err);
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_BUFFER_BYTES) stdout += chunk.toString();
      else stdoutTruncated = true;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_BUFFER_BYTES) stderr += chunk.toString();
      else stderrTruncated = true;
    });

    child.on("error", (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      if (code !== 0) {
        const err = new Error(`claude -p が終了コード${code}で失敗しました`);
        err.code = code;
        err.stdout = stdout + (stdoutTruncated ? "\n...(切り詰め)" : "");
        err.stderr = stderr + (stderrTruncated ? "\n...(切り詰め)" : "");
        reject(err);
        return;
      }
      resolve({
        stdout: stdout + (stdoutTruncated ? "\n...(切り詰め)" : ""),
      });
    });
  });
}

async function analyzeOne(fileName, template, maxAttempts = 3) {
  const employeeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-activity-single-"));
  await fs.symlink(path.join(collectedDir, fileName), path.join(employeeDir, fileName));

  const prompt = template.replaceAll("{{DATE}}", date).replaceAll("{{SHARED_DRIVE_PATH}}", employeeDir);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { stdout } = await runClaude(prompt);
        return extractJsonArray(stdout);
      } catch (err) {
        // claudeコマンドが存在しない場合はリトライしても直らないため即座に諦める
        if (err.code === "ENOENT") throw err;
        if (attempt === maxAttempts) throw err;
        // API側の一時的な過負荷(529等)・タイムアウトを想定し、間隔をあけて再試行する
        const waitSeconds = attempt * 10;
        console.log(`  再試行します(${fileName}, ${attempt}/${maxAttempts}, ${waitSeconds}秒待機): ${(err.stdout || err.message || "").slice(0, 200)}`);
        await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      }
    }
  } finally {
    await fs.rm(employeeDir, { recursive: true, force: true });
  }
}

async function main() {
  const template = await fs.readFile(promptTemplatePath, "utf-8");
  const files = (await fs.readdir(collectedDir)).filter(
    (f) => f.startsWith(`${date}_`) && f.endsWith(".json")
  );

  if (files.length === 0) {
    await fs.writeFile(outputFile, "[]", "utf-8");
    console.log("対象ログなし");
    return;
  }

  console.log(`${files.length}人分を最大${CONCURRENCY}人ずつ並列で分析します...`);

  const failed = [];
  const perFileResults = await runWithConcurrency(files, CONCURRENCY, async (fileName) => {
    try {
      const result = await analyzeOne(fileName, template);
      console.log(`  分析完了: ${fileName}`);
      return result;
    } catch (err) {
      console.error(`  分析失敗(スキップします): ${fileName}`);
      console.error(`    stderr: ${err.stderr || "(なし)"}`);
      console.error(`    stdout: ${err.stdout ? err.stdout.slice(0, 500) : "(なし)"}`);
      console.error(`    code: ${err.code}`);
      failed.push(fileName);
      return [];
    }
  });

  const merged = perFileResults.flat();
  await fs.writeFile(outputFile, JSON.stringify(merged, null, 2), "utf-8");
  console.log(`分析完了: ${merged.length}人分`);

  if (files.length > 0 && merged.length === 0) {
    console.error("全員分の分析に失敗しました");
    process.exit(1);
  }
  if (failed.length > 0) {
    console.error(`一部の社員の分析に失敗しました(${failed.length}人): ${failed.join(", ")}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
