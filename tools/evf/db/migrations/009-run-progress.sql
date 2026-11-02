-- 009-run-progress (OPS-115): the progress fingerprint of a seat stage run. When a seat closes a plan, implement,
-- simplify or verify run with `evf run done`, evf records the worktree HEAD and a sha256 of the stored task spec. Two
-- closes of one stage with the same status and the same fingerprint trip the circuit breaker in `evf drive`. Runs closed
-- before this migration, runs evf closed for the seat and evf's own stages keep NULL: they never trip it.

ALTER TABLE runs ADD COLUMN progress_head TEXT;
ALTER TABLE runs ADD COLUMN progress_spec TEXT;
