# evf check slots: first real four-check set (2026-W47)

The first evf check set to pass after T-474 landed (`e3a80d4fa`) ran on T-539's head `7cdf1d4e6`, run R-8243 on slot 1.
`db-packages` and `census` ran on the slot's own Postgres (`pgvector/pgvector:0.8.7-pg18`, database `everyfield_ci`).
The census statement-budget test asserted and was not skipped. `fast-check` had passed for the same head in R-8228,
also on slot 1.

| Check | Wall | Slots busy | T-474 rehearsal (1 slot) |
|---|---|---|---|
| fast-check (R-8228) | ~40 s | 2 | n/a |
| full-check | 1381 s | 4, falling to 1 | 896 s (+54 %) |
| db-packages | 346 s | 1 | 212 s (+63 %) |
| census | 353 s | 1 | 694 s (−49 %) |
| whole set | 2089 s | | |

Seven earlier sets on the new config timed out in `full-check` at 25 minutes, with 2 to 4 slots busy. R-8243 passed
only after the other tasks were held, and its `full-check` still used 23 of its 25 minutes.

Evidence, kept outside the repository: `~/dev/everyfield-evidence/t478/README.md` (T-478).
