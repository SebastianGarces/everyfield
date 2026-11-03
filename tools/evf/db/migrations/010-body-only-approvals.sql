-- 010-body-only-approvals: a verify approval may record decision body_only (OPS-113): the verifier approved the code
-- and the experience at the head and listed PR body fixes only. SQLite cannot change a CHECK in place, so the table
-- is rebuilt (the documented twelve-step ALTER). No view or index reads approvals, and no table references it.

CREATE TABLE approvals_new (
	id INTEGER PRIMARY KEY,
	task_id INTEGER NOT NULL REFERENCES tasks (id),
	gate TEXT NOT NULL,
	approver TEXT NOT NULL,
	head_sha TEXT,
	spec_hash TEXT,
	proof_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(proof_ids)),
	decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'rejected', 'body_only')),
	quote TEXT,
	created_at TEXT NOT NULL
);
INSERT INTO approvals_new SELECT id, task_id, gate, approver, head_sha, spec_hash, proof_ids, decision, quote, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
