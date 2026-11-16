export const CLAIM_SECONDS = 60;

export const liveJob = (alias: string) =>
	`((${alias}.state='ready' AND ${alias}.eligible_at>clock_timestamp()-make_interval(secs=>${CLAIM_SECONDS})) OR (${alias}.state='claimed' AND ${alias}.lease_until>clock_timestamp()))`;
