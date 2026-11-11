import {
	organizationPersonRequest,
	ownResidencyProjection,
	pipelineAccessResult,
	pipelineDuty,
} from "@everyfield/contracts/access";
import { owner, type Owner, type sessionId } from "@everyfield/contracts/common";
import type { Transaction } from "@everyfield/db/client";
import { alias, and, eq, isNull, lte, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";
import { currentActor, liveOwner, liveRead, observedActor } from "./session.ts";

const development_enrollment_e = alias(tables.development_enrollment, "e");
const development_program_p = alias(tables.development_program, "p");
const residency_link_l = alias(tables.residency_link, "l");
const affiliation_a = alias(tables.affiliation, "a");
const invitation_i = alias(tables.invitation, "i");
const person_p = alias(tables.person, "p");

export async function readPipelinePerson(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
) {
	const input = organizationPersonRequest.safeParse(raw);
	const unavailable = () => pipelineAccessResult.parse({ status: "unavailable" });
	if (!input.success || selected.kind !== "organization") return unavailable();
	const actor = await currentActor(tx, session, selected, false);
	if (actor.status !== "active" || actor.context.kind !== "seat") return unavailable();
	const person = await tx
		.select({ id: tables.person.id })
		.from(tables.person)
		.where(
			and(
				and(
					and(
						and(eq(tables.person.id, input.data.personId), eq(tables.person.tenant_id, selected.id)),
						eq(tables.person.organization_id, selected.id),
					),
					isNull(tables.person.plant_id),
				),
				eq(tables.person.state, "live"),
			),
		);

	if (person.length !== 1) return unavailable();
	const duties: z.input<typeof pipelineDuty>[] = [];
	if (isAdministrator(actor)) duties.push({ kind: "organization_administration", canReadStaffNotes: true });
	const staff = await tx
		.select({ id: tables.pipeline_person.id })
		.from(tables.pipeline_person)
		.where(
			and(
				and(
					eq(tables.pipeline_person.organization_id, selected.id),
					eq(tables.pipeline_person.person_id, input.data.personId),
				),
				eq(tables.pipeline_person.responsible_seat_id, actor.context.seatId),
			),
		);

	if (staff.length) duties.push({ kind: "responsible_staff", canReadStaffNotes: true });
	const director = await tx
		.select({ id: development_enrollment_e.id })
		.from(development_enrollment_e)
		.innerJoin(
			development_program_p,
			and(
				eq(development_program_p.id, development_enrollment_e.program_id),
				eq(development_program_p.organization_id, development_enrollment_e.organization_id),
			),
		)
		.where(
			and(
				and(
					and(
						eq(development_enrollment_e.organization_id, selected.id),
						eq(development_enrollment_e.person_id, input.data.personId),
					),
					eq(development_enrollment_e.status, "active"),
				),
				eq(development_program_p.director_seat_id, actor.context.seatId),
			),
		);

	if (director.length) duties.push({ kind: "program_director", canReadStaffNotes: false });
	return duties.length
		? pipelineAccessResult.parse({ status: "allowed", organization: selected, personId: input.data.personId, duties })
		: unavailable();
}

export async function readOwnResidency(
	tx: Transaction,
	session: z.infer<typeof sessionId>,
	organization: Owner,
	raw: unknown,
) {
	const input = organizationPersonRequest.safeParse(raw);
	if (!input.success || organization.kind !== "organization" || !(await liveOwner(tx, organization, false)))
		return null;
	// The request actor observed on this transaction names the account; otherwise one lock-free session read does. The
	// link statement checks the account's live access itself (C13), without a session lock (C27).
	const observed = observedActor(tx, session);
	const accountId = observed
		? observed.accountId
		: (await tx.execute<{ account_id: string }>(sql`SELECT account_id FROM live_session(${session})`)).rows[0]
				?.account_id;
	if (!accountId) return null;
	const live = liveRead({ session, owner: owner.parse({ kind: "account", id: accountId }) });
	const links = await tx
		.select({ id: residency_link_l.id, revision: residency_link_l.revision })
		.from(residency_link_l)
		.innerJoin(
			affiliation_a,
			and(
				and(
					eq(affiliation_a.id, residency_link_l.affiliation_id),
					eq(affiliation_a.organization_id, residency_link_l.organization_id),
				),
				eq(affiliation_a.account_id, residency_link_l.account_id),
			),
		)
		.innerJoin(
			invitation_i,
			and(
				and(
					eq(invitation_i.id, residency_link_l.invitation_id),
					eq(invitation_i.tenant_id, residency_link_l.organization_id),
				),
				eq(invitation_i.accepted_account_id, residency_link_l.account_id),
			),
		)
		.innerJoin(
			person_p,
			and(
				and(eq(person_p.id, residency_link_l.person_id), eq(person_p.tenant_id, residency_link_l.organization_id)),
				eq(person_p.linked_account_id, residency_link_l.account_id),
			),
		)
		.where(
			and(
				and(
					and(
						and(
							and(
								and(
									and(
										and(
											and(
												and(
													and(
														and(
															eq(residency_link_l.organization_id, organization.id),
															eq(residency_link_l.person_id, input.data.personId),
														),
														eq(residency_link_l.account_id, accountId),
													),
													isNull(residency_link_l.ended_at),
												),
												lte(
													residency_link_l.accepted_at,
													sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
												),
											),
											isNull(affiliation_a.ended_at),
										),
										lte(
											affiliation_a.accepted_at,
											sql<Date>`clock_timestamp()`.mapWith((value: string) => new Date(value)),
										),
									),
									eq(invitation_i.state, "accepted"),
								),
								eq(invitation_i.purpose, "residency_link"),
							),
							eq(invitation_i.resident_person_id, residency_link_l.person_id),
						),
						eq(person_p.state, "live"),
					),
					sql<unknown>`(NOT EXISTS (SELECT  FROM lifecycle_witness  AS w  WHERE ((w .affiliation_id = a .id) AND (w .state NOT IN (('active'), ('cancelled'))))))`,
				),
				live,
			),
		);

	if (links.length !== 1) return null;
	return ownResidencyProjection.parse({
		organization,
		personId: input.data.personId,
		linkId: links[0]!.id,
		revision: links[0]!.revision,
	});
}

const isAdministrator = (actor: { context: { kind: string; role?: string } }) =>
	actor.context.kind === "seat" && actor.context.role !== "member";
