import { expect, it } from "vitest";
import { defaultMonitorConfig, evaluateHealth, validateMonitorConfig, validateSlackWebhook, type HealthRow } from "./log-monitor";
const config = { ...defaultMonitorConfig, enabled: true };
const row: HealthRow = { slug: "employee", name: "Test", status: "pending", monitoring_enabled: 1, has_token: 1, added_at: "2026-09-01 00:00:00", heartbeat_at: null, collection_ok: null, today_upload_at: null };
const enabled = "2026-09-01T00:00:00Z";
const state = (patch: Partial<HealthRow> = {}, now = "2026-09-10T03:00:00Z", c = config) => evaluateHealth([{ ...row, ...patch }], c, enabled, new Date(now)).employees[0].state;
it("detects missing first upload for a token-issued employee after grace", () => expect(state()).toBe("missing_today"));
it("skips weekends, off hours, holidays, monitoring-off and explicit exclusions", () => {
  expect(state({}, "2026-09-12T03:00:00Z")).toBe("outside_hours");
  expect(state({}, "2026-09-10T10:00:00Z")).toBe("outside_hours");
  expect(state({}, undefined, { ...config, holidays: ["2026-09-10"] })).toBe("outside_hours");
  expect(state({ monitoring_enabled: 0 })).toBe("excluded");
  expect(state({}, undefined, { ...config, excludedSlugs: ["employee"] })).toBe("excluded");
  expect(state({ has_token: 0 })).toBe("excluded");
});
it("respects business-opening and newly-enabled grace periods", () => {
  expect(state({}, "2026-09-10T01:00:00Z")).toBe("grace");
  expect(evaluateHealth([row], config, "2026-09-10T02:30:00Z", new Date("2026-09-10T03:00:00Z")).issues).toEqual([]);
});
it("unchanged logs with healthy heartbeat are not falsely called stale", () => {
  expect(state({ today_upload_at: "2026-09-10 00:00:00", heartbeat_at: "2026-09-10T02:50:00Z", collection_ok: 1 })).toBe("ok");
  expect(state({ today_upload_at: "2026-09-10 00:00:00" })).toBe("stale");
});
it("heartbeat alone cannot hide missing logs or a collector error", () => {
  expect(state({ heartbeat_at: "2026-09-10T02:50:00Z", collection_ok: 1 })).toBe("missing_today");
  expect(state({ heartbeat_at: "2026-09-10T02:50:00Z", collection_ok: 0 })).toBe("collector_error");
});
it("validates schedules and allows only non-redirecting Slack destinations", () => {
  expect(validateMonitorConfig(config)).toEqual(config);
  for (const patch of [{ graceMinutes: 0 }, { weekdays: [] }, { startHour: 19 }, { enabled: "yes" }]) expect(() => validateMonitorConfig({ ...config, ...patch })).toThrow();
  expect(validateSlackWebhook("https://hooks.slack.com/services/T/B/secret")).toContain("hooks.slack.com");
  for (const url of ["http://hooks.slack.com/services/T/B/x", "https://hooks.slack.com.evil.test/services/T/B/x", "http://127.0.0.1", "https://hooks.slack.com/services/T/B/x?secret=x"]) expect(() => validateSlackWebhook(url)).toThrow();
});
