-- 002-prototype-statuses: tasks gain the statuses prototype mode needs. SQLite cannot change a CHECK in place, so
-- the table is rebuilt (the documented twelve-step ALTER): new table, copy, drop the views that read it, swap,
-- recreate the indexes and the views unchanged.

CREATE TABLE tasks_new (
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
		CHECK (status IN ('new', 'specced', 'active', 'awaiting_pick', 'escalated', 'pr_open', 'merged', 'done', 'abandoned')),
	worktree TEXT,
	branch TEXT,
	herdr_workspace_id TEXT,
	pr_number INTEGER,
	merge_commit TEXT,
	round INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
INSERT INTO tasks_new SELECT id, slug, mode, ref, goal_id, title, ask, spec, spec_hash, status, worktree, branch, herdr_workspace_id, pr_number, merge_commit, round, created_at, updated_at FROM tasks;
DROP VIEW v_tasks;
DROP VIEW v_seats;
DROP VIEW v_recent;
DROP VIEW v_health;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE UNIQUE INDEX tasks_ref_merge_commit ON tasks (ref, merge_commit) WHERE merge_commit IS NOT NULL;
CREATE INDEX tasks_status ON tasks (status, updated_at);

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
	(SELECT COUNT(*) FROM tasks WHERE status NOT IN ('merged', 'done', 'abandoned')) AS open_tasks,
	(SELECT COUNT(*) FROM tasks WHERE status = 'escalated') AS escalated_tasks,
	(SELECT COUNT(*) FROM runs WHERE status = 'started') AS active_seats,
	(SELECT COUNT(*) FROM tasks WHERE status = 'merged' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS merged_24h,
	(SELECT COUNT(*) FROM tasks WHERE status = 'merged' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS merged_7d,
	(SELECT AVG(round) FROM tasks WHERE status = 'merged' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS rounds_per_merge_7d;
