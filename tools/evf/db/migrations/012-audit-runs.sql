-- 012-audit-runs: one row per `evf audit` run (OPS-116). The run inserts its row when it picks the mutation and sets
-- the outcome and end time when it ends. A row with no outcome is a run that is still going or that crashed.
-- `tests` holds [{ "file": ..., "main": "passed"|"failed", "mutant": "passed"|"failed"|"invalid"|null }].

CREATE TABLE audit_runs (
	id INTEGER PRIMARY KEY,
	task_ref TEXT NOT NULL,
	merge_commit TEXT NOT NULL,
	main_sha TEXT NOT NULL,
	candidate_id TEXT NOT NULL,
	operator TEXT NOT NULL CHECK (operator IN ('off-by-one', 'dropped-call', 'removed-route')),
	file TEXT NOT NULL,
	line INTEGER NOT NULL,
	seed INTEGER NOT NULL,
	dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1)),
	outcome TEXT CHECK (outcome IN ('killed', 'survived', 'invalid', 'baseline-red', 'stopped', 'error')),
	tests TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tests)),
	filed_task TEXT,
	started_at TEXT NOT NULL,
	ended_at TEXT
);
CREATE INDEX audit_runs_task ON audit_runs (task_ref, ended_at);
CREATE INDEX audit_runs_candidate ON audit_runs (task_ref, candidate_id, main_sha);
