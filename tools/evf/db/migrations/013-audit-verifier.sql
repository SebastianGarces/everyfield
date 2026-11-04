-- 013-audit-verifier: the result of the optional verifier seat of `evf audit --with-verifier` (OPS-124). A run without
-- the flag leaves all five columns null. `verifier_result` is found, missed or no-verdict; `verifier_findings` holds
-- the seat's [{ "file", "line", "summary" }] list; `verifier_usage` holds the tokens per model (readSessionUsage).

ALTER TABLE audit_runs ADD COLUMN verifier_result TEXT CHECK (verifier_result IN ('found', 'missed', 'no-verdict'));
ALTER TABLE audit_runs ADD COLUMN verifier_session TEXT;
ALTER TABLE audit_runs ADD COLUMN verifier_findings TEXT CHECK (verifier_findings IS NULL OR json_valid(verifier_findings));
ALTER TABLE audit_runs ADD COLUMN verifier_usage TEXT CHECK (verifier_usage IS NULL OR json_valid(verifier_usage));
ALTER TABLE audit_runs ADD COLUMN verifier_ended_at TEXT;
