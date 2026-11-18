import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { countdown, NOTE_MAX } from "../../../packages/contracts/src/launch/index.ts";
import type { TaskReminders } from "../../../packages/domain/src/tasks/index.ts";
import { authorizeLaunchNotices } from "../../../packages/domain/src/launch/index.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	readConversation,
	readReview,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { modelTools } from "../../../packages/evry/src/runtime/tools.ts";
import { LAUNCH_RULES } from "../../../packages/evry/src/context/compile.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { seatedNotificationService } from "../../../apps/web/src/server/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/features/launch/notices.ts";
import { ACTOR_SPECS, evalDatabase, PLANT, seedHope } from "./golden-church.mts";
import {
	authorityOf,
	COMPLETED,
	day,
	LINKED_TASK,
	planOf,
	reader,
	said,
	correctOnPlan,
	MATCH,
	OUTCOME_NOTE,
	seedGuestMatch,
	seedGuests,
	seedLaunched,
	seedOutcomeNote,
	seedMilestones,
	seedNeedsReview,
	seedScheduled,
	sessionOf,
	setVenue,
	setVenueTask,
	today,
	VENUE_TASKS,
	VENUE_TITLE,
	venueOf,
	writer,
	type LaunchName,
} from "./launch-church.mts";

type Change = { field: string; before: unknown; after: unknown };
type Expected = { operation: string; target: string; changes?: Change[]; notes?: string[] };
type Case = {
	id: string;
	criterion: number;
	setup?:
		"scheduled" | "unloadable" | "launched" | "guests" | "milestones" | "needsReview" | "guestMatch" | "outcomeNote";
	continue?: true;
	actor: LaunchName;
	ask: string;
	calls: string[];
	answer?: string[];
	absent?: string[];
	proposal?: Expected;
	proposals?: Expected[];
	approve?: true;
	outcome?: "completed" | "refused";
};
const { cases } = JSON.parse(readFileSync(new URL("./launch.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

function next(month: number, d: number) {
	const t = today();
	const at = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	const year = Number(t.slice(0, 4));
	return at(year) >= t ? at(year) : at(year + 1);
}
const DATES: Record<string, string> = {
	mar14: next(3, 14),
	mar21: next(3, 21),
	apr11: next(4, 11),
	apr18: next(4, 18),
};
const monthDay = (d: string, year: boolean) =>
	new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		...(year && { year: "numeric" as const }),
		timeZone: "UTC",
	}).format(new Date(`${d}T12:00:00Z`));
const fill = (text: string) =>
	text
		.replace(/\{md:(-?\d+)\}/g, (_, n) => monthDay(day(Number(n)), false))
		.replace(/\{mdy:(-?\d+)\}/g, (_, n) => monthDay(day(Number(n)), true))
		.replace(/\{said:(-?\d+)\}/g, (_, n) => said(day(Number(n))))
		.replace(/\{day:(-?\d+)\}/g, (_, n) => day(Number(n)))
		.replace(/\{(mar14|mar21|apr11|apr18)\}/g, (_, k: string) => said(DATES[k]!));
const filled = <T,>(value: T): T => JSON.parse(fill(JSON.stringify(value))) as T;

let close: () => Promise<void>;
let db: Database;
let admin: Database;
let native: NativePorts;
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const noReminders: TaskReminders = async () => undefined;
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: LaunchName) => (await freshActor(sessionOf(who)))!;

before(async () => {
	const database = await evalDatabase({ prefix: "evrylaunch", max: 10 });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(database.admin, { seatNames: true });
	const mail = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	native = { launchNotices: launchNotices(seatedNotificationService(mail)) } as unknown as NativePorts;
});
after(() => close?.());

async function ask(actor: EvryActor, conversationId: string, text: string) {
	await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native: null },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const read = await readConversation(db, actor, conversationId);
	const start = read.events.findLastIndex((e) => e.kind === "user_message");
	const turn = read.events.slice(start + 1);
	const reads = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof e.body.operation === "string" && e.body.operation !== "evry.prepareProposal"
			? [e.body.operation]
			: [],
	);
	const answer = turn
		.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
		.join("");
	const ids = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof (e.body.result as { proposalId?: unknown })?.proposalId === "string"
			? [(e.body.result as { proposalId: string }).proposalId]
			: [],
	);
	const proposals = ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p));
	return { reads, answer, proposals };
}

async function approveAndRun(actor: EvryActor, proposal: Proposal) {
	await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
		null,
		native,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

const untouched = async () =>
	(
		await admin.execute(sql`SELECT (SELECT jsonb_agg(jsonb_build_array(k.id,k.due_date,k.status,
				(SELECT jsonb_agg(a.account_id ORDER BY a.account_id) FROM task_assignee a WHERE a.task_id=k.id)) ORDER BY k.id)
			FROM task k WHERE k.plant_id=${PLANT}) AS tasks,(SELECT phase FROM plant WHERE id=${PLANT}) AS phase`)
	).rows[0];
const livePeople = async () =>
	Number(
		(await admin.execute(sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${PLANT} AND state='live'`)).rows[0]!
			.n,
	);
const journal = async () =>
	(await reader.readJournal(db, await authorityOf(db, "owner"))) as {
		status: string;
		value: { entries: { actor: { displayName: string } | null; change: Record<string, unknown> }[] };
	};
const doneCount = async () => (await planOf(db)).milestones.filter((m) => m.completion && !m.needsReview).length;
const notices = async () => {
	const n = async (who: "owner" | "admin") =>
		Number(
			(
				await admin.execute(sql`SELECT count(*)::int AS n FROM notice WHERE tenant_id=${PLANT}
					AND purpose='launch_milestone' AND recipient_id=${ACTOR_SPECS[who].account}::uuid`)
			).rows[0]!.n,
		);
	return { owner: await n("owner"), admin: await n("admin") };
};
const venueState = async () => {
	const m = await venueOf(db);
	return { by: m.completion?.by?.displayName ?? null, needsReview: m.needsReview };
};
const venueHistory = async () =>
	(await journal()).value.entries
		.filter((e) => e.change.kind === "milestone" && e.change.title === VENUE_TITLE)
		.map((e) => `${String(e.change.event)} by ${e.actor?.displayName}`)
		.reverse();
const venueNow = async (milestone: string, statuses: string[]) => {
	const m = await venueOf(db);
	return [
		{ id: m.id, label: VENUE_TITLE, value: milestone },
		...VENUE_TASKS.map((title, n) => ({
			id: m.tasks.find((t) => t.title === title)!.id,
			label: title,
			value: statuses[n],
		})),
	];
};

const outcomeNow = async () => {
	const p = await planOf(db);
	return {
		outcome: p.outcome && {
			actualDate: p.outcome.actualDate,
			attendance: p.outcome.attendance,
			decisions: p.outcome.decisions,
			note: p.outcome.note,
		},
		guests: (p.guests.named ?? []).map((g) => g.personId).sort(),
		submitted: p.debrief?.submitted?.answers ?? null,
		draft: p.debrief?.draft?.answers ?? null,
	};
};
const namedGuests = async () => ((await planOf(db)).guests.named ?? []).map((g) => g.displayName).sort();
const entriesOf = async (kind: "guest" | "outcome") =>
	(await journal()).value.entries.filter((e) => e.change.kind === kind);
const peopleNamed = async (name: string) =>
	(
		await admin.execute(sql`SELECT id,email,phone,street,city,birth_date FROM person WHERE plant_id=${PLANT}
			AND state='live' AND display_name=${name} ORDER BY created_at,id`)
	).rows;
async function refused(operation: string, input: unknown, refusal: string) {
	const owner = await actorOf("owner");
	const card = await propose(owner, operation, input);
	assert.ok(card, `${operation} ${JSON.stringify(input).slice(0, 80)}`);
	assert.equal(card.review.refusal, refusal, JSON.stringify(input).slice(0, 80));
	await assert.rejects(approveProposal(db, owner, card.id, { revision: card.revision, digest: card.digest }, null), {
		code: "review_closed",
	});
}
async function notRecordedRefusals() {
	const before = await outcomeNow();
	await refused(
		"launch.addGuestAttendance",
		{ displayName: "Sam Ortiz" },
		"Launch Sunday isn't recorded yet. Record it first, then name its guests.",
	);
	await refused(
		"launch.correctOutcome",
		{ attendance: 162, reason: "we miscounted the overflow room" },
		"Launch Sunday isn't recorded yet, so there's nothing to correct. Record it first.",
	);
	assert.deepEqual(await outcomeNow(), before, "nothing changed");
}
async function guestRefusals() {
	const before = await outcomeNow();
	const people = await livePeople();
	await refused("launch.addGuestAttendance", { displayName: "" }, "Type the guest's name. A first name is enough.");
	await refused("launch.addGuestAttendance", { displayName: "   " }, "Type the guest's name. A first name is enough.");
	await refused(
		"launch.addGuestAttendance",
		{ displayName: "y".repeat(256) },
		"Keep the guest's name to 255 characters or fewer.",
	);
	const [sam] = await peopleNamed("Sam Ortiz");
	await refused(
		"launch.addGuestAttendance",
		{ personId: sam!.id },
		"Sam Ortiz is already named as a Launch Sunday guest.",
	);
	assert.equal(await propose(await actorOf("owner"), "launch.addGuestAttendance", { personId: randomUUID() }), null);
	assert.deepEqual([await outcomeNow(), await livePeople()], [before, people], "nothing changed");
}
async function correctionRefusals() {
	const before = await outcomeNow();
	const people = await livePeople();
	const r = "we recounted";
	await refused(
		"launch.correctOutcome",
		{ attendance: 170, reason: "" },
		"A reason is needed. Tell Evry why, and it stays in the Launch history.",
	);
	await refused(
		"launch.correctOutcome",
		{ attendance: 170, reason: "z".repeat(NOTE_MAX + 1) },
		"Keep the reason to 2,000 characters or fewer.",
	);
	await refused(
		"launch.correctOutcome",
		{ actualDate: day(3), reason: r },
		"Launch Sunday can't be recorded for a date after today.",
	);
	await refused(
		"launch.correctOutcome",
		{ attendance: 1_000_001, reason: r },
		"Counts are whole numbers from 0 to 1,000,000.",
	);
	await refused("launch.correctOutcome", { decisions: -1, reason: r }, "Counts are whole numbers from 0 to 1,000,000.");
	await refused(
		"launch.correctOutcome",
		{ attendance: 162, reason: r },
		"Launch Sunday already has attendance 162, so there's nothing to correct.",
	);
	await refused(
		"launch.correctOutcome",
		{ reason: r },
		"Say what to correct: the date it was held, attendance or decisions.",
	);
	assert.deepEqual([await outcomeNow(), await livePeople()], [before, people], "nothing changed");
}

async function propose(who: EvryActor, operation: string, input: unknown) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	const proposal = await prepareProposal(db, who, lease, c.id, { operation, input });
	await transaction(db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	return proposal;
}

async function refusals() {
	const owner = await actorOf("owner");
	const before = (await planOf(db)).launch;
	for (const [operation, input, refusal] of [
		["launch.schedule", { date: day(40), reason: null }, "A reason is needed."],
		["launch.schedule", { date: day(40), reason: "   " }, "A reason is needed."],
		[
			"launch.schedule",
			{ date: day(40), reason: "x".repeat(NOTE_MAX + 1) },
			"Keep the reason to 2,000 characters or fewer.",
		],
		["launch.postpone", { reason: "" }, "A reason is needed."],
		["launch.postpone", { reason: "y".repeat(NOTE_MAX + 1) }, "Keep the reason to 2,000 characters or fewer."],
	] as const) {
		const card = (await propose(owner, operation, input))!;
		assert.ok(card, operation);
		assert.ok(card.review.refusal?.startsWith(refusal), `${operation}: ${card.review.refusal}`);
		await assert.rejects(approveProposal(db, owner, card.id, { revision: card.revision, digest: card.digest }, null), {
			code: "review_closed",
		});
	}
	for (const input of [
		{ date: day(40), reason: null },
		{ date: day(40), reason: "z".repeat(NOTE_MAX + 1) },
	])
		assert.equal(
			(
				await writer.schedule(db, owner.authority, {
					requestKey: randomUUID(),
					expectedRevision: before!.revision,
					input,
				})
			).status,
			"refused",
		);
	assert.deepEqual((await planOf(db)).launch, before, "nothing changed");
}

const SETTLED: Record<
	string,
	{
		before?: (p?: Proposal) => Promise<void>;
		after?: (p?: Proposal) => Promise<void>;
		each?: (n: number, p: Proposal) => Promise<void>;
	}
> = {
	"LAU-02": {
		after: async () => {
			const plan = await planOf(db);
			assert.deepEqual(countdown(plan.launch, plan.today), { kind: "ahead", days: 28, window: true });
			await refusals();
		},
	},
	"LAU-04": {
		after: async () => assert.equal(await doneCount(), COMPLETED.length),
	},
	"LAU-09": {
		before: async (p) => {
			assert.equal((await planOf(db)).launch?.targetDate, day(28));
			await assert.rejects(
				approveProposal(db, await actorOf("member"), p!.id, { revision: p!.revision, digest: p!.digest }, null),
				{ code: "not_found" },
			);
			assert.equal((await readReview(db, await actorOf("owner"), p!.id)).status, "pending");
			kept.untouched = await untouched();
		},
		after: async () => {
			assert.equal((await planOf(db)).launch?.targetDate, DATES.mar14);
			const move = (await journal()).value.entries.find((e) => e.change.to === DATES.mar14);
			assert.deepEqual(
				[move?.actor?.displayName, move?.change],
				["Nate Ellis", { kind: "date", event: "moved", from: day(28), to: DATES.mar14, reason: "venue fell through" }],
			);
			assert.deepEqual(await untouched(), kept.untouched, "prep tasks and the phase are unchanged");
		},
	},
	"LAU-10": {
		after: async () => {
			assert.equal((await planOf(db)).launch?.targetDate, DATES.mar21);
			const move = (await journal()).value.entries.find((e) => e.change.to === DATES.mar21);
			assert.deepEqual([move?.actor?.displayName, move?.change.from], ["Lena Park", DATES.mar14]);
		},
	},
	"LAU-11": {
		before: async () => {
			const plan = await planOf(db);
			assert.equal(
				(
					await writer.schedule(db, await authorityOf(db, "owner"), {
						requestKey: randomUUID(),
						expectedRevision: plan.launch!.revision,
						input: { date: DATES.apr18!, reason: "Moved on the Launch plan." },
					})
				).status,
				"ok",
			);
		},
		after: async (p) => {
			const card = await readReview(db, await actorOf("owner"), p!.id);
			assert.deepEqual(
				[card.receipt?.code, card.receipt?.current],
				["revision_conflict", [{ id: PLANT, label: "Launch Sunday", value: said(DATES.apr18!) }]],
			);
			assert.equal((await planOf(db)).launch?.targetDate, DATES.apr18, "the card changed nothing");
		},
	},
	"LAU-12": {
		after: async () => {
			const plan = await planOf(db);
			assert.deepEqual([plan.launch?.status, countdown(plan.launch, plan.today).kind], ["postponed", "postponed"]);
		},
	},
	"LAU-15": {
		before: async () => {
			kept.people = await livePeople();
		},
		after: async () => {
			const plan = await planOf(db);
			assert.deepEqual([plan.outcome?.actualDate, plan.outcome?.attendance], [day(-2), 150]);
			assert.deepEqual(
				[plan.debrief?.draft?.answers.missingNames, plan.debrief?.draft?.answers.missingCount],
				["yes", 12],
			);
			assert.equal(await livePeople(), kept.people, "no people are created from the numbers");
		},
	},
	"LAU-18": {
		after: async () => {
			const plan = await planOf(db);
			assert.deepEqual(
				[plan.debrief?.submitted?.version, plan.debrief?.submitted?.answers.missingCount, plan.summary?.published],
				[1, 12, []],
			);
		},
	},
	"LAU-21": {
		before: async (p) => {
			assert.deepEqual(await venueState(), { by: null, needsReview: false });
			await assert.rejects(
				approveProposal(db, await actorOf("member"), p!.id, { revision: p!.revision, digest: p!.digest }, null),
				{ code: "not_found" },
			);
			assert.equal((await readReview(db, await actorOf("owner"), p!.id)).status, "pending");
			kept.untouched = await untouched();
			kept.notices = await notices();
		},
		after: async () => {
			assert.deepEqual(await venueState(), { by: "Nate Ellis", needsReview: false });
			assert.deepEqual(await untouched(), kept.untouched, "prep tasks are unchanged");
			assert.deepEqual((await venueHistory()).slice(-1), ["completed by Nate Ellis"]);
			const n = kept.notices!;
			assert.deepEqual(await notices(), { owner: n.owner, admin: n.admin + 1 });
		},
	},
	"LAU-22": {
		after: async () => {
			const card = (await propose(await actorOf("owner"), "launch.completeMilestone", {
				milestoneId: (await venueOf(db)).id,
			}))!;
			assert.equal(card.review.refusal, "This milestone is already complete.");
			await assert.rejects(
				approveProposal(db, await actorOf("owner"), card.id, { revision: card.revision, digest: card.digest }, null),
				{ code: "review_closed" },
			);
			assert.deepEqual(await notices(), { owner: kept.notices!.owner, admin: kept.notices!.admin + 1 });
		},
	},
	"LAU-23": {
		before: async () => {
			kept.untouched = await untouched();
			kept.notices = await notices();
		},
		after: async () => {
			assert.deepEqual(await venueState(), { by: null, needsReview: false });
			assert.deepEqual((await venueHistory()).slice(-2), ["completed by Nate Ellis", "reopened by Nate Ellis"]);
			assert.deepEqual(await untouched(), kept.untouched, "prep tasks are unchanged");
			assert.deepEqual(await notices(), kept.notices);
		},
	},
	"LAU-25": {
		before: async () => {
			kept.notices = await notices();
			await setVenueTask(db, "admin", 2, "complete");
		},
		after: async (p) => {
			const card = await readReview(db, await actorOf("owner"), p!.id);
			assert.deepEqual(
				[card.receipt?.code, card.receipt?.current],
				["stale_review", await venueNow("Not complete", ["Complete", "Complete", "Complete", "Not started"])],
			);
			assert.deepEqual(await venueState(), { by: null, needsReview: false }, "the card saved nothing");
			assert.deepEqual(await notices(), kept.notices, "and told no one");
		},
	},
	"LAU-26": {
		after: async () => {
			assert.deepEqual(await venueState(), { by: "Nate Ellis", needsReview: false });
			assert.deepEqual(await notices(), { owner: kept.notices!.owner, admin: kept.notices!.admin + 1 });
		},
	},
	"LAU-27": {
		before: async () => setVenue(db, "owner", "reopen"),
		after: async (p) => {
			const card = await readReview(db, await actorOf("owner"), p!.id);
			assert.deepEqual(
				[card.receipt?.code, card.receipt?.current],
				["revision_conflict", await venueNow("Not complete", ["Complete", "Complete", "Complete", "Not started"])],
			);
			assert.deepEqual(await venueState(), { by: null, needsReview: false }, "the card changed nothing");
		},
	},
	"LAU-28": {
		before: async (p) => {
			const m = await venueOf(db);
			assert.deepEqual(await venueState(), { by: "Lena Park", needsReview: true });
			const on = new Intl.DateTimeFormat("en-US", {
				timeZone: "America/Chicago",
				month: "short",
				day: "numeric",
				year: "numeric",
			}).format(new Date(m.completion!.at));
			assert.ok(
				p!.review.notes?.includes(
					`This confirms the earlier completion by Lena Park on ${on}. A prep task that was complete then has been reopened since.`,
				),
				JSON.stringify(p!.review.notes),
			);
		},
		after: async () => assert.deepEqual(await venueState(), { by: "Nate Ellis", needsReview: false }),
	},
	"LAU-29": {
		after: async () => {
			assert.deepEqual(await venueState(), { by: null, needsReview: false });
			assert.deepEqual((await venueHistory()).slice(-1), ["reopened by Lena Park"]);
		},
	},
	"LAU-30": {
		before: async () => {
			kept.notices = await notices();
		},
		after: async () => {
			assert.deepEqual(await venueState(), { by: "Lena Park", needsReview: false });
			assert.deepEqual(await notices(), { owner: kept.notices!.owner + 1, admin: kept.notices!.admin });
		},
	},
	"LAU-38": { after: notRecordedRefusals },
	"LAU-39": {
		before: async (p) => {
			await assert.rejects(
				approveProposal(db, await actorOf("member"), p!.id, { revision: p!.revision, digest: p!.digest }, null),
				{ code: "not_found" },
			);
			assert.equal((await readReview(db, await actorOf("owner"), p!.id)).status, "pending");
			assert.deepEqual(await peopleNamed("Sam Ortiz"), []);
			kept.people = await livePeople();
			kept.outcome = await outcomeNow();
			kept.guests = await namedGuests();
		},
		after: async () => {
			assert.deepEqual(await namedGuests(), [...kept.guests!, "Sam Ortiz"].sort());
			assert.equal(await livePeople(), kept.people! + 1, "one new Person");
			const [sam, ...more] = await peopleNamed("Sam Ortiz");
			assert.deepEqual(
				[sam, more],
				[{ id: sam!.id, email: null, phone: null, street: null, city: null, birth_date: null }, []],
			);
			const entry = (await entriesOf("guest")).find((e) => e.change.name === "Sam Ortiz");
			assert.deepEqual(
				[entry?.actor?.displayName, entry?.change],
				["Nate Ellis", { kind: "guest", name: "Sam Ortiz", added: true }],
			);
			const { guests: _g, ...now } = await outcomeNow();
			const { guests: _k, ...was } = kept.outcome as Awaited<ReturnType<typeof outcomeNow>>;
			assert.deepEqual(now, was, "attendance, decisions and the debrief's guest answer are unchanged");
		},
	},
	"LAU-41": {
		before: async () => {
			kept.people = await livePeople();
		},
		after: async () => {
			const [maria] = await peopleNamed(MATCH.name);
			assert.ok((await outcomeNow()).guests.includes(String(maria!.id)), "the existing Maria Lopez is a guest");
			assert.equal(await livePeople(), kept.people, "no Person is created");
			assert.deepEqual(
				(await entriesOf("guest")).filter((e) => e.change.name === MATCH.name).map((e) => e.change),
				[{ kind: "guest", name: MATCH.name, added: false }],
			);
		},
	},
	"LAU-44": {
		before: async () => {
			kept.people = await livePeople();
		},
		after: async () => {
			assert.equal(await livePeople(), kept.people! + 1, "a new Person, never a merge");
			const marias = await peopleNamed(MATCH.name);
			assert.deepEqual(
				marias.map((m) => m.email),
				[MATCH.email, null],
			);
			const guests = (await outcomeNow()).guests;
			assert.ok(marias.every((m) => guests.includes(String(m.id))));
		},
	},
	"LAU-45": {
		before: async () => {
			kept.guests = await namedGuests();
		},
		each: async (n) =>
			assert.deepEqual(await namedGuests(), [...kept.guests!, ...["Jo Kim", "Lee Park"].slice(0, n + 1)].sort()),
	},
	"LAU-47": { after: guestRefusals },
	"LAU-49": {
		after: async () => {
			const entry = (await entriesOf("guest")).find((e) => e.change.name === "Ivy Chen");
			assert.equal(entry?.actor?.displayName, "Lena Park");
		},
	},
	"LAU-51": {
		before: async (p) => {
			await assert.rejects(
				approveProposal(db, await actorOf("member"), p!.id, { revision: p!.revision, digest: p!.digest }, null),
				{ code: "not_found" },
			);
			kept.outcome = await outcomeNow();
			kept.people = await livePeople();
			assert.deepEqual((kept.outcome as Awaited<ReturnType<typeof outcomeNow>>).outcome, {
				actualDate: day(-2),
				attendance: 150,
				decisions: 4,
				note: OUTCOME_NOTE,
			});
		},
		after: async () => {
			const was = kept.outcome as Awaited<ReturnType<typeof outcomeNow>>;
			assert.deepEqual(await outcomeNow(), { ...was, outcome: { ...was.outcome!, attendance: 162 } });
			const entry = (await entriesOf("outcome")).find((e) => e.change.reason === "we miscounted the overflow room");
			assert.deepEqual(
				[entry?.actor?.displayName, entry?.change],
				[
					"Nate Ellis",
					{
						kind: "outcome",
						event: "corrected",
						changes: [{ field: "attendance", before: 150, after: 162 }],
						reason: "we miscounted the overflow room",
					},
				],
			);
		},
	},
	"LAU-52": {
		after: async () => {
			const o = (await outcomeNow()).outcome!;
			assert.deepEqual([o.attendance, o.decisions, o.note], [162, null, OUTCOME_NOTE], "Not recorded, not 0");
		},
	},
	"LAU-53": {
		after: async () => assert.equal((await outcomeNow()).outcome?.actualDate, day(-3)),
	},
	"LAU-57": { after: correctionRefusals },
	"LAU-58": {
		before: async () => correctOnPlan(db, "owner", 158, "Recounted on the Launch plan."),
		after: async (p) => {
			const card = await readReview(db, await actorOf("owner"), p!.id);
			assert.deepEqual(
				[card.receipt?.code, card.receipt?.current?.map((x) => [x.label, x.value])],
				[
					"revision_conflict",
					[
						["Date held", said(day(-3))],
						["Attendance", "158"],
						["Decisions", "Not recorded"],
					],
				],
			);
			assert.equal((await outcomeNow()).outcome?.attendance, 158, "the card changed nothing");
		},
	},
	"LAU-60": {
		after: async () => {
			const entry = (await entriesOf("outcome")).find((e) => e.change.reason === "one more from the nursery");
			assert.equal(entry?.actor?.displayName, "Lena Park");
			assert.equal((await outcomeNow()).outcome?.attendance, 166);
			assert.equal(await livePeople(), kept.people);
		},
	},
	"LAU-19": {
		after: async (p) => {
			const shown = p!.review.changes.find((c) => c.field === "summary")?.after;
			assert.equal((await planOf(db)).summary?.published[0]?.body, shown);
		},
	},
};
const kept: {
	untouched?: unknown;
	people?: number;
	notices?: { owner: number; admin: number };
	outcome?: unknown;
	guests?: string[];
} = {};

async function unloadable(body: () => Promise<void>) {
	await admin.execute(sql`ALTER TABLE launch RENAME TO launch_unloadable`);
	try {
		await body();
	} finally {
		await admin.execute(sql`ALTER TABLE launch_unloadable RENAME TO launch`);
	}
}

test("INV-evry-launch: every Launch case passes on the scripted model, and each approved change reads back on the Launch plan", async () => {
	let previous: string | null = null;
	for (const raw of cases) {
		const c = filled(raw);
		if (c.setup === "scheduled") await seedScheduled(admin, db);
		if (c.setup === "launched") await seedLaunched(db);
		if (c.setup === "guests") await seedGuests(db);
		if (c.setup === "milestones") await seedMilestones(admin, db);
		if (c.setup === "needsReview") await seedNeedsReview(db);
		if (c.setup === "guestMatch") await seedGuestMatch(db);
		if (c.setup === "outcomeNote") await seedOutcomeNote(db);
		const actor = await actorOf(c.actor);
		const conversation = c.continue
			? previous!
			: (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		previous = conversation;
		let turn!: Awaited<ReturnType<typeof ask>>;
		const run = async () => {
			turn = await ask(actor, conversation, c.ask);
		};
		await (c.setup === "unloadable" ? unloadable(run) : run());
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		for (const text of c.absent ?? [])
			assert.ok(!turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} leaves out ${text}`);
		const cards = c.proposals ?? (c.proposal ? [c.proposal] : []);
		if (!cards.length) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review`);
			await SETTLED[c.id]?.after?.();
			continue;
		}
		assert.equal(turn.proposals.length, cards.length, `${c.id} prepares ${cards.length}: ${turn.answer}`);
		for (const [n, expected] of cards.entries()) {
			const proposal = turn.proposals[n]!;
			assert.equal(proposal.operation, expected.operation, c.id);
			assert.equal(proposal.status, "pending", `${c.id}: nothing runs before approval`);
			assert.equal(proposal.review.target?.label, expected.target, `${c.id} target`);
			assert.equal(proposal.review.refusal, undefined, `${c.id} refusal`);
			if (expected.changes) assert.deepEqual(proposal.review.changes, expected.changes, `${c.id} changes`);
			for (const line of expected.notes ?? [])
				assert.ok(
					proposal.review.notes?.some((x) => x.includes(line)),
					`${c.id} notes ${JSON.stringify(proposal.review.notes)} have ${line}`,
				);
		}
		await SETTLED[c.id]?.before?.(turn.proposals[0]);
		if (!c.approve) continue;
		for (const [n, proposal] of turn.proposals.entries()) {
			assert.equal(await approveAndRun(actor, proposal), c.outcome, c.id);
			const done = await readReview(db, actor, proposal.id);
			assert.equal(done.outcome, c.outcome, `${c.id} outcome ${JSON.stringify(done.receipt)}`);
			await SETTLED[c.id]?.each?.(n, proposal);
		}
		await SETTLED[c.id]?.after?.(turn.proposals[0]);
	}
});

test("INV-evry-launch-tools: only an Owner or Admin may propose a Launch change, and only an approved card completes a milestone", async () => {
	const tools = async (who: LaunchName) =>
		modelTools(await actorOf(who), { read: async () => ({}), select: async () => ({}), propose: async () => ({}) });
	const member = await tools("member");
	assert.ok(member.launch_read, "a Member reads the Launch plan");
	assert.ok(
		!JSON.stringify(member.propose_change?.description ?? "").includes("launch."),
		"a Member proposes no Launch change",
	);
	assert.ok(
		!JSON.stringify(member.launch_read!.description).includes("launch.readJournal"),
		"history is an Owner's or Admin's",
	);
	for (const who of ["owner", "admin", "member"] as const) {
		const all = await tools(who);
		const text = JSON.stringify(Object.values(all).map((t) => t.description));
		for (const op of ["launch.ensureReadiness", "pipeline.readGoals"])
			assert.ok(!text.includes(op), `${who} has no ${op}`);
		const proposes = JSON.stringify(all.propose_change?.description ?? "");
		for (const op of [
			"launch.completeMilestone",
			"launch.reopenMilestone",
			"launch.addGuestAttendance",
			"launch.correctOutcome",
		])
			assert.equal(proposes.includes(op), who !== "member", `${who} ${op}`);
		assert.match(
			JSON.stringify(all.launch_read!.description),
			/Guests are named, and the recorded outcome is corrected, only by a person: on a review card they approve \(launch.addGuestAttendance, launch.correctOutcome\) or on the Launch plan/,
		);
		if (who !== "member") {
			assert.match(proposes, /It creates no person from any number/);
			assert.match(proposes, /A typed name never links to or merges with an existing Person/);
		}
		assert.match(
			JSON.stringify(all.launch_read!.description),
			/This read never completes a milestone: only a person does, on a review card they approve \(launch.completeMilestone\) or on the Launch plan/,
		);
		assert.ok(
			!JSON.stringify(all.launch_read!.description).includes(
				"only a person marks a milestone complete, on the Launch plan",
			),
		);
	}
	assert.ok(LAUNCH_RULES.ownerOnly.startsWith("Only an Owner or Admin can change the Launch plan"));
	assert.equal(LINKED_TASK, "Send the press release to local media");
});
