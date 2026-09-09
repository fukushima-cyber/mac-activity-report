export function validateAnalysis(reports, expectedSlug) {
  if (typeof expectedSlug !== "string" || !expectedSlug) throw new Error("Source employee is required");
  if (!Array.isArray(reports) || reports.length !== 1) throw new Error("Expected exactly one employee report");
  const report = reports[0];
  if (!report || report.employee_slug !== expectedSlug) throw new Error("Analysis employee does not match source log");
  for (const key of ["active_hours", "window_count"]) {
    if (typeof report[key] !== "number" || !Number.isFinite(report[key]) || report[key] < 0) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (report.active_hours > 24 || !Number.isInteger(report.window_count)) throw new Error("Invalid activity totals");
  for (const key of ["employee_name", "summary", "waste_notes", "automation_notes", "day_note"]) {
    if (report[key] != null && typeof report[key] !== "string") throw new Error(`Invalid ${key}`);
  }
  if (!Array.isArray(report.timeline) || report.timeline.some((entry) =>
    !entry || ["time_range", "duration", "main_app", "description"].some((key) => typeof entry[key] !== "string")
  )) throw new Error("Invalid timeline");
  return reports;
}
