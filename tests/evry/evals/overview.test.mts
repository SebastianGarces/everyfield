// The Overview and feedback evals (T-330) on the scripted model. Each case in overview.cases.json is asked the way the
// app asks it: a real turn (runTurn) with the real catalog, reads and review cards, for Cedar Creek Church, the
// acceptance fixture church (setup-church.mts seedOverview), with the database clock pinned to Oct 13, 2026 in America/
// Chicago. Answers are checked against what Overview itself shows (its own reads and words) and, for MON-01 and CLN-10,
// against the golden case's approved question, expected answer and must-not. The feedback case is approved and its
// effect run through the WP-031 queue, then read back through Sent feedback's own read. No paid model, network or
// recording.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { SETUP_STEPS } from "../../../packages/contracts/src/dashboard/index.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { dashboardReader } from "../../../packages/domain/src/dashboard/index.ts";
import { feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readConversation,
	readReview,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { entryText, STEP_TEXT } from "../../../apps/web/src/features/overview/model.ts";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { testDatabase } from "../../support/test-database.mts";
import { nativePorts } from "./settings-ports.mts";
import { seedHope } from "./golden-church.mts";
import {
	crowdActivity,
	planVisionMeeting,
	seatMember,
	seedOverview,
	seedSetup,
	SETUP_SPECS,
	type SetupName,
} from "./setup-church.mts";

/** The acceptance fixture's today: Tuesday, Oct 13, 2026, 10 AM in America/Chicago. */
const TODAY = new Date("2026-10-13T15:00:00Z");
const ACTORS = { owner: "setupOwner", member: "teamLead" } as const satisfies Record<string, SetupName>;
type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	criterion: number | number[];
	golden?: string;
	actor: keyof typeof ACTORS;
	given?: keyof typeof GIVEN;
	ask: string;
	expected_answer?: string;
	must_not?: string;
	calls: string[];
	answer: string[];
	forbid?: string[];
	proposal?: { operation: string; target: string; changes: Change[]; notes: string[] };
	approve?: true;
	retry?: true;
};
/** Evry's feedback never asks for or starts a code change (PUB57-006): no review, answer or note offers one. */
const CODE_WORK = /\b(fix(es|ed)?|branch(es)?|pull requests?|PRs?|code|commits?|merge[sd]?|deploy(s|ed)?)\b/i;
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

let close: () => Promise<void>;
let db: Database;
let admin: Database;
let plant: string;
let fixture: Awaited<ReturnType<typeof seedOverview>>;
let cases: Case[];
const native: NativePorts = nativePorts();
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
/** The host clock in the database clock's frame, as the prompt states it (deps.now). */
const shift = TODAY.getTime() - Date.now();
const now = () => new Date(Date.now() + shift);
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: keyof typeof ACTORS) => (await freshActor(SETUP_SPECS[ACTORS[who]].session))!;
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
const rows = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows as Record<string, unknown>[];

/** The fixture changes a case names in `given`, applied once before it, in case order. */
const GIVEN = {
	// One read fails while the seat still holds: the runtime capability loses its grant on this schema's meeting kit
	// items, which only the Meetings list reads, so that read errors and every other read still answers.
	meetingsFail: {
		async apply() {
			await admin.execute(sql`REVOKE SELECT ON meeting_kit_item FROM everyfield_runtime`);
			return () => admin.execute(sql`GRANT SELECT ON meeting_kit_item TO everyfield_runtime`);
		},
	},
	visionMeetingPlanned: { apply: () => planVisionMeeting(admin, db, plant) },
	memberSeated: { apply: () => seatMember(admin, plant) },
	activityCrowded: { apply: () => crowdActivity(admin, db, plant) },
};

before(async () => {
	const database = await testDatabase({ prefix: "evryovw", max: 10, clock: TODAY });
	close = database.close;
	db = database.pools.runtime;
	admin = database.admin;
	await seedHope(admin, { seatNames: true });
	plant = (await seedSetup(admin, db, native, { team: false })).plant;
	fixture = await seedOverview(admin, db, native, plant);
	const meetings = Object.fromEntries(
		(await rows(sql`SELECT title, id::text FROM meeting WHERE plant_id=${plant}`)).map((m) => [m.title, m.id]),
	);
	cases = (
		JSON.parse(
			readFileSync(new URL("./overview.cases.json", import.meta.url), "utf8")
				.replace(/\{PERSON:([^}]+)\}/g, (_, name) => fixture.people[name]!)
				.replace(/\{MEETING:([^}]+)\}/g, (_, title) => String(meetings[title]))
				.replaceAll("{FEEDBACK:other}", fixture.otherFeedback),
		) as { cases: Case[] }
	).cases;
});
after(() => close?.());

/** One turn as the app runs it: submitted, claimed from the queue, run on the scripted model and finished. */
async function ask(actor: EvryActor, text: string) {
	const conversationId = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
	await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native, now },
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

/** The trusted approval of the exact revision shown, then the effect run once through the WP-031 queue. */
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

/** What `/overview` shows the actor now, from its own reads, in its own words (overview/model.ts). */
async function overview(who: keyof typeof ACTORS) {
	const authority = (await actorOf(who)).authority;
	const ok = <T,>(r: { status: string; value?: T }) => (r.status === "ok" ? r.value! : assert.fail("overview read"));
	const frame = ok(await dashboardReader.readAvailableActions(db, authority));
	const activity = ok(await dashboardReader.readActivity(db, authority));
	return { frame, added: activity.entries.filter((e) => e.change.kind === "person_added").map(entryText) };
}
/** Sent feedback (`/feedback`) for the Owner: its own native read. */
const sentFeedback = async () => {
	const r = await feedbackWriter.listOwn(db, (await actorOf("owner")).authority, {});
	return r.status === "ok" ? r.value.items : assert.fail("sent feedback read");
};
const ownerAccount = SETUP_SPECS.setupOwner.account;
const feedbackWrites = () =>
	rows(sql`SELECT (SELECT count(*)::int FROM feedback WHERE account_id=${ownerAccount}) AS feedback,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${ownerAccount} AND action='feedback.received') AS received,
		(SELECT coalesce(jsonb_agg(kind ORDER BY kind),'[]') FROM job WHERE tenant_id=${ownerAccount}) AS jobs`);

/** What each case shows or changes, read back as Overview and Sent feedback show it. */
const SETTLED: Record<string, { before?: () => Promise<void>; after?: (answer: string) => Promise<void> }> = {
	// Overview offers the Owner exactly these three first-week steps, in this order, with these links.
	"OVW-01": {
		after: async (answer) => {
			const { frame } = await overview("owner");
			assert.deepEqual(frame.setup.gaps, ["plan_vision_meeting", "invite_team", "set_launch_date"]);
			assert.equal(frame.firstWeek, true);
			for (const s of frame.setup.gaps)
				assert.ok(answer.includes(`- [${STEP_TEXT[s].title}](${STEP_TEXT[s].action.href})`), s);
		},
	},
	// The six "added to People" entries of Overview's activity in the last month, with the same dates.
	"OVW-03": {
		after: async (answer) => {
			const { added } = await overview("owner");
			const listed = [...answer.matchAll(/^- \[(.+?)(?: \(you\))?\]\((\/people\/[^)]+)\), added /gm)].map((m) => ({
				title: `${m[1]} added to People`,
				href: m[2],
			}));
			assert.equal(listed.length, 6);
			assert.deepEqual(listed, added.slice(0, 6));
		},
	},
	// Each open setup step as Overview words and links it; done steps are not listed.
	"OVW-04": {
		after: async (answer) => {
			const { frame } = await overview("owner");
			assert.deepEqual(frame.setup.gaps, ["invite_team", "set_launch_date"]);
			const lines = answer.split("\n").filter((l) => l.startsWith("- "));
			assert.deepEqual(
				lines,
				frame.setup.gaps.map((s) => `- [${STEP_TEXT[s].title}](${STEP_TEXT[s].action.href})`),
			);
			assert.ok(SETUP_STEPS.every((s) => frame.setup.gaps.includes(s) || !answer.includes(STEP_TEXT[s].title)));
		},
	},
	// A Member's Overview offers no action, and neither does Evry.
	"OVW-06": {
		after: async () => {
			const { frame } = await overview("member");
			assert.deepEqual([frame.role, frame.actions, frame.prompts], ["member", [], []]);
		},
	},
	"FDB-01": {
		// Nothing is saved and no publication job is queued before approval.
		before: async () => assert.deepEqual(await feedbackWrites(), [{ feedback: 0, received: 0, jobs: [] }]),
		after: async () => {
			// One feedback, one audit row and one publication job, and no other effect, even after a retried approval.
			assert.deepEqual(await feedbackWrites(), [{ feedback: 1, received: 1, jobs: ["feedback_publication"] }]);
			const items = await sentFeedback();
			assert.deepEqual(
				items.map((i) => [i.category, i.status, i.submittedAt.slice(0, 10)]),
				[["other", "new", "2026-10-13"]],
			);
			assert.deepEqual(
				await rows(
					sql`SELECT description, page_label, page_address, church_label, role_label FROM feedback WHERE account_id=${ownerAccount}`,
				),
				[
					{
						description: "The import screen is confusing",
						page_label: "Evry",
						page_address: null,
						church_label: "Cedar Creek Church",
						role_label: "Owner",
					},
				],
			);
		},
	},
	// Evry's list is Sent feedback's list: the Owner's one item, never Sam's.
	"FDB-02": {
		after: async (answer) => {
			const items = await sentFeedback();
			assert.equal(items.length, 1);
			assert.ok(!items.some((i) => i.id === fixture.otherFeedback));
			assert.equal((answer.match(/^- /gm) ?? []).length, items.length);
		},
	},
};

test("AC:MON-01 AC:CLN-10 AC:PUB57-006 INV-evry-overview: every Overview and feedback case passes on the scripted model and matches what Overview and Sent feedback show", async () => {
	for (const c of cases) {
		const applied: unknown = c.given ? await GIVEN[c.given].apply() : undefined;
		const undo = typeof applied === "function" ? (applied as () => Promise<unknown>) : undefined;
		try {
			if (c.golden) {
				// The golden case's approved question, word for word, scored against its expected answer and must-not.
				const g = golden.get(c.golden)!;
				assert.deepEqual([c.ask, c.expected_answer, c.must_not], [g.question, g.expected_answer, g.must_not], c.id);
			}
			const actor = await actorOf(c.actor);
			const turn = await ask(actor, c.ask);
			assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
			for (const text of c.answer)
				assert.ok(
					turn.answer.includes(text),
					`${c.id} answer ${JSON.stringify(turn.answer)} has ${JSON.stringify(text)}`,
				);
			for (const f of c.forbid ?? []) assert.doesNotMatch(turn.answer, regex(f), `${c.id} answer must not match ${f}`);
			if (!c.proposal) {
				assert.equal(turn.proposals.length, 0, `${c.id} prepares no review`);
				await SETTLED[c.id]?.after?.(turn.answer);
				continue;
			}
			assert.equal(turn.proposals.length, 1, `${c.id} prepares one review: ${turn.answer}`);
			const [proposal] = turn.proposals as [Proposal];
			assert.equal(proposal.operation, c.proposal.operation, c.id);
			assert.equal(proposal.status, "pending", `${c.id}: nothing runs before approval`);
			assert.equal(proposal.review.target?.label, c.proposal.target, `${c.id} target`);
			assert.deepEqual(proposal.review.changes, c.proposal.changes, `${c.id} changes`);
			assert.deepEqual(proposal.review.notes, c.proposal.notes, `${c.id} notes`);
			assert.doesNotMatch(JSON.stringify([proposal.review, turn.answer]), CODE_WORK, `${c.id} offers no code work`);
			await SETTLED[c.id]?.before?.();
			if (!c.approve) continue;
			assert.equal(await approveAndRun(actor, proposal), "completed", `${c.id} runs once approved`);
			if (c.retry) {
				// Approving the same card again (a double click or a retried request) queues no second effect.
				await approveProposal(
					db,
					actor,
					proposal.id,
					{ revision: proposal.revision, digest: proposal.digest },
					null,
				).catch(() => null);
				assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), [], `${c.id} runs only once`);
			}
			assert.equal((await readReview(db, actor, proposal.id)).outcome, "completed", `${c.id} card`);
			await SETTLED[c.id]?.after?.(turn.answer);
		} finally {
			await undo?.();
		}
	}
	// Every feedback answer and review is free of code work too.
	assert.ok(cases.filter((c) => c.id.startsWith("FDB")).every((c) => !c.answer.some((a) => CODE_WORK.test(a))));
});
