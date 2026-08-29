-- 社員ごとに、組織共通とは別のNotion書き込み先を指定できるようにする(未設定なら組織共通を使う)
ALTER TABLE employees ADD COLUMN notion_token TEXT;
ALTER TABLE employees ADD COLUMN notion_report_db_url TEXT;
