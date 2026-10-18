import type { OperationPolicy } from "../access/policy.ts";
import { isAdministrator } from "../access/policy.ts";
const readNames = [
	"people.getPerson",
	"people.listPeople",
	"people.getPipelineData",
	"people.getStatusWarnings",
	"people.getActivities",
	"people.getAccountLink",
	"people.getOwnAccountPerson",
	"people.readPipelineMetrics",
] as const;
const writeNames = [
	"people.createPerson",
	"people.updatePerson",
	"people.changeStatus",
	"people.deletePerson",
	"people.restorePerson",
	"people.recordAdultClassification",
	"people.correctAdultClassification",
	"people.reorderPipeline",
] as const;
// Mounted by the access/Evry adapter; producers independently recheck these facts.
export const peoplePolicies: readonly OperationPolicy[] = [
	...readNames.map(
		(operation) =>
			({
				operation,
				subjectKinds: ["person", "plant"] as const,
				async authorize(_tx, actor, subject, purpose) {
					return (
						actor.context.kind === "seat" &&
						actor.context.owner.kind === "plant" &&
						subject.owner.kind === "plant" &&
						(operation !== "people.readPipelineMetrics" || purpose === "native")
					);
				},
			}) satisfies OperationPolicy,
	),
	...writeNames.map(
		(operation) =>
			({
				operation,
				subjectKinds: ["person", "plant"] as const,
				async authorize(_tx, actor, subject) {
					return subject.owner.kind === "plant" && isAdministrator(actor);
				},
			}) satisfies OperationPolicy,
	),
	...(
		[
			"orgPeople.create",
			"orgPeople.update",
			"orgPeople.retire",
			"orgPeople.restore",
			"orgPeople.remove",
			"orgPeople.export",
		] as const
	).map(
		(operation) =>
			({
				operation,
				subjectKinds: ["person", "organization"] as const,
				async authorize(_tx, actor, subject, purpose) {
					return (
						subject.owner.kind === "organization" &&
						isAdministrator(actor) &&
						(!(operation === "orgPeople.remove" || operation === "orgPeople.export") || purpose !== "model")
					);
				},
			}) satisfies OperationPolicy,
	),
	{
		operation: "orgPeople.read",
		subjectKinds: ["person"],
		async authorize(tx, actor, subject) {
			if (subject.owner.kind !== "organization" || actor.context.kind !== "seat") return false;
			if (isAdministrator(actor)) return true;
			const r = await tx.query(
				"SELECT id FROM pipeline_person WHERE organization_id=$1 AND person_id=$2 AND responsible_seat_id=$3",
				[subject.owner.id, subject.id, actor.context.seatId],
			);
			return !!r.rowCount;
		},
	},
	...(["people.addNote", "people.editNote", "people.deleteNote"] as const).map(
		(operation) =>
			({
				operation,
				subjectKinds: ["person", "person_note"] as const,
				async authorize(tx, actor, subject, purpose) {
					if (actor.context.kind !== "seat") return false;
					if (subject.owner.kind === "organization") {
						if (purpose !== "native") return false;
						// The exact note author check below is separate from current staff duty.
					} else if (subject.owner.kind !== "plant" || !isAdministrator(actor)) return false;
					const notes =
						subject.kind === "person_note"
							? await tx.query(
									"SELECT person_id,author_id FROM person_note WHERE id=$1 AND tenant_id=$2 AND removed_at IS NULL",
									[subject.id, subject.owner.id],
								)
							: null;
					if (operation !== "people.addNote" && (!notes?.rowCount || notes.rows[0].author_id !== actor.accountId))
						return false;
					if (subject.owner.kind === "organization") {
						if (isAdministrator(actor)) return true;
						const personId = notes?.rows[0]?.person_id ?? subject.id;
						const r = await tx.query(
							"SELECT id FROM pipeline_person WHERE organization_id=$1 AND person_id=$2 AND responsible_seat_id=$3",
							[subject.owner.id, personId, actor.context.seatId],
						);
						return !!r.rowCount;
					}
					return true;
				},
			}) satisfies OperationPolicy,
	),
];
