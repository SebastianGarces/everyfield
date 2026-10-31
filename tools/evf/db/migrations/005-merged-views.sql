-- 005-merged-views (OPS-100): a merged task leaves its open runs closed, and the views tell when it merged.
-- 1. Close the `started` evf runs of tasks already merged, as markMerged now does. Seat runs stay as they are.
-- 2. v_tasks gains last_event (type of the latest event), merged_at (ts of the latest `merged` event) and ref_rows
--    (non-abandoned rows of the same ref). No task row or other column changes.
-- 3. v_health counts merges by merged_at, since updated_at moves on any later write.
UPDATE runs
SET status = 'passed',
	ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	summary = (SELECT COALESCE(t.ref, t.slug) || ' merged' || CASE WHEN t.merge_commit IS NULL THEN '' ELSE ' as ' || substr(t.merge_commit, 1, 10) END FROM tasks t WHERE t.id = runs.task_id)
WHERE status = 'started'
	AND role = 'evf'
	AND task_id IN (SELECT id FROM tasks WHERE status = 'merged');

DROP VIEW v_health;
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
	(SELECT e.type FROM events e WHERE e.task_id = t.id ORDER BY e.ts DESC, e.id DESC LIMIT 1) AS last_event,
	(SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'merged') AS merged_at,
	(SELECT COUNT(*) FROM tasks o WHERE o.status <> 'abandoned' AND COALESCE(o.ref, o.slug) = COALESCE(t.ref, t.slug)) AS ref_rows,
	t.created_at,
	t.updated_at
FROM tasks t
LEFT JOIN goals g ON g.id = t.goal_id;

CREATE VIEW v_health AS
SELECT
	(SELECT COUNT(*) FROM tasks WHERE status NOT IN ('merged', 'done', 'abandoned')) AS open_tasks,
	(SELECT COUNT(*) FROM tasks WHERE status = 'escalated') AS escalated_tasks,
	(SELECT COUNT(*) FROM runs WHERE status = 'started') AS active_seats,
	(SELECT COUNT(*) FROM v_tasks WHERE status = 'merged' AND merged_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')) AS merged_24h,
	(SELECT COUNT(*) FROM v_tasks WHERE status = 'merged' AND merged_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS merged_7d,
	(SELECT AVG(round) FROM v_tasks WHERE status = 'merged' AND merged_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')) AS rounds_per_merge_7d;
