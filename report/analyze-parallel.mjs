// 社員ごとに個別の claude -p 呼び出しで分析し、複数人を同時並行(既定4人)で処理する。
// 1回のプロンプトに全員分の生ログを積む方式だと、人数が増えるほどコンテキストが
// 膨らみ実行時間・トークン消費が線形以上に増えるため、1人分ずつに分割して並列化している。
// 1人の失敗(壊れたログ等・API側の一時的な過負荷等)が他の人の結果を巻き込まないよう、
// 失敗した人は数回リトライしてもダメならスキップして続行する。
//
// 使い方: node report/analyze-parallel.mjs <DATE> <COLLECTED_DIR> <PROMPT_TEMPLATE_PATH> <OUTPUT_FILE>
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const [date, collectedDir, promptTemplatePath, outputFile] = process.argv.slice(2);
if (!date || !collectedDir || !promptTemplatePath || !outputFile) {
  console.error("使い方: node analyze-parallel.mjs <DATE> <COLLECTED_DIR> <PROMPT_TEMPLATE_PATH> <OUTPUT_FILE>");
  process.exit(1);
}

const CONCURRENCY = Number(process.env.REPORT_CONCURRENCY) || 4;

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

function extractJsonArray(raw) {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("JSON配列が見つかりませんでした");
  return JSON.parse(raw.slice(start, end + 1));
}

async function analyzeOne(fileName, template, maxAttempts = 3) {
  const employeeDir = await fs.mkdtemp(path.join(os.tmpdir(), "mac-activity-single-"));
  await fs.symlink(path.join(collectedDir, fileName), path.join(employeeDir, fileName));

  const prompt = template.replaceAll("{{DATE}}", date).replaceAll("{{SHARED_DRIVE_PATH}}", employeeDir);

  try {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { stdout } = await execFileAsync("claude", ["-p", prompt, "--allowedTools", "Read"], {
          maxBuffer: 1024 * 1024 * 20,
          // stdinを開いたパイプのままにすると、claude -p が入力待ちで詰まることがあるため明示的に閉じる
          stdio: ["ignore", "pipe", "pipe"],
        });
        return extractJsonArray(stdout);
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts) throw err;
        // API側の一時的な過負荷(529等)を想定し、間隔をあけて再試行する
        const waitSeconds = attempt * 10;
        console.log(`  再試行します(${fileName}, ${attempt}/${maxAttempts}, ${waitSeconds}秒待機): ${(err.stdout || err.message || "").slice(0, 200)}`);
        await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      }
    }
    throw lastErr;
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
      return [];
    }
  });

  const merged = perFileResults.flat();
  await fs.writeFile(outputFile, JSON.stringify(merged, null, 2), "utf-8");
  console.log(`分析完了: ${merged.length}人分`);
}

main().catch((err) => {
  console.error("エラー:", err.message);
  process.exit(1);
});
