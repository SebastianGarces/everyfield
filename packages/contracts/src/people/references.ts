import { z } from "zod";
import { personId, recordId, revision, sameOwner } from "../common/values.ts";
import { tenantOwner } from "./values.ts";

export const lockedPersonReference = z.strictObject({
	owner: tenantOwner,
	personId,
	revision,
	state: z.literal("live"),
});
// References are registered in target.json/person_references, never in a new
// runtime registry. A descriptor identifies one static table+column registration.
// Producer locks both Persons in stable UUID order before consumer rows. Current
// inserts take the same lifecycle locks. Immutable snapshots retain provenance.
export const referenceMoveReview = z
	.strictObject({
		source: lockedPersonReference,
		survivor: lockedPersonReference,
		references: z
			.array(
				z
					.strictObject({
						descriptor: z.string().min(1).max(255),
						recordId,
						beforeRevision: revision,
						afterRevision: revision,
						treatment: z.enum(["rewrite_current", "deduplicate", "preserve_history"]),
						inverse: z.enum(["restore_exact", "retain_original"]),
					})
					.refine((v) => (v.treatment === "preserve_history") === (v.inverse === "retain_original")),
			)
			.max(1000),
	})
	.refine((v) => sameOwner(v.source.owner, v.survivor.owner) && v.source.personId !== v.survivor.personId);
export type ReferenceMoveReview = z.infer<typeof referenceMoveReview>;
// WP-015 implements merge/guarded Unmerge. Every consumer proves its static
// registration, collisions, current revisions and inverse before its own closure.
// No account consent, private care, note authorship or grants move with a Person.
export interface PersonReferenceConsumer<Tx> {
	review(
		tx: Tx,
		pair: { source: z.infer<typeof lockedPersonReference>; survivor: z.infer<typeof lockedPersonReference> },
	): Promise<ReferenceMoveReview>;
	validateInverse(tx: Tx, review: ReferenceMoveReview): Promise<"unchanged" | "conflict">;
}
