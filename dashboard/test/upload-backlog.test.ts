import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { retrySavedUploads, snapshotHash } from "../../agent/export-daily-log";

it("replays old failed snapshots, skips acknowledged and other employees, and retains failed work", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "upload-backlog-test-"));
  const log = (date: string, employee = "test") => ({ date, employee, windows: [], active_seconds: 60, window_count: 0 });
  try {
    for (const date of ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-09"]) {
      await writeFile(path.join(dir, `${date}_test.json`), JSON.stringify(log(date)));
    }
    await writeFile(path.join(dir, "2026-09-04_other.json"), JSON.stringify(log("2026-09-04", "other")));
    await mkdir(path.join(dir, ".uploaded"));
    await writeFile(path.join(dir, ".uploaded/2026-09-01_test.sha256"), snapshotHash(log("2026-09-01")));
    const sent: string[] = [];
    const failed = await retrySavedUploads({
      outputDir: dir, employee: "test", now: new Date("2026-09-10T00:00:00Z"),
      upload: async (body) => {
        const date = JSON.parse(body).date as string;
        sent.push(date);
        return date === "2026-09-02" ? { kind: "gave_up" } : { kind: "ok", date, size: body.length };
      },
    });
    expect(failed).toBe(1);
    expect(sent).toEqual(["2026-09-02", "2026-09-03"]);
    await expect(readFile(path.join(dir, ".uploaded/2026-09-02_test.sha256"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(dir, ".uploaded/2026-09-03_test.sha256"), "utf8")).toBe(snapshotHash(log("2026-09-03")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
