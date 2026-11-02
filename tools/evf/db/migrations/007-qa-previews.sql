-- 007-qa-previews (OPS-106): one row for each open QA preview that `evf qa up` made. The row is written before the
-- Neon branch, so a crashed `qa up` still leaves what `qa down` needs. It holds names only: never a connection string,
-- key or password. `qa down` deletes the row after it removes the alias, the deployment and the Neon branch.
CREATE TABLE qa_previews (
	id TEXT PRIMARY KEY,
	branch TEXT NOT NULL,
	head TEXT NOT NULL,
	neon_branch TEXT NOT NULL,
	url TEXT NOT NULL,
	deployment TEXT,
	created_at TEXT NOT NULL
);
