import { sql, type SQL } from "@everyfield/db/query";
import {
	assessments,
	commitments,
	interviews,
	peopleMerge,
	peopleUnmerge,
	recordCorrections,
} from "@everyfield/domain/people";
import {
	commitmentKind,
	correctCommitmentRequest,
	correctPersonRecordRequest,
	counted,
	createAssessmentRequest,
	createCommitmentRequest,
	createInterviewRequest,
	criterionRating,
	fourCs,
	interviewCriteria,
	interviewResult,
	listText,
	mergeBlockedText,
	mergePeopleRequest,
	reactivateCommitmentRequest,
	stage,
	unmergePeopleRequest,
	withdrawCommitmentRequest,
	type PeopleReply,
} from "@everyfield/contracts/people";
import { z } from "zod";
import { person, reviewed, target, type Receipt } from "../../people/commands/index.ts";
import { mergeReviewOf, unmergePreviewOf } from "../reads/index.ts";
import { date, id } from "../ids.ts";

// The People assessment-area reviewed writes (WP-062). Each review is one SELECT under the proposal's statement that
// reads the target live in the actor's church and saves the native command's exact arguments: exactly the ratings,
// scores, dates and choices the person gave, never one the model filled in (the inputs require every one, so a request
// that leaves one out cannot be proposed). On approval the executor runs the owning native People command once with the
// effect key as its request key; anything that changed since the review refuses instead of being overwritten.

const json = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;
const change = (field: string, after: unknown, before: SQL = sql`NULL`) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before},'after',${json(after ?? null)})`;
const changes = (list: SQL[]) => (list.length ? sql`jsonb_build_array(${sql.join(list, sql`,`)})` : sql`'[]'::jsonb`);
/** The church's today, for the person `p`. */
const today = sql`(SELECT (clock_timestamp() AT TIME ZONE pl.timezone)::date FROM plant pl WHERE pl.id=p.plant_id)`;
/** A review the native command would refuse says so on the card, which then offers no Approve. */
const refusal = (cases: [when: SQL, text: string][]) =>
	sql`CASE ${sql.join(
		cases.map(([when, text]) => sql`WHEN ${when} THEN jsonb_build_object('refusal',${text}::text)`),
		sql` `,
	)} ELSE '{}'::jsonb END`;
const future = (on: string): [SQL, string] => [
	sql`${on}::date>${today}`,
	"That date is after today in the church's time zone, so it can't be recorded.",
];
const ORDER = sql.raw(`ARRAY[${stage.options.map((s) => `'${s}'`).join(",")}]::text[]`);
/** REQ-PPL-020: an interview moves an earlier stage to interviewed and a commitment card to core_group. */
const advance = (to: string) =>
	sql`CASE WHEN array_position(${ORDER},p.stage::text)<array_position(${ORDER},${to}::text)
		THEN jsonb_build_array(jsonb_build_object('field','stage','before',to_jsonb(p.stage),'after',to_jsonb(${to}::text))) ELSE '[]'::jsonb END`;

const receipt =
	<T>(revision: (v: T & { receiptId: string }) => string) =>
	(reply: PeopleReply<T & { receiptId: string }>): PeopleReply<Receipt> =>
		reply.status === "ok"
			? { status: "ok", value: { receiptId: reply.value.receiptId, revision: revision(reply.value) } }
			: reply;
const personRevision = receipt<{ person: { revision: string } }>((v) => v.person.revision);
const commitmentRevision = receipt<{ current: { personRevision: string } }>((v) => v.current.personRevision);

const notes = z.string().trim().min(1).max(5000).optional().describe("Only notes the user gave");
const criterion = z.strictObject({ rating: criterionRating, notes });
const lens = z.strictObject({ score: z.int().min(1).max(5), notes });
const withNotes = <T extends { notes?: string }>(v: T) => ({ ...v, notes: v.notes ?? null });

const interviewInput = z.strictObject({
	personId: id,
	occurredOn: date,
	maturity: criterion,
	gifted: criterion,
	chemistry: criterion,
	rightReasons: criterion,
	season: criterion,
	result: interviewResult,
	nextSteps: notes,
});
const createInterview = reviewed({
	operation: "people.createInterview",
	description:
		"Propose recording one person's interview exactly as the user gave it: the date, a pass, concern or fail rating for each of the five criteria (maturity, gifted, chemistry, right reasons, season) and the result. Every rating and the result must come from the user; ask for any they left out, never fill one in or suggest one. Nothing is recorded until the user approves the exact review.",
	input: interviewInput,
	review(actor, v) {
		const input = {
			personId: v.personId,
			occurredOn: v.occurredOn,
			...Object.fromEntries(interviewCriteria.map((k) => [k, withNotes(v[k])])),
			result: v.result,
			nextSteps: v.nextSteps ?? null,
		};
		const list = [
			change("occurredOn", v.occurredOn),
			...interviewCriteria.map((k) => change(k, withNotes(v[k]))),
			change("result", v.result),
			...(v.nextSteps ? [change("nextSteps", v.nextSteps)] : []),
		];
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)}||${advance("interviewed")})
				||${refusal([future(v.occurredOn)])} AS review,
			jsonb_build_object('input',${json(input)}) AS args
			${target(actor, v.personId)}`;
	},
	request: createInterviewRequest,
	run: async (tx, context, request) => personRevision(await interviews.createInterview(tx, context, request)),
});

const assessmentInput = z.strictObject({
	personId: id,
	occurredOn: date,
	committed: lens,
	compelled: lens,
	contagious: lens,
	courageous: lens,
});
const createAssessment = reviewed({
	operation: "people.createAssessment",
	description:
		"Propose recording one person's 4 C's assessment exactly as the user gave it: the date and a score from 1 to 5 for each of committed, compelled, contagious and courageous. Every score must come from the user; ask for any they left out, never fill one in or suggest one. The total is the sum. The stage does not change. Nothing is recorded until the user approves the exact review.",
	input: assessmentInput,
	review(actor, v) {
		const input = {
			personId: v.personId,
			occurredOn: v.occurredOn,
			...Object.fromEntries(fourCs.map((k) => [k, withNotes(v[k])])),
		};
		const list = [
			change("occurredOn", v.occurredOn),
			...fourCs.map((k) => change(k, withNotes(v[k]))),
			change(
				"total",
				fourCs.reduce((sum, k) => sum + v[k].score, 0),
			),
		];
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)})||${refusal([future(v.occurredOn)])} AS review,
			jsonb_build_object('input',${json(input)}) AS args
			${target(actor, v.personId)}`;
	},
	request: createAssessmentRequest,
	run: async (tx, context, request) => personRevision(await assessments.createAssessment(tx, context, request)),
});

const commitmentInput = z.strictObject({
	personId: id,
	kind: commitmentKind.describe("core_group or launch_team"),
	occurredOn: date.describe("The date the card was signed, YYYY-MM-DD"),
	witness: z
		.union([z.strictObject({ personId: id }), z.strictObject({ external: z.string().trim().min(1).max(200) })])
		.optional()
		.describe("Only a witness the user named: a person in this church, or a name outside it"),
	notes,
});
const createCommitment = reviewed({
	operation: "people.createCommitment",
	description:
		"Propose recording a signed commitment card for one person exactly as the user gave it: the kind (core group or launch team), the date it was signed, and any witness or notes they gave. An earlier stage moves to core group. Nothing is recorded until the user approves the exact review.",
	input: commitmentInput,
	review(actor, v) {
		const input = {
			personId: v.personId,
			kind: v.kind,
			occurredOn: v.occurredOn,
			witness: v.witness ?? null,
			notes: v.notes ?? null,
		};
		const witness =
			v.witness && "personId" in v.witness
				? sql`(SELECT to_jsonb(w.display_name) FROM person w WHERE w.id=${v.witness.personId}::uuid AND w.tenant_id=p.tenant_id
					AND w.plant_id=p.plant_id AND w.state='live' AND w.id<>p.id)`
				: null;
		const list = [
			change("kind", v.kind),
			change("occurredOn", v.occurredOn),
			...(witness ? [sql`jsonb_build_object('field','witness','before',NULL,'after',${witness})`] : []),
			...(v.witness && "external" in v.witness ? [change("witness", v.witness.external)] : []),
			...(v.notes ? [change("notes", v.notes)] : []),
		];
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)}||${advance("core_group")})
				||${refusal([future(v.occurredOn), ...(witness ? [[sql`${witness} IS NULL`, "That witness is not a current person in this church."] as [SQL, string]] : [])])} AS review,
			jsonb_build_object('input',${json(input)}) AS args
			${target(actor, v.personId)}`;
	},
	request: createCommitmentRequest,
	run: async (tx, context, request) => personRevision(await commitments.createCommitment(tx, context, request)),
});

const lifecycleInput = z.strictObject({
	personId: id,
	effectiveOn: date.describe("The date it takes effect, YYYY-MM-DD"),
	reason: notes.describe("Only a reason the user gave"),
});
/** Withdraw or reactivate: the person's current commitment changes from `from` to `to`; the stage never changes. */
function lifecycle(to: "withdrawn" | "active") {
	const withdraw = to === "withdrawn";
	const from = withdraw ? "active" : "withdrawn";
	return reviewed({
		operation: withdraw ? "people.withdrawCommitment" : "people.reactivateCommitment",
		description: withdraw
			? "Propose withdrawing one person's active commitment from a date the user gave, with any reason they gave. The stage does not change. Nothing changes until the user approves the exact review."
			: "Propose reactivating one person's withdrawn commitment from a date the user gave, with any reason they gave. The stage does not change. Nothing changes until the user approves the exact review.",
		input: lifecycleInput,
		review(actor, v) {
			const list = [
				change("commitment", to, sql`to_jsonb(p.commitment_state)`),
				change("effectiveOn", v.effectiveOn, sql`to_jsonb(p.commitment_effective_on::text)`),
				...(v.reason ? [change("reason", v.reason)] : []),
			];
			return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)})||${refusal([
				[
					sql`p.commitment_state<>${from}`,
					withdraw
						? "This person has no active commitment to withdraw."
						: "This person has no withdrawn commitment to reactivate.",
				],
				future(v.effectiveOn),
				[
					sql`${v.effectiveOn}::date<p.commitment_effective_on`,
					"That date is before the commitment's current state began.",
				],
			])} AS review,
				jsonb_build_object('expectedRevision',p.revision::text,'input',jsonb_build_object('personId',p.id,
					'effectiveOn',${v.effectiveOn}::text,'reason',${v.reason ?? null}::text)) AS args
				${target(actor, v.personId)}`;
		},
		request: withdraw ? withdrawCommitmentRequest : reactivateCommitmentRequest,
		run: async (tx, context, request) =>
			commitmentRevision(
				await (withdraw
					? commitments.withdrawCommitment(tx, context, request)
					: commitments.reactivateCommitment(tx, context, request)),
			),
	});
}

const cardCorrection = z.strictObject({
	commitmentId: id,
	correction: z.discriminatedUnion("action", [
		z.strictObject({
			action: z.literal("correct"),
			occurredOn: date.optional().describe("The corrected signed date"),
			kind: commitmentKind.optional(),
		}),
		z.strictObject({ action: z.literal("void").describe("The card was never genuine") }),
	]),
	reason: z.string().trim().min(1).max(5000).describe("Why, in the user's words"),
});
const correctCommitmentLifecycle = reviewed({
	operation: "people.correctCommitmentLifecycle",
	description:
		"Propose correcting one commitment card's signed date or kind, or voiding a card that was never genuine, by the card id from people.getCommitments, with the user's reason. The history keeps the original. Nothing changes until the user approves the exact review.",
	input: cardCorrection,
	review(actor, v) {
		const c = v.correction;
		const list =
			c.action === "void"
				? [change("voided", true, sql`to_jsonb(false)`)]
				: [
						...(c.occurredOn ? [change("occurredOn", c.occurredOn, sql`to_jsonb(k.signed_on::text)`)] : []),
						...(c.kind ? [change("kind", c.kind, sql`to_jsonb(k.kind)`)] : []),
					];
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes([...list, change("reason", v.reason)])})||${refusal([
			[sql`k.voided_at IS NOT NULL`, "This card was already voided."],
			...(c.action === "correct" && c.occurredOn ? [future(c.occurredOn)] : []),
		])} AS review,
			jsonb_build_object('expectedRevision',k.revision::text,'input',jsonb_build_object('commitmentId',k.id,
				'correction',${json(c)},'reason',${v.reason}::text)) AS args
			FROM commitment k JOIN person p ON p.id=k.person_id AND p.tenant_id=k.plant_id AND p.plant_id=k.plant_id AND p.state='live'
			WHERE k.id=${v.commitmentId}::uuid AND k.plant_id=${actor.owner.id}::uuid`;
	},
	request: correctCommitmentRequest,
	run: async (tx, context, request) =>
		commitmentRevision(await commitments.correctCommitmentLifecycle(tx, context, request)),
});

// Record corrections: each correctable field, how its current value reads from the record `r`, and whether a given
// value replaces it whole (a date, a result) or only the parts the user gave (a rating keeps its notes unless new
// notes were given).
const partial = { rating: criterionRating.optional(), score: z.int().min(1).max(5).optional(), notes };
const interviewChanges = z
	.strictObject({
		occurredOn: date.optional(),
		...Object.fromEntries(
			interviewCriteria.map((k) => [k, z.strictObject({ rating: partial.rating, notes }).optional()]),
		),
		result: interviewResult.optional(),
		nextSteps: notes,
	})
	.describe("Only the fields the user is correcting, with the values they gave");
const assessmentChanges = z
	.strictObject({
		occurredOn: date.optional(),
		...Object.fromEntries(fourCs.map((k) => [k, z.strictObject({ score: partial.score, notes }).optional()])),
	})
	.describe("Only the fields the user is correcting, with the values they gave");
const recordInput = z.discriminatedUnion("recordType", [
	z.strictObject({ recordType: z.literal("interview"), recordId: id, changes: interviewChanges, reason: notes }),
	z.strictObject({ recordType: z.literal("assessment"), recordId: id, changes: assessmentChanges, reason: notes }),
	z.strictObject({
		recordType: z.literal("commitment"),
		recordId: id,
		changes: z.strictObject({ notes: z.string().trim().max(5000).nullable() }),
		reason: notes,
	}),
]);
const column = (field: string) => (field === "rightReasons" ? "right_reasons" : field);
const RECORDS = {
	interview: {
		table: "interview",
		read: (f: string) =>
			f === "occurredOn"
				? sql`to_jsonb(r.interviewed_on::text)`
				: f === "result"
					? sql`to_jsonb(r.result)`
					: f === "nextSteps"
						? sql`to_jsonb(r.next_steps)`
						: sql.raw(`jsonb_build_object('rating',r.${column(f)},'notes',r.${column(f)}_notes)`),
	},
	assessment: {
		table: "four_cs",
		read: (f: string) =>
			f === "occurredOn"
				? sql`to_jsonb(r.assessed_on::text)`
				: sql.raw(`jsonb_build_object('score',r.${f},'notes',r.${f}_notes)`),
	},
	commitment: { table: "commitment", read: () => sql`to_jsonb(r.notes)` },
} as const;
const correctPersonRecord = reviewed({
	operation: "people.correctPersonRecord",
	description:
		"Propose correcting fields of one recorded interview, 4 C's assessment or commitment card's notes, by its id from an earlier read, with only the values the user gave. A card's signed date or kind goes through people.correctCommitmentLifecycle. The history keeps the original entry. Nothing changes until the user approves the exact review.",
	input: recordInput,
	review(actor, v) {
		const def = RECORDS[v.recordType];
		const given = Object.entries(v.changes as Record<string, unknown>).filter(([, x]) => x !== undefined);
		// A rating or score given without notes keeps the notes it has: the parts given replace only those parts.
		const after = (f: string, x: unknown) =>
			x !== null && typeof x === "object" ? sql`(${def.read(f)})||${json(x)}` : json(x);
		const list = given.map(
			([f, x]) => sql`jsonb_build_object('field',${f}::text,'before',${def.read(f)},'after',${after(f, x)})`,
		);
		const values = given.length
			? sql`jsonb_build_object(${sql.join(
					given.map(([f, x]) => sql`${f}::text,${after(f, x)}`),
					sql`,`,
				)})`
			: sql`'{}'::jsonb`;
		const date = (v.changes as { occurredOn?: string }).occurredOn;
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)}
				||${v.reason ? sql`jsonb_build_array(${change("reason", v.reason)})` : sql`'[]'::jsonb`})||${refusal([
				[sql`${given.length}=0`, "Nothing to correct was given."],
				...(v.recordType === "commitment"
					? [[sql`r.voided_at IS NOT NULL`, "This card was voided, so it can't be corrected."] as [SQL, string]]
					: []),
				...(date ? [future(date)] : []),
			])} AS review,
			jsonb_build_object('expectedRevision',r.revision::text,'input',jsonb_build_object('recordType',${v.recordType}::text,
				'personId',r.person_id,'recordId',r.id,${v.reason ? sql`'reason',${v.reason}::text,` : sql``}'changes',${values})) AS args
			FROM ${sql.identifier(def.table)} r JOIN person p ON p.id=r.person_id AND p.tenant_id=r.plant_id AND p.plant_id=r.plant_id AND p.state='live'
			WHERE r.id=${v.recordId}::uuid AND r.plant_id=${actor.owner.id}::uuid`;
	},
	request: correctPersonRecordRequest,
	run: async (tx, context, request) => {
		const reply = await recordCorrections.correctPersonRecord(tx, context, request);
		return reply.status === "ok"
			? { status: "ok", value: { receiptId: reply.value.receiptId, revision: reply.value.revision } }
			: reply;
	},
});

type Columns = Record<string, unknown>;
const empty = (field: string, v: Columns) =>
	Object.values(v).every((x) => x === null || x === "" || (field === "adultClassification" && x === "unknown"));
/** A field's value in words for the review: its non-empty column values. */
const columnsText = (v: Columns) =>
	Object.values(v)
		.filter((x) => x !== null && x !== "")
		.map(String)
		.join(" · ") || null;
const mergeInput = z.strictObject({
	sourceId: id.describe("The person who merges in and stops being a separate record"),
	survivorId: id.describe("The person who stays"),
});
const mergePeople = reviewed({
	operation: "people.mergePeople",
	description:
		"Propose merging two people in this church, after people.getMergeReview: the source merges into the survivor, which stays. Each detail keeps the survivor's value unless the survivor has none, as the People merge does. When the review says the merge is blocked, the card says why and nothing can be approved. Nothing changes until the user approves the exact review.",
	input: mergeInput,
	async review(actor, v, { db }) {
		if (v.sourceId === v.survivorId) return null;
		const m = await db.transaction((tx) => mergeReviewOf(tx, actor, v));
		if (!m) return null;
		const who = { source: m.source.displayName, survivor: m.survivor.displayName };
		// The People merge review's default (corrections/model.ts, defaultChoices): the survivor's value stays unless it
		// has none and the source has one.
		const fields = m.fields.filter(
			(f) => empty(f.field, f.survivor as Columns) && !empty(f.field, f.source as Columns),
		);
		const fieldChoices = Object.fromEntries(fields.map((f) => [f.field, "source"]));
		const moves = m.references.filter((r) => r.treatment === "move" || r.treatment === "deduplicate");
		const stays = m.references.filter((r) => r.treatment === "keep");
		const list = [
			change("keeps", who.survivor),
			change("mergesIn", who.source),
			...(moves.length ? [change("moves", listText(moves.map((r) => counted(r.kind, r.count))))] : []),
			...(stays.length ? [change("staysWithMergedRecord", listText(stays.map((r) => counted(r.kind, r.count))))] : []),
			...(m.stage && m.stage.result !== m.stage.survivor
				? [change("stage", m.stage.result, json(m.stage.survivor))]
				: []),
			...fields.map((f) =>
				change(f.field, columnsText(f.source as Columns), json(columnsText(f.survivor as Columns))),
			),
		];
		const blocked = m.blockers.causes.length ? mergeBlockedText(m.blockers, who) : null;
		const input = { sourceId: m.source.personId, survivorId: m.survivor.personId, reviewDigest: m.reviewDigest, fieldChoices };
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)})
				||${blocked ? sql`jsonb_build_object('refusal',${blocked}::text)` : sql`'{}'::jsonb`} AS review,
			jsonb_build_object('input',${json(input)}) AS args
			${target(actor, v.survivorId)}`;
	},
	request: mergePeopleRequest,
	run: async (tx, context, request) => {
		const reply = await peopleMerge.mergePeople(tx, context, request);
		return reply.status === "ok"
			? { status: "ok", value: { receiptId: reply.value.receiptId, revision: reply.value.survivorRevision } }
			: reply;
	},
});

const unmergePeople = reviewed({
	operation: "people.unmergePeople",
	description:
		"Propose undoing one merge, by the mergeId from people.previewUnmerge. When something changed since the merge, the card says why and nothing can be approved. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ mergeId: id }),
	async review(actor, v, { db }) {
		const u = await db.transaction((tx) => unmergePreviewOf(tx, actor, v.mergeId));
		if (!u) return null;
		const list = [
			change("comesBack", u.names.source),
			...(u.restores.length ? [change("movesBack", listText(u.restores.map((r) => counted(r.kind, r.count))))] : []),
			...(u.fields.length ? [change("detailsGoBack", u.fields.join(", "))] : []),
		];
		return sql`SELECT jsonb_build_object('target',${person},'changes',${changes(list)})
				||${u.blocked ? sql`jsonb_build_object('refusal',${u.blocked}::text)` : sql`'{}'::jsonb`} AS review,
			jsonb_build_object('expectedRevision',${u.reviewRevision}::text,'input',jsonb_build_object('mergeId',${u.mergeId}::uuid)) AS args
			${target(actor, u.survivorId)}`;
	},
	request: unmergePeopleRequest,
	run: async (tx, context, request) => {
		const reply = await peopleUnmerge.unmergePeople(tx, context, request);
		return reply.status === "ok"
			? { status: "ok", value: { receiptId: reply.value.receiptId, revision: reply.value.survivorRevision } }
			: reply;
	},
});

/** The installed assessment-area reviewed writes, keyed by operation. */
export const ASSESSMENT_COMMANDS = {
	"people.createInterview": createInterview,
	"people.createAssessment": createAssessment,
	"people.createCommitment": createCommitment,
	"people.withdrawCommitment": lifecycle("withdrawn"),
	"people.reactivateCommitment": lifecycle("active"),
	"people.correctCommitmentLifecycle": correctCommitmentLifecycle,
	"people.correctPersonRecord": correctPersonRecord,
	"people.mergePeople": mergePeople,
	"people.unmergePeople": unmergePeople,
} as const;
