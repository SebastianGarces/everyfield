// A test fixture that issues an RSVP link the way an invitation send does: the same set-based rsvpTokenUpdate, here in
// a statement of its own. The send also writes the mail rows; a test of the link needs only the token.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { newRsvpToken, rsvpTokenDigest, rsvpTokenUpdate } from "../../../packages/domain/src/meetings/tokens.ts";

type Executor = { execute: (query: ReturnType<typeof sql>) => Promise<{ rows: Record<string, unknown>[] }> };

/** The raw token for the guest's new link, or null when no open meeting's live guest row took it. */
export async function issueRsvpToken(db: Executor, plantId: string, meetingId: string, personId: string) {
	const token = newRsvpToken();
	const pairs = sql`(SELECT ${personId}::uuid AS person_id, ${rsvpTokenDigest(token)}::text AS token_hash)`;
	const r = await db.execute(
		sql`WITH issued AS (${rsvpTokenUpdate(plantId, meetingId, pairs)}) SELECT count(*)::int AS n FROM issued`,
	);
	return r.rows[0]!.n === 1 ? token : null;
}
