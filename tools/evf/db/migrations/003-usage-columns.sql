-- 003-usage-columns (OPS-69): cache token counts per run. tokens_in holds uncached input tokens, tokens_out output
-- tokens; cost_est is a list-price estimate in US dollars (nothing is billed). Existing rows keep every value.
ALTER TABLE runs ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE runs ADD COLUMN cache_write_tokens INTEGER;
