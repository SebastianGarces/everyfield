import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { owner, type Owner, type sessionId } from "@everyfield/contracts/common";
import {
	organizationPersonRequest,
	organizationNotesRequest,
	pipelineAccessResult,
	organizationNotesResult,
	ownResidencyProjection,
	pipelineDuty,
} from "@everyfield/contracts/access";
import { currentActor, liveOwner } from "./session.ts";
import { isAdministrator } from "./policy.ts";

export async function readPipelinePerson(
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
) {
	const input = organizationPersonRequest.safeParse(raw);
	const unavailable = () => pipelineAccessResult.parse({ status: "unavailable" });
	if (!input.success || selected.kind !== "organization") return unavailable();
	const actor = await currentActor(tx, session, selected);
	if (actor.status !== "active" || actor.context.kind !== "seat") return unavailable();
	const person = await tx.query(
		"SELECT id FROM person WHERE id=$1 AND tenant_id=$2 AND organization_id=$2 AND plant_id IS NULL AND state='live' FOR SHARE",
		[input.data.personId, selected.id],
	);
	if (person.rows.length !== 1) return unavailable();
	const duties: z.input<typeof pipelineDuty>[] = [];
	if (isAdministrator(actor)) duties.push({ kind: "organization_administration", canReadStaffNotes: true });
	const staff = await tx.query(
		"SELECT id FROM pipeline_person WHERE organization_id=$1 AND person_id=$2 AND responsible_seat_id=$3 FOR SHARE",
		[selected.id, input.data.personId, actor.context.seatId],
	);
	if (staff.rows.length) duties.push({ kind: "responsible_staff", canReadStaffNotes: true });
	const director = await tx.query(
		"SELECT e.id FROM development_enrollment e JOIN development_program p ON p.id=e.program_id AND p.organization_id=e.organization_id WHERE e.organization_id=$1 AND e.person_id=$2 AND e.status='active' AND p.director_seat_id=$3 FOR SHARE OF e,p",
		[selected.id, input.data.personId, actor.context.seatId],
	);
	if (director.rows.length) duties.push({ kind: "program_director", canReadStaffNotes: false });
	return duties.length
		? pipelineAccessResult.parse({ status: "allowed", organization: selected, personId: input.data.personId, duties })
		: unavailable();
}

// This separate native endpoint must never be installed as an Evry tool, export
// or general Person DTO. No notes are loaded by readPipelinePerson.
export async function readOrganizationNotes(
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	selected: Owner,
	raw: unknown,
) {
	const parsed = organizationNotesRequest.safeParse(raw);
	const unavailable = () => organizationNotesResult.parse({ status: "unavailable" });
	if (!parsed.success) return unavailable();
	const input = parsed.data;
	const access = await readPipelinePerson(tx, session, selected, { personId: input.personId });
	if (access.status !== "allowed") return unavailable();
	const duty = access.duties.find((d) => d.kind === "organization_administration" || d.kind === "responsible_staff");
	if (!duty) return unavailable();
	const result = await tx.query(
		"SELECT id,author_id,body,occurred_at,revision FROM person_note WHERE tenant_id=$1 AND person_id=$2 AND plant_id IS NULL AND removed_at IS NULL AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 101 FOR SHARE",
		[selected.id, input.personId, input.after ?? null],
	);
	const notes = result.rows.slice(0, 100).map((note) => ({
		id: note.id,
		author: note.author_id === null ? { kind: "removed" } : { kind: "account", accountId: note.author_id },
		body: note.body,
		occurredAt: note.occurred_at.toISOString(),
		revision: note.revision,
	}));
	return organizationNotesResult.parse({
		status: "allowed",
		purpose: "native_org_person_notes",
		organization: selected,
		personId: input.personId,
		duty: duty.kind,
		notes,
		next: result.rows.length > 100 ? notes.at(-1)!.id : null,
	});
}

export async function readOwnResidency(
	tx: PoolClient,
	session: z.infer<typeof sessionId>,
	organization: Owner,
	raw: unknown,
) {
	const input = organizationPersonRequest.safeParse(raw);
	if (!input.success || organization.kind !== "organization" || !(await liveOwner(tx, organization))) return null;
	const identity = await tx.query("SELECT account_id FROM access_session($1)", [session]);
	if (identity.rows.length !== 1) return null;
	const selected = { kind: "account", id: identity.rows[0].account_id };
	// Parse the trusted database identity through the same account-context loader.
	const accountOwner = owner.parse(selected);
	const actor = await currentActor(tx, session, accountOwner);
	if (actor.status !== "active") return null;
	const links = await tx.query(
		`SELECT l.id,l.revision FROM residency_link l JOIN affiliation a ON a.id=l.affiliation_id AND a.organization_id=l.organization_id AND a.account_id=l.account_id
    JOIN invitation i ON i.id=l.invitation_id AND i.tenant_id=l.organization_id AND i.accepted_account_id=l.account_id
    JOIN person p ON p.id=l.person_id AND p.tenant_id=l.organization_id AND p.linked_account_id=l.account_id
    WHERE l.organization_id=$1 AND l.person_id=$2 AND l.account_id=$3 AND l.ended_at IS NULL AND l.accepted_at<=clock_timestamp()
      AND a.ended_at IS NULL AND a.accepted_at<=clock_timestamp() AND i.state='accepted' AND i.purpose='residency_link' AND i.resident_person_id=l.person_id AND p.state='live'
      AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.affiliation_id=a.id AND w.state NOT IN ('active','cancelled')) FOR SHARE OF l,a,i,p`,
		[organization.id, input.data.personId, actor.accountId],
	);
	if (links.rows.length !== 1) return null;
	return ownResidencyProjection.parse({
		organization,
		personId: input.data.personId,
		linkId: links.rows[0].id,
		revision: links.rows[0].revision,
	});
}
