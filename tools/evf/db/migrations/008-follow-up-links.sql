-- 008-follow-up-links (OPS-109): `evf task link` makes an existing row a follow-up of another task. `slice` is the later
-- slice of the parent's spec that a follow-up covers (1 is the first later slice); NULL means it covers no slice, so a
-- plain link never fills one. `linked` is 1 for a row that `evf task link` attached and 0 for a row that storing a spec
-- filed. Storing a spec edits and abandons only filed rows. Every filed row that is not abandoned covers the slice of its
-- position among its parent's live follow-ups, as fileFollowUps counted them before this migration.

ALTER TABLE tasks ADD COLUMN slice INTEGER CHECK (slice IS NULL OR slice >= 1);
ALTER TABLE tasks ADD COLUMN linked INTEGER NOT NULL DEFAULT 0 CHECK (linked IN (0, 1));
UPDATE tasks
SET slice = (
	SELECT COUNT(*) FROM tasks s
	WHERE s.parent_task_id = tasks.parent_task_id AND s.status != 'abandoned' AND s.id <= tasks.id
)
WHERE parent_task_id IS NOT NULL AND status != 'abandoned';
CREATE UNIQUE INDEX tasks_parent_slice ON tasks (parent_task_id, slice)
WHERE slice IS NOT NULL AND status != 'abandoned';
