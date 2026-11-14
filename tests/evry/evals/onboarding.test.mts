// The setup and Discovery evals (T-345) on the scripted model. Each case in onboarding.cases.json is asked the way the
// app asks it: a real turn (runTurn) with the real catalog, reads and review cards, for the setup accounts seeded next
// to Hope Fellowship (setup-church.mts). A case with `approve` is then approved and its effect run through the WP-031
// queue with the same onboarding producer `/onboarding` uses; its check reads the result back through `/onboarding`'s
// own read (readOnboardingEntry) and Home's landing rule. No paid model, network or recording.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { landingFor } from "../../../packages/contracts/src/identity/navigation.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { readPlantSetupComplete } from "../../../packages/domain/src/identity/index.ts";
import { readOnboardingEntry } from "../../../packages/domain/src/onboarding/index.ts";
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
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../apps/web/src/server/jobs/queue.ts";
import { nativePorts } from "./settings-ports.mts";
import { evalDatabase, seedHope } from "./golden-church.mts";
import { seedSetup, SETUP_SPECS, type SetupName } from "./setup-church.mts";

type Change = { field: string; before: unknown; after: unknown };
type Case = {
	id: string;
	criterion: number;
	actor: SetupName;
	ask: string;
	calls: string[];
	answer?: string[];
	proposal?: { operation: string; target: string; changes?: Change[]; notes?: string[]; refusal?: string | null };
	approve?: true;
};
const { cases } = JSON.parse(readFileSync(new URL("./onboarding.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

let close: () => Promise<void>;
let db: Database;
/** Every email the native commands queued, in order. */
const mail: { to: string; purpose: string }[] = [];
const native: NativePorts = nativePorts(mail);
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
/** Each account's actor as it is now: creating a church moves an account from its own context into the church. */
const actorOf = async (who: SetupName) => (await freshActor(SETUP_SPECS[who].session))!;
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(async () => {
	const database = await evalDatabase({ prefix: "evryonb", max: 10 });
	close = database.close;
	db = database.pools.runtime;
	await seedHope(database.admin, { seatNames: true });
	await seedSetup(database.admin, db, native);
	mail.length = 0;
});
after(() => close?.());

/** One turn as the app runs it: submitted, claimed from the queue, run on the scripted model and finished. */
async function ask(actor: EvryActor, conversationId: string, text: string) {
	await submitTurn(db, actor, conversationId, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native },
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

// What `/onboarding` shows: its own entry read, for the account as it is now.
async function onboardingScreen(who: SetupName) {
	const actor = await actorOf(who);
	const session = {
		status: "active",
		accountId: actor.accountId,
		sessionId: actor.session,
		expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
	};
	return readOnboardingEntry(db, native.onboarding, session as never, actor.authority, true) as Promise<
		Record<string, any>
	>;
}
const resume = async (who: SetupName) => (await onboardingScreen(who)).resume;
/** Where Home sends the account: its church, or setup while the church's setup is unfinished. */
async function home(who: SetupName) {
	const actor = await actorOf(who);
	const plant =
		actor.owner.kind === "plant"
			? (await readPlantSetupComplete(db, actor.session as never, actor.owner as never))
				? "complete"
				: "incomplete"
			: "none";
	return landingFor({ status: "active", plant });
}
const rows = async (query: ReturnType<typeof sql>) => (await db.execute(query)).rows as Record<string, unknown>[];
const seatsOf = (who: SetupName) =>
	rows(
		sql`SELECT p.name, s.role FROM seat s JOIN plant p ON p.id=s.plant_id WHERE s.account_id=${SETUP_SPECS[who].account} AND s.ended_at IS NULL`,
	);

/** What each case shows or changes, read back as `/onboarding` and Home show it; `before` also runs before approval. */
const SETTLED: Record<string, { before?: () => Promise<void>; after?: () => Promise<void> }> = {
	"ONB-01": {
		after: async () => {
			const r = await resume("setupOwner");
			assert.deepEqual(
				[r.journey, r.launch, r.lead, r.completion],
				[{ status: "pending" }, { status: "pending" }, { answer: "pending" }, { status: "unfinished" }],
			);
		},
	},
	"ONB-02": {
		before: async () => assert.deepEqual((await resume("setupOwner")).journey, { status: "pending" }),
		after: async () => {
			const r = await resume("setupOwner");
			assert.deepEqual(
				[r.journey.value, r.launch.value, r.currentPhase],
				[{ answer: "discerning" }, { answer: "skip" }, 1],
			);
		},
	},
	"ONB-04": {
		after: async () => {
			const r = await resume("setupOwner");
			assert.deepEqual([r.journey.value, r.currentPhase], [{ answer: "existing", phase: 2 }, 2]);
		},
	},
	"ONB-08": {
		before: async () => assert.deepEqual((await resume("setupOwner")).lead, { answer: "pending" }),
		after: async () => {
			assert.equal((await resume("setupOwner")).lead.answer, "skip");
			assert.deepEqual(
				await rows(sql`SELECT r.name FROM team_role r JOIN plant p ON p.id=r.plant_id WHERE p.name='Riverside Church'`),
				[],
			);
		},
	},
	"ONB-09": {
		after: async () => {
			const lead = (await resume("setupOwner")).lead;
			assert.equal(lead.answer, "yes");
			assert.deepEqual(
				await rows(sql`SELECT t.name AS team, r.name AS role, pe.display_name AS person FROM team_role r JOIN team t ON t.id=r.team_id
					JOIN person pe ON pe.id=${lead.assignment.personId} WHERE r.id=${lead.assignment.roleId}`),
				[{ team: "Leadership", role: "Lead pastor", person: "Casey Rivera" }],
			);
		},
	},
	"ONB-11": {
		before: async () => assert.equal(await home("setupOwner"), "/onboarding"),
		after: async () => {
			assert.notEqual(await home("setupOwner"), "/onboarding");
			assert.equal((await resume("setupOwner")).completion.status, "completed");
		},
	},
	"ONB-12": {
		after: async () =>
			assert.deepEqual(
				await rows(
					sql`SELECT count(*)::int AS n FROM audit_event a JOIN plant p ON p.id=a.tenant_id WHERE p.name='Riverside Church' AND a.kind='complete'`,
				),
				[{ n: 1 }],
			),
	},
	"ONB-13": {
		before: async () => assert.deepEqual(await seatsOf("seatless"), []),
		after: async () => assert.deepEqual(await seatsOf("seatless"), [{ name: "Harvest Point", role: "owner" }]),
	},
	"ONB-15": {
		before: async () => assert.equal((await onboardingScreen("explorer")).kind, "start"),
		after: async () => {
			const screen = await onboardingScreen("explorer");
			assert.equal(screen.kind, "discovery");
			assert.deepEqual(mail.at(-1), { to: "explorer@example.test", purpose: "discovery_receipt" });
		},
	},
	"ONB-16": {
		after: async () => {
			const screen = await onboardingScreen("discovery");
			assert.equal(screen.kind, "discovery");
			assert.equal(screen.profile.relationships.length, 1);
		},
	},
	"ONB-19": {
		before: async () => assert.deepEqual(await seatsOf("discovery"), []),
		after: async () => {
			assert.deepEqual(await seatsOf("discovery"), [{ name: "Harvest Point", role: "owner" }]);
			assert.deepEqual(
				await rows(sql`SELECT o.name FROM affiliation a JOIN organization o ON o.id=a.organization_id JOIN seat s ON s.plant_id=a.plant_id
					WHERE s.account_id=${SETUP_SPECS.discovery.account} AND a.ended_at IS NULL`),
				[{ name: "Hill Country Network" }],
			);
		},
	},
	"ONB-20": { after: async () => assert.equal((await seatsOf("discovery")).length, 1) },
};

test("INV-evry-onboarding: every setup and Discovery case passes on the scripted model, and each approved change reads back on /onboarding", async () => {
	for (const c of cases) {
		// A fresh conversation per case, in the context the account holds now.
		const actor = await actorOf(c.actor);
		const conversation = (await createConversation(db, actor, { requestKey: randomUUID() })).id;
		await SETTLED[c.id]?.before?.();
		const turn = await ask(actor, conversation, c.ask);
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, `${c.id} prepares no review`);
			await SETTLED[c.id]?.after?.();
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id} prepares one review: ${turn.answer}`);
		const [proposal] = turn.proposals as [Proposal];
		const expected = c.proposal;
		assert.equal(proposal.operation, expected.operation, c.id);
		assert.equal(proposal.status, "pending", `${c.id}: nothing runs before approval`);
		assert.equal(proposal.review.target?.label, expected.target, `${c.id} target`);
		if (expected.changes) assert.deepEqual(proposal.review.changes, expected.changes, `${c.id} changes`);
		for (const line of expected.notes ?? [])
			assert.ok(
				proposal.review.notes?.some((n) => n.includes(line)),
				`${c.id} notes ${JSON.stringify(proposal.review.notes)} have ${line}`,
			);
		if (expected.refusal !== undefined)
			assert.equal(proposal.review.refusal ?? null, expected.refusal, `${c.id} refusal`);
		// Still nothing changed: the review is only a card.
		await SETTLED[c.id]?.before?.();
		if (!c.approve) continue;
		assert.equal(await approveAndRun(actor, proposal), "completed", `${c.id} runs once approved`);
		// The card still shows its outcome to the same account, even after the change gave it a church seat.
		assert.equal((await readReview(db, await actorOf(c.actor), proposal.id)).outcome, "completed", `${c.id} card`);
		await SETTLED[c.id]?.after?.();
	}
});
