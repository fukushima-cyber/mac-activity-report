import { describe, expect, it } from "vitest";
import { generateUploadToken, hashToken, retentionCutoffDate, storageKey, validateDailyLog } from "./logs";

describe("generateUploadToken", () => {
  it("mal_ プレフィックス付きで、十分な長さのトークンを返す", () => {
    const token = generateUploadToken();
    expect(token.startsWith("mal_")).toBe(true);
    expect(token.length).toBeGreaterThanOrEqual(40); // mal_ + 32バイトのbase64url
  });

  it("呼ぶたびに異なるトークンを返す", () => {
    const a = generateUploadToken();
    const b = generateUploadToken();
    expect(a).not.toBe(b);
  });
});

describe("hashToken", () => {
  it("同じ入力には常に同じハッシュを返す(決定的)", async () => {
    const hash1 = await hashToken("mal_sometoken");
    const hash2 = await hashToken("mal_sometoken");
    expect(hash1).toBe(hash2);
  });

  it("SHA-256の16進数表現(64文字)を返す", async () => {
    const hash = await hashToken("mal_sometoken");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("異なる入力には異なるハッシュを返す", async () => {
    const hash1 = await hashToken("mal_tokenA");
    const hash2 = await hashToken("mal_tokenB");
    expect(hash1).not.toBe(hash2);
  });
});

describe("validateDailyLog", () => {
  const validSample = {
    date: "2026-09-04",
    employee: "hie",
    windows: [{ app: "Chrome", title: "example", seconds: 30 }],
    active_seconds: 3600,
    window_count: 42,
  };

  it("正しい形のログを受理する", () => {
    const result = validateDailyLog(validSample, "hie");
    expect(result).toEqual({ ok: true, date: "2026-09-04" });
  });

  it("employeeがトークンの社員と一致しない場合は拒否する", () => {
    const result = validateDailyLog(validSample, "other-employee");
    expect(result.ok).toBe(false);
  });

  it("dateの形式が不正な場合は拒否する", () => {
    const result = validateDailyLog({ ...validSample, date: "2026/09/04" }, "hie");
    expect(result.ok).toBe(false);
  });

  it("windowsが配列でない場合は拒否する", () => {
    const result = validateDailyLog({ ...validSample, windows: "not-an-array" }, "hie");
    expect(result.ok).toBe(false);
  });

  it("オブジェクトでない入力は拒否する", () => {
    expect(validateDailyLog("just a string", "hie").ok).toBe(false);
    expect(validateDailyLog(null, "hie").ok).toBe(false);
    expect(validateDailyLog([1, 2, 3], "hie").ok).toBe(false);
  });

  it("active_secondsが数値でない場合は拒否する", () => {
    const result = validateDailyLog({ ...validSample, active_seconds: "3600" }, "hie");
    expect(result.ok).toBe(false);
  });

  it("window_countが数値でない場合は拒否する", () => {
    const result = validateDailyLog({ ...validSample, window_count: "42" }, "hie");
    expect(result.ok).toBe(false);
  });
});

describe("storageKey", () => {
  it("orgs/<org>/logs/<slug>/<date>.json の形になる", () => {
    expect(storageKey("org-1", "hie", "2026-09-04")).toBe("orgs/org-1/logs/hie/2026-09-04.json");
  });
});

describe("retentionCutoffDate", () => {
  it("日数分だけ過去のJST日付を返す(UTC日付をまたぐケース)", () => {
    // 2026-09-04T00:30:00Z は JSTでは2026-09-04T09:30なので、そこから90日前は2026-06-06
    const now = new Date("2026-09-04T00:30:00Z");
    expect(retentionCutoffDate(now, 90)).toBe("2026-06-06");
  });

  it("JST日付境界の前後で正しく切り替わる(UTC 15:30 = JST翌0:30)", () => {
    // 2026-09-03T15:30:00Z は JSTでは2026-09-04T00:30なので、日数0なら当日=2026-09-04
    const now = new Date("2026-09-03T15:30:00Z");
    expect(retentionCutoffDate(now, 0)).toBe("2026-09-04");
  });

  it("日数0なら当日のJST日付をそのまま返す", () => {
    const now = new Date("2026-01-15T03:00:00Z"); // JSTで2026-01-15T12:00
    expect(retentionCutoffDate(now, 0)).toBe("2026-01-15");
  });
});
