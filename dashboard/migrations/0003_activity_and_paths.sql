ALTER TABLE employees ADD COLUMN drive_path TEXT;
ALTER TABLE employees ADD COLUMN notion_page_url TEXT;

CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_slug TEXT NOT NULL,
  date TEXT NOT NULL,
  app TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  UNIQUE(employee_slug, date, app)
);

CREATE INDEX idx_activity_date ON activity(date);
CREATE INDEX idx_activity_employee ON activity(employee_slug);

CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
