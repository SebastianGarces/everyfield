import { and, eq, isNull } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
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
			const r = await tx
				.select({ id: tables.pipeline_person.id })
				.from(tables.pipeline_person)
				.where(
					and(
						and(
							eq(tables.pipeline_person.organization_id, subject.owner.id),
							eq(tables.pipeline_person.person_id, subject.id),
						),
						eq(tables.pipeline_person.responsible_seat_id, actor.context.seatId),
					),
				);
			return !!r.length;
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
							? await tx
									.select({ person_id: tables.person_note.person_id, author_id: tables.person_note.author_id })
									.from(tables.person_note)
									.where(
										and(
											and(eq(tables.person_note.id, subject.id), eq(tables.person_note.tenant_id, subject.owner.id)),
											isNull(tables.person_note.removed_at),
										),
									)
							: null;
					if (operation !== "people.addNote" && (!notes?.length || notes[0]!.author_id !== actor.accountId))
						return false;
					if (subject.owner.kind === "organization") {
						if (isAdministrator(actor)) return true;
						const personId = notes?.[0]?.person_id ?? subject.id;
						const r = await tx
							.select({ id: tables.pipeline_person.id })
							.from(tables.pipeline_person)
							.where(
								and(
									and(
										eq(tables.pipeline_person.organization_id, subject.owner.id),
										eq(tables.pipeline_person.person_id, personId),
									),
									eq(tables.pipeline_person.responsible_seat_id, actor.context.seatId),
								),
							);
						return !!r.length;
					}
					return true;
				},
			}) satisfies OperationPolicy,
	),
];
