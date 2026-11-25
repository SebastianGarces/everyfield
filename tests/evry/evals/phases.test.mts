import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { createFacts } from "../../../packages/domain/src/intelligence/facts.ts";
import { criteriaOf, readingOf } from "../../../packages/domain/src/intelligence/views.ts";
import { phaseReader, readCatalog, readReadiness } from "../../../packages/domain/src/phases/index.ts";
import {
	approveProposal,
	evryActor,
	executeProposal,
	readConversation,
	runTurn,
	submitTurn,
	createConversation,
	type EvryActor,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { scriptedQualifiedModel } from "../../../packages/evry-scripted/src/index.ts";
import { readCatalog as evryCatalog, READ_DOMAINS } from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter, SourceRow } from "../../../packages/evry/src/catalog/types.ts";
import { modelTools, proposalForModel } from "../../../packages/evry/src/runtime/tools.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { ACTOR_SPECS, goldenChurch, PLANT, type ActorName } from "./golden-church.mts";
import { reader } from "./launch-church.mts";
import { COMMITTED, seedAllMet, seedCommitted } from "./phases-church.mts";

type Open = { label: string; status: string; reading: string | null };
type Case = {
	id: string;
	operation: string;
	setup?: "allMet";
	actor: ActorName;
	ask: string;
	calls: string[];
	phase?: number;
	answer?: string[];
	absent?: string[];
	proposal?: { operation: string; openCriteria: Open[] };
	approve?: true;
};
const file = JSON.parse(readFileSync(new URL("./phases.cases.json", import.meta.url), "utf8")) as {
	forbid: string[];
	cases: Case[];
};
const pattern = (p: string) => {
	const m = /^\/(.*)\/([a-z]*)$/s.exec(p);
	return m ? new RegExp(m[1]!, m[2]) : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
};
const OPERATIONS = ["intelligence.readExitCriteria", "intelligence.readJourney"];
const adapter = (operation: string) =>
	Object.values(READ_DOMAINS)
		.flat()
		.find((a) => a.operation === operation) as ReadAdapter<unknown>;

let close: () => Promise<void>;
let db: Database;
let admin: Database;
const model = scriptedQualifiedModel();
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: ActorName) => (await freshActor(ACTOR_SPECS[who].session))!;
const read = (who: EvryActor, operation: string, input: unknown = {}) => invokeRead(db, who, adapter(operation), input);
const phase = async () => Number((await admin.execute(sql`SELECT phase FROM plant WHERE id=${PLANT}`)).rows[0]!.phase);

before(async () => {
	const church = await goldenChurch();
	close = church.close;
	db = church.db;
	admin = church.admin;
	await seedCommitted(admin);
});
after(() => close?.());

async function ask(actor: EvryActor, text: string) {
	const conversation = await createConversation(db, actor, { requestKey: randomUUID() });
	await submitTurn(db, actor, conversation.id, { requestKey: randomUUID(), text, references: [] });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim, "the turn is queued");
	const outcome = await runTurn(
		{ db, model, freshActor, native: null },
		{ turnId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ claimStart: new Date(), claimEnd: new Date() },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "succeeded", text);
	const conversationRead = await readConversation(db, actor, conversation.id);
	const turn = conversationRead.events.slice(
		conversationRead.events.findLastIndex((e) => e.kind === "user_message") + 1,
	);
	const results = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof e.body.operation === "string" && e.body.operation !== "evry.prepareProposal"
			? [{ operation: e.body.operation, result: e.body.result as { rows?: SourceRow[]; proposalId?: string } }]
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
	const proposals = ids.map((id) => conversationRead.reviews[id]).filter((p): p is Proposal => Boolean(p));
	return { results, answer, proposals };
}

async function approveAndRun(actor: EvryActor, proposal: Proposal) {
	await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{
			reminders: async () => undefined,
			phaseNotices: async () => undefined,
		},
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

async function screenCriteria(who: EvryActor, at: number) {
	const facts = await createFacts().readFacts(db, who.authority);
	assert.equal(facts.status, "ok");
	if (facts.status !== "ok") throw Error("unreachable");
	const catalog = await readCatalog();
	const journey = readReadiness(catalog, facts.value.criteria).find((r) => r.phase === at)!;
	return { assessed: criteriaOf(catalog, at, facts.value), journey, facts: facts.value };
}

test("INV-phases-fixture: Hope Fellowship counts 18 committed adults, in Core Group Development", async () => {
	const { facts } = await screenCriteria(await actorOf("owner"), 1);
	assert.deepEqual([facts.committedAdults.exact, facts.committedAdults.status], [COMMITTED, "not_met"]);
	assert.equal(await phase(), 1);
});

test("INV-phases-exit-criteria: intelligence.readExitCriteria gives each phase's criteria with the status and reading Plant Intelligence shows from the same facts", async () => {
	const owner = await actorOf("owner");
	for (let at = 0; at <= 6; at++) {
		const { assessed, journey } = await screenCriteria(owner, at);
		const rows = (await read(owner, "intelligence.readExitCriteria", { phase: at })).rows;
		const words = { met: "met", not_met: "not met", unknown: "no data yet", not_tracked: "not tracked" } as const;
		assert.deepEqual(
			rows.slice(1).map((r) => [r.id, r.label, r.fields.status, r.fields.reading]),
			assessed.map((x) => [x.key, x.label, words[x.status], readingOf(x)]),
			`phase ${at}`,
		);
		assert.deepEqual(
			rows.slice(1).map((r) => r.fields.status),
			journey.criteria.map((x) => words[x.status]),
			`phase ${at} matches the journey's signs`,
		);
		for (const r of rows.slice(1))
			if (r.fields.status === "no data yet" && r.id !== "committed_adults") assert.equal(r.fields.reading, null, r.id);
	}
	const current = (await read(owner, "intelligence.readExitCriteria")).rows;
	assert.deepEqual(current[0], {
		kind: "phase",
		id: "1",
		label: "Core Group Development",
		fields: { phase: "1", current: true, next: "Launch Team Formation" },
	});
	assert.equal(current.find((r) => r.id === "committed_adults")?.fields.reading, "18 of 30 committed adults");
});

test("INV-phases-authority: only an Owner or Admin of the church is offered the two reads; a Member and an organization seat get no tool and are refused", async () => {
	for (const who of ["owner", "admin"] as const) {
		const actor = await actorOf(who);
		const offered = evryCatalog(actor).domains.flatMap((d) => d.operations.map((o) => o.operation));
		assert.ok(
			OPERATIONS.every((o) => offered.includes(o)),
			who,
		);
	}
	for (const who of ["member", "org"] as const) {
		const actor = await actorOf(who);
		const offered = evryCatalog(actor).domains.flatMap((d) => d.operations.map((o) => o.operation));
		const tools = JSON.stringify(Object.keys(modelTools(actor, {} as never)));
		for (const operation of OPERATIONS) {
			assert.ok(!offered.includes(operation), `${who} is not offered ${operation}`);
			await assert.rejects(read(actor, operation), { code: "access_denied" }, `${who} ${operation}`);
		}
		assert.doesNotMatch(tools, /phases_read/, who);
	}
	const other = await actorOf("other");
	const rows = (await read(other, "intelligence.readExitCriteria")).rows;
	assert.ok(
		rows.every((r) => r.fields.reading !== "18 of 30 committed adults"),
		"another church reads only its own facts",
	);
	const steps = (await read(other, "intelligence.readJourney")).rows;
	assert.ok(steps.every((r) => r.fields.reason !== "The core group started meeting every week."));
});

test("INV-evry-phases-evals: every phase readiness case passes on the scripted model, and no reply calls the church ready", async (t) => {
	const forbid = file.forbid.map(pattern);
	for (const c of file.cases) {
		await t.test(c.id, async () => {
			if (c.setup === "allMet") await seedAllMet(admin, db);
			const actor = await actorOf(c.actor);
			const before = await phase();
			const turn = await ask(actor, c.ask);
			assert.deepEqual(
				turn.results.map((r) => r.operation),
				c.calls,
				"tool calls",
			);
			for (const p of c.answer ?? []) assert.match(turn.answer, pattern(p));
			for (const p of [...(c.absent ?? []).map(pattern), ...forbid]) assert.doesNotMatch(turn.answer, p);
			const rows = turn.results.flatMap((r) => r.result.rows ?? []);
			if (c.phase !== undefined) {
				const { assessed } = await screenCriteria(actor, c.phase);
				const criteria = rows.filter((r) => r.kind === "criterion");
				assert.equal(criteria.length, assessed.length);
				for (const r of criteria) {
					const line = turn.answer.split("\n").find((l) => l.startsWith(`- ${r.label}:`));
					assert.ok(line, `the answer names ${r.label}`);
					if (r.fields.reading === null) assert.doesNotMatch(line, /\d/, `${r.label} shows no estimate`);
				}
			}
			if (!c.proposal) {
				assert.equal(turn.proposals.length, 0);
				return;
			}
			const [proposal] = turn.proposals;
			assert.ok(proposal, "a review card");
			assert.equal(proposal.operation, c.proposal.operation);
			assert.deepEqual(proposal.review.changes.find((x) => x.field === "openCriteria")?.after, c.proposal.openCriteria);
			const shown = proposalForModel(proposal) as {
				rows: { fields: { changes: { field: string; after: unknown }[] } }[];
			};
			assert.deepEqual(
				shown.rows[0]!.fields.changes.find((x) => x.field === "openCriteria")?.after,
				c.proposal.openCriteria.map(({ label, status }) => ({ label, status })),
				"the model's copy keeps the recorded shape until the batched re-record (D-2014)",
			);
			assert.equal(await phase(), before, "nothing changes before approval");
			const journeyBefore = (await read(actor, "intelligence.readJourney")).rows;
			assert.equal(journeyBefore[0]?.label, "Core Group Development");
			if (!c.approve) return;
			assert.equal(await approveAndRun(actor, proposal), "completed");
			assert.equal(await phase(), 2);
			const journeyAfter = (await read(actor, "intelligence.readJourney")).rows;
			assert.deepEqual(
				[journeyAfter[0]?.label, journeyAfter[0]?.fields.direction, journeyAfter[0]?.fields.reason],
				["Launch Team Formation", "forward", c.ask],
			);
			assert.equal(journeyAfter.length, journeyBefore.length + 1);
		});
	}
});

test("INV-phases-journey: intelligence.readJourney returns the steps the journey screen shows, newest first, and nothing else", async () => {
	const owner = await actorOf("owner");
	const history = await phaseReader.readHistory(db, owner.authority);
	const journal = await reader.readJournal(db, owner.authority);
	assert.ok(history.status === "ok" && journal.status === "ok");
	const screen = [
		...history.value.entries.map((e) => ({ id: e.id, at: e.occurredAt })),
		...journal.value.entries.filter((e) => e.change.kind === "date").map((e) => ({ id: e.id, at: e.at })),
	]
		.sort((a, b) => a.at.localeCompare(b.at))
		.toReversed()
		.map((s) => s.id);
	const rows = (await read(owner, "intelligence.readJourney")).rows;
	assert.deepEqual(
		rows.map((r) => r.id),
		screen,
	);
	assert.ok(
		rows.some((r) => r.fields.entry === "launch_date"),
		"the Launch Sunday date change",
	);
	const movements = history.value.entries.filter((e) => e.kind === "movement");
	assert.deepEqual(
		rows.filter((r) => r.fields.entry === "movement").map((r) => [r.fields.direction, r.fields.reason]),
		movements.toReversed().map((e) => [e.direction, e.reason]),
	);
});
