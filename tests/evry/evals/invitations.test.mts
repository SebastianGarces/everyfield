import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readCatalog,
	readConversation,
	readReview,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type MailPort,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { testDatabase, type Database } from "../../support/test-database.mts";
import { nativePorts } from "./settings-ports.mts";
import { seedHope } from "./golden-church.mts";
import {
	backdateLastMonth,
	seatMember,
	seedInvitations,
	seedOverview,
	seedSetup,
	sinceLastMonth,
	SETUP_SPECS,
	type SetupName,
} from "./setup-church.mts";

const TODAY = new Date("2026-10-13T15:00:00Z");
const ACTORS = { owner: "setupOwner", member: "teamLead" } as const satisfies Record<string, SetupName>;
type Expected = {
	operation: string;
	target: string | null;
	meeting?: { title: string; when: string; venue: string | null; isNew: boolean };
	guests?: string[];
	recipients?: string[];
	leftOut?: [string, string][];
	notes?: string[] | null;
};
type Case = {
	id: string;
	golden?: string;
	actor: keyof typeof ACTORS;
	continues?: true;
	ask: string;
	expected_answer?: string;
	must_not?: string;
	calls: string[];
	steps?: string[];
	answer: string[];
	forbid?: string[];
	proposal?: Expected;
	approve?: true;
};
const regex = (r: string) => {
	const [, body, flags] = /^\/(.*)\/([a-z]*)$/s.exec(r)!;
	return new RegExp(body!, flags);
};
const golden = new Map(
	(
		JSON.parse(readFileSync(new URL("./golden.cases.json", import.meta.url), "utf8")) as {
			case_id: string;
			question: string;
			expected_answer: string;
			must_not: string;
		}[]
	).map((g) => [g.case_id, g]),
);
const cases = (
	JSON.parse(readFileSync(new URL("./invitations.cases.json", import.meta.url), "utf8")) as { cases: Case[] }
).cases;

const sent: { to: string[]; subject: string; text: string[] }[] = [];
const mail: MailPort = {
	keys: {
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: Buffer.alloc(32, 9),
		from: "church@example.test",
		origin: "https://app.example.test",
	},
	transport: {
		async send(batch) {
			sent.push({
				to: batch.messages.map((m) => m.to),
				subject: batch.messages[0]!.subject,
				text: batch.messages.map((m) => m.text),
			});
			return { outcome: "ids", ids: batch.messages.map(() => `re_${randomUUID()}`) };
		},
		async cancel(ids) {
			return ids.map(() => ({ outcome: "done" as const }));
		},
		async reschedule(ids) {
			return ids.map(() => ({ outcome: "done" as const }));
		},
	},
};

let close: () => Promise<void>;
let db: Database;
let admin: Database;
let plant: string;
let people: Record<string, string>;
const native: NativePorts = nativePorts();
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const shift = TODAY.getTime() - Date.now();
const now = () => new Date(Date.now() + shift);
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: keyof typeof ACTORS) => (await freshActor(SETUP_SPECS[ACTORS[who]].session))!;
const rows = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows as Record<string, unknown>[];
const ports = {
	reminders: async () => undefined,
	phaseNotices: async () => {
		throw Error("unexpected phase notice");
	},
};

async function ask(actor: EvryActor, text: string, conversation?: string) {
	const conversationId = conversation ?? (await createConversation(db, actor, { requestKey: randomUUID() })).id;
	await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native, mail, now },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const read = await readConversation(db, actor, conversationId);
	const turn = read.events.slice(read.events.findLastIndex((e) => e.kind === "user_message") + 1);
	const results = turn.flatMap((e) => (e.kind === "tool_result" ? [e.body] : []));
	const reads = results.flatMap((b) =>
		typeof b.operation === "string" && b.operation !== "evry.prepareProposal" ? [b.operation] : [],
	);
	const answer = turn
		.flatMap((e) => (e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : []))
		.join("");
	const ids = results.flatMap((b) => {
		const id = (b.result as { proposalId?: unknown } | undefined)?.proposalId;
		return typeof id === "string" ? [id] : [];
	});
	const steps = results.flatMap((b) =>
		b.operation === "evry.readWorkflowHint" ? (b.result as { rows: { id: string }[] }).rows.map((r) => r.id) : [],
	);
	const proposals = ids.map((id) => read.reviews[id]).filter((p): p is Proposal => Boolean(p));
	return { conversationId, reads, answer, proposals, steps };
}

async function approveAndRun(actor: EvryActor, proposal: Proposal) {
	await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const lease = {
		jobId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	const outcome = await executeProposal(db, lease, ports, mail, native);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

const after_ = (p: Proposal, field: string) => p.review.changes.find((c) => c.field === field)?.after;
const names = (value: unknown) => (value as { name: string }[]).map((v) => v.name);
const meetingOf = (title: string, date: string) =>
	rows(sql`SELECT id::text, revision::text FROM meeting WHERE plant_id=${plant} AND title IS NOT DISTINCT FROM ${title}
		AND local_date=${date}::date AND retired_at IS NULL`);
const guestsOf = (meeting: string) =>
	rows(sql`SELECT p.display_name AS name FROM participation g JOIN person p ON p.id=g.person_id
		WHERE g.meeting_id=${meeting} AND g.removed_at IS NULL ORDER BY lower(p.display_name) COLLATE "C"`).then((r) =>
		r.map((x) => x.name),
	);
const messages = () =>
	rows(sql`SELECT c.id::text, c.subject, c.state, c.meeting_id::text AS meeting FROM communication c
		WHERE c.plant_id=${plant} ORDER BY c.created_at, c.id`);
const handedOff = (message: string) =>
	rows(sql`SELECT p.display_name AS name FROM mail m JOIN person p ON p.id=m.recipient_person_id
		WHERE m.communication_id=${message} AND m.state IN ('accepted','sent') ORDER BY lower(p.display_name) COLLATE "C"`).then(
		(r) => r.map((x) => x.name),
	);
const effects = async () => ({
	meetings: Number((await rows(sql`SELECT count(*)::int AS n FROM meeting WHERE plant_id=${plant}`))[0]!.n),
	guests: Number(
		(await rows(sql`SELECT count(*)::int AS n FROM participation WHERE removed_at IS NULL AND plant_id=${plant}`))[0]!
			.n,
	),
	messages: (await messages()).length,
	provider: sent.length,
});
const proposalBytes = (id: string) =>
	rows(sql`SELECT state, outcome, approved_at::text, receipt::text, input::text, digest FROM proposal WHERE id=${id}`);
const messageBytes = (id: string) =>
	rows(sql`SELECT c.state, c.revision::text, c.subject, c.body_html, c.audience::text, c.updated_at::text,
		(SELECT jsonb_agg(m.state ORDER BY m.id) FROM mail m WHERE m.logical_key LIKE 'communication/'||c.id||'/%')::text AS mail
		FROM communication c WHERE c.id=${id}`);

let lastMonth: { proposal: string; message: string };

before(async () => {
	const database = await testDatabase({ prefix: "evryinv", max: 10, clock: TODAY });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(admin, { seatNames: true });
	plant = (await seedSetup(admin, db, native, { team: false })).plant;
	const overview = await seedOverview(admin, db, native, plant);
	await seatMember(admin, plant);
	const seeded = await seedInvitations(admin, db, plant, overview.people);
	people = { ...overview.people, ...seeded.people };
	const owner = await actorOf("owner");
	const setup = await ask(owner, "invite the core group to the next vision meeting");
	assert.equal(setup.proposals.length, 1, setup.answer);
	assert.equal(await approveAndRun(owner, setup.proposals[0]!), "completed");
	await backdateLastMonth(admin, plant);
	await sinceLastMonth(admin, db, plant, people);
	const [message] = await messages();
	lastMonth = { proposal: setup.proposals[0]!.id, message: String(message!.id) };
	assert.deepEqual(
		sent
			.splice(0)
			.flatMap((s) => s.to)
			.sort(),
		["grace.holt@example.test", "marcus.webb@example.test", "tom.reyes@example.test"],
	);
});
after(() => close?.());

const CHECKS: Record<
	string,
	{ before?: () => Promise<unknown>; after?: (p: Proposal, seen: unknown) => Promise<void> }
> = {
	"INV-01": {
		before: async () => {
			const [m] = await meetingOf("Vision night", "2026-10-15");
			assert.deepEqual(await guestsOf(String(m!.id)), [], "no guest is added before approval");
			return { meeting: String(m!.id) };
		},
		after: async (p, seen) => {
			const s = seen as { meeting: string };
			assert.deepEqual(await guestsOf(s.meeting), ["Luis Garcia", "Maria Garcia", "Sofia Garcia"]);
			const message = (await messages()).at(-1)!;
			assert.deepEqual([message.meeting, message.subject], [s.meeting, "You're invited: Vision night"]);
			assert.deepEqual(await handedOff(String(message.id)), ["Luis Garcia", "Maria Garcia"]);
			assert.deepEqual(sent.flatMap((x) => x.to).sort(), ["luis.garcia@example.test", "maria.garcia@example.test"]);
			const card = await readReview(db, await actorOf("owner"), p.id);
			assert.equal(card.receipt?.meetingId, s.meeting);
			assert.deepEqual(
				[card.receipt?.report?.confirmation, card.receipt?.report?.accepted, card.receipt?.report?.leftOut],
				["confirmed", 2, 1],
			);
		},
	},
	"INV-03": {
		before: async () => {
			assert.deepEqual(await rows(sql`SELECT id FROM meeting WHERE plant_id=${plant} AND local_date='2026-10-20'`), []);
		},
		after: async (p) => {
			const [m] = await rows(
				sql`SELECT m.id::text, m.venue_name, to_char(m.local_time,'HH24:MI') AS at FROM meeting m WHERE m.plant_id=${plant} AND m.local_date='2026-10-20'`,
			);
			assert.deepEqual([m!.venue_name, m!.at], ["Northside Library", "18:30"]);
			assert.deepEqual(await guestsOf(String(m!.id)), ["Grace Holt", "Marcus Webb", "Nina Patel", "Tom Reyes"]);
			const to = sent.flatMap((x) => x.to).sort();
			assert.deepEqual(to, ["grace.holt@example.test", "marcus.webb@example.test", "nina.patel@example.test"]);
			assert.ok(!to.includes("tom.reyes@example.test"), "the unsubscribed member receives nothing");
			assert.equal((await readReview(db, await actorOf("owner"), p.id)).receipt?.meetingId, m!.id);
		},
	},
	"INV-04": {
		before: async () => ({
			proposal: await proposalBytes(lastMonth.proposal),
			message: await messageBytes(lastMonth.message),
		}),
		after: async (p, seen) => {
			const s = seen as { proposal: unknown; message: unknown };
			assert.notEqual(p.id, lastMonth.proposal);
			assert.deepEqual(await proposalBytes(lastMonth.proposal), s.proposal, "last month's receipt is unchanged");
			assert.deepEqual(await messageBytes(lastMonth.message), s.message, "last month's message is unchanged");
			assert.deepEqual(sent.flatMap((x) => x.to).sort(), [
				"grace.holt@example.test",
				"marcus.webb@example.test",
				"nina.patel@example.test",
			]);
		},
	},
};

test("AC:PREP-04 AC:INH-MEETINGS-08 INV-evry-recipes: every multi-step request passes on the scripted model with one review, no effect before approval and a fresh approval on reuse", async () => {
	let conversation: string | undefined;
	for (const c of cases) {
		if (c.golden) {
			const g = golden.get(c.golden)!;
			assert.deepEqual([c.ask, c.expected_answer, c.must_not], [g.question, g.expected_answer, g.must_not], c.id);
		}
		const actor = await actorOf(c.actor);
		const start = await effects();
		const turn = await ask(actor, c.ask, c.continues ? conversation : undefined);
		conversation = turn.conversationId;
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
		for (const text of c.answer)
			assert.ok(
				turn.answer.includes(text),
				`${c.id} answer ${JSON.stringify(turn.answer)} has ${JSON.stringify(text)}`,
			);
		for (const f of c.forbid ?? []) assert.doesNotMatch(turn.answer, regex(f), `${c.id} must not match ${f}`);
		if (c.steps) {
			assert.deepEqual(turn.steps, c.steps, `${c.id} steps`);
			const allowed = new Set(readCatalog(actor).reviewedWrites.map((w) => w.operation));
			assert.ok(
				turn.steps.every((s) => allowed.has(s)),
				`${c.id}: every step is in the asker's catalog`,
			);
		}
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review: ${turn.answer}`);
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id} prepares one review: ${turn.answer}`);
		const [p] = turn.proposals as [Proposal];
		const e = c.proposal;
		assert.equal(p.operation, e.operation, c.id);
		assert.deepEqual(
			[p.status, p.approvedAt, p.outcome],
			["pending", null, null],
			`${c.id}: nothing runs before approval`,
		);
		assert.equal(p.review.target?.label ?? null, e.target, `${c.id} target`);
		assert.equal(p.review.refusal, undefined, `${c.id} refusal`);
		if (e.meeting) {
			assert.deepEqual(after_(p, "meeting"), e.meeting, `${c.id} meeting`);
			assert.deepEqual(names(after_(p, "guests")), e.guests, `${c.id} guests`);
			assert.deepEqual(names(after_(p, "recipients")), e.recipients, `${c.id} recipients`);
			assert.deepEqual(
				(after_(p, "leftOut") as { name: string; reason: string }[]).map((l) => [l.name, l.reason]),
				e.leftOut,
				`${c.id} left out`,
			);
			assert.deepEqual(p.review.notes ?? null, e.notes, `${c.id} notes`);
		}
		assert.deepEqual(
			await effects(),
			start,
			`${c.id}: no meeting, guest or message write and no provider call before approval`,
		);
		const seen = await CHECKS[c.id]?.before?.();
		if (!c.approve) continue;
		assert.equal(await approveAndRun(actor, p), "completed", `${c.id} runs once approved`);
		assert.equal((await readReview(db, actor, p.id)).outcome, "completed", `${c.id} card`);
		await CHECKS[c.id]?.after?.(p, seen);
		sent.splice(0);
	}
});

test("INV-evry-recipes: a reused invitation whose audience changed after its review is refused at approval, and nothing is sent", async () => {
	const owner = await actorOf("owner");
	const turn = await ask(owner, "do the same invite for this month's vision night");
	const [p] = turn.proposals as [Proposal];
	assert.equal(p.operation, "evry.reuseRecipe");
	await admin.execute(
		sql`INSERT INTO person_email_opt_out(plant_id,person_id) VALUES(${plant},${people["Grace Holt"]})`,
	);
	const before = await effects();
	assert.equal(await approveAndRun(owner, p), "refused");
	const card = await readReview(db, owner, p.id);
	assert.deepEqual([card.outcome, card.receipt?.code], ["refused", "stale_review"]);
	assert.deepEqual(await effects(), before, "nothing is added or sent");
});
