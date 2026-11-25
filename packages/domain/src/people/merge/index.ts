import { meetingTitle } from "@everyfield/contracts/common";
import { meetingType } from "@everyfield/contracts/meetings";
import * as c from "@everyfield/contracts/people";
import { taskStatus } from "@everyfield/contracts/tasks";
import { sql, type SQL, type SQLWrapper } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import {
	authorizeRead,
	deny,
	hash,
	mutation,
	parse,
	readReply,
	reply,
	type Context,
	type Tx,
	type WriteContext,
} from "../core.ts";
import { matchPeople } from "../duplicates.ts";
import type { AuditWrite } from "../../operations/writes.ts";
import { columnsChanged, freshPosition, sameColumn } from "../people.ts";
import {
	lockPair,
	parseReferences,
	referencesOf,
	registrationOf,
	treatmentOf,
	type Reference,
} from "../person-reference-registry/index.ts";
import { adminRead } from "../assessments/shared.ts";
import {
	commitmentInputs,
	commitmentInputsJson,
	commitmentOf,
	type CommitmentInputs,
} from "../commitments/lifecycle.ts";

type Field = z.infer<typeof c.mergeField>;
type Kind = z.infer<typeof c.referenceKind>;
const columns: Record<Field, readonly string[]> = {
	displayName: ["display_name"],
	firstName: ["first_name"],
	lastName: ["last_name"],
	email: ["email"],
	phone: ["phone"],
	address: ["street", "city", "state_province", "postal_code", "country"],
	source: ["source", "source_details"],
	summaryNotes: ["notes"],
	birthDate: ["birth_date"],
	adultClassification: ["adult_classification"],
	household: ["household_id", "household_role"],
	photo: ["photo_object_id"],
};
const meetingOf = z.object({
	title: z.string().nullable(),
	type: meetingType,
	vision_number: z.number().int().nullable(),
});
export const PARTICIPATION_COLUMNS = [
	"person_id",
	"inviter_person_id",
	"roster_member",
	"presence",
	"rsvp",
	"rsvp_at",
	"rsvp_source",
	"removed_at",
	"rsvp_token_open",
	"card_response",
	"card_notes",
	"card_recorded_at",
	"card_author_id",
	"card_occurred_at",
] as const;
type Columns = Record<(typeof PARTICIPATION_COLUMNS)[number], unknown>;
const participationRow = meetingOf.extend({
	id: z.uuid(),
	meeting_id: z.uuid(),
	person_id: z.uuid(),
	inviter_person_id: z.uuid().nullable(),
	presence: z.enum(["attended", "excused", "absent"]),
	rsvp: z.enum(["pending", "confirmed", "declined"]).nullable(),
	removed_at: z.string().nullable(),
	revision: z.string(),
});
export type Participation = z.infer<typeof participationRow> & { meeting: string; columns: Columns };
function parseParticipation(raw: Record<string, unknown>): Participation {
	const row = participationRow.parse(raw);
	const columns = Object.fromEntries(PARTICIPATION_COLUMNS.map((k) => [k, raw[k] ?? null])) as Columns;
	return { ...row, meeting: titled(row), columns };
}
const followUpRow = meetingOf.extend({
	id: z.uuid(),
	meeting_id: z.uuid(),
	revision: z.coerce.string(),
	waived_at: z.string().nullable(),
	waiver_reason: z.string().nullable(),
	task: z
		.object({
			id: z.uuid(),
			revision: z.coerce.string(),
			status: taskStatus,
			completed_at: z.string().nullable(),
			deleted_at: z.string().nullable(),
			assignees: z.array(z.uuid()),
		})
		.nullable(),
});
type FollowUp = z.infer<typeof followUpRow>;
const factsRow = z.object({
	id: z.uuid(),
	state: z.enum(["live", "retired", "merged"]),
	revision: z.coerce.string(),
	display_name: z.string(),
	linked_account_id: z.uuid().nullable(),
	merged_into_person_id: z.uuid().nullable(),
	stage: c.stage.nullable(),
	pipeline_position: z.coerce.string().nullable(),
	commitment_state: z.enum(["active", "withdrawn", "unknown"]).nullable(),
	commitment_effective_on: z.string().nullable(),
	household_id: z.uuid().nullable(),
	commitment_inputs: commitmentInputs,
	enrollment_programs: z.array(z.uuid()),
	open_follow_ups: z.array(meetingOf.extend({ id: z.uuid(), due_date: z.string() })),
	participations: z.array(z.record(z.string(), z.unknown())),
	open_tasks: z.array(z.object({ id: z.uuid(), title: z.string(), due_date: z.string().nullable() })),
	open_kit_items: z.array(meetingOf.extend({ text: z.string() })),
	current_roles: z.array(z.object({ team_id: z.uuid(), team: z.string(), role: z.string() })),
	residency_invitations: z.array(z.object({ recipient_email: z.string() })),
	residency_linked: z.boolean(),
	skill_names: z.array(z.object({ id: z.uuid(), name: z.string() })),
	follow_ups: z.array(followUpRow),
	follow_up_tasks: z.array(z.object({ id: z.uuid(), status: taskStatus, revision: z.coerce.string() })),
	active_training: z.array(z.object({ id: z.uuid(), program_id: z.uuid() })),
	refs: z.unknown(),
});
const extra = [
	"commitment_inputs",
	"open_follow_ups",
	"participations",
	"open_tasks",
	"open_kit_items",
	"current_roles",
	"residency_invitations",
	"residency_linked",
	"skill_names",
	"follow_ups",
	"follow_up_tasks",
	"active_training",
] as const;
export type Facts = Omit<z.infer<typeof factsRow>, "refs" | (typeof extra)[number]> & {
	refs: Reference[];
	values: Record<string, unknown>;
	commitment: CommitmentInputs;
	openFollowUps: { id: string; personId: string; meeting: string; dueDate: string }[];
	participations: Participation[];
	openTasks: { id: string; title: string; dueDate: string | null }[];
	openKitItems: { meeting: string; text: string }[];
	currentRoles: { teamId: string; team: string; role: string }[];
	residencyInvitations: { recipientEmail: string }[];
	residencyLinked: boolean;
	skillNames: Map<string, string>;
	followUps: FollowUp[];
	followUpTasks: { id: string; status: FollowUpTask["status"]; revision: string }[];
	activeTraining: Map<string, string>;
};
const titled = (m: z.infer<typeof meetingOf>) =>
	meetingTitle({ title: m.title, type: m.type, visionNumber: m.vision_number });
export function parseFacts(raw: unknown): Facts | null {
	if (raw === null) return null;
	const parsed = factsRow.parse(raw);
	const values = z.record(z.string(), z.unknown()).parse(raw);
	for (const k of extra) delete values[k];
	const {
		commitment_inputs,
		open_follow_ups,
		participations,
		open_tasks,
		open_kit_items,
		current_roles,
		residency_invitations,
		residency_linked,
		skill_names,
		follow_ups,
		follow_up_tasks,
		active_training,
		...row
	} = parsed;
	return {
		...row,
		refs: parseReferences(row.refs),
		values,
		commitment: commitment_inputs,
		openFollowUps: open_follow_ups.map((f) => ({
			id: f.id,
			personId: row.id,
			meeting: titled(f),
			dueDate: f.due_date,
		})),
		participations: participations.map(parseParticipation),
		openTasks: open_tasks.map((t) => ({ id: t.id, title: t.title, dueDate: t.due_date })),
		openKitItems: open_kit_items.map((i) => ({ meeting: titled(i), text: i.text })),
		currentRoles: current_roles.map((r) => ({ teamId: r.team_id, team: r.team, role: r.role })),
		residencyInvitations: residency_invitations.map((i) => ({ recipientEmail: i.recipient_email })),
		residencyLinked: residency_linked,
		skillNames: new Map(skill_names.map((s) => [s.id, s.name])),
		followUps: follow_ups,
		followUpTasks: follow_up_tasks,
		activeTraining: new Map(active_training.map((t) => [t.id, t.program_id])),
	};
}
const participationsOf = (person: SQL, owner: string | SQL) =>
	sql`(SELECT coalesce(jsonb_agg(jsonb_build_object(${sql.join(
		PARTICIPATION_COLUMNS.map((k) => sql`${k}::text,g.${sql.identifier(k)}`),
		sql`,`,
	)},'id',g.id,'meeting_id',g.meeting_id,'revision',g.revision::text,'title',m.title,'type',m.type,
 'vision_number',m.vision_number) ORDER BY g.id),'[]') FROM participation g JOIN meeting m ON m.id=g.meeting_id
 AND m.plant_id=g.plant_id WHERE (g.person_id=${person} OR g.inviter_person_id=${person}) AND g.plant_id=${owner}::uuid)`;
const openTasksOf = (person: SQL, owner: string | SQL) =>
	sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'title',k.title,'due_date',coalesce(k.due_date,
 (k.due_at AT TIME ZONE coalesce(k.timezone,'UTC'))::date)::text) ORDER BY k.due_date NULLS LAST,k.created_at,k.id),'[]')
 FROM task k WHERE k.person_id=${person} AND k.plant_id=${owner}::uuid AND k.deleted_at IS NULL
 AND k.status NOT IN ('complete','no_longer_needed'))`;
const openKitItemsOf = (person: SQL, owner: string | SQL) =>
	sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('title',m.title,'type',m.type,'vision_number',m.vision_number,
 'text',i.text) ORDER BY m.starts_at,i.position,i.id),'[]') FROM meeting_kit_item i JOIN meeting m ON m.id=i.meeting_id
 AND m.plant_id=i.plant_id WHERE i.assignee_person_id=${person} AND i.plant_id=${owner}::uuid AND NOT i.checked)`;
const currentRolesOf = (person: SQL, owner: string | SQL) =>
	sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('team_id',t.id,'team',t.name,'role',r.name) ORDER BY t.name,r.name),'[]')
 FROM team_tenure e JOIN team_role r ON r.id=e.role_id AND r.plant_id=e.plant_id
 JOIN team t ON t.id=r.team_id AND t.plant_id=r.plant_id
 WHERE e.person_id=${person} AND e.plant_id=${owner}::uuid AND e.ended_on IS NULL)`;
const residencyOf = (person: SQL, owner: string | SQL) =>
	sql`'residency_invitations',(SELECT coalesce(jsonb_agg(jsonb_build_object('recipient_email',i.recipient_email)
 ORDER BY i.created_at,i.id),'[]') FROM invitation i WHERE i.resident_person_id=${person} AND i.tenant_id=${owner}::uuid
 AND i.state='pending'),'residency_linked',EXISTS(SELECT FROM residency_link l WHERE l.person_id=${person}
 AND l.organization_id=${owner}::uuid AND l.ended_at IS NULL)`;
const duplicateKeysOf = (person: SQL, owner: string | SQL) =>
	sql`'skill_names',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',lower(btrim(s.name)))),'[]')
 FROM person_skill s WHERE s.person_id=${person} AND s.plant_id=${owner}::uuid),
 'follow_up_tasks',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',k.id,'status',k.status,
 'revision',k.revision::text)),'[]') FROM task k WHERE k.person_id=${person} AND k.plant_id=${owner}::uuid
 AND k.obligation_id IS NOT NULL),
 'follow_ups',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',o.id,'meeting_id',o.meeting_id,'title',m.title,
 'type',m.type,'vision_number',m.vision_number,'revision',o.revision::text,'waived_at',o.waived_at,
 'waiver_reason',o.waiver_reason,'task',(SELECT jsonb_build_object('id',k.id,'revision',k.revision::text,
  'status',k.status,'completed_at',k.completed_at,'deleted_at',k.deleted_at,'assignees',(SELECT
  coalesce(jsonb_agg(a.account_id ORDER BY a.account_id),'[]') FROM task_assignee a WHERE a.task_id=k.id))
  FROM task k WHERE k.obligation_id=o.id AND k.plant_id=o.plant_id
  ORDER BY k.deleted_at NULLS FIRST,k.created_at DESC LIMIT 1)) ORDER BY o.id),'[]')
 FROM obligation o JOIN meeting m ON m.id=o.meeting_id AND m.plant_id=o.plant_id
 WHERE o.person_id=${person} AND o.plant_id=${owner}::uuid AND o.kind='follow_up' AND o.superseded_at IS NULL),
 'active_training',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'program_id',a.program_id)),'[]')
 FROM training_assignment a WHERE a.person_id=${person} AND a.plant_id=${owner}::uuid AND a.state='active')`;
const openFollowUpsOf = (person: SQL, owner: string | SQL) =>
	sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('title',m.title,'type',m.type,'vision_number',m.vision_number,
 'id',o.id,'due_date',o.due_date::text) ORDER BY o.due_date,o.id),'[]') FROM obligation o
 JOIN meeting m ON m.id=o.meeting_id AND m.plant_id=o.plant_id
 LEFT JOIN LATERAL (SELECT k.status,k.deleted_at FROM task k WHERE k.obligation_id=o.id AND k.plant_id=o.plant_id
  ORDER BY k.deleted_at NULLS FIRST,k.created_at DESC LIMIT 1) t ON true
 WHERE o.person_id=${person} AND o.plant_id=${owner}::uuid AND o.kind='follow_up' AND o.superseded_at IS NULL
 AND o.waived_at IS NULL AND NOT coalesce(t.deleted_at IS NULL AND t.status IN ('complete','no_longer_needed'),false))`;
export const factsOf = (id: SQL, owner: string | SQL) =>
	sql`(SELECT to_jsonb(p)||jsonb_build_object('revision',p.revision::text,'pipeline_position',p.pipeline_position::text,
 'refs',${referencesOf(sql`p.id`, owner)},
 'enrollment_programs',(SELECT coalesce(jsonb_agg(e.program_id),'[]') FROM development_enrollment e
  WHERE e.person_id=p.id AND e.organization_id=p.tenant_id),'open_follow_ups',${openFollowUpsOf(sql`p.id`, owner)},
 'participations',${participationsOf(sql`p.id`, owner)},'open_tasks',${openTasksOf(sql`p.id`, owner)},
 'open_kit_items',${openKitItemsOf(sql`p.id`, owner)},'current_roles',${currentRolesOf(sql`p.id`, owner)},
 ${residencyOf(sql`p.id`, owner)},${duplicateKeysOf(sql`p.id`, owner)},'commitment_inputs',${commitmentInputsJson(sql`p.id`, sql`${owner}::uuid`)}) FROM person p WHERE p.id=${id} AND p.tenant_id=${owner}::uuid
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id))`;

export const referencesDigest = (refs: readonly Reference[]) =>
	hash(
		refs
			.filter((x) => x.kind !== "commitment_change")
			.map((x) => [x.kind, x.id, x.revision])
			.sort((a, b) => (a.join() < b.join() ? -1 : 1)),
	);

const order = c.stage.options;
export const participating = (kind: string) => kind === "participation" || kind === "participation_inviter";
const PRESENCE_RANK = { absent: 0, excused: 1, attended: 2 } as const;
const answered = (rsvp: string | null | undefined): rsvp is "confirmed" | "declined" =>
	rsvp === "confirmed" || rsvp === "declined";
const RSVP = ["rsvp", "rsvp_at", "rsvp_source"] as const;
const CARD = ["card_response", "card_notes", "card_recorded_at", "card_author_id", "card_occurred_at"] as const;
const pick = (from: Columns, keys: readonly (keyof Columns)[]) => Object.fromEntries(keys.map((k) => [k, from[k]]));

function attendancePlan(source: Facts, survivor: Facts) {
	const rows = new Map([...survivor.participations, ...source.participations].map((r) => [r.id, r]));
	const at = new Map(survivor.participations.filter((r) => r.person_id === survivor.id).map((r) => [r.meeting_id, r]));
	const next = new Map<string, Columns>();
	const removed = new Set<string>(),
		stays = new Set<string>();
	const changes: z.input<typeof c.attendanceChange>[] = [];
	for (const s of source.participations.filter((r) => r.person_id === source.id)) {
		const v = at.get(s.meeting_id);
		if (!v) continue;
		if (s.removed_at !== null) {
			stays.add(s.id);
			continue;
		}
		removed.add(s.id);
		const both = v.removed_at === null;
		const presence = both && PRESENCE_RANK[v.presence] > PRESENCE_RANK[s.presence] ? v.presence : s.presence;
		const rsvpFrom = !both || (!answered(v.rsvp) && (answered(s.rsvp) || v.rsvp === null)) ? s : v;
		if (both && answered(v.rsvp) !== answered(s.rsvp) && (v.rsvp === "pending" || s.rsvp === "pending")) {
			const pending = rsvpFrom === v ? s : v;
			const answer = rsvpFrom.rsvp;
			if (answered(answer))
				changes.push({
					change: "rsvp_replaced",
					meeting: v.meeting,
					pendingPersonId: pending === v ? survivor.id : source.id,
					answer,
				});
		}
		changes.push({ change: "combined", meeting: v.meeting, presence });
		next.set(v.id, {
			...v.columns,
			presence,
			...pick(rsvpFrom.columns, RSVP),
			...pick((both && v.columns.card_response !== null ? v : s).columns, CARD),
			roster_member: both
				? v.columns.roster_member === true || s.columns.roster_member === true
				: s.columns.roster_member,
			inviter_person_id: both ? (v.inviter_person_id ?? s.inviter_person_id) : s.inviter_person_id,
			removed_at: null,
		});
	}
	for (const r of rows.values()) {
		if (removed.has(r.id) || stays.has(r.id)) continue;
		const f = next.get(r.id) ?? r.columns;
		const person = f.person_id === source.id ? survivor.id : f.person_id;
		let inviter = f.inviter_person_id === source.id ? survivor.id : f.inviter_person_id;
		if (inviter !== null && inviter === person) {
			changes.push({ change: "inviter_cleared", meeting: r.meeting, inviterPersonId: String(f.inviter_person_id) });
			inviter = null;
		}
		if (next.has(r.id) || person !== f.person_id || inviter !== f.inviter_person_id)
			next.set(r.id, { ...f, person_id: person, inviter_person_id: inviter });
	}
	const touched = (r: Participation) => next.has(r.id) || removed.has(r.id);
	const after: Reference[] = [];
	for (const r of rows.values()) {
		const f = next.get(r.id) ?? r.columns;
		const revision = touched(r) ? String(BigInt(r.revision) + 1n) : r.revision;
		if (f.person_id === survivor.id) after.push({ kind: "participation", id: r.id, revision, moves: true });
		if (f.inviter_person_id === survivor.id)
			after.push({ kind: "participation_inviter", id: r.id, revision, moves: true });
	}
	return {
		updates: [...next].map(([id, columns]) => ({ id, ...columns })),
		removed: [...removed],
		prior: [...rows.values()].filter(touched).map((r) => ({ id: r.id, ...r.columns })),
		moved: {
			participation: source.participations
				.filter((r) => r.person_id === source.id && !stays.has(r.id))
				.map((r) => r.id),
			participation_inviter: [...rows.values()].filter((r) => r.inviter_person_id === source.id).map((r) => r.id),
		},
		changes,
		after,
	};
}
const PARTICIPATION_TYPES: Record<(typeof PARTICIPATION_COLUMNS)[number], string> = {
	person_id: "uuid",
	inviter_person_id: "uuid",
	roster_member: "boolean",
	presence: "text",
	rsvp: "text",
	rsvp_at: "timestamptz",
	rsvp_source: "text",
	removed_at: "timestamptz",
	rsvp_token_open: "boolean",
	card_response: "text",
	card_notes: "text",
	card_recorded_at: "timestamptz",
	card_author_id: "uuid",
	card_occurred_at: "timestamptz",
};
export function writeParticipations(owner: string, rows: readonly Record<string, unknown>[]): SQLWrapper {
	const set = PARTICIPATION_COLUMNS.map((k) => sql`${sql.identifier(k)}=v.${sql.identifier(k)}`);
	const shape = PARTICIPATION_COLUMNS.map((k) => sql.raw(`${k} ${PARTICIPATION_TYPES[k]}`));
	return sql`UPDATE participation g SET ${sql.join(set, sql`,`)},revision=g.revision+1
 FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(id uuid,${sql.join(shape, sql`,`)})
 WHERE g.id=v.id AND g.plant_id=${owner}::uuid`;
}

type FollowUpTask = NonNullable<FollowUp["task"]>;
function followUpState(f: FollowUp) {
	if (f.waived_at !== null || f.task?.status === "no_longer_needed") return "no_longer_needed" as const;
	if (!f.task || f.task.deleted_at !== null) return "deleted" as const;
	return f.task.status === "complete" ? ("complete" as const) : ("open" as const);
}
const FOLLOW_UP_RANK = { deleted: 0, no_longer_needed: 1, open: 2, complete: 3 } as const;
function followUpPlan(source: Facts, survivor: Facts) {
	const mine = new Map(survivor.followUps.map((f) => [f.meeting_id, f]));
	return source.followUps.flatMap((replaced) => {
		const kept = mine.get(replaced.meeting_id);
		if (!kept) return [];
		const theirs = followUpState(replaced),
			own = followUpState(kept);
		const better = kept.task && replaced.task && FOLLOW_UP_RANK[theirs] > FOLLOW_UP_RANK[own];
		const state = better ? theirs : own;
		const held = new Set(kept.task?.assignees);
		return [
			{
				meeting: titled(kept),
				state: state === "deleted" ? ("no_longer_needed" as const) : state,
				kept,
				replaced,
				takes: better ? replaced : null,
				owners: state === "open" ? (replaced.task?.assignees ?? []).filter((id) => !held.has(id)) : [],
				closes: theirs === "open" ? replaced.task : null,
			},
		];
	});
}

function plan(
	kind: "plant" | "organization",
	source: Facts,
	survivor: Facts,
	choices: Partial<Record<Field, "source" | "survivor">>,
) {
	const fields = c.mergeField.options.filter(
		(f) => kind === "plant" || !(c.plantOnlyMergeFields as readonly string[]).includes(f),
	);
	if (Object.keys(choices).some((f) => !fields.includes(f as Field))) deny("invalid_input");
	const differing = fields.filter((f) =>
		columns[f].some((col) => JSON.stringify(source.values[col]) !== JSON.stringify(survivor.values[col])),
	);
	const set: Record<string, unknown> = {};
	for (const f of differing) if (choices[f] === "source") for (const col of columns[f]) set[col] = source.values[col];
	let stage = null,
		commitment = null;
	if (kind === "plant") {
		if (source.stage === null || survivor.stage === null) throw Error("A plant person has no stage");
		const result = order[Math.max(order.indexOf(source.stage), order.indexOf(survivor.stage))];
		if (!result) throw Error(`Stages ${source.stage} and ${survivor.stage} are not in the pipeline order`);
		stage = { source: source.stage, survivor: survivor.stage, result };
		if (result !== survivor.stage) {
			set.stage = result;
			if (!sameColumn(survivor.stage, result)) set.pipeline_position = freshPosition(survivor.id);
		}
		commitment = commitmentOf({
			cards: [...survivor.commitment.cards, ...source.commitment.cards],
			changes: [...survivor.commitment.changes, ...source.commitment.changes],
		});
		if (commitment.state !== survivor.commitment_state || commitment.effectiveOn !== survivor.commitment_effective_on) {
			set.commitment_state = commitment.state;
			set.commitment_effective_on = commitment.effectiveOn;
		}
	}
	const prior = Object.fromEntries(Object.keys(set).map((col) => [col, survivor.values[col]]));
	const byKind = new Map<Kind, Reference[]>();
	for (const ref of source.refs.filter((x) => x.moves)) byKind.set(ref.kind, [...(byKind.get(ref.kind) ?? []), ref]);
	const held = new Set(survivor.refs.filter((x) => x.kind === "tag").map((x) => x.id));
	const keptOf = (k: Kind) => (survivor.refs.some((x) => x.kind === k) ? (byKind.get(k) ?? []).map((x) => x.id) : []);
	const same = (mine: Map<string, string>, theirs: Map<string, string>) => {
		const taken = new Set(theirs.values());
		return [...mine].filter(([, key]) => taken.has(key)).map(([id]) => id);
	};
	const droppedTags = (byKind.get("tag") ?? []).filter((x) => held.has(x.id)).map((x) => x.id);
	const followUps = followUpPlan(source, survivor);
	const keptByKind: readonly (readonly [Kind, string[]])[] = [
		["tag", droppedTags],
		["attestation", keptOf("attestation")],
		["launch_guest", keptOf("launch_guest")],
		["skill", same(source.skillNames, survivor.skillNames)],
		["obligation", followUps.map((f) => f.replaced.id)],
		["task", followUps.flatMap((f) => (f.replaced.task ? [f.replaced.task.id] : []))],
	];
	const kept = new Map(keptByKind.map(([k, ids]) => [k, new Set(ids)]));
	const carried = new Map(
		[...byKind].filter(([k]) => !participating(k)).map(([k, refs]) => [k, refs.filter((x) => !kept.get(k)?.has(x.id))]),
	);
	const causes: z.infer<typeof c.mergeBlocker>[] = [];
	if (source.linked_account_id && survivor.linked_account_id) causes.push("linked_account_collision");
	else if (source.linked_account_id) causes.push("linked_source");
	if (source.enrollment_programs.some((program) => survivor.enrollment_programs.includes(program)))
		causes.push("enrollment_collision");
	const leadership = source.currentRoles.flatMap((s) =>
		survivor.currentRoles
			.filter((v) => v.teamId === s.teamId)
			.map((v) => ({ team: s.team, sourceRole: s.role, survivorRole: v.role })),
	);
	if (leadership.length) causes.push("leadership_conflict");
	const invitations =
		source.residencyInvitations.length && (survivor.residencyLinked || survivor.residencyInvitations.length)
			? source.residencyInvitations
			: [];
	if (invitations.length) causes.push("residency_invitation_collision");
	const attendance = attendancePlan(source, survivor);
	const moves = ([k, refs]: [Kind, Reference[]]) => {
		if (k === "tag") return refs.length;
		return k === "participation" ? attendance.moved[k].length : (carried.get(k)?.length ?? refs.length);
	};
	const references = [
		...[...byKind].map(([k, refs]) => ({ kind: k, count: moves([k, refs]), treatment: treatmentOf(k) })),
		...keptByKind
			.filter(([k]) => k !== "tag")
			.map(([k, ids]) => ({ kind: k, count: ids.length, treatment: "keep" as const })),
	].filter((r) => r.count > 0);
	return {
		fields: differing.map((f) => ({
			field: f,
			source: Object.fromEntries(columns[f].map((col) => [col, source.values[col]])),
			survivor: Object.fromEntries(columns[f].map((col) => [col, survivor.values[col]])),
		})),
		set,
		prior,
		stage,
		commitment,
		carried,
		droppedTags,
		closedTraining: same(source.activeTraining, survivor.activeTraining),
		references,
		blockers: { causes, leadership, invitations },
		attendance,
		followUps,
		changes: [
			...attendance.changes,
			...followUps.map((f) => ({ change: "follow_up_combined" as const, meeting: f.meeting, state: f.state })),
		],
		reviewDigest: hash({
			source: [source.id, source.revision, referencesDigest(source.refs)],
			survivor: [survivor.id, survivor.revision, referencesDigest(survivor.refs)],
		}),
	};
}

async function readPair(tx: Tx, owner: string, input: { sourceId: string; survivorId: string }, gate: SQL) {
	const result =
		await tx.execute(sql`SELECT ${gate} AS allowed,${factsOf(sql`${input.sourceId}::uuid`, owner)} AS source,
 ${factsOf(sql`${input.survivorId}::uuid`, owner)} AS survivor`);
	const row = z.object({ allowed: z.boolean(), source: z.unknown(), survivor: z.unknown() }).parse(result.rows[0]);
	const source = parseFacts(row.source),
		survivor = parseFacts(row.survivor);
	if (!row.allowed || !source || !survivor || source.state !== "live" || survivor.state !== "live") deny("unavailable");
	return { source, survivor };
}
const ownerKind = (ctx: Pick<Context, "selected">) => {
	if (ctx.selected.kind !== "plant" && ctx.selected.kind !== "organization") deny("unavailable");
	return ctx.selected.kind;
};

type Touched = { kind: "task" | "obligation"; id: string; revision: string };
function combineFollowUps(
	owner: string,
	accountId: string,
	audit: AuditWrite,
	followUps: ReturnType<typeof followUpPlan>,
): Touched[] {
	const touched: Touched[] = [];
	const touch = (kind: Touched["kind"], row: { id: string; revision: string }) =>
		touched.push({ kind, id: row.id, revision: String(BigInt(row.revision) + 1n) });
	for (const { kept, replaced, takes, owners, closes } of followUps) {
		audit.writes.push(sql`UPDATE obligation SET superseded_at=clock_timestamp(),revision=revision+1
 WHERE id=${replaced.id}::uuid AND plant_id=${owner}::uuid`);
		touch("obligation", replaced);
		if (closes) {
			audit.writes.push(writeFollowUpTask(owner, { ...closes, status: "no_longer_needed" }));
			auditTaskStatus(owner, accountId, audit, "merge", closes, "no_longer_needed");
			touch("task", closes);
		}
		if (!kept.task || !(takes || owners.length)) continue;
		audit.writes.push(writeFollowUpTask(owner, { ...(takes?.task ?? kept.task), id: kept.task.id }));
		touch("task", kept.task);
		if (takes?.task && takes.task.status !== kept.task.status)
			auditTaskStatus(owner, accountId, audit, "merge", kept.task, takes.task.status);
		if (takes && kept.waived_at !== null) {
			audit.writes.push(writeWaiver(owner, { id: kept.id, waived_at: null, waiver_reason: null }));
			touch("obligation", kept);
		}
		if (owners.length)
			audit.writes.push(sql`INSERT INTO task_assignee(plant_id,task_id,account_id)
 SELECT ${owner}::uuid,${kept.task.id}::uuid,a FROM unnest(${sql.param(owners)}::uuid[]) a`);
	}
	return touched;
}
export const writeFollowUpTask = (
	owner: string,
	t: Pick<FollowUpTask, "id" | "status" | "completed_at" | "deleted_at">,
) => sql`UPDATE task SET status=${t.status},completed_at=${t.completed_at}::timestamptz,
 deleted_at=${t.deleted_at}::timestamptz,revision=revision+1 WHERE id=${t.id}::uuid AND plant_id=${owner}::uuid`;
export const writeWaiver = (owner: string, o: Pick<FollowUp, "id" | "waived_at" | "waiver_reason">) =>
	sql`UPDATE obligation SET waived_at=${o.waived_at}::timestamptz,waiver_reason=${o.waiver_reason},revision=revision+1
 WHERE id=${o.id}::uuid AND plant_id=${owner}::uuid`;
const bumped = (x: Reference): Reference =>
	x.revision === null ? x : { ...x, revision: String(BigInt(x.revision) + 1n) };
export function auditTaskStatus(
	owner: string,
	accountId: string,
	audit: AuditWrite,
	source: "merge" | "unmerge",
	t: Pick<FollowUpTask, "id" | "status" | "revision">,
	to: FollowUpTask["status"],
) {
	audit.events.push({
		id: randomUUID(),
		tenant_id: owner,
		actor_id: accountId,
		actor_token: hash([owner, accountId]),
		action: source === "merge" ? "people.merged" : "people.unmerged",
		kind: source,
		subject_type: "task",
		subject_id: t.id,
		before_value: { status: t.status },
		after_value: { status: to },
		before_revision: t.revision,
		after_revision: String(BigInt(t.revision) + 1n),
		metadata: { source },
	});
}

export function moveRefs(owner: string, k: Kind, ids: string[], from: string, to: string): SQLWrapper {
	const e = registrationOf(k);
	if (k === "training_assignment") {
		return sql`UPDATE ${sql.identifier(e.table)} SET ${sql.identifier(e.column)}=${to}::uuid,
 state=CASE WHEN clash.hit THEN 'removed' ELSE state END,
 ended_on=CASE WHEN clash.hit THEN (clock_timestamp() AT TIME ZONE (SELECT timezone FROM plant WHERE id=${owner}::uuid))::date ELSE ended_on END,
 revision=revision+1
 FROM (SELECT s.id, (s.state='active' AND EXISTS (
 SELECT 1 FROM ${sql.identifier(e.table)} o
 WHERE o.plant_id=s.plant_id AND o.program_id=s.program_id AND o.person_id=${to}::uuid
 AND o.state='active' AND o.id<>s.id)) AS hit
 FROM ${sql.identifier(e.table)} s
 WHERE s.${sql.identifier(e.column)}=${from}::uuid AND s.${sql.identifier(e.owner)}=${owner}::uuid
 AND s.${sql.identifier(e.key)}=ANY(${sql.param(ids)}::uuid[])) AS clash
 WHERE ${sql.identifier(e.table)}.id=clash.id`;
	}
	return sql`UPDATE ${sql.identifier(e.table)} SET ${sql.identifier(e.column)}=${to}::uuid${e.revision ? sql`,revision=revision+1` : sql``}
 WHERE ${sql.identifier(e.column)}=${from}::uuid AND ${sql.identifier(e.owner)}=${owner}::uuid
 AND ${sql.identifier(e.key)}=ANY(${sql.param(ids)}::uuid[])`;
}
export function updatePerson(owner: string, id: string, set: Record<string, unknown>): SQLWrapper {
	const assignments = Object.entries(set).map(([col, v]) =>
		v instanceof Object && "getSQL" in v
			? sql`${sql.identifier(col)}=${v as SQL}`
			: sql`${sql.identifier(col)}=${sql.param(v)}`,
	);
	return sql`UPDATE person SET ${sql.join([...assignments, sql`revision=revision+1`], sql`,`)}
 WHERE id=${id}::uuid AND tenant_id=${owner}::uuid`;
}
export const peopleMerge = {
	async getMergeReview(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const kind = ownerKind(ctx);
			const input = parse(c.mergeReviewRequest, raw);
			const { source, survivor } = await readPair(tx, ctx.selected.id, input, adminRead(ctx));
			const p = plan(kind, source, survivor, {});
			const replaced = new Set(p.followUps.flatMap((f) => [f.replaced.id, ...(f.takes ? [f.kept.id] : [])])),
				closed = new Set(p.followUps.map((f) => f.closes?.id));
			const side = (f: Facts) => ({
				personId: f.id,
				revision: f.revision,
				displayName: f.display_name,
				linkedAccount: f.linked_account_id !== null,
			});
			return c.mergeReview.parse({
				source: side(source),
				survivor: side(survivor),
				fields: p.fields,
				stage: p.stage,
				commitment: p.commitment && { result: p.commitment.state, effectiveOn: p.commitment.effectiveOn },
				references: p.references,
				blockers: p.blockers,
				openFollowUps: [...survivor.openFollowUps, ...source.openFollowUps]
					.filter((f) => !replaced.has(f.id))
					.map(({ personId, meeting, dueDate }) => ({ personId, meeting, dueDate })),
				attendance: p.changes,
				openTasks: source.openTasks.filter((t) => !closed.has(t.id)).map(({ title, dueDate }) => ({ title, dueDate })),
				openKitItems: source.openKitItems,
				reviewDigest: p.reviewDigest,
			});
		});
	},
	async mergePeople(tx: Tx, ctx: WriteContext, raw: unknown) {
		return reply(tx, async () => {
			const kind = ownerKind(ctx);
			const owner = ctx.selected.id;
			const input = parse(c.mergePeopleRequest, raw);
			const name = kind === "plant" ? "people.mergePeople" : "orgPeople.merge";
			return c.mergeResult.parse(
				await mutation<unknown>(tx, ctx, name, input, async (actor, receiptId, audit) => {
					const m = input.input;
					await lockPair(tx, owner, sql`${m.sourceId}::uuid,${m.survivorId}::uuid`);
					const { source, survivor } = await readPair(tx, owner, m, sql`true`);
					const p = plan(kind, source, survivor, m.fieldChoices);
					if (p.reviewDigest !== m.reviewDigest) deny("conflict");
					if (p.blockers.causes.length) deny("merge_blocked", p.blockers);
					const mergeId = randomUUID();
					const moved: Record<string, string[]> = { ...p.attendance.moved };
					const a = p.attendance;
					if (a.removed.length)
						audit.writes.push(sql`UPDATE participation SET removed_at=clock_timestamp(),rsvp_token_open=false,
 revision=revision+1 WHERE id=ANY(${sql.param(a.removed)}::uuid[]) AND plant_id=${owner}::uuid`);
					if (a.updates.length) audit.writes.push(writeParticipations(owner, a.updates));
					const touched = combineFollowUps(owner, actor, audit, p.followUps);
					for (const [k, refs] of p.carried) {
						const ids = refs.map((x) => x.id);
						moved[k] = ids;
						if (ids.length) audit.writes.push(moveRefs(owner, k, ids, source.id, survivor.id));
					}
					if (p.droppedTags.length) {
						moved.tag_dropped = p.droppedTags;
						audit.writes.push(
							sql`DELETE FROM person_tag WHERE person_id=${source.id}::uuid AND plant_id=${owner}::uuid
 AND tag_id=ANY(${sql.param(p.droppedTags)}::uuid[])`,
						);
					}
					const sourceSet: Record<string, unknown> = {
						state: "merged",
						merged_into_person_id: survivor.id,
						retired_at: sql`clock_timestamp()`,
					};
					const sourcePrior: Record<string, unknown> = {};
					if (kind === "plant" && source.household_id) {
						Object.assign(sourceSet, { household_id: null, household_role: null });
						Object.assign(sourcePrior, {
							household_id: source.household_id,
							household_role: source.values.household_role,
						});
					}
					audit.writes.push(updatePerson(owner, source.id, sourceSet));
					audit.writes.push(updatePerson(owner, survivor.id, p.set));
					if (kind === "plant")
						audit.writes.push(
							columnsChanged(owner, [source.stage, ...(p.set.stage ? [survivor.stage, p.set.stage as string] : [])]),
						);
					const sourceRevision = String(BigInt(source.revision) + 1n),
						survivorRevision = String(BigInt(survivor.revision) + 1n);
					const after = [
						...survivor.refs
							.filter((x) => !participating(x.kind))
							.map((x) => (touched.some((t) => t.id === x.id) ? bumped(x) : x)),
						...a.after,
						...[...p.carried.values()].flat().map(bumped),
						{ kind: "merged_person" as const, id: source.id, revision: sourceRevision, moves: true },
					];
					audit.writes.push(
						sql`INSERT INTO person_merge(id,tenant_id,source_id,survivor_id,prior,moved,source_revision,survivor_revision,references_digest)
 VALUES (${mergeId}::uuid,${owner}::uuid,${source.id}::uuid,${survivor.id}::uuid,${JSON.stringify({
		source: sourcePrior,
		survivor: p.prior,
		participation: a.prior,
		attendance: p.changes,
		training: p.closedTraining,
		followUps: p.followUps.map(({ kept, replaced, takes, owners, closes }) => ({
			replaced: replaced.id,
			closed: closes,
			kept: takes || owners.length ? kept.task : null,
			waiver:
				takes && kept.waived_at !== null
					? { id: kept.id, waived_at: kept.waived_at, waiver_reason: kept.waiver_reason }
					: null,
			owners,
			touched: touched.filter((t) => [kept.id, kept.task?.id, replaced.id, replaced.task?.id].includes(t.id)),
		})),
		references: after.map((x) => [x.kind, x.id, x.revision]),
 })}::jsonb,
 ${JSON.stringify(moved)}::jsonb,${sourceRevision}::bigint,${survivorRevision}::bigint,${referencesDigest(after)})`,
					);
					return {
						value: {
							mergeId,
							sourceId: source.id,
							survivorId: survivor.id,
							survivorRevision,
							moved: p.references.filter((r) => r.treatment !== "keep").map(({ kind, count }) => ({ kind, count })),
							outcome: "changed",
							receiptId,
						},
						subject: survivor.id,
						action: "people.merged",
						before: { revision: survivor.revision },
						after: { revision: survivorRevision },
						metadata: {
							event: "person_merged",
							recordId: mergeId,
							sourceId: source.id,
							fields: Object.keys(p.prior).join(","),
						},
					};
				}),
			);
		});
	},
	async mergedPersonDestination(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			const kind = ownerKind(ctx);
			const input = parse(c.mergedPersonDestinationRequest, raw);
			const gate = kind === "plant" ? (await authorizeRead(tx, ctx)).gate : adminRead(ctx);
			const result = await tx.execute(sql`SELECT p.state,coalesce(p.merged_into_person_id,p.id) AS destination,
 (SELECT m.id FROM person_merge m WHERE m.source_id=p.id AND m.tenant_id=p.tenant_id AND m.unmerged_at IS NULL) AS merge_id
 FROM person p WHERE ${gate} AND p.id=${input.personId}::uuid AND p.tenant_id=${ctx.selected.id}::uuid
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)`);
			const row = z
				.object({ state: z.enum(["live", "retired", "merged"]), destination: z.uuid(), merge_id: z.uuid().nullable() })
				.safeParse(result.rows[0]);
			if (!row.success) deny("unavailable");
			return c.mergedPersonDestination.parse({
				personId: input.personId,
				status: row.data.state,
				destinationId: row.data.destination,
				mergeId: row.data.merge_id,
			});
		});
	},
	async findDuplicates(tx: Tx, ctx: Context, raw: unknown) {
		return readReply(async () => {
			if (ctx.selected.kind !== "organization") deny("unavailable");
			const input = parse(c.organizationDuplicatesRequest, raw);
			const gate = adminRead(ctx);
			const result = await tx.execute(sql`SELECT p.display_name,p.email,p.phone FROM person p WHERE ${gate}
 AND p.id=${input.personId}::uuid AND p.tenant_id=${ctx.selected.id}::uuid AND p.state='live'
 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id)`);
			const p = z
				.object({ display_name: z.string(), email: z.string().nullable(), phone: z.string().nullable() })
				.safeParse(result.rows[0]);
			if (!p.success) deny("unavailable");
			return matchPeople(
				tx,
				ctx.selected.id,
				gate,
				{ displayName: p.data.display_name, email: p.data.email, phone: p.data.phone },
				input.personId,
			);
		});
	},
};
