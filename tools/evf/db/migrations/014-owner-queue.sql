-- 014-owner-queue: one owner_ask for each task that already waits for Sebastian when the queue starts (OPS-131). An
-- escalated task, an awaiting_pick task and a pr_open task whose latest owner_approval_wait has no later owner approval.
-- askedAt is the time of that event. The old events carry no head and no digest slot, so both are null. An old wait does
-- not name its route: the text of a voided approval and an FB ref give the kind, and any other wait is `parked`.
-- The NOT EXISTS keeps a second run from adding anything.

INSERT INTO events (task_id, ts, type, payload)
SELECT
	w.id,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	'owner_ask',
	json_object('task', w.task, 'pr', w.pr, 'head', NULL, 'kind', w.kind, 'digestId', NULL, 'askedAt', w.asked_at)
FROM (
	SELECT
		t.id,
		COALESCE(t.ref, t.slug) AS task,
		t.pr_number AS pr,
		'escalation' AS kind,
		COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'escalation'), t.updated_at) AS asked_at
	FROM tasks t
	WHERE t.status = 'escalated'
	UNION ALL
	SELECT
		t.id,
		COALESCE(t.ref, t.slug),
		t.pr_number,
		'prototype_pick',
		COALESCE((SELECT MAX(e.ts) FROM events e WHERE e.task_id = t.id AND e.type = 'awaiting_pick'), t.updated_at)
	FROM tasks t
	WHERE t.status = 'awaiting_pick'
	UNION ALL
	SELECT
		t.id,
		COALESCE(t.ref, t.slug),
		t.pr_number,
		CASE
			WHEN e.payload LIKE '%owner approval is void%' THEN 'void_approval'
			WHEN t.ref LIKE 'FB-%' THEN 'feedback'
			ELSE 'parked'
		END,
		e.ts
	FROM tasks t
	JOIN events e ON e.id = (
		SELECT MAX(l.id) FROM events l WHERE l.task_id = t.id AND l.type = 'owner_approval_wait'
	)
	WHERE t.status = 'pr_open'
		AND NOT EXISTS (
			SELECT 1 FROM approvals a
			WHERE a.task_id = t.id AND a.gate = 'owner' AND a.decision = 'approved' AND a.created_at > e.ts
		)
) w
WHERE NOT EXISTS (SELECT 1 FROM events o WHERE o.task_id = w.id AND o.type = 'owner_ask');
