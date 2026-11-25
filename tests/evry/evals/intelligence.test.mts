import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createAssessments, createFacts } from "../../../packages/domain/src/intelligence/index.ts";
import type { EvryActor } from "../../../packages/evry/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { checkCase, harness, loadCases } from "./intelligence-harness.mts";
import { CANARY, FOLLOW_UP, intelligenceChurch, TODAY, type IntelligenceChurch } from "./intelligence-church.mts";

const cases = loadCases("./intelligence.cases.json");
const assessments = createAssessments();
const facts = createFacts();
let ch: IntelligenceChurch;
let h: ReturnType<typeof harness>;

before(async () => {
	ch = await intelligenceChurch("evryint");
	h = harness(ch.db, TODAY);
	starter = (await ch.plant("New Life Church")).owner.session;
});
after(() => ch?.database.close());

type Asker = "owner" | "admin" | "member" | "starter";
let starter: string;
const actorOf = async (who: Asker) => (await h.freshActor(who === "starter" ? starter : ch.seats[who].session))!;
const authority = async () => (await RequestActor.resolve(ch.db, ch.seats.owner.session as never)) as RequestActor;
const screen = async () => ({
	view: ok(await assessments.readAssessment(ch.db, await authority(), {})),
	facts: ok(await facts.readFacts(ch.db, await authority(), {})),
});
const tasksTitled = async (title: string) =>
	(await ch.rows(sql`SELECT id FROM task WHERE plant_id=${ch.cedar.id} AND title=${title} AND deleted_at IS NULL`))
		.length;
const LENS_STANDING = {
	attention: "Attention",
	watch: "Watch",
	noted: "Noted",
	strength: "Strength",
	not_raised: "Not raised",
	insufficient: "Not enough evidence",
} as const;

const SETUP: Record<string, () => Promise<void>> = {
	classified: async () => {
		await ch.classify();
		await ch.runJob();
	},
	preparing: async () => {
		ok(await assessments.requestRefresh(ch.db, await authority(), { requestId: randomUUID() }));
	},
};
type Got = Awaited<ReturnType<ReturnType<typeof harness>["ask"]>>;
const SETTLED: Record<string, (got: Got, actor: EvryActor) => Promise<void>> = {
	"INT-01": async () => {
		const a = (await screen()).facts;
		assert.deepEqual(
			[a.committedAdults.known, a.committedAdults.exact, a.committedAdults.needsClassifying.length, a.today],
			[28, null, 2, "2026-10-13"],
		);
	},
	"INT-02": async (got) => {
		const v = (await screen()).view.current!;
		for (const l of v.lenses) assert.ok(got.answer.includes(`**${l.label}**: ${LENS_STANDING[l.standing]}`), l.label);
	},
	"INT-03": async (got) => {
		const v = (await screen()).view.current!;
		for (const p of [v.focus, ...v.supporting, ...v.positives]) {
			assert.ok(got.answer.includes(`**${p.title}**`), p.title);
			for (const cite of p.citations.filter((x) => x.kind === "fact")) {
				const r = ok(await assessments.resolveCitation(ch.db, await authority(), { runId: v.runId, key: cite.key }));
				assert.equal(r.status, "verified");
				if (r.status === "verified" && r.kind === "fact") {
					const value = r.value === null ? "Unknown" : typeof r.value === "boolean" ? (r.value ? "Yes" : "No") : null;
					if (value) assert.ok(got.answer.includes(`${cite.label}: ${value}`), cite.label);
				}
			}
		}
	},
	"INT-04": async () => assert.equal(await tasksTitled(FOLLOW_UP), 1, "the approved card created the task"),
	"INT-05": async () => assert.equal(await tasksTitled(FOLLOW_UP), 1, "no duplicate"),
	"INT-06": async () => assert.equal(await tasksTitled("Set a regular prayer rhythm"), 0),
	"INT-07": async () => {
		const admin = (await RequestActor.resolve(ch.db, ch.seats.admin.session as never)) as RequestActor;
		const v = ok(await assessments.readAssessment(ch.db, admin, {}));
		assert.deepEqual(
			v.feedback.map((f) => [f.ordinal, f.rating, f.comment]),
			[[0, "not_useful", null]],
		);
	},
	"INT-08": async () => {
		const n = await ch.rows(sql`SELECT id FROM job WHERE kind='assessment' AND subject_record_id=${ch.cedar.id}
			AND state='ready'`);
		assert.equal(n.length, 0, "a Member requests nothing");
	},
	"INT-10": async () => {
		assert.equal((await screen()).view.newest?.state, "preparing");
		const audit = await ch.rows(sql`SELECT actor_id FROM audit_event WHERE tenant_id=${ch.cedar.id}
			AND action='intelligence.refresh_requested' ORDER BY occurred_at DESC LIMIT 1`);
		assert.equal(audit[0]?.actor_id, ch.seats.owner.id);
	},
	"INT-11": async () => {
		const a = (await screen()).facts.committedAdults;
		assert.deepEqual([a.exact, a.status], [30, "met"]);
	},
	"INT-12": async (got) => {
		const v = (await screen()).view.current!;
		assert.ok(v.delta?.changed.length, "the second run has a delta");
		for (const x of v.delta!.changed) assert.ok(got.answer.includes(`**${x.label}**`), x.label);
	},
};

test("AC:CA024 AC:INH-INTELLIGENCE-06 AC:TEAM-02 AC:TEAM-01 INV-privacy: Plant Intelligence through Evry quotes the screen's own reads, dedupes tasks, keeps prayer out of tasks and never reads a private check-in", async () => {
	for (const c of cases) {
		if (c.setup) await SETUP[c.setup]!();
		const actor = await actorOf(c.actor as Asker);
		const got = await h.ask(actor, c.ask);
		if (process.env.EVRY_EVAL_PRINT) console.log(`## ${c.id} (${c.actor}): ${c.ask}\n${got.answer}\n`);
		const card = checkCase(c, got);
		assert.ok(!got.results.includes(CANARY) && !got.answer.includes(CANARY), `${c.id} never reads the check-in`);
		assert.doesNotMatch(got.answer, /spiritual(ly)? (mature|immature|maturity)/i, c.id);
		if (card && c.approve) assert.equal(await h.approveAndRun(actor, card), "completed", c.id);
		await SETTLED[c.id]?.(got, actor);
	}
});
