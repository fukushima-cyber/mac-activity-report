// Dashboard ingestion is the pending queue's completion marker. Commit it last.
export async function publishReports(reports, { notionConfig, publishNotion, publishDashboard, onError = console.error }) {
  const failures = [];
  for (const report of reports) {
    try {
      const config = await notionConfig(report.employee_slug);
      if (config.name) report.employee_name = config.name;
      if (Boolean(config.token) !== Boolean(config.reportDbUrl)) throw new Error("Notion token and database must be configured together");
      if (config.token) await publishNotion(report, config);
      await publishDashboard(report);
    } catch (error) {
      failures.push(report.employee_slug);
      onError(`Publish failed (${report.employee_slug}): ${error.message}`);
    }
  }
  if (failures.length) throw new Error(`Reports remain pending: ${failures.join(", ")}`);
}
