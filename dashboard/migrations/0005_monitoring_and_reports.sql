ALTER TABLE employees ADD COLUMN monitoring_enabled INTEGER NOT NULL DEFAULT 1;

CREATE TABLE reports (
  org_id TEXT NOT NULL,
  employee_slug TEXT NOT NULL,
  date TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  active_hours REAL,
  window_count INTEGER,
  summary TEXT,
  waste_notes TEXT,
  automation_notes TEXT,
  timeline_json TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, employee_slug, date)
);

CREATE INDEX idx_reports_org_date ON reports(org_id, date);
