import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { meetingsWriter } from "@everyfield/domain/meetings";
import {
	responsibilityReader,
	responsibilityWriter,
	teamsWriter,
	trainingReader,
	trainingWriter,
} from "@everyfield/domain/teams";
import { scheduleMeetingRequest } from "@everyfield/contracts/meetings";
import {
	appointLeaderRequest,
	archiveTeamRequest,
	assignRoleRequest,
	attestProgramRequest,
	correctProgramRequest,
	createProgramRequest,
	createRoleRequest,
	createTeamRequest,
	editRoleRequest,
	editTeamRequest,
	endMembershipRequest,
	initializeRequest,
	reactivateMembershipRequest,
	recompleteTrainingRequest,
	removeRoleRequest,
	restoreTeamRequest,
	retireRoleRequest,
	revokeCompletionRequest,
	setRequiredTrainingRequest,
	TEMPLATE_VERSION,
	type TeamsReply,
} from "@everyfield/contracts/teams";
import {
	addRequest,
	completeRequest,
	deleteRequest,
	editRequest,
	offerRequest,
} from "@everyfield/contracts/teams/responsibilities";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { recordId } from "../ids.ts";
import type { EffectResult, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";

type TeamsContext = Parameters<typeof teamsWriter.create>[1];

// The Ministries reviewed writes (WP-070). Each review is one SELECT under the proposal's statement: it reads the
// ministry, role, program or responsibility live in the actor's church, shows every change with its value before and
// after (names, never ids) and saves the native command's exact arguments with the revision the review showed. On
// approval the executor runs the owning native teams command once, for the approving session, with the effect key as
// its request key: the command checks the seat and the role again, refuses anything that changed
// since the review (conflict, occupied, unavailable) and writes its audit row with the change. Assigning someone to a
// role never grants an account or a seat, and Evry never records a training completion nobody reported.

const admin = (actor: EvryActor) => actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");
const plant = (actor: EvryActor) => sql`${actor.owner.id}::uuid`;
const json = (value: unknown) => sql`${JSON.stringify(value ?? null)}::jsonb`;
const change = (field: string, before: SQL, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${after})`;
const changes = (...items: SQL[]) => sql`jsonb_build_array(${sql.join(items, sql`,`)})`;
const review = (target: SQL, list: SQL, refusal: SQL = sql`NULL::text`) =>
	sql`jsonb_build_object('target',${target},'changes',${list})||CASE WHEN ${refusal} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal',${refusal}) END`;
const args = (revision: SQL | null, input: SQL) =>
	revision
		? sql`jsonb_build_object('expectedRevision',${revision}::text,'input',${input})`
		: sql`jsonb_build_object('input',${input})`;

const teamTarget = sql`jsonb_build_object('kind','team','id',t.id,'label',t.name)`;
const roleTarget = sql`jsonb_build_object('kind','role','id',r.id,'label',r.name||' · '||t.name)`;
const programTarget = sql`jsonb_build_object('kind','training','id',g.id,'label',g.name)`;
const lineTarget = sql`jsonb_build_object('kind','responsibility','id',l.id,'label',left(l.text,120))`;
/** The ministry `t` in the actor's church. */
const ministry = (actor: EvryActor, teamId: string) =>
	sql`FROM team t WHERE t.id=${teamId}::uuid AND t.plant_id=${plant(actor)}`;
/** The role `r` of ministry `t` in the actor's church. */
const roleIn = (actor: EvryActor, roleId: string) =>
	sql`FROM team_role r JOIN team t ON t.id=r.team_id AND t.plant_id=r.plant_id
		WHERE r.id=${roleId}::uuid AND r.plant_id=${plant(actor)}`;
/** The live person `p` in the actor's church. */
const livePerson = (actor: EvryActor, personId: string) =>
	sql`JOIN person p ON p.id=${personId}::uuid AND p.tenant_id=${plant(actor)} AND p.state='live'`;
/** The current holder of role `r`, by name. */
const holder = sql`(SELECT op.display_name FROM team_tenure tn JOIN person op ON op.id=tn.person_id
	WHERE tn.role_id=r.id AND tn.ended_on IS NULL ORDER BY tn.started_on DESC LIMIT 1)`;
const holderId = sql`(SELECT tn.person_id FROM team_tenure tn WHERE tn.role_id=r.id AND tn.ended_on IS NULL
	ORDER BY tn.started_on DESC LIMIT 1)`;
/** A domain receipt's revision, where the result names one; the outcome still says what happened. */
function receipt(value: Record<string, unknown>): { receiptId: string; revision: string } {
	const nested = ["team", "role", "program", "meeting", "assignment"]
		.map((k) => (value[k] as { revision?: unknown } | undefined)?.revision)
		.find((r) => r !== undefined);
	return { receiptId: String(value.receiptId), revision: String(value.revision ?? nested ?? "1") };
}

/**
 * One reviewed write: `review` selects the review and `args` (the native request without its request key); `run` is
 * the native command. Evry offers every ministry write to an Owner or Admin only: a Member's assistant reads and never
 * prepares changes, though a ministry's own leader may make some of them on the Ministries screens.
 */
export function reviewed<I, R extends z.ZodType>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	review(actor: EvryActor, input: I, context: ReviewContext): SQL | Promise<SQL | null>;
	request: R;
	run(tx: Transaction, context: TeamsContext, request: z.output<R>): Promise<TeamsReply<unknown>>;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: admin,
		review: spec.review,
		async execute(tx, context, args, effectKey): Promise<EffectResult> {
			const request = spec.request.parse({ ...z.object({}).loose().parse(args), requestKey: effectKey });
			const reply = await spec.run(tx, context, request);
			if (reply.status !== "ok") return { refused: reply.error.code };
			return receipt(reply.value as Record<string, unknown>);
		},
	};
}

const teamId = recordId;
const roleId = recordId;
const personId = recordId;
const programId = recordId;
const responsibilityId = recordId;
const name = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(2000);
const date = z.iso.date();

/** Ministry facts a create or edit names, each with its before value from `t` (null for a new ministry). */
const teamFields = (value: Record<string, unknown>, before: (column: string) => SQL) =>
	Object.entries({ name: "name", description: "description", state: "state" }).flatMap(([field, column]) =>
		value[field] === undefined ? [] : [change(field, before(column), json(value[field]))],
	);
const roleFields = (value: Record<string, unknown>, before: (column: string) => SQL) =>
	Object.entries({
		name: "name",
		description: "description",
		leadership: "leadership",
		timeCommitment: "time_commitment",
		desiredSkills: "desired_skills",
	}).flatMap(([field, column]) =>
		value[field] === undefined ? [] : [change(field, before(column), json(value[field]))],
	);
const none = () => sql`NULL::jsonb`;
const column = (alias: string) => (name: string) => sql.raw(`to_jsonb(${alias}.${name})`);

const teamFacts = {
	description: text.nullable().optional(),
	state: z.enum(["forming", "active", "paused"]).optional(),
};
const roleFacts = {
	description: text.nullable().optional(),
	leadership: z.boolean().optional().describe("A leadership role: its holder becomes the fallback leader"),
	timeCommitment: text.nullable().optional(),
	desiredSkills: text.nullable().optional(),
};

const create = reviewed({
	operation: "teams.create",
	description: `Propose adding a new ministry (team) with its name, description and state.`,
	input: z.strictObject({ name, ...teamFacts }),
	review: (_actor, value) =>
		sql`SELECT ${review(sql`'null'::jsonb`, changes(...teamFields(value, none)))} AS review, ${args(null, json(value))} AS args`,
	request: createTeamRequest,
	run: (tx, c, r) => teamsWriter.create(tx, c, r),
});

const edit = reviewed({
	operation: "teams.edit",
	description: `Propose renaming a ministry or changing its description or state (forming, active, paused), with an optional reason.`,
	input: z
		.strictObject({ teamId, name: name.optional(), ...teamFacts, reason: z.string().trim().max(500).optional() })
		.refine((v) => v.name !== undefined || v.description !== undefined || v.state !== undefined, "nothing to change"),
	review: (actor, value) =>
		sql`SELECT ${review(teamTarget, changes(...teamFields(value, column("t"))))} AS review,
			${args(sql`t.revision`, json(value))} AS args ${ministry(actor, value.teamId)}`,
	request: editTeamRequest,
	run: (tx, c, r) => teamsWriter.edit(tx, c, r),
});

const archive = reviewed({
	operation: "teams.archive",
	description: `Propose archiving a ministry: it leaves current lists, staffing and health, and keeps its history.`,
	input: z.strictObject({ teamId }),
	review: (actor, value) =>
		sql`SELECT ${review(teamTarget, changes(change("archived", sql`'false'::jsonb`, sql`'true'::jsonb`)))} AS review,
			${args(sql`t.revision`, json(value))} AS args ${ministry(actor, value.teamId)} AND t.archived_at IS NULL`,
	request: archiveTeamRequest,
	run: (tx, c, r) => teamsWriter.archive(tx, c, r),
});

const restore = reviewed({
	operation: "teams.restore",
	description: `Propose restoring an archived ministry to current lists.`,
	input: z.strictObject({ teamId }),
	review: (actor, value) =>
		sql`SELECT ${review(teamTarget, changes(change("archived", sql`'true'::jsonb`, sql`'false'::jsonb`)))} AS review,
			${args(sql`t.revision`, json(value))} AS args ${ministry(actor, value.teamId)} AND t.archived_at IS NOT NULL`,
	request: restoreTeamRequest,
	run: (tx, c, r) => teamsWriter.restore(tx, c, r),
});

const createRole = reviewed({
	operation: "teams.createRole",
	description: `Propose adding a role slot to a ministry.`,
	input: z.strictObject({ teamId, name, ...roleFacts }),
	review: (actor, value) => {
		return sql`SELECT ${review(teamTarget, changes(...roleFields(value, none)))} AS review,
			${args(null, json(value))} AS args ${ministry(actor, value.teamId)} AND t.archived_at IS NULL`;
	},
	request: createRoleRequest,
	run: (tx, c, r) => teamsWriter.createRole(tx, c, r),
});

const editRole = reviewed({
	operation: "teams.editRole",
	description: `Propose changing a role's name, description, leadership flag, time commitment or desired skills.`,
	input: z
		.strictObject({ roleId, name: name.optional(), ...roleFacts })
		.refine((v) => Object.keys(v).length > 1, "nothing to change"),
	review: (actor, value) => {
		return sql`SELECT ${review(roleTarget, changes(...roleFields(value, column("r"))))} AS review,
			${args(sql`r.revision`, json(value))} AS args ${roleIn(actor, value.roleId)} AND r.retired_at IS NULL`;
	},
	request: editRoleRequest,
	run: (tx, c, r) => teamsWriter.editRole(tx, c, r),
});

const retireRole = reviewed({
	operation: "teams.retireRole",
	description: `Propose retiring a role slot: it leaves the ministry's current structure, its holder's time in it ends and its history stays.`,
	input: z.strictObject({ roleId }),
	review: (actor, value) =>
		sql`SELECT ${review(
			roleTarget,
			sql`${changes(change("retired", sql`'false'::jsonb`, sql`'true'::jsonb`))}||CASE WHEN ${holder} IS NULL THEN '[]'::jsonb
				ELSE ${changes(change("filledBy", sql`to_jsonb(${holder})`, sql`'null'::jsonb`))} END`,
		)} AS review,
			${args(sql`r.revision`, json(value))} AS args ${roleIn(actor, value.roleId)} AND r.retired_at IS NULL`,
	request: retireRoleRequest,
	run: (tx, c, r) => teamsWriter.retireRole(tx, c, r),
});

/** Placing person `p` in role `r`: refused on the card when someone else holds it. Grants no account or seat. */
const placement = (actor: EvryActor, value: { roleId: string; personId: string }, target: SQL, shown: SQL) =>
	sql`SELECT ${review(
		target,
		changes(shown),
		sql`CASE WHEN ${holderId} IS NOT NULL AND ${holderId}<>p.id THEN ${holder}||' already fills this role. Choose an open role, or remove them from it first.' END`,
	)} AS review,
		${args(sql`r.revision`, sql`jsonb_build_object('roleId',r.id,'teamId',t.id,'personId',p.id)`)} AS args
		FROM team_role r JOIN team t ON t.id=r.team_id AND t.plant_id=r.plant_id ${livePerson(actor, value.personId)}
		WHERE r.id=${value.roleId}::uuid AND r.plant_id=${plant(actor)} AND r.retired_at IS NULL AND t.archived_at IS NULL`;

const assignRole = reviewed({
	operation: "teams.assignRole",
	description: `Propose placing one person in one open role. Their other roles and ministries stay as they are, and it gives them no account access.`,
	input: z.strictObject({ roleId, personId }),
	review: (actor, value) =>
		placement(actor, value, roleTarget, change("filledBy", sql`to_jsonb(${holder})`, sql`to_jsonb(p.display_name)`)),
	request: assignRoleRequest,
	run: (tx, c, r) => teamsWriter.assignRole(tx, c, r),
});

const assignMember = reviewed({
	operation: "teams.assignMember",
	description: `Propose adding one person to a ministry in one of its open roles (roleId of that ministry). They keep every other ministry and role, and gain no account access.`,
	input: z.strictObject({ teamId, roleId, personId }),
	review: (actor, value) =>
		sql`SELECT x.review, x.args FROM (${placement(
			actor,
			value,
			teamTarget,
			change("member", sql`'null'::jsonb`, sql`to_jsonb(p.display_name||' as '||r.name)`),
		)}) x WHERE x.args->'input'->>'teamId'=${value.teamId}::text`,
	request: assignRoleRequest,
	run: (tx, c, r) => teamsWriter.assignRole(tx, c, r),
});

const removeRole = reviewed({
	operation: "teams.removeRole",
	description: `Propose ending one role a person holds now. They keep their other roles and ministries, their People stage and their training.`,
	input: z.strictObject({ roleId, personId }),
	review: (actor, value) =>
		sql`SELECT ${review(roleTarget, changes(change("filledBy", sql`to_jsonb(p.display_name)`, sql`'null'::jsonb`)))} AS review,
			${args(sql`r.revision`, sql`jsonb_build_object('roleId',r.id,'personId',p.id)`)} AS args
			FROM team_role r JOIN team t ON t.id=r.team_id AND t.plant_id=r.plant_id ${livePerson(actor, value.personId)}
			WHERE r.id=${value.roleId}::uuid AND r.plant_id=${plant(actor)} AND ${holderId}=p.id`,
	request: removeRoleRequest,
	run: (tx, c, r) => teamsWriter.removeRole(tx, c, r),
});

const endMembership = reviewed({
	operation: "teams.endMembership",
	description: `Propose ending a person's time in a ministry: every role they hold there ends. Their other ministries, People stage, training and account stay.`,
	input: z.strictObject({ teamId, personId }),
	review: (actor, value) => {
		const roles = sql`(SELECT string_agg(r.name, ', ' ORDER BY r.name) FROM team_tenure tn JOIN team_role r ON r.id=tn.role_id
			WHERE r.team_id=t.id AND tn.person_id=p.id AND tn.ended_on IS NULL)`;
		return sql`SELECT ${review(teamTarget, changes(change("member", sql`to_jsonb(p.display_name||' as '||${roles})`, sql`'null'::jsonb`)))} AS review,
			${args(sql`t.revision`, sql`jsonb_build_object('teamId',t.id,'personId',p.id)`)} AS args
			FROM team t ${livePerson(actor, value.personId)}
			WHERE t.id=${value.teamId}::uuid AND t.plant_id=${plant(actor)} AND ${roles} IS NOT NULL`;
	},
	request: endMembershipRequest,
	run: (tx, c, r) => teamsWriter.endMembership(tx, c, r),
});

const reactivateMembership = reviewed({
	operation: "teams.reactivateMembership",
	description: `Propose returning a person to a role they held before, as a new time in it; their earlier dates stay.`,
	input: z.strictObject({ roleId, personId }),
	review: (actor, value) =>
		sql`SELECT ${review(
			roleTarget,
			changes(change("filledBy", sql`to_jsonb(${holder})`, sql`to_jsonb(p.display_name)`)),
			sql`CASE WHEN ${holderId} IS NOT NULL AND ${holderId}<>p.id THEN ${holder}||' already fills this role.' END`,
		)} AS review,
			${args(sql`r.revision`, sql`jsonb_build_object('roleId',r.id,'personId',p.id)`)} AS args
			FROM team_role r JOIN team t ON t.id=r.team_id AND t.plant_id=r.plant_id ${livePerson(actor, value.personId)}
			WHERE r.id=${value.roleId}::uuid AND r.plant_id=${plant(actor)} AND r.retired_at IS NULL AND t.archived_at IS NULL
				AND EXISTS(SELECT FROM team_tenure tn WHERE tn.role_id=r.id AND tn.person_id=p.id AND tn.ended_on IS NOT NULL)`,
	request: reactivateMembershipRequest,
	run: (tx, c, r) => teamsWriter.reactivateMembership(tx, c, r),
});

const appointLeader = reviewed({
	operation: "teams.appointLeader",
	description: `Propose appointing a live person as a ministry's leader, replacing any current leader. It gives them no account access. Only when the user names the person: never suggest or judge who is suitable.`,
	input: z.strictObject({ teamId, personId }),
	review: (actor, value) =>
		sql`SELECT ${review(
			teamTarget,
			changes(
				change(
					"leader",
					sql`to_jsonb((SELECT lp.display_name FROM person lp WHERE lp.id=t.leader_person_id))`,
					sql`to_jsonb(p.display_name)`,
				),
			),
		)} AS review,
			${args(sql`t.revision`, sql`jsonb_build_object('teamId',t.id,'personId',p.id)`)} AS args
			FROM team t ${livePerson(actor, value.personId)}
			WHERE t.id=${value.teamId}::uuid AND t.plant_id=${plant(actor)} AND t.archived_at IS NULL`,
	request: appointLeaderRequest,
	run: (tx, c, r) => teamsWriter.appointLeader(tx, c, r),
});

const selection = z.strictObject({
	teamKey: z.string().trim().min(1).max(80).describe("A template key from teams.listImportTemplates"),
	roleKeys: z.array(z.string().trim().min(1).max(80)).max(20),
});
/** Catalog names for the chosen keys; the native command refuses an unknown key. */
const catalogNames = (selections: { teamKey: string; roleKeys: string[] }[]) => ({
	teams: selections.map((s) => s.teamKey).join(", "),
	roles: selections.flatMap((s) => s.roleKeys).join(", ") || null,
});

const initialize = reviewed({
	operation: "teams.initialize",
	description: `Propose importing chosen ministry templates and their starter roles (keys from teams.listImportTemplates). A ministry or role already here is kept, never duplicated.`,
	input: z.strictObject({ selections: z.array(selection).min(1).max(20) }),
	review: (_actor, value) => {
		const names = catalogNames(value.selections);
		return sql`SELECT ${review(
			sql`'null'::jsonb`,
			changes(
				change("ministries", sql`'null'::jsonb`, json(names.teams)),
				change("roles", sql`'null'::jsonb`, json(names.roles)),
			),
		)} AS review,
			${args(null, json({ expectedVersion: TEMPLATE_VERSION, mode: "import", selections: value.selections }))} AS args`;
	},
	request: initializeRequest,
	run: (tx, c, r) => teamsWriter.initialize(tx, c, r),
});

const importRoles = reviewed({
	operation: "teams.importRoles",
	description: `Propose adding starter roles from one ministry template (keys from teams.listImportTemplates) to an existing ministry. Roles it already has are kept.`,
	input: z.strictObject({
		teamId,
		teamKey: selection.shape.teamKey,
		roleKeys: z.array(selection.shape.teamKey).min(1).max(20),
	}),
	review: (actor, value) =>
		sql`SELECT ${review(teamTarget, changes(change("roles", sql`'null'::jsonb`, json(value.roleKeys.join(", ")))))} AS review,
			${args(
				null,
				sql`jsonb_build_object('expectedVersion',${TEMPLATE_VERSION}::text,'mode','import','selections',
					jsonb_build_array(jsonb_build_object('teamKey',${value.teamKey}::text,'roleKeys',${json(value.roleKeys)},'destinationTeamId',t.id)))`,
			)} AS args ${ministry(actor, value.teamId)} AND t.archived_at IS NULL`,
	request: initializeRequest,
	run: (tx, c, r) => teamsWriter.initialize(tx, c, r),
});

const scheduleMeeting = reviewed({
	operation: "teams.scheduleMeeting",
	description: `Propose scheduling a team meeting for one ministry on a church-local date and time; its guest list starts as the ministry's people. It records no attendance or training.`,
	input: z.strictObject({
		teamId,
		date,
		time: z
			.string()
			.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
			.describe("Church-local time like 19:00"),
		subtype: z.enum(["regular", "training", "planning", "special", "rehearsal"]).optional(),
		title: z.string().trim().min(1).max(200).optional(),
	}),
	review: (actor, value) => {
		const facts = Object.fromEntries(Object.entries(value).filter(([field]) => field !== "teamId"));
		return sql`SELECT ${review(
			teamTarget,
			changes(...Object.entries(facts).map(([field, after]) => change(field, sql`'null'::jsonb`, json(after)))),
		)} AS review,
			${args(null, sql`${json({ type: "team_meeting", ...facts })}||jsonb_build_object('teamId',t.id)`)} AS args
			${ministry(actor, value.teamId)} AND t.archived_at IS NULL`;
	},
	request: scheduleMeetingRequest,
	run: (tx, c, r) => meetingsWriter.schedule(tx, c, r) as Promise<TeamsReply<unknown>>,
});

const offerResponsibilities = reviewed({
	operation: "teams.offerResponsibilities",
	description: `Propose accepting chosen suggested Playbook responsibilities for a ministry (line keys from teams.previewResponsibilities), or declining the offer.`,
	input: z.strictObject({
		teamId,
		decision: z.enum(["accept", "decline"]),
		selected: z.array(z.string().trim().min(1).max(80)).max(20),
	}),
	async review(actor, value, context) {
		// The offer binds the exact preview the user saw: its catalog version and digest, read under live authority.
		const preview = await responsibilityReader.previewResponsibilities(context.db, actor.authority, {
			teamId: value.teamId,
		});
		if (preview.status !== "ok") return null;
		const lines = preview.value.lines.filter((l) => value.selected.includes(l.key)).map((l) => l.text);
		return sql`SELECT ${review(
			teamTarget,
			changes(
				change("offer", json(preview.value.offer), json(value.decision === "accept" ? "accepted" : "declined")),
				...(lines.length ? [change("responsibilities", sql`'null'::jsonb`, json(lines.join("; ")))] : []),
			),
		)} AS review,
			${args(
				sql`t.revision`,
				json({ ...value, expectedVersion: preview.value.templateVersion, reviewDigest: preview.value.reviewDigest }),
			)} AS args ${ministry(actor, value.teamId)}`;
	},
	request: offerRequest,
	run: (tx, c, r) => responsibilityWriter.offerResponsibilities(tx, c, r),
});

const addResponsibility = reviewed({
	operation: "teams.addResponsibility",
	description: `Propose adding one responsibility line to a ministry's checklist.`,
	input: z.strictObject({ teamId, text }),
	review: (actor, value) =>
		sql`SELECT ${review(teamTarget, changes(change("responsibility", sql`'null'::jsonb`, json(value.text))))} AS review,
			${args(sql`t.revision`, json(value))} AS args ${ministry(actor, value.teamId)} AND t.archived_at IS NULL`,
	request: addRequest,
	run: (tx, c, r) => responsibilityWriter.addResponsibility(tx, c, r),
});

/** The live responsibility `l` of ministry `t` in the actor's church. */
const line = (actor: EvryActor, id: string) =>
	sql`FROM responsibility l JOIN team t ON t.id=l.team_id AND t.plant_id=l.plant_id
		WHERE l.id=${id}::uuid AND l.plant_id=${plant(actor)} AND l.removed_at IS NULL`;

const editResponsibility = reviewed({
	operation: "teams.editResponsibility",
	description: `Propose rewording one responsibility.`,
	input: z.strictObject({ responsibilityId, text }),
	review: (actor, value) =>
		sql`SELECT ${review(lineTarget, changes(change("text", sql`to_jsonb(l.text)`, json(value.text))))} AS review,
			${args(sql`l.revision`, json(value))} AS args ${line(actor, value.responsibilityId)}`,
	request: editRequest,
	run: (tx, c, r) => responsibilityWriter.editResponsibility(tx, c, r),
});

const completeResponsibility = reviewed({
	operation: "teams.completeResponsibility",
	description: `Propose ticking one responsibility done, or unticking it.`,
	input: z.strictObject({ responsibilityId, done: z.boolean() }),
	review: (actor, value) =>
		sql`SELECT ${review(lineTarget, changes(change("done", sql`to_jsonb(l.completed_on IS NOT NULL)`, json(value.done))))} AS review,
			${args(sql`l.revision`, json(value))} AS args ${line(actor, value.responsibilityId)}`,
	request: completeRequest,
	run: (tx, c, r) => responsibilityWriter.completeResponsibility(tx, c, r),
});

const deleteResponsibility = reviewed({
	operation: "teams.deleteResponsibility",
	description: `Propose removing one responsibility from a ministry's checklist; it never comes back from the Playbook.`,
	input: z.strictObject({ responsibilityId }),
	review: (actor, value) =>
		sql`SELECT ${review(lineTarget, changes(change("responsibility", sql`to_jsonb(l.text)`, sql`'null'::jsonb`)))} AS review,
			${args(sql`l.revision`, json(value))} AS args ${line(actor, value.responsibilityId)}`,
	request: deleteRequest,
	run: (tx, c, r) => responsibilityWriter.deleteResponsibility(tx, c, r),
});

const createProgram = reviewed({
	operation: "teams.createProgram",
	description: `Propose adding a training program, required or optional, for one ministry or church-wide (teamId null).`,
	input: z.strictObject({ name, required: z.boolean(), teamId: teamId.nullable() }),
	review: (actor, value) => {
		const shown = changes(
			change("name", sql`'null'::jsonb`, json(value.name)),
			change("required", sql`'null'::jsonb`, json(value.required)),
		);
		return value.teamId === null
			? sql`SELECT ${review(sql`'null'::jsonb`, shown)} AS review, ${args(null, json(value))} AS args`
			: sql`SELECT ${review(teamTarget, shown)} AS review, ${args(null, json(value))} AS args
				${ministry(actor, value.teamId)} AND t.archived_at IS NULL`;
	},
	request: createProgramRequest,
	run: (tx, c, r) => trainingWriter.createProgram(tx, c, r),
});

/** The training program `g` in the actor's church, not archived. */
const programIn = (actor: EvryActor, id: string) =>
	sql`FROM training_program g WHERE g.id=${id}::uuid AND g.plant_id=${plant(actor)} AND g.archived_at IS NULL`;

const correctProgram = reviewed({
	operation: "teams.correctProgram",
	description: `Propose correcting a training program's name or whether it is required, with the reason.`,
	input: z.strictObject({ programId, name, required: z.boolean(), reason: z.string().trim().min(1).max(500) }),
	review: (actor, value) =>
		sql`SELECT ${review(
			programTarget,
			changes(
				change("name", sql`to_jsonb(g.name)`, json(value.name)),
				change("required", sql`to_jsonb(g.required)`, json(value.required)),
				change("reason", sql`'null'::jsonb`, json(value.reason)),
			),
		)} AS review, ${args(sql`g.revision`, json(value))} AS args ${programIn(actor, value.programId)}`,
	request: correctProgramRequest,
	run: (tx, c, r) => trainingWriter.correctProgram(tx, c, r),
});

const setRequiredTrainingParticipants = reviewed({
	operation: "teams.setRequiredTrainingParticipants",
	description: `Propose saving a training program's exact required list: these people, and no one else. Joining the ministry later never adds anyone.`,
	input: z.strictObject({ programId, personIds: z.array(personId).max(100) }),
	async review(actor, value, context) {
		// The list binds the exact people the review shows, by the native preview's digest of their current records.
		const preview = await trainingReader.readRequiredTrainingPreview(context.db, actor.authority, value);
		if (preview.status !== "ok") return null;
		const names = (ids: SQL) =>
			sql`to_jsonb((SELECT string_agg(p.display_name, ', ' ORDER BY p.display_name) FROM person p WHERE p.id=ANY(${ids})))`;
		const saved = sql`ARRAY(SELECT a.person_id FROM training_assignment a WHERE a.program_id=g.id AND a.state='active')`;
		return sql`SELECT ${review(
			programTarget,
			changes(change("requiredPeople", names(saved), names(sql`${sql.param(value.personIds)}::uuid[]`))),
		)} AS review,
			${args(sql`${preview.value.revision}`, json({ ...value, rosterDigest: preview.value.rosterDigest }))} AS args
			${programIn(actor, value.programId)} AND g.revision::text=${preview.value.revision}`;
	},
	request: setRequiredTrainingRequest,
	run: (tx, c, r) => trainingWriter.setRequiredTrainingParticipants(tx, c, r),
});

/** One person's completion of program `g`, as the user reported it, on the date they gave. */
const completion = (
	actor: EvryActor,
	value: { programId: string; personId: string; earnedOn: string },
	entry: string,
	extra: Record<string, string> = {},
) =>
	sql`SELECT ${review(
		programTarget,
		changes(
			change("person", sql`'null'::jsonb`, sql`to_jsonb(p.display_name)`),
			change(entry, sql`'null'::jsonb`, json(value.earnedOn)),
		),
	)} AS review,
		${args(sql`g.revision`, sql`${json(extra)}||jsonb_build_object('personId',p.id,'programId',g.id,'earnedOn',${value.earnedOn}::text)`)} AS args
		FROM training_program g ${livePerson(actor, value.personId)}
		WHERE g.id=${value.programId}::uuid AND g.plant_id=${plant(actor)} AND g.archived_at IS NULL`;
const reported = z.strictObject({
	personId,
	programId,
	earnedOn: date.describe(
		"The date the user says it was completed. For today, today's date in the church's time zone from the trusted clock.",
	),
});

const attestCompletion = reviewed({
	operation: "teams.attestCompletion",
	description: `Propose recording that one named person completed one training program, only when the user reports it: never for a group, a guess or on Evry's own judgment.`,
	input: reported,
	review: (actor, value) => completion(actor, value, "completedOn", { kind: "program" }),
	request: attestProgramRequest,
	run: (tx, c, r) => trainingWriter.attestCompletion(tx, c, r),
});

const revokeCompletion = reviewed({
	operation: "teams.revokeCompletion",
	description: `Propose marking one person's current completion of a program as no longer valid; the record stays in their history.`,
	input: z.strictObject({ personId, programId }),
	review: (actor, value) =>
		sql`SELECT ${review(
			programTarget,
			changes(
				change("completion", sql`to_jsonb(p.display_name||': completed')`, sql`to_jsonb(p.display_name||': revoked')`),
			),
		)} AS review,
			${args(sql`g.revision`, sql`jsonb_build_object('personId',p.id,'programId',g.id)`)} AS args
			FROM training_program g ${livePerson(actor, value.personId)}
			WHERE g.id=${value.programId}::uuid AND g.plant_id=${plant(actor)}`,
	request: revokeCompletionRequest,
	run: (tx, c, r) => trainingWriter.revokeCompletion(tx, c, r),
});

const recompleteTraining = reviewed({
	operation: "teams.recompleteTraining",
	description: `Propose recording that one named person completed a program again after a revoked completion, only when the user reports it.`,
	input: reported,
	review: (actor, value) => completion(actor, value, "completedAgainOn"),
	request: recompleteTrainingRequest,
	run: (tx, c, r) => trainingWriter.recompleteTraining(tx, c, r),
});

/** The installed Ministries reviewed writes, keyed by operation. */
export const TEAMS_COMMANDS = {
	"teams.create": create,
	"teams.edit": edit,
	"teams.archive": archive,
	"teams.restore": restore,
	"teams.createRole": createRole,
	"teams.editRole": editRole,
	"teams.retireRole": retireRole,
	"teams.assignRole": assignRole,
	"teams.assignMember": assignMember,
	"teams.removeRole": removeRole,
	"teams.endMembership": endMembership,
	"teams.reactivateMembership": reactivateMembership,
	"teams.appointLeader": appointLeader,
	"teams.initialize": initialize,
	"teams.importRoles": importRoles,
	"teams.scheduleMeeting": scheduleMeeting,
	"teams.offerResponsibilities": offerResponsibilities,
	"teams.addResponsibility": addResponsibility,
	"teams.editResponsibility": editResponsibility,
	"teams.completeResponsibility": completeResponsibility,
	"teams.deleteResponsibility": deleteResponsibility,
	"teams.createProgram": createProgram,
	"teams.correctProgram": correctProgram,
	"teams.setRequiredTrainingParticipants": setRequiredTrainingParticipants,
	"teams.attestCompletion": attestCompletion,
	"teams.revokeCompletion": revokeCompletion,
	"teams.recompleteTraining": recompleteTraining,
} as const;
