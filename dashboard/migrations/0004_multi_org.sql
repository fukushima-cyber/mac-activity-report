-- 複数組織(他社・他の人)がこのツールを独立して使えるようにする。
-- 既存データは全て "78500bcc-7993-4a2f-a38e-7c79940ac721"(Bonkers、最初からの利用者)に割り当てる。

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO organizations (id, name) VALUES ('78500bcc-7993-4a2f-a38e-7c79940ac721', 'Bonkers');

-- managers: 組織に所属させる
ALTER TABLE managers ADD COLUMN org_id TEXT NOT NULL DEFAULT '78500bcc-7993-4a2f-a38e-7c79940ac721';

-- employees: slugのユニーク制約を「組織内で一意」に変更するため作り直す
CREATE TABLE employees_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  drive_path TEXT,
  notion_page_url TEXT,
  added_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(org_id, slug)
);
INSERT INTO employees_new (id, org_id, name, slug, note, status, drive_path, notion_page_url, added_at)
  SELECT id, '78500bcc-7993-4a2f-a38e-7c79940ac721', name, slug, note, status, drive_path, notion_page_url, added_at FROM employees;
DROP TABLE employees;
ALTER TABLE employees_new RENAME TO employees;

-- settings: (org_id, key)の複合キーに変更
CREATE TABLE settings_new (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, key)
);
INSERT INTO settings_new (org_id, key, value, updated_at)
  SELECT '78500bcc-7993-4a2f-a38e-7c79940ac721', key, value, updated_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

-- secrets: (org_id, key)の複合キーに変更
CREATE TABLE secrets_new (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);
INSERT INTO secrets_new (org_id, key, value)
  SELECT '78500bcc-7993-4a2f-a38e-7c79940ac721', key, value FROM secrets;
DROP TABLE secrets;
ALTER TABLE secrets_new RENAME TO secrets;

-- activity: org_id列を追加し、ユニーク制約に組み込む
CREATE TABLE activity_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL,
  employee_slug TEXT NOT NULL,
  date TEXT NOT NULL,
  app TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  UNIQUE(org_id, employee_slug, date, app)
);
INSERT INTO activity_new (org_id, employee_slug, date, app, seconds)
  SELECT '78500bcc-7993-4a2f-a38e-7c79940ac721', employee_slug, date, app, seconds FROM activity;
DROP TABLE activity;
ALTER TABLE activity_new RENAME TO activity;
CREATE INDEX idx_activity_date ON activity(date);
CREATE INDEX idx_activity_org_employee ON activity(org_id, employee_slug);
