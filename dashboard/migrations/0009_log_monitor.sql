CREATE TABLE employee_log_health (
  org_id TEXT NOT NULL,
  employee_slug TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  collection_ok INTEGER NOT NULL,
  PRIMARY KEY (org_id, employee_slug)
);

CREATE TABLE log_monitor (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  config_json TEXT NOT NULL,
  webhook_url TEXT,
  enabled_at TEXT NOT NULL,
  notified_signature TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT,
  last_notified_at TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
