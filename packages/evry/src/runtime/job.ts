/** A job that no worker took within this many seconds is lost: the request that queued it never ran its drain. */
export const CLAIM_SECONDS = 60;

/**
 * The one rule for whether an Evry job (a turn's run or an approved effect, both one attempt) can still make progress:
 * it is queued and younger than CLAIM_SECONDS, or claimed with a lease that has not ended. Every run and effect state
 * Evry reports or acts on derives from it, so a lost worker or an unclaimed job ends within a bounded time.
 */
export const liveJob = (alias: string) =>
	`((${alias}.state='ready' AND ${alias}.eligible_at>clock_timestamp()-make_interval(secs=>${CLAIM_SECONDS})) OR (${alias}.state='claimed' AND ${alias}.lease_until>clock_timestamp()))`;
