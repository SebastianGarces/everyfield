import * as c from "@everyfield/contracts/teams";
import { sql } from "@everyfield/db/query";
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuditWrite } from "../../operations/writes.ts";
import { command, deny, next, parse, reply, type Change, type TeamsContext, type Tx, type Writer } from "../core.ts";
import { unique } from "../reads.ts";
import { rosterDigest } from "./digest.ts";

const programRow = z.object({
	id: z.string().uuid(),
	teamId: z.string().uuid().nullable(),
	name: z.string(),
	required: z.boolean(),
	version: z.number().int(),
	revision: z.string(),
	archived: z.boolean(),
});
type Program = z.infer<typeof programRow>;

async function oneRow(tx: Tx, query: ReturnType<typeof sql>) {
	const found = await tx.execute(query);
	return found.rows[0] as Record<string, unknown> | undefined;
}
function today(zone: string) {
	return sql`(clock_timestamp() AT TIME ZONE ${zone})::date`;
}
/** Training rows are not records. The audit subject is a record that already exists. */
function subjectOf(program: Program, plantId: string) {
	return program.teamId ?? plantId;
}

async function lockProgram(tx: Tx, w: Writer, programId: string): Promise<Program> {
	const row = await oneRow(
		tx,
		sql`SELECT id, team_id AS "teamId", name, required, version::int AS version, revision::text AS revision,
			(archived_at IS NOT NULL) AS archived
			FROM training_program WHERE id = ${programId}::uuid AND plant_id = ${w.plant.id}::uuid FOR UPDATE`,
	);
	if (!row) deny();
	return programRow.parse(row);
}
async function teamGate(tx: Tx, w: Writer, teamId: string | null | undefined) {
	if (!teamId) return;
	const row = await oneRow(
		tx,
		sql`SELECT (archived_at IS NOT NULL) AS archived FROM team
			WHERE id = ${teamId}::uuid AND plant_id = ${w.plant.id}::uuid FOR SHARE`,
	);
	if (!row || row.archived === true) deny();
}
async function programTeam(tx: Tx, w: Writer, programId: string) {
	const row = await oneRow(
		tx,
		sql`SELECT team_id AS "teamId" FROM training_program
			WHERE id = ${programId}::uuid AND plant_id = ${w.plant.id}::uuid`,
	);
	return typeof row?.teamId === "string" ? row.teamId : undefined;
}
async function livePeople(tx: Tx, w: Writer, ids: string[]) {
	if (!ids.length) return [];
	const found = await tx.execute(sql`SELECT id, revision::text AS revision FROM person
		WHERE id = ANY(${sql.param(ids)}::uuid[]) AND tenant_id = ${w.plant.id}::uuid AND state = 'live'
		ORDER BY id`);
	if (found.rows.length === ids.length)
		return z.array(z.object({ id: z.string().uuid(), revision: z.string() })).parse(found.rows);
	const other = await oneRow(
		tx,
		sql`SELECT 1 AS n FROM person WHERE id = ANY(${sql.param(ids)}::uuid[]) AND tenant_id <> ${w.plant.id}::uuid`,
	);
	if (other) deny("access_denied");
	deny("invalid_subject");
}
const creditFacts = z.object({
	kind: c.creditKind.nullable(),
	version: z.number().int().nullable(),
	earnedOn: z.string().nullable(),
	verifierAccountId: z.string().uuid().nullable(),
	assigned: z.boolean(),
	member: z.boolean(),
});
async function creditContext(tx: Tx, w: Writer, program: Program, personId: string) {
	const row = await oneRow(
		tx,
		sql`SELECT p.state, p.tenant_id AS "tenantId",
			latest.kind, latest.version::int AS version, latest.earned_on::text AS "earnedOn",
			latest.verifier_account_id AS "verifierAccountId",
			EXISTS (SELECT 1 FROM training_assignment a
				WHERE a.program_id = ${program.id}::uuid AND a.person_id = p.id AND a.state = 'active') AS assigned,
			EXISTS (SELECT 1 FROM team_tenure tn
				JOIN team_role r ON r.id = tn.role_id AND r.retired_at IS NULL AND r.plant_id = p.tenant_id
				WHERE tn.person_id = p.id AND tn.ended_on IS NULL AND tn.plant_id = p.tenant_id
					AND r.team_id IS NOT DISTINCT FROM ${program.teamId}::uuid) AS member
			FROM person p
			LEFT JOIN LATERAL (
				SELECT c.kind, c.version, c.earned_on, c.verifier_account_id
				FROM training_credit c
				WHERE c.plant_id = ${w.plant.id}::uuid AND c.person_id = p.id AND c.program_id = ${program.id}::uuid
				ORDER BY c.recorded_at DESC, c.id DESC
				LIMIT 1
			) latest ON true
			WHERE p.id = ${personId}::uuid AND p.tenant_id = ${w.plant.id}::uuid
			FOR UPDATE OF p`,
	);
	if (!row) {
		const other = await oneRow(tx, sql`SELECT 1 AS n FROM person WHERE id = ${personId}::uuid`);
		if (other) deny("access_denied");
		deny("invalid_subject");
	}
	if (row.state !== "live") deny("invalid_subject");
	return creditFacts.parse({
		...row,
		kind: row.kind ?? null,
		version: row.version ?? null,
		earnedOn: row.earnedOn ?? null,
		verifierAccountId: row.verifierAccountId ?? null,
	});
}
function eligible(program: Program, facts: z.infer<typeof creditFacts>) {
	if (program.archived) deny();
	if (program.required && !facts.assigned) deny("invalid_subject");
	if (!program.required && program.teamId && !facts.member && !facts.assigned) deny("invalid_subject");
}
function compatible(program: Program, facts: z.infer<typeof creditFacts>) {
	return facts.kind === "earned" && facts.version === program.version && facts.earnedOn !== null;
}
function creditValue(
	auditId: string,
	outcome: "changed" | "noop",
	personId: string,
	programId: string | null,
	kind: z.infer<typeof c.creditKind>,
	candidate: boolean,
	verifier: string,
	earnedOn: string | null,
) {
	return c.creditResult.parse({
		receiptId: auditId,
		outcome,
		personId,
		programId,
		kind,
		candidate,
		verifierAccountId: verifier,
		earnedOn,
	});
}

async function createProgram(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.createProgramRequest>,
): Promise<Change<z.infer<typeof c.programMutationResult>>> {
	const teamId = input.input.teamId;
	await teamGate(tx, w, teamId);
	const id = randomUUID();
	const program = programRow.parse({
		id,
		teamId,
		name: input.input.name,
		required: input.input.required,
		version: 1,
		revision: "1",
		archived: false,
	});
	audit.writes.push(sql`INSERT INTO training_program (id, plant_id, team_id, name, required)
		VALUES (${id}::uuid, ${w.plant.id}::uuid, ${teamId}::uuid, ${program.name}, ${program.required})`);
	return {
		value: c.programMutationResult.parse({ receiptId: audit.id, outcome: "changed", program }),
		subject: subjectOf(program, w.plant.id),
		subjectType: "training_program",
		kind: "create",
		before: null,
		after: program,
	};
}
async function correctProgram(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.correctProgramRequest>,
): Promise<Change<z.infer<typeof c.programMutationResult>>> {
	const before = await lockProgram(tx, w, input.input.programId);
	if (before.revision !== input.expectedRevision) deny("conflict");
	const same = before.name === input.input.name && before.required === input.input.required;
	const after = same
		? before
		: {
				...before,
				name: input.input.name,
				required: input.input.required,
				version: before.version + 1,
				revision: next(before.revision),
			};
	if (!same)
		audit.writes.push(sql`UPDATE training_program SET name = ${after.name}, required = ${after.required},
			version = version + 1, revision = revision + 1
			WHERE id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid AND revision = ${before.revision}::bigint`);
	return {
		value: c.programMutationResult.parse({ receiptId: audit.id, outcome: same ? "noop" : "changed", program: after }),
		subject: subjectOf(before, w.plant.id),
		subjectType: "training_program",
		action: "training.corrected",
		kind: "correct",
		outcome: same ? "noop" : "changed",
		reason: input.input.reason,
		before: { name: before.name, required: before.required, version: before.version, teamId: before.teamId },
		after: { name: after.name, required: after.required, version: after.version, teamId: after.teamId },
		revision: { before: before.revision, after: after.revision },
	};
}
async function setRoster(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.setRequiredTrainingRequest>,
): Promise<Change<z.infer<typeof c.rosterResult>>> {
	const before = await lockProgram(tx, w, input.input.programId);
	if (before.revision !== input.expectedRevision) deny("conflict");
	if (before.archived) deny();
	const wanted = unique(input.input.personIds);
	const people = await livePeople(tx, w, wanted);
	const digest = rosterDigest({ programId: before.id, revision: before.revision, people });
	if (digest !== input.input.rosterDigest) deny("conflict");
	const current = await tx.execute(sql`SELECT person_id AS id FROM training_assignment
		WHERE program_id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid AND state = 'active'`);
	const have = new Set(
		z
			.array(z.object({ id: z.string().uuid() }))
			.parse(current.rows)
			.map((row) => row.id),
	);
	const want = new Set(wanted);
	const add = wanted.filter((id) => !have.has(id));
	const remove = [...have].filter((id) => !want.has(id));
	const outcome = add.length || remove.length ? "changed" : "noop";
	if (outcome === "changed") {
		if (remove.length)
			audit.writes
				.push(sql`UPDATE training_assignment SET state = 'removed', ended_on = ${today(w.plant.timezone)}, revision = revision + 1
				WHERE plant_id = ${w.plant.id}::uuid AND program_id = ${before.id}::uuid AND state = 'active'
					AND person_id = ANY(${sql.param(remove)}::uuid[])`);
		if (add.length)
			audit.writes
				.push(sql`INSERT INTO training_assignment (plant_id, program_id, person_id, version, state, effective_on)
				SELECT ${w.plant.id}::uuid, ${before.id}::uuid, p, ${before.version}::int, 'active', ${today(w.plant.timezone)}
				FROM unnest(${sql.param(add)}::uuid[]) AS p`);
		audit.writes.push(sql`UPDATE training_program SET revision = revision + 1
			WHERE id = ${before.id}::uuid AND plant_id = ${w.plant.id}::uuid AND revision = ${before.revision}::bigint`);
	}
	return {
		value: c.rosterResult.parse({
			receiptId: audit.id,
			outcome,
			programId: before.id,
			personIds: wanted,
			added: add.length,
			removed: remove.length,
		}),
		subject: subjectOf(before, w.plant.id),
		subjectType: "training_assignment",
		action: remove.length && !add.length ? "training.assignment_removed" : "training.assigned",
		kind: remove.length && !add.length ? "remove" : "assign",
		outcome,
		before: { personIds: [...have].sort() },
		after: { personIds: wanted },
		revision: { before: before.revision, after: outcome === "changed" ? next(before.revision) : before.revision },
	};
}
async function attestProgram(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.attestProgramRequest>,
): Promise<Change<z.infer<typeof c.creditResult>>> {
	const body = input.input;
	const program = await lockProgram(tx, w, body.programId);
	if (program.revision !== input.expectedRevision) deny("conflict");
	const facts = await creditContext(tx, w, program, body.personId);
	eligible(program, facts);
	if (compatible(program, facts))
		return {
			value: creditValue(
				audit.id,
				"noop",
				body.personId,
				program.id,
				"earned",
				true,
				facts.verifierAccountId ?? w.accountId,
				facts.earnedOn,
			),
			subject: body.personId,
			subjectType: "training_credit",
			action: "training.completed",
			kind: "earn",
			outcome: "noop",
		};
	audit.writes
		.push(sql`INSERT INTO training_credit (plant_id, person_id, program_id, kind, version, earned_on, verifier_account_id)
		VALUES (${w.plant.id}::uuid, ${body.personId}::uuid, ${program.id}::uuid, 'earned', ${program.version}::int,
			${body.earnedOn}::date, ${w.accountId}::uuid)`);
	return {
		value: creditValue(audit.id, "changed", body.personId, program.id, "earned", true, w.accountId, body.earnedOn),
		subject: body.personId,
		subjectType: "training_credit",
		action: "training.completed",
		kind: "earn",
		before: null,
		after: {
			personId: body.personId,
			programId: program.id,
			version: program.version,
			earnedOn: body.earnedOn,
			verifierAccountId: w.accountId,
		},
	};
}
async function attestService(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.attestServiceRequest>,
): Promise<Change<z.infer<typeof c.creditResult>>> {
	const body = input.input;
	const person = await oneRow(
		tx,
		sql`SELECT state FROM person WHERE id = ${body.personId}::uuid AND tenant_id = ${w.plant.id}::uuid FOR UPDATE`,
	);
	if (!person) {
		const other = await oneRow(tx, sql`SELECT 1 AS n FROM person WHERE id = ${body.personId}::uuid`);
		if (other) deny("access_denied");
		deny("invalid_subject");
	}
	if (person.state !== "live") deny("invalid_subject");
	const candidate = body.attendanceDays >= 60 && body.volunteerDays >= 60;
	audit.writes
		.push(sql`INSERT INTO training_credit (plant_id, person_id, kind, attendance_days, volunteer_days, verifier_account_id)
		VALUES (${w.plant.id}::uuid, ${body.personId}::uuid, 'service', ${body.attendanceDays}::int, ${body.volunteerDays}::int,
			${w.accountId}::uuid)`);
	return {
		value: creditValue(audit.id, "changed", body.personId, null, "service", candidate, w.accountId, null),
		subject: body.personId,
		subjectType: "training_credit",
		action: "training.completed",
		kind: "earn",
		before: null,
		after: {
			personId: body.personId,
			attendanceDays: body.attendanceDays,
			volunteerDays: body.volunteerDays,
			candidate,
		},
	};
}
async function revoke(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.revokeCompletionRequest>,
): Promise<Change<z.infer<typeof c.creditResult>>> {
	const program = await lockProgram(tx, w, input.input.programId);
	if (program.revision !== input.expectedRevision) deny("conflict");
	const facts = await creditContext(tx, w, program, input.input.personId);
	if (facts.kind !== "earned" || facts.version === null)
		return {
			value: creditValue(audit.id, "noop", input.input.personId, program.id, "revoked", false, w.accountId, null),
			subject: input.input.personId,
			subjectType: "training_credit",
			action: "training.revoked",
			kind: "revoke_credit",
			outcome: "noop",
		};
	audit.writes
		.push(sql`INSERT INTO training_credit (plant_id, person_id, program_id, kind, version, verifier_account_id)
		VALUES (${w.plant.id}::uuid, ${input.input.personId}::uuid, ${program.id}::uuid, 'revoked', ${facts.version}::int,
			${w.accountId}::uuid)`);
	return {
		value: creditValue(audit.id, "changed", input.input.personId, program.id, "revoked", false, w.accountId, null),
		subject: input.input.personId,
		subjectType: "training_credit",
		action: "training.revoked",
		kind: "revoke_credit",
		before: {
			kind: "earned",
			version: facts.version,
			earnedOn: facts.earnedOn,
			verifierAccountId: facts.verifierAccountId,
		},
		after: { kind: "revoked", version: facts.version },
	};
}
async function recomplete(
	tx: Tx,
	w: Writer,
	audit: AuditWrite,
	input: z.infer<typeof c.recompleteTrainingRequest>,
): Promise<Change<z.infer<typeof c.creditResult>>> {
	const program = await lockProgram(tx, w, input.input.programId);
	if (program.revision !== input.expectedRevision) deny("conflict");
	const facts = await creditContext(tx, w, program, input.input.personId);
	eligible(program, facts);
	if (compatible(program, facts))
		return {
			value: creditValue(
				audit.id,
				"noop",
				input.input.personId,
				program.id,
				"earned",
				true,
				facts.verifierAccountId ?? w.accountId,
				facts.earnedOn,
			),
			subject: input.input.personId,
			subjectType: "training_credit",
			action: "training.completed",
			kind: "earn",
			outcome: "noop",
		};
	audit.writes
		.push(sql`INSERT INTO training_credit (plant_id, person_id, program_id, kind, version, earned_on, verifier_account_id)
		VALUES (${w.plant.id}::uuid, ${input.input.personId}::uuid, ${program.id}::uuid, 'earned', ${program.version}::int,
			${input.input.earnedOn}::date, ${w.accountId}::uuid)`);
	return {
		value: creditValue(
			audit.id,
			"changed",
			input.input.personId,
			program.id,
			"earned",
			true,
			w.accountId,
			input.input.earnedOn,
		),
		subject: input.input.personId,
		subjectType: "training_credit",
		action: "training.completed",
		kind: "earn",
		before: { kind: facts.kind, version: facts.version },
		after: { kind: "earned", version: program.version, earnedOn: input.input.earnedOn, verifierAccountId: w.accountId },
	};
}

export const trainingWriter = {
	async createProgram(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.createProgramRequest, raw);
			return command(
				tx,
				ctx,
				"teams.createProgram",
				input,
				(w, audit) => createProgram(tx, w, audit, input),
				input.input.teamId ?? undefined,
			);
		});
	},
	async correctProgram(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.correctProgramRequest, raw);
			return command(
				tx,
				ctx,
				"teams.correctProgram",
				input,
				(w, audit) => correctProgram(tx, w, audit, input),
				(t, w) => programTeam(t, w, input.input.programId),
			);
		});
	},
	async setRequiredTrainingParticipants(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.setRequiredTrainingRequest, raw);
			return command(
				tx,
				ctx,
				"teams.setRequiredTrainingParticipants",
				input,
				(w, audit) => setRoster(tx, w, audit, input),
				(t, w) => programTeam(t, w, input.input.programId),
			);
		});
	},
	async attestCompletion(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.attestCompletionRequest, raw);
			if ("expectedRevision" in input) {
				const programId = input.input.programId;
				return command(
					tx,
					ctx,
					"teams.attestCompletion",
					input,
					(w, audit) => attestProgram(tx, w, audit, input),
					(t, w) => programTeam(t, w, programId),
				);
			}
			const personId = input.input.personId;
			return command(
				tx,
				ctx,
				"teams.attestCompletion",
				input,
				(w, audit) => attestService(tx, w, audit, input),
				(t, w) => serviceTeam(t, w, personId),
			);
		});
	},
	async revokeCompletion(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.revokeCompletionRequest, raw);
			return command(
				tx,
				ctx,
				"teams.revokeCompletion",
				input,
				(w, audit) => revoke(tx, w, audit, input),
				(t, w) => programTeam(t, w, input.input.programId),
			);
		});
	},
	async recompleteTraining(tx: Tx, ctx: TeamsContext, raw: unknown) {
		return reply(tx, async () => {
			const input = parse(c.recompleteTrainingRequest, raw);
			return command(
				tx,
				ctx,
				"teams.recompleteTraining",
				input,
				(w, audit) => recomplete(tx, w, audit, input),
				(t, w) => programTeam(t, w, input.input.programId),
			);
		});
	},
};

async function serviceTeam(tx: Tx, w: Writer, personId: string) {
	const row = await oneRow(
		tx,
		sql`SELECT t.id FROM team t
			JOIN person leader ON leader.id = t.leader_person_id AND leader.linked_account_id = ${w.accountId}::uuid
				AND leader.state = 'live' AND leader.tenant_id = t.plant_id
			JOIN team_role r ON r.team_id = t.id AND r.retired_at IS NULL AND r.plant_id = t.plant_id
			JOIN team_tenure tn ON tn.role_id = r.id AND tn.ended_on IS NULL AND tn.person_id = ${personId}::uuid
			WHERE t.plant_id = ${w.plant.id}::uuid AND t.archived_at IS NULL
			LIMIT 1`,
	);
	return typeof row?.id === "string" ? row.id : undefined;
}
