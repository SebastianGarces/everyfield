-- 011-proof-writer (OPS-112): who wrote a proof row. `seat` rows come from `evf proof add`; `evf` rows come from
-- `evf ac run`, which ran the tests that carry a criterion's AC: marker at the worktree HEAD. Rows written before this
-- migration were all written by seats.

ALTER TABLE proofs ADD COLUMN written_by TEXT NOT NULL DEFAULT 'seat' CHECK (written_by IN ('seat', 'evf'));
