-- 016-drive-heartbeat (OPS-137): a live drive records a heartbeat each minute, and the drive records its normal end and
-- a requested stop. These records say nothing about the task's work, so last_event and last_event_at in v_tasks skip
-- them and the TUI still shows `awaiting owner` after them. v_recent leaves the heartbeats out. The dead drive watcher
-- reads the latest event of each type for each task once per minute, so that read gets an index.

CREATE INDEX events_task_type ON events (task_id, type, id);

DROP VIEW v_health;
DROP VIEW v_recent;
DROP VIEW v_tasks;

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
	t.seat_model,
	t.seat_effort,
	t.parent_task_id,
	g.key AS goal_key,
	g.title AS goal_title,
	(SELECT r.stage FROM runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS stage,
	(SELECT r.status FROM runs r WHERE r.task_id = t.id ORDER BY r.started_at DESC, r.id DESC LIMIT 1) AS stage_status,
	(SELECT COUNT(*) FROM runs r WHERE r.task_id = t.id AND r.status = 'started') AS active_seats,
	(SELECT COUNT(*) FROM proofs p WHERE p.task_id = t.id AND p.status = 'met') AS proofs_met,
	(SELECT COUNT(*) FROM proofs p WHERE p.task_id = t.id) AS proofs_total,
	(SELECT e.ts FROM events e WHERE e.task_id = t.id AND e.type NOT IN ('drive_heartbeat', 'drive_ended', 'drive_stop_requested') ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS last_event_at,
	(SELECT e.type FROM events e WHERE e.task_id = t.id AND e.type NOT IN ('drive_heartbeat', 'drive_ended', 'drive_stop_requested') ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS last_event,
	(SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'merged') AS merged_at,
	(SELECT COUNT(*) FROM tasks o WHERE o.status NOT IN ('abandoned', 'queued') AND COALESCE(o.ref, o.slug) = COALESCE(t.ref, t.slug)) AS ref_rows,
	(SELECT json_extract(e.payload, '$.cause') FROM events e WHERE e.task_id = t.id AND e.type = 'held_external' ORDER BY e.id DESC LIMIT 1) AS hold_cause,
	t.created_at,
	t.updated_at
FROM tasks t
LEFT JOIN goals g ON g.id = t.goal_id;

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
WHERE e.type <> 'drive_heartbeat'
ORDER BY e.ts DESC, e.id DESC;

CREATE VIEW v_health AS
SELECT
	(SELECT COUNT(*) FROM tasks WHERE status NOT IN ('queued', 'merged', 'done', 'abandoned')) AS open_tasks,
	(SELECT COUNT(*) FROM tasks WHERE status = 'escalated') AS escalated_tasks,
	(SELECT COUNT(*) FROM runs WHERE status = 'started') AS active_seats,
	(SELECT COUNT(*) FROM v_tasks WHERE status = 'merged' AND merged_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS merged_24h,
	(SELECT COUNT(*) FROM v_tasks WHERE status = 'merged' AND merged_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS merged_7d,
	(SELECT AVG(round) FROM v_tasks WHERE status = 'merged' AND merged_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS rounds_per_merge_7d;
