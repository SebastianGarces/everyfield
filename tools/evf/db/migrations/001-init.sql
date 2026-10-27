-- 001-init: the harness work store (OPS-57). One file per worktree family under <git-common-dir>/evf/work.sqlite.
-- Timestamps are ISO 8601 UTC strings. JSON columns hold text that json_valid accepts.

CREATE TABLE goals (
	id INTEGER PRIMARY KEY,
	key TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL CHECK (kind IN ('project', 'mission')),
	title TEXT NOT NULL,
	body TEXT NOT NULL DEFAULT '',
	parent_id INTEGER REFERENCES goals (id),
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'retired')),
	packages TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(packages)),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
	id INTEGER PRIMARY KEY,
	slug TEXT NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('implement', 'prototype', 'write-article')),
	ref TEXT,
	goal_id INTEGER REFERENCES goals (id),
	title TEXT NOT NULL DEFAULT '',
	ask TEXT NOT NULL DEFAULT '',
	spec TEXT,
	spec_hash TEXT,
	status TEXT NOT NULL DEFAULT 'new'
		CHECK (status IN ('new', 'specced', 'active', 'escalated', 'pr_open', 'merged', 'abandoned')),
	worktree TEXT,
	branch TEXT,
	herdr_workspace_id TEXT,
	pr_number INTEGER,
	merge_commit TEXT,
	round INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX tasks_ref_merge_commit ON tasks (ref, merge_commit) WHERE merge_commit IS NOT NULL;
CREATE INDEX tasks_status ON tasks (status, updated_at);

CREATE TABLE runs (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks (id),
	stage TEXT NOT NULL,
	role TEXT NOT NULL,
	model TEXT,
	effort TEXT,
	round INTEGER NOT NULL DEFAULT 0,
	herdr_agent TEXT,
	herdr_pane TEXT,
	session_id TEXT UNIQUE,
	status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'passed', 'failed', 'aborted')),
	started_at TEXT NOT NULL,
	ended_at TEXT,
	tokens_in INTEGER,
	tokens_out INTEGER,
	cost_est REAL,
	summary TEXT
);
CREATE INDEX runs_task ON runs (task_id, started_at);

CREATE TABLE events (
	id INTEGER PRIMARY KEY,
	task_id INTEGER REFERENCES tasks (id),
	run_id INTEGER REFERENCES runs (id),
	ts TEXT NOT NULL,
	type TEXT NOT NULL,
	payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload))
);
CREATE INDEX events_ts ON events (ts, id);
CREATE INDEX events_task ON events (task_id, ts);

CREATE TABLE proofs (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks (id),
	run_id INTEGER REFERENCES runs (id),
	head_sha TEXT NOT NULL,
	criterion TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('met', 'unmet', 'n/a')),
	evidence_url TEXT,
	notes TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX proofs_task_head ON proofs (task_id, head_sha);

CREATE TABLE approvals (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks (id),
	gate TEXT NOT NULL,
	approver TEXT NOT NULL,
	head_sha TEXT,
	spec_hash TEXT,
	proof_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(proof_ids)),
	decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected')),
	quote TEXT,
	created_at TEXT NOT NULL
);

CREATE TABLE learnings (
	id INTEGER PRIMARY KEY,
	role TEXT NOT NULL,
	text TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'rejected', 'retired')),
	source_task_id INTEGER REFERENCES tasks (id),
	source_run_id INTEGER REFERENCES runs (id),
	model TEXT,
	reviewed_by TEXT,
	created_at TEXT NOT NULL,
	decided_at TEXT
);

-- Views are the read contract for evf status and the TUI. Change them with a new migration, never in place.
CREATE VIEW v_tasks AS
SELECT
	t.id,
	t.ref,
	t.slug,
	t.mode,
	t.status,
	t.round,
	t.pr_number,
	t.merge_commit,
	t.branch,
	t.worktree,
	t.herdr_workspace_id,
	t.title,
	g.key AS goal_key,
	g.title AS goal_title,
	(SELECT r.stage FROM runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS stage,
	(SELECT r.status FROM runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS stage_status,
	(SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id AND r.status = 'started') AS active_seats,
	(SELECT COUNT(*) FROM proofs p WHERE p.task_id = t.id AND p.status = 'met') AS proofs_met,
	(SELECT COUNT(*) FROM proofs p WHERE p.task_id = t.id) AS proofs_total,
	(SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id) AS last_event_at,
	t.created_at,
	t.updated_at
FROM tasks t
LEFT JOIN goals g ON g.id = t.goal_id;

CREATE VIEW v_seats AS
SELECT
	r.id AS run_id,
	t.id AS task_id,
	t.ref,
	t.slug,
	t.mode,
	r.stage,
	r.role,
	r.role || '@' || COALESCE(t.ref, t.slug) AS seat,
	r.model,
	r.effort,
	r.round,
	r.session_id,
	r.herdr_agent,
	r.herdr_pane,
	r.status,
	r.started_at,
	(SELECT e.type FROM events e WHERE e.run_id = r.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS last_event,
	(SELECT e.ts FROM events e WHERE e.run_id = r.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS last_event_at
FROM runs r
JOIN tasks t ON t.id = r.task_id
WHERE r.status = 'started';

CREATE VIEW v_recent AS
SELECT
	e.id,
	e.ts,
	e.type,
	e.task_id,
	e.run_id,
	t.ref,
	t.slug,
	CASE WHEN r.id IS NULL THEN NULL ELSE r.role || '@' || COALESCE(t.ref, t.slug) END AS seat,
	json_extract(e.payload, '$.summary') AS summary,
	e.payload
FROM events e
LEFT JOIN tasks t ON t.id = e.task_id
LEFT JOIN runs r ON r.id = e.run_id
ORDER BY e.ts DESC, e.id DESC;

CREATE VIEW v_health AS
SELECT
	(SELECT COUNT(*) FROM tasks WHERE status NOT IN ('merged', 'abandoned')) AS open_tasks,
	(SELECT COUNT(*) FROM tasks WHERE status = 'escalated') AS escalated_tasks,
	(SELECT COUNT(*) FROM runs WHERE status = 'started') AS active_seats,
	(SELECT COUNT(*) FROM tasks WHERE status = 'merged' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS merged_24h,
	(SELECT COUNT(*) FROM tasks WHERE status = 'merged' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS merged_7d,
	(SELECT AVG(round) FROM tasks WHERE status = 'merged' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS rounds_per_merge_7d;
