-- 社員PCから共有ドライブを介さずダッシュボードへ直接ログを送る方式(docs/decisions/0003)
ALTER TABLE employees ADD COLUMN upload_token_hash TEXT;
ALTER TABLE employees ADD COLUMN upload_token_rotated_at TEXT;

CREATE TABLE uploads (
  org_id TEXT NOT NULL,
  employee_slug TEXT NOT NULL,
  date TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (org_id, employee_slug, date)
);

CREATE INDEX idx_uploads_org_date ON uploads(org_id, date);
CREATE INDEX idx_uploads_org_uploaded ON uploads(org_id, uploaded_at);
