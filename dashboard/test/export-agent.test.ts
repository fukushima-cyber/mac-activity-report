// 社員PC側の送信スクリプト(agent/export-daily-log.ts)の純粋関数のテスト。
// dashboard/src 配下に置くと tsc -b がWorkers用の型設定でagent側まで型検査して壊れるため、ここ(vitestだけが拾う場所)に置く。
import { describe, expect, it } from "vitest";
import { recentJstDates, snapshotHash, sendHeartbeat } from "../../agent/export-daily-log";

describe("recentJstDates", () => {
  it("JST基準で今日を含む直近N日を古い順に返す(UTCではまだ前日でもJSTの日付で数える)", () => {
    const now = new Date("2026-09-06T23:30:00Z"); // JSTでは 2026-09-07 08:30
    expect(recentJstDates(now, 3)).toEqual(["2026-09-05", "2026-09-06", "2026-09-07"]);
  });

  it("1日だけなら今日(JST)だけ", () => {
    expect(recentJstDates(new Date("2026-09-06T03:00:00Z"), 1)).toEqual(["2026-09-06"]);
  });
});

describe("snapshotHash", () => {
  const base = {
    date: "2026-09-06",
    employee: "tester",
    active_seconds: 100,
    window_count: 1,
    windows: [{ app: "Safari", title: "t", start: "2026-09-06T01:00:00Z", duration_seconds: 10 }],
  };

  it("generated_at(実行時刻)が違っても中身が同じなら同じ値(=送信スキップの判定に使える)", () => {
    expect(snapshotHash({ ...base, generated_at: "2026-09-06T10:00:00Z" })).toBe(
      snapshotHash({ ...base, generated_at: "2026-09-06T10:30:00Z" })
    );
  });

  it("中身が違えば別の値", () => {
    expect(snapshotHash(base)).not.toBe(snapshotHash({ ...base, active_seconds: 101 }));
  });
});
it("heartbeat sends only collection status and does not leak operation logs", async () => {
  let body = "";
  await sendHeartbeat(false, "https://example.test", "test-token", async (_url, init) => { body = String(init?.body); return Response.json({ ok: true }); });
  expect(JSON.parse(body)).toEqual({ collection_ok: false });
  await expect(sendHeartbeat(true, "https://example.test", "test-token", async () => { throw new Error("offline"); })).resolves.toBeUndefined();
});
