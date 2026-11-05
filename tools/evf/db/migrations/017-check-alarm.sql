-- OPS-139: the new check alarm and the red check alarm. Events alone do not fit: each poll would write one per name.
-- One row per check name. new_state is 'baseline' for a name the poll must not call new, 'watching' until the name
-- reaches 2 PRs, then 'alarmed'. first_seen_at and prs start again when a name comes back after more than 7 days.
CREATE TABLE check_names (
	name TEXT PRIMARY KEY,
	first_seen_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	prs TEXT NOT NULL,
	new_state TEXT NOT NULL CHECK (new_state IN ('baseline', 'watching', 'alarmed')),
	red_alarmed INTEGER NOT NULL DEFAULT 0
);

-- One row. last_attempt_at spaces the sampler's polls; last_ok_at is the last poll whose GitHub reads all worked.
CREATE TABLE check_poll (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	last_attempt_at TEXT NOT NULL,
	last_ok_at TEXT
);
