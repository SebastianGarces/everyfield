-- 004-task-seat-override (OPS-81): a per-task seat model and effort. NULL means no override. The columns belong to one
-- task row, not to the ref. Existing rows keep every value. v_tasks gains the two columns so evf status shows them.
ALTER TABLE tasks ADD COLUMN seat_model TEXT;
ALTER TABLE tasks ADD COLUMN seat_effort TEXT;
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
