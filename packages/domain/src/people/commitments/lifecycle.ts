import { sql, type SQL } from "@everyfield/db/query";
import { z } from "zod";

/**
 * The inputs of a Person's current commitment (C100): the valid cards with their actual signed dates and the explicit
 * dated withdrawals and reactivations. `at` orders changes on the same date by when they were recorded.
 */
export const commitmentInputs = z.object({
	cards: z.array(z.object({ id: z.uuid(), on: z.string() })),
	changes: z.array(
		z.object({ id: z.uuid(), kind: z.enum(["withdrawn", "reactivated"]), on: z.string(), at: z.number() }),
	),
});
export type CommitmentInputs = z.infer<typeof commitmentInputs>;
export type CurrentCommitment = { state: "active" | "withdrawn" | "unknown"; effectiveOn: string | null };

/**
 * One Person's inputs as one JSON value, read in the statement that holds the Person (`person`, `plant`). Its own
 * aliases (input_card, input_change) never capture a caller's alias.
 */
export const commitmentInputsJson = (person: SQL, plant: SQL) => sql`jsonb_build_object(
 'cards',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',input_card.id,'on',input_card.signed_on::text)),'[]')
  FROM commitment input_card WHERE input_card.person_id=${person} AND input_card.plant_id=${plant}
  AND input_card.voided_at IS NULL),
 'changes',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',input_change.id,'kind',input_change.kind,
  'on',input_change.effective_on::text,'at',extract(epoch FROM input_change.recorded_at))),'[]')
  FROM commitment_change input_change WHERE input_change.person_id=${person} AND input_change.plant_id=${plant}))`;

/**
 * REQ-PPL-014 and REQ-PPL-026: the current commitment as one function of its inputs, used by every write that changes
 * them; the Person's commitment columns cache its result. Inputs apply in date order; on one date cards come first, then
 * changes in recorded order. A card makes an unknown commitment active from its signed date. After a withdrawal only a
 * card signed after it makes the commitment active again; an older signature never overrides it. A reactivation makes
 * a withdrawn commitment active from its date. Without a valid card the commitment is unknown.
 */
export function commitmentOf({ cards, changes }: CommitmentInputs): CurrentCommitment {
	const steps = [
		...cards.map((k) => ({ on: k.on, rank: 0, at: 0, id: k.id, kind: "card" as const })),
		...changes.map((e) => ({ on: e.on, rank: 1, at: e.at, id: e.id, kind: e.kind })),
	].sort((a, b) => a.on.localeCompare(b.on) || a.rank - b.rank || a.at - b.at || a.id.localeCompare(b.id));
	let current: CurrentCommitment = { state: "unknown", effectiveOn: null };
	for (const s of steps) {
		const activates =
			(s.kind === "card" &&
				(current.state === "unknown" || (current.state === "withdrawn" && s.on > (current.effectiveOn ?? "")))) ||
			(s.kind === "reactivated" && current.state === "withdrawn");
		if (activates) current = { state: "active", effectiveOn: s.on };
		else if (s.kind === "withdrawn" && current.state === "active") current = { state: "withdrawn", effectiveOn: s.on };
	}
	return current;
}
