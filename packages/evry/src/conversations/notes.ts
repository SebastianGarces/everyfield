import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import { currentAuthority, liveAuthority } from "../context/authority.ts";
import { scrub } from "../context/errors.ts";
import { LIMITS } from "../context/limits.ts";
import { READ_DRAFT, UPDATE_DRAFT } from "../catalog/catalog.ts";
import type { SourceResult, SourceRow } from "../catalog/types.ts";
import { appendEvent, fence, type RunLease } from "../runtime/run-store.ts";
import { rowLive } from "./liveness.ts";

const protocol = (operation: string, rows: SourceRow[], revision: number): SourceResult => ({
	operation,
	status: "available",
	rows,
	total: null,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions: [],
	facts: { revision },
});
export const notesRead = (notes: PlanningNotes) =>
	protocol(READ_DRAFT, notes.withheld ? [] : notes.sources, notes.revision);

const isNotes = sql`e.kind='tool_result' AND e.body->>'operation'=${UPDATE_DRAFT}`;
const notesRow = z.strictObject({
	notes: z.string(),
	revision: z.int(),
	sources: z.array(z.strictObject({ kind: z.custom<SourceRow["kind"]>((v) => typeof v === "string"), id: z.string() })),
	gone: z.boolean(),
});
export type PlanningNotes = { notes: string; revision: number; sources: SourceRow[]; withheld: boolean };

export async function readNotes(
	db: Pick<Database, "execute">,
	actor: EvryActor,
	conversationId: string,
): Promise<PlanningNotes | null> {
	const r = await db.execute(sql`
		SELECT coalesce(n.notes,'') AS notes,coalesce(n.revision,0) AS revision,coalesce(s.sources,'[]'::jsonb) AS sources,coalesce(s.gone,false) AS gone
		FROM conversation c
		LEFT JOIN LATERAL (SELECT e.sequence,e.body->>'notes' AS notes,(e.body->>'revision')::int AS revision FROM conversation_event e
			WHERE e.conversation_id=c.id AND ${isNotes} ORDER BY e.sequence DESC LIMIT 1) n ON true
		LEFT JOIN LATERAL (
			SELECT jsonb_agg(DISTINCT jsonb_build_object('kind',r->>'kind','id',r->>'id')) AS sources,
				bool_or(NOT ${rowLive(sql`r`, sql`c.tenant_id`, sql`c.account_id`)}) AS gone
			FROM conversation_event t CROSS JOIN jsonb_array_elements(coalesce(t.body->'result'->'rows','[]'::jsonb)) r
			WHERE t.conversation_id=c.id AND t.kind='tool_result' AND t.sequence<=n.sequence AND t.turn_id IN (
				SELECT w.turn_id FROM conversation_event w WHERE w.conversation_id=c.id AND w.sequence>=(
					SELECT max(e.sequence) FROM conversation_event e WHERE e.conversation_id=c.id AND ${isNotes} AND (e.body->>'fresh')::boolean)
				AND w.kind='tool_result' AND w.body->>'operation'=${UPDATE_DRAFT})
		) s ON true
		WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid
			AND ${liveAuthority(actor)}`);
	if (!r.rows.length) return null;
	const row = notesRow.parse(r.rows[0]);
	return {
		notes: row.gone ? "" : scrub(row.notes),
		revision: row.revision,
		sources: row.sources.map((s) => ({ ...s, label: "", fields: {} })),
		withheld: row.gone,
	};
}

export type NotesUpdate =
	| { status: "saved"; revision: number }
	| { status: "stale"; revision: number }
	| { status: "too_long" }
	| { status: "lost" };
export async function updateNotes(
	db: Database,
	actor: EvryActor,
	lease: RunLease,
	conversationId: string,
	input: { notes: string; expectedRevision: number },
): Promise<NotesUpdate> {
	const notes = scrub(input.notes.trim());
	if (notes.length > LIMITS.notesChars) return { status: "too_long" };
	return db.transaction(async (tx): Promise<NotesUpdate> => {
		const held = await tx.execute(sql`SELECT c.id FROM conversation c WHERE c.id=${conversationId}::uuid
			AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid
			AND c.active_turn_id=${lease.turnId}::uuid AND ${fence(lease)} AND ${currentAuthority(actor)} FOR UPDATE`);
		const before = held.rows.length ? await readNotes(tx, actor, conversationId) : null;
		if (!before) return { status: "lost" };
		if (before.revision !== input.expectedRevision) return { status: "stale", revision: before.revision };
		const revision = before.revision + 1;
		const saved = await appendEvent(tx, lease, conversationId, "tool_result", {
			operation: UPDATE_DRAFT,
			notes,
			revision,
			fresh: !before.notes,
			result: protocol(UPDATE_DRAFT, [], revision),
		});
		return saved === null ? { status: "lost" } : { status: "saved", revision };
	});
}
