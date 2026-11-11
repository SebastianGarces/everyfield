import {
	organizationPersonRequest,
	ownResidencyProjection,
	pipelineAccessResult,
	pipelineDuty,
} from "@everyfield/contracts/access";
import { owner, type Owner, type sessionId } from "@everyfield/contracts/common";
import type { Transaction } from "@everyfield/db/client";
import { alias, and, eq, isNull, sql } from "@everyfield/db/query";
import * as tables from "@everyfield/db/tables";
import "server-only";
import { z } from "zod";
import { currentActor, liveOwner, liveRead, observedActor } from "./session.ts";

const development_enrollment_e = alias(tables.development_enrollment, "e");
const development_program_p = alias(tables.development_program, "p");

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

/**
 * The residency link `l` (a residency_link row in the statement) is its account's live residency: accepted and not
 * ended, its connection with the organization accepted, not ended and not being deleted, its residency invitation
 * accepted by that account, and its person live and linked to that account.
 */
export const liveResidency = sql<boolean>`(l.ended_at IS NULL AND l.accepted_at<=clock_timestamp()
 AND EXISTS(SELECT FROM affiliation a WHERE a.id=l.affiliation_id AND a.organization_id=l.organization_id
  AND a.account_id=l.account_id AND a.ended_at IS NULL AND a.accepted_at<=clock_timestamp()
  AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.affiliation_id=a.id AND w.state NOT IN ('active','cancelled')))
 AND EXISTS(SELECT FROM invitation i WHERE i.id=l.invitation_id AND i.tenant_id=l.organization_id
  AND i.accepted_account_id=l.account_id AND i.state='accepted' AND i.purpose='residency_link' AND i.resident_person_id=l.person_id)
 AND EXISTS(SELECT FROM person p WHERE p.id=l.person_id AND p.tenant_id=l.organization_id
  AND p.linked_account_id=l.account_id AND p.state='live'))`;

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
	const links = (
		await tx.execute<{ id: string; revision: string }>(
			sql`SELECT l.id, l.revision::text AS revision FROM residency_link l WHERE l.organization_id=${organization.id}::uuid
			AND l.person_id=${input.data.personId}::uuid AND l.account_id=${accountId}::uuid AND ${liveResidency} AND ${live}`,
		)
	).rows;

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
