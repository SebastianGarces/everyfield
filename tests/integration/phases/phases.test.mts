import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import {
	CRITERION_KEYS,
	DECLARATION_REASON,
	type CriterionStatus,
} from "../../../packages/contracts/src/phases/index.ts";
import { accountId, frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { caseOf } from "../target/sql/core/support.mts";
import {
	authorizePhaseNotices,
	createPhaseWriter,
	phaseReader,
	readCatalog,
	readinessOf,
	readReadiness,
} from "../../../packages/domain/src/phases/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { createNotificationService } from "../../../packages/domain/src/jobs/notifications.ts";
import { phaseNotices } from "../../../apps/web/src/features/phases/notices.ts";
import { ok, raced, refused, type Workspace } from "../../support/fixture.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { frozenClock as frozenSchemaClock } from "../../support/test-database.mts";
import { failingWrite } from "../../support/recorded.mts";
import { createFacts, createSignals } from "../../../packages/domain/src/intelligence/index.ts";
import { createTemplateReader } from "../../../packages/domain/src/tasks/index.ts";
import { church as assessmentChurch } from "../intelligence/assessment-church.mts";

let f: Awaited<ReturnType<typeof fixture>>;
let writer: ReturnType<typeof createPhaseWriter>;
let onboarding: ReturnType<typeof createOnboardingProducer>;
type Seated = Awaited<ReturnType<typeof seated>>;
const rows = async (q: SQL) => (await f.admin.execute(q)).rows;
const one = async (q: SQL) => {
	const [row] = await rows(q);
	if (!row) throw Error("the query returned no row");
	return row;
};
const history = (who: Seated) => phaseReader.readHistory(f.db, who.actor);
const historyOf = async (who: Seated) => ok(await history(who));
const declare = (who: Seated, phase: unknown, expectedRevision: string, requestKey = randomUUID()) =>
	writer.declare(f.db, who.actor, { requestKey, expectedRevision, input: { phase } });
const move = (who: Seated, toPhase: unknown, reason: string, expectedRevision: string, requestKey = randomUUID()) =>
	writer.transition(f.db, who.actor, { requestKey, expectedRevision, input: { toPhase, reason } });
const revisionOf = async (plant: Workspace) => {
	const { r } = await one(sql`SELECT revision::text AS r FROM plant WHERE id=${plant.id}`);
	assert.equal(typeof r, "string");
	return String(r);
};
const footprint = async (plant: Workspace) => {
	const row = await one(sql`SELECT (SELECT count(*)::int FROM phase_transition WHERE plant_id=${plant.id}) transitions,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${plant.id}) audits,
		(SELECT count(*)::int FROM notice) notices, (SELECT count(*)::int FROM job) jobs,
		(SELECT phase FROM plant WHERE id=${plant.id}) phase, (SELECT revision::text FROM plant WHERE id=${plant.id}) revision`);
	const { transitions, audits, revision } = row;
	assert.ok(typeof transitions === "number" && typeof audits === "number" && typeof revision === "string");
	return { ...row, transitions, audits, revision };
};

async function seated(w: Workspace, role: "owner" | "admin" | "member") {
	const a = await f.account();
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function church(name = "Harvest Point") {
	const a = await f.account("pending_domain");
	await f.admin.execute(sql`UPDATE account SET registration_kind='planter' WHERE id=${a.id}`);
	const create = { requestKey: randomUUID(), expectedRevision: "1", input: { name, confirmed: true } };
	const run = () =>
		gatedTransaction(f.db, (tx) =>
			onboarding.createPlant(
				tx,
				{ session: a.session, selected: { kind: "account", id: accountId.parse(a.id) } },
				create,
			),
		);
	const created = ok(await run());
	const owner = { ...a, actor: await f.actor(a.session) };
	return { plant: created.plant, owner, replayCreation: run };
}
async function churchAt(phase: number) {
	const c = await church();
	if (phase !== 1) ok(await move(c.owner, phase, "Setting up the test church", await revisionOf(c.plant)));
	return c;
}
async function connect(plant: Workspace, kind: "sending_church" | "sending_network" = "sending_church") {
	const org = await f.workspace(kind);
	const owner = await seated(org, "owner");
	await f.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${plant.id},${org.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	return { org, owner };
}
type PhaseCase = {
	given: Record<string, { value?: unknown }>;
	clock: { now: string };
	expected: { result: Record<string, unknown> };
};
const phaseCase = (id: string) => caseOf("intelligence", id) as unknown as PhaseCase;
const given = <T,>(k: PhaseCase, name: string) => k.given[name]!.value as T;
const facts = createFacts();
const templates = createTemplateReader();
async function at<T>(instant: string, body: () => Promise<T>) {
	const main = f;
	f = await fixture({ clock: new Date(instant) });
	try {
		return await body();
	} finally {
		const pinned = f;
		f = main;
		await pinned.close();
	}
}
const frozen = <T,>(instant: string, body: () => Promise<T>) => frozenSchemaClock(f.admin, f.schema, instant, body);
const plantLock = (plant: Workspace) => sql`SELECT FROM plant WHERE id=${plant.id} FOR UPDATE`;
const noticesFor = (plant: Workspace) =>
	rows(sql`SELECT n.tenant_id,n.recipient_id,n.cancelled_at,n.purpose FROM notice n
		JOIN phase_transition t ON t.id=n.source_record_id WHERE t.plant_id=${plant.id} ORDER BY n.created_at`);

before(async () => {
	f = await fixture();
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "phases@example.test",
		authorize: authorizePhaseNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const notices = phaseNotices((eligible) => createNotificationService({ mail, eligible }));
	writer = createPhaseWriter({
		notices,
	});
	onboarding = createOnboardingProducer({
		relationships: async () => {},
		async enqueue() {},
	});
});
after(() => f?.close());

test("AC:DC-021 AC:DC-027 AC:DC-029 AC:DC-031 AC:ROLE43-014 AC:DC-001 creation starts at Phase 1 with one creation entry and no 0→1 move", async () => {
	const { plant, owner } = await church();
	assert.equal((await one(sql`SELECT count(*)::int n FROM reading WHERE account_id=${owner.id}`)).n, 0);
	const h = await historyOf(owner);
	assert.deepEqual(h.state, { phase: 1, revision: h.state.revision, declarable: true });
	assert.equal(h.plantName, "Harvest Point");
	assert.equal(h.entries.length, 1);
	assert.deepEqual(
		{ ...h.entries[0], id: null, occurredAt: null },
		{
			kind: "creation",
			id: null,
			fromPhase: null,
			toPhase: 1,
			actor: { accountId: owner.id, displayName: "Synthetic person" },
			occurredAt: null,
		},
	);
	const stored = await rows(sql`SELECT kind,from_phase,to_phase FROM phase_transition WHERE plant_id=${plant.id}`);
	assert.deepEqual(stored, [{ kind: "creation", from_phase: null, to_phase: 1 }]);
});

test("AC:PHASE-CASE-008 AC:B02-032 the catalog has seven phases and the 19 reference keys; Phase 6 is terminal", async () => {
	const catalog = await readCatalog();
	assert.deepEqual(
		catalog.phases.map((p) => [p.phase, p.name]),
		[
			[0, "Discovery"],
			[1, "Core Group Development"],
			[2, "Launch Team Formation"],
			[3, "Training & Preparation"],
			[4, "Pre-Launch (final three to four weeks)"],
			[5, "Launch Sunday"],
			[6, "Post-Launch"],
		],
	);
	assert.deepEqual(
		catalog.phases.map((p) => p.criteria.length),
		[3, 5, 2, 3, 3, 3, 0],
	);
	assert.deepEqual(
		catalog.phases.flatMap((p) => p.criteria.map((x) => x.key)),
		[...CRITERION_KEYS],
	);
	assert.deepEqual(
		catalog.phases.flatMap((p) => p.criteria.filter((x) => x.softwareOnly).map((x) => [p.phase, x.key])),
		[[4, "readiness_milestones"]],
	);
	assert.deepEqual(
		catalog.phases.map((p) => p.terminal),
		[false, false, false, false, false, false, true],
	);
	const k = phaseCase("PHASE-CASE-008");
	const phases = catalog.phases.map((p) => p.phase);
	assert.deepEqual([phases, phases], [k.expected.result.phases, given<number[]>(k, "expected_phases")]);
	assert.deepEqual(
		catalog.phases.map((p) => p.criteria.length),
		given<number[]>(k, "criterion_counts_by_phase"),
	);
	assert.equal(
		new Set(catalog.phases.flatMap((p) => p.criteria.map((x) => x.key))).size,
		k.expected.result.source_keys,
	);
	assert.equal(catalog.phases.find((p) => p.terminal)?.criteria.length, k.expected.result.phase6_exit_keys);
	assert.equal(given<string>(k, "software_only_key"), "playbook_checklist");
	assert.deepEqual(
		catalog.phases.map((p) => p.criteria.filter((x) => x.softwareOnly).length),
		[0, 0, 0, 0, 1, 0, 0],
	);
});

test("AC:PHASE-CASE-004 readiness is an advisory conjunction: Unknown holds it back without failing it", async () => {
	const phase1 = (await readCatalog()).phases[1];
	assert.ok(phase1);
	const keys = phase1.criteria.map((x) => x.key);
	const cluster = (...statuses: CriterionStatus[]) => Object.fromEntries(keys.map((k, i) => [k, statuses[i]]));
	const verdict = (...statuses: CriterionStatus[]) => {
		const r = readinessOf(phase1, cluster(...statuses));
		return [r.verdict, r.ready, r.humanTransitionAllowed];
	};
	assert.deepEqual(verdict("met", "met", "met", "met", "met"), ["ready", true, true]);
	assert.deepEqual(verdict("met", "met", "met", "met", "unknown"), ["approaching", false, true]);
	const r = readinessOf(phase1, cluster("met", "met", "met", "met", "unknown"));
	assert.deepEqual(
		r.criteria.filter((x) => x.status !== "met").map((x) => [x.key, x.status]),
		[["geographic_area", "unknown"]],
	);
	assert.deepEqual(verdict("met", "not_met", "met", "met", "met"), ["approaching", false, true]);
	assert.deepEqual(verdict("met", "not_met", "unknown", "met", "met"), ["not_ready", false, true]);
	assert.deepEqual(verdict("unknown", "unknown", "unknown", "not_tracked", "unknown"), ["unknown", false, true]);
	const catalog = await readCatalog();
	const live = readReadiness(catalog, {});
	assert.ok(live.every((x) => !x.measured && x.criteria.every((c) => c.status === "unknown")));
	assert.deepEqual(
		live.map((x) => x.verdict),
		["unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "terminal"],
	);
	const filled = readReadiness(catalog, {
		committed_adults: "met",
		financial_base: "not_met",
		training_complete: "met",
	});
	const [, second, , fourth] = filled;
	assert.ok(second && fourth);
	assert.deepEqual(
		second.criteria.map((c) => c.status),
		["met", "unknown", "not_met", "unknown", "unknown"],
	);
	assert.deepEqual([second.measured, second.verdict, fourth.criteria[0]?.status], [true, "not_ready", "met"]);
	const k = phaseCase("PHASE-CASE-004");
	const cluster4 = given<{ met: number; unknown: number; not_met: number; total: number }>(k, "phase1_cluster");
	const ch = await assessmentChurch("phase004", { clock: new Date(k.clock.now) });
	try {
		const p = await ch.harvest("Readiness Point");
		ok(
			await createSignals().attest(ch.db, p.actor, {
				requestKey: randomUUID(),
				expectedRevision: "0",
				input: { key: "financial_base_established", value: "yes" },
			}),
		);
		const readiness = async () => {
			const measured = ok(await facts.readFacts(ch.db, p.actor, {})).criteria;
			const phase = given<number>(k, "cached_assessment_phase");
			return readReadiness(await readCatalog(), measured).find((x) => x.phase === phase)!;
		};
		const one1 = await readiness();
		const count = (status: CriterionStatus) => one1.criteria.filter((x) => x.status === status).length;
		assert.deepEqual(
			{ met: count("met"), unknown: count("unknown"), not_met: count("not_met"), total: one1.criteria.length },
			cluster4,
		);
		assert.deepEqual(
			one1.criteria.filter((x) => x.status !== "met").map((x) => x.key),
			["geographic_area"],
		);
		assert.deepEqual(
			{
				ready: one1.ready,
				met: count("met"),
				unknown: count("unknown"),
				human_transition_allowed: one1.humanTransitionAllowed,
			},
			k.expected.result,
		);
		assert.equal(one1.verdict, "approaching");
		const phases = createPhaseWriter({ notices: async () => {} });
		const target = given<number>(k, "target_phase");
		const reason = given<string>(k, "human_reason");
		const { r } = await ch.one<{ r: string }>(sql`SELECT revision::text r FROM plant WHERE id=${p.id}`);
		const moved = ok(
			await phases.transition(ch.db, p.actor, {
				requestKey: randomUUID(),
				expectedRevision: r,
				input: { toPhase: target, reason },
			}),
		);
		assert.ok(moved.outcome === "moved" && moved.entry.kind === "movement");
		assert.deepEqual([moved.entry.fromPhase, moved.entry.toPhase, moved.entry.reason], [1, target, reason]);
		assert.deepEqual(await readiness(), one1);
	} finally {
		await ch.database.close();
	}
});

test("AC:PHASE-CASE-001 AC:DC-022 AC:DC-032 AC:TARGET-IDN-015 a declaration records where the church was, once, and creation retry keeps it", async () => {
	const { plant, owner, replayCreation } = await church();
	const admin = await seated(plant, "admin");
	const revision = await revisionOf(plant);
	const d = ok(await declare(owner, 3, revision));
	assert.equal(d.state.phase, 3);
	assert.equal(d.state.declarable, false);
	assert.deepEqual(
		{ kind: d.entry.kind, fromPhase: d.entry.fromPhase, toPhase: d.entry.toPhase },
		{ kind: "initial_declaration", fromPhase: 1, toPhase: 3 },
	);
	const stored = await rows(
		sql`SELECT kind,from_phase,to_phase,reason FROM phase_transition WHERE plant_id=${plant.id} ORDER BY occurred_at`,
	);
	assert.deepEqual(stored, [
		{ kind: "creation", from_phase: null, to_phase: 1, reason: "Plant created in EveryField." },
		{ kind: "initial_declaration", from_phase: 1, to_phase: 3, reason: DECLARATION_REASON },
	]);
	assert.deepEqual(
		(await historyOf(owner)).entries.map((e) => e.kind),
		["creation", "initial_declaration"],
	);
	const before = await footprint(plant);
	refused(await declare(admin, 4, d.state.revision), "already_declared");
	refused(await declare(owner, 2, d.state.revision), "already_declared");
	assert.deepEqual(await footprint(plant), before);
	ok(await replayCreation());
	assert.equal((await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase, 3);
});

test("AC:PHASE-CASE-001 two Admins declaring at the same moment leave one creation entry and exactly one declaration", async () => {
	const k = phaseCase("PHASE-CASE-001");
	const [first, second] = given<{ actor: "A" | "B"; declare: number }[]>(k, "requests");
	const creation = given<{ from: number | null; to: number }>(k, "creation_entry");
	assert.ok(first && second);
	await at(k.clock.now, async () => {
		const { plant } = await church();
		const by = { A: await seated(plant, "admin"), B: await seated(plant, "admin") };
		assert.equal((await historyOf(by.A)).state.declarable, given<string>(k, "declaration_slot") === "unused");
		const revision = await revisionOf(plant);
		const [won, lost] = await raced(f.admin, f.db, plantLock(plant), [
			() => declare(by[first.actor], first.declare, revision),
			() => declare(by[second.actor], second.declare, revision),
		]);
		assert.equal(ok(won).state.phase, first.declare);
		refused(lost, "already_declared");
		const stored = await rows(
			sql`SELECT kind,from_phase,to_phase FROM phase_transition WHERE plant_id=${plant.id} ORDER BY occurred_at,id`,
		);
		const kinds = (kind: string) => stored.filter((r) => r.kind === kind);
		assert.deepEqual(kinds("creation"), [{ kind: "creation", from_phase: creation.from, to_phase: creation.to }]);
		assert.equal(kinds("creation").length, k.expected.result.creation_rows);
		assert.equal(kinds("initial_declaration").length, k.expected.result.initial_declarations);
		assert.deepEqual(kinds("initial_declaration"), [
			{ kind: "initial_declaration", from_phase: creation.to, to_phase: first.declare },
		]);
		const phase = (await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase;
		assert.equal(phase === second.declare, k.expected.result.loser_changes_phase);
		assert.equal(phase, first.declare);
		for (const admin of Object.values(by))
			assert.equal((await historyOf(admin)).state.phase === first.declare, given<boolean>(k, "both_current_admins"));
	});
});

test("AC:DC-022 onboarding and the journey view share one declaration slot", async () => {
	const { plant, owner } = await church();
	const ctx = { session: owner.session, selected: plant };
	const resume = ok(await gatedTransaction(f.db, (tx) => onboarding.getResume(tx, ctx, {})));
	assert.ok(resume.status === "available", JSON.stringify(resume));
	const journey = {
		requestKey: randomUUID(),
		expectedRevision: resume.revision,
		input: { journey: { answer: "existing", phase: 2 }, launch: { answer: "no_date" } },
	};
	const saved = ok(await gatedTransaction(f.db, (tx) => onboarding.declareJourney(tx, ctx, journey)));
	assert.equal(saved.currentPhase, 2);
	refused(await declare(owner, 3, saved.revision), "already_declared");
	const h = await historyOf(owner);
	assert.equal(h.state.declarable, false);
	assert.deepEqual(
		h.entries.map((e) => ("fromPhase" in e ? [e.kind, e.fromPhase, e.toPhase] : [e.kind])),
		[
			["creation", null, 1],
			["initial_declaration", 1, 2],
		],
	);
	const other = await church();
	const moved = ok(await move(other.owner, 2, "Launch team is forming", await revisionOf(other.plant)));
	refused(await declare(other.owner, 4, moved.state.revision), "already_declared");
	const octx = { session: other.owner.session, selected: other.plant };
	const late = {
		requestKey: randomUUID(),
		expectedRevision: moved.state.revision,
		input: { journey: { answer: "existing", phase: 4 }, launch: { answer: "no_date" } },
	};
	refused(await gatedTransaction(f.db, (tx) => onboarding.declareJourney(tx, octx, late)), "already_declared");
});

test("AC:PHASE-CASE-009 phases are integers 0 to 6, reasons are trimmed, the reserved sentence is refused and the declaration path records it once", async () => {
	const k = phaseCase("PHASE-CASE-009");
	const expected = k.expected.result as {
		valid_phase_bounds: [number, number];
		invalid_phases: unknown[];
		invalid_write_count: number;
		declared_phase: number;
		declaration_count: number;
		ordinary_trimmed_reason: string;
	};
	assert.equal(given<string>(k, "reservedInitialReason"), DECLARATION_REASON);
	await at(k.clock.now, async () => {
		const { plant, owner } = await church();
		const revision = await revisionOf(plant);
		const before = await footprint(plant);
		const current = given<number>(k, "currentPhase");
		assert.equal((await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase, current);
		assert.equal((await historyOf(owner)).state.declarable, given<string>(k, "declarationSlot") === "unused");
		for (const phase of expected.invalid_phases) {
			refused(await declare(owner, phase, revision), "invalid_input");
			refused(await move(owner, phase, "A real reason", revision), "invalid_input");
		}
		const reason = async (problem: string, text: string, to = 2) =>
			assert.equal(refused(await move(owner, to, text, revision), "invalid_reason").details.problem, problem);
		await reason("empty", "   \n\t ");
		await reason("too_long", "x".repeat(2001));
		await reason("reserved", `  ${DECLARATION_REASON}  `);
		await reason("reserved", DECLARATION_REASON, current);
		for (const input of [
			{ toPhase: 2, reason: "Because", kind: "initial_declaration" },
			{ toPhase: 2, reason: "Because", fromPhase: 0 },
		])
			refused(
				await writer.transition(f.db, owner.actor, { requestKey: randomUUID(), expectedRevision: revision, input }),
				"invalid_input",
			);
		refused(
			await writer.declare(f.db, owner.actor, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { phase: 2, reason: "Mine" },
			}),
			"invalid_input",
		);
		const untouchedAfter = await footprint(plant);
		assert.deepEqual(untouchedAfter, before);
		assert.equal(untouchedAfter.transitions - before.transitions, expected.invalid_write_count);
		const declared = ok(await declare(owner, expected.declared_phase, revision));
		assert.equal(declared.state.phase, expected.declared_phase);
		refused(await declare(owner, 4, declared.state.revision), "already_declared");
		const declarations = await rows(
			sql`SELECT from_phase,to_phase,reason FROM phase_transition WHERE plant_id=${plant.id} AND kind='initial_declaration'`,
		);
		assert.equal(declarations.length, expected.declaration_count);
		assert.deepEqual(declarations, [{ from_phase: 1, to_phase: expected.declared_phase, reason: DECLARATION_REASON }]);
		const [low, high] = expected.valid_phase_bounds;
		const moved = ok(await move(owner, low, `  ${expected.ordinary_trimmed_reason}  `, declared.state.revision));
		assert.ok(moved.outcome === "moved" && moved.entry.kind === "movement", JSON.stringify(moved));
		assert.deepEqual([moved.state.phase, moved.entry.reason], [low, expected.ordinary_trimmed_reason]);
		assert.equal(
			(await one(sql`SELECT reason FROM phase_transition WHERE plant_id=${plant.id} AND kind='movement'`)).reason,
			expected.ordinary_trimmed_reason,
		);
		const long = ok(await move(owner, high, "x".repeat(2000), moved.state.revision));
		assert.ok(long.outcome === "moved" && long.entry.kind === "movement", JSON.stringify(long));
		assert.deepEqual([long.state.phase, long.entry.reason.length], [high, 2000]);
	});
});

test("AC:PHASE-CASE-007 a reasoned move records from, to, direction, reason, actor and time; the history only grows", async () => {
	const { plant, owner } = await churchAt(2);
	const admin = await seated(plant, "admin");
	const start = (await historyOf(owner)).entries;
	const steps: [Seated, number, string, string, number][] = [
		[admin, 4, "Training finished early", "skip_forward", 2],
		[owner, 1, "Core group shrank after the move", "backward", 4],
		[admin, 0, "Back to discernment", "backward", 1],
		[owner, 1, "Discernment is done", "forward", 0],
	];
	let revision = await revisionOf(plant);
	const dbNow = async () => Date.parse(String((await one(sql`SELECT clock_timestamp()::text AS t`)).t));
	for (const [who, to, reason, direction, from] of steps) {
		const earliest = await dbNow();
		const r = ok(await move(who, to, reason, revision));
		const latest = await dbNow();
		assert.equal(r.outcome, "moved");
		assert.equal(r.state.phase, to);
		assert.equal(BigInt(r.state.revision), BigInt(revision) + 1n);
		assert.deepEqual(
			{ ...r.entry, id: null, occurredAt: null },
			{
				kind: "movement",
				id: null,
				fromPhase: from,
				toPhase: to,
				direction,
				reason,
				actor: { accountId: who.id, displayName: "Synthetic person" },
				occurredAt: null,
			},
		);
		const at = Date.parse(r.entry.occurredAt);
		assert.ok(at >= earliest && at <= latest, `${r.entry.occurredAt} outside the move`);
		revision = r.state.revision;
	}
	const h = await historyOf(owner);
	assert.deepEqual(h.entries.slice(0, start.length), start);
	assert.deepEqual(
		h.entries
			.slice(start.length)
			.map((e) => (e.kind === "movement" ? [e.fromPhase, e.toPhase, e.direction] : [e.kind])),
		[
			[2, 4, "skip_forward"],
			[4, 1, "backward"],
			[1, 0, "backward"],
			[0, 1, "forward"],
		],
	);
	assert.equal(h.state.phase, 1);
});

test("AC:PHASE-CASE-002 two moves from the same reviewed revision: one wins from Phase 1, the other sees the change, and Unknown readiness blocks neither", async () => {
	const k = phaseCase("PHASE-CASE-002");
	const [first, second] = given<{ actor: "A" | "B"; to: number; reason: string; reviewed_state: string }[]>(
		k,
		"requests",
	);
	assert.ok(first && second && first.reviewed_state === second.reviewed_state);
	await at(k.clock.now, async () => {
		const { plant } = await church();
		const by = { A: await seated(plant, "admin"), B: await seated(plant, "admin") };
		const revision = await revisionOf(plant);
		assert.equal((await historyOf(by.A)).state.phase, given<number>(k, "plant_phase"));
		const measured = ok(await facts.readFacts(f.db, by.A.actor, {})).criteria;
		const [current] = readReadiness(await readCatalog(), measured).filter((r) => r.phase === 1);
		assert.ok(current);
		assert.deepEqual(
			current.criteria.map((c) => c.status),
			["not_met", ...Array<string>(4).fill(given<string>(k, "readiness"))],
		);
		assert.deepEqual([current.verdict, current.ready, current.humanTransitionAllowed], ["not_ready", false, true]);
		const [won, lost] = await raced(f.admin, f.db, plantLock(plant), [
			() => move(by[first.actor], first.to, first.reason, revision),
			() => move(by[second.actor], second.to, second.reason, revision),
		]);
		const winner = ok(won);
		assert.ok(winner.outcome === "moved");
		assert.equal(winner.entry.fromPhase, k.expected.result.winning_from_phase);
		assert.equal(winner.state.phase, first.to);
		assert.equal(won.status !== "ok", k.expected.result.unknown_readiness_blocks);
		const conflict = refused(lost, String(k.expected.result.loser_error));
		assert.deepEqual(conflict.details.state, winner.state);
		const moves = await rows(
			sql`SELECT from_phase,to_phase,reason FROM phase_transition WHERE plant_id=${plant.id} AND kind='movement'`,
		);
		assert.equal(moves.length, k.expected.result.winning_transitions);
		assert.deepEqual(moves, [{ from_phase: 1, to_phase: first.to, reason: first.reason }]);
		assert.equal((await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase, first.to);
	});
});

test("AC:PHASE-CASE-003 the same phase returns a noop receipt and changes nothing else: no phase, fact input or offer", async () => {
	const k = phaseCase("PHASE-CASE-003");
	const phase = given<number>(k, "phase");
	assert.equal(given<number>(k, "requested_phase"), phase);
	await at(k.clock.now, async () => {
		const { plant, owner } = await churchAt(phase);
		await connect(plant);
		const offer = () => gatedTransaction(f.db, (tx) => templates.readPhaseOffer(tx, owner.actor, {}));
		const inputs = async () => ok(await facts.readFacts(f.db, owner.actor, {})).sourceRevision;
		const before = await footprint(plant);
		const [offered, sourceBefore] = [ok(await offer()), await inputs()];
		assert.equal(offered.status, "open");
		const entries = (await historyOf(owner)).entries;
		const key = randomUUID();
		const reason = given<string>(k, "reason");
		const receipt = ok(await move(owner, phase, reason, before.revision, key));
		assert.equal(receipt.outcome, k.expected.result.kind);
		assert.deepEqual(receipt.state, { phase: k.expected.result.phase, revision: before.revision, declarable: false });
		assert.deepEqual(ok(await move(owner, phase, reason, before.revision, key)), receipt);
		const after = await footprint(plant);
		assert.deepEqual(after, { ...before, transitions: before.transitions + 1, audits: before.audits + 1 });
		assert.deepEqual(
			await rows(
				sql`SELECT id,kind,from_phase,to_phase,reason FROM phase_transition WHERE plant_id=${plant.id} AND kind='noop'`,
			),
			[{ id: receipt.receiptId, kind: "noop", from_phase: phase, to_phase: phase, reason }],
		);
		assert.deepEqual((await historyOf(owner)).entries, entries);
		assert.equal(await inputs(), sourceBefore);
		const reoffered = ok(await offer());
		assert.ok(reoffered.status === "open" && offered.status === "open");
		assert.deepEqual(reoffered, offered);
		assert.equal(Number(reoffered.transition.id !== offered.transition.id), k.expected.result.new_offers);
		assert.equal((await one(sql`SELECT count(*)::int n FROM task WHERE plant_id=${plant.id}`)).n, 0);
		refused(await move(owner, 4, "Something else", before.revision, key), "idempotency_conflict");
	});
});

test("AC:PHASE-CASE-005 a move, its audit and its notice commit together; a notice insert fault leaves nothing and the same key then moves once", async () => {
	const k = phaseCase("PHASE-CASE-005");
	const [from, to] = [given<number>(k, "from"), given<number>(k, "to")];
	assert.deepEqual(given<string[]>(k, "event_types"), ["phase.changed", "plant.assessment.created"]);
	await at(k.clock.now, async () => {
		const { plant, owner } = await church();
		const linked = await connect(plant);
		const before = await footprint(plant);
		const phaseNow = async () => (await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase;
		assert.equal(await phaseNow(), from);
		const key = randomUUID();
		await failingWrite(f.admin, { on: "notice", event: "INSERT", when: `NEW.tenant_id='${linked.org.id}'` }, () =>
			assert.rejects(move(owner, to, "Launch team is forming", before.revision, key), (e: Error) =>
				/injected fault/.test(String(e.cause ?? e)),
			),
		);
		const faulted = await footprint(plant);
		assert.deepEqual(faulted, before);
		assert.equal(await phaseNow(), k.expected.result.fault_phase);
		assert.equal((await historyOf(owner)).entries.length, 1);
		const moved = ok(await move(owner, to, "Launch team is forming", before.revision, key));
		assert.equal(moved.state.phase, k.expected.result.success_phase);
		assert.deepEqual(ok(await move(owner, to, "Launch team is forming", before.revision, key)), moved);
		const intents = await noticesFor(plant);
		assert.equal(intents.length, k.expected.result.phase_changed_intents);
		assert.deepEqual(
			intents.map((n) => [n.tenant_id, n.recipient_id, n.purpose, n.cancelled_at]),
			[[linked.org.id, linked.owner.id, "phase_transition", null]],
		);
		const audits = await rows(
			sql`SELECT action,kind,before_value,after_value FROM audit_event WHERE tenant_id=${plant.id} AND action LIKE 'phase.%' AND action<>'phase.created'`,
		);
		assert.deepEqual(audits, [
			{ action: "phase.transitioned", kind: "edit", before_value: { phase: from }, after_value: { phase: to } },
		]);
		const phantom = await one(sql`SELECT
			(SELECT count(*)::int FROM audit_event WHERE tenant_id=${plant.id} AND action LIKE 'intelligence.%')
			+ (SELECT count(*)::int FROM job WHERE kind='assessment' AND tenant_id=${plant.id})
			+ (SELECT count(*)::int FROM assessment_run WHERE plant_id=${plant.id}) AS n`);
		assert.equal(phantom.n, k.expected.result.phantom_assessment_events);
		assert.equal((await footprint(plant)).transitions, before.transitions + 1);
	});
});

test("AC:CASE-NTF-009 a forward move notifies each connected organization once; declaration, backward and noop do not", async () => {
	const { plant, owner } = await church("Grace Commons");
	const church1 = await connect(plant, "sending_church");
	const network = await connect(plant, "sending_network");
	let revision = await revisionOf(plant);
	revision = ok(await declare(owner, 2, revision)).state.revision;
	assert.deepEqual(await noticesFor(plant), []);
	const key = randomUUID();
	const advance = ok(await move(owner, 4, "Training is complete", revision, key));
	const first = await noticesFor(plant);
	assert.deepEqual(
		first.map((n) => [n.tenant_id, n.recipient_id, n.purpose, n.cancelled_at]).sort(),
		[
			[church1.org.id, church1.owner.id, "phase_transition", null],
			[network.org.id, network.owner.id, "phase_transition", null],
		].sort(),
	);
	const mails = await one(sql`SELECT count(*)::int n FROM mail m JOIN notice n ON n.id=m.notice_id
		JOIN phase_transition t ON t.id=n.source_record_id WHERE t.plant_id=${plant.id}`);
	assert.equal(mails.n, 2);
	assert.deepEqual(ok(await move(owner, 4, "Training is complete", revision, key)), advance);
	assert.equal((await noticesFor(plant)).length, 2);
	revision = ok(await move(owner, 3, "Pre-launch was too early", advance.state.revision)).state.revision;
	ok(await move(owner, 3, "Still here", revision));
	assert.equal((await noticesFor(plant)).length, 2);
	await f.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE organization_id=${church1.org.id}`);
	assert.ok((await noticesFor(plant)).every((n) => n.cancelled_at === null));
	ok(await move(owner, 4, "Pre-launch for real", revision));
	const last = await noticesFor(plant);
	assert.equal(last.length, 3);
	assert.equal(last.at(-1)?.tenant_id, network.org.id);
});

test("AC:PHASE-CASE-007 only a live Owner or Admin seat reads the journey or changes the phase", async () => {
	const { plant, owner } = await church();
	const member = await seated(plant, "member");
	const admin = await seated(plant, "admin");
	const revision = await revisionOf(plant);
	const before = await footprint(plant);
	refused(await history(member), "access_denied");
	refused(await declare(member, 3, revision), "access_denied");
	refused(await move(member, 3, "Members cannot move it", revision), "access_denied");
	assert.deepEqual(await footprint(plant), before);
	assert.equal((await historyOf(admin)).entries.length, 1);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${admin.id}`);
	const gone = refused(await history(admin), "access_denied");
	assert.deepEqual(gone.details, {});
	refused(await move(admin, 3, "After the seat ended", revision), "access_denied");
	assert.deepEqual(await footprint(plant), before);
	await historyOf(owner);
});

test("AC:PHASE-CASE-007 a later correction appends to the journey, the recorded move never changes, and a revoked reader gets no body", async () => {
	const k = phaseCase("PHASE-CASE-007");
	type Step = { actor: "A" | "B"; at: string; from: number; to: number; reason: string };
	const original = given<Step>(k, "original_event");
	const correction = given<Step>(k, "correction");
	const expiry = k.given["session-A"] as unknown as { expires_at: string };
	const dayBefore = new Date(Date.parse(original.at) - 86_400_000).toISOString();
	await at(dayBefore, async () => {
		const made = await church();
		const by = { A: await seated(made.plant, "admin"), B: await seated(made.plant, "admin") };
		const c = { ...made, by };
		for (const who of [made.owner, ...Object.values(by)])
			await f.admin.execute(
				sql`UPDATE auth_session SET expires_at=${expiry.expires_at}::timestamptz WHERE id=${who.session}`,
			);
		assert.equal((await historyOf(by.A)).state.phase, original.from);
		await frozen(original.at, async () =>
			ok(await move(by[original.actor], original.to, original.reason, await revisionOf(made.plant))),
		);
		const first = await frozen(correction.at, async () => {
			const seen = (await historyOf(c.by.A)).entries;
			ok(await move(c.by[correction.actor], correction.to, correction.reason, await revisionOf(c.plant)));
			return seen;
		});
		await frozen(k.clock.now, async () => {
			const h = await historyOf(c.by.A);
			const journey = h.entries.filter((e) => e.kind !== "creation");
			assert.equal(journey.length, k.expected.result.history_events);
			assert.deepEqual(
				journey.map((e) =>
					e.kind === "movement" ? [e.fromPhase, e.toPhase, e.reason, e.actor?.accountId, e.occurredAt] : [e.kind],
				),
				[original, correction].map((x) => [x.from, x.to, x.reason, c.by[x.actor].id, new Date(x.at).toISOString()]),
			);
			assert.equal(
				JSON.stringify(h.entries.slice(0, first.length)) !== JSON.stringify(first),
				k.expected.result.first_event_changed,
			);
			assert.equal(h.state.phase, correction.to);
			assert.equal(given<string>(k, "reader_grant"), "revoked_after_first_read");
			await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${c.by.A.id}`);
			const revoked = await history(c.by.A);
			assert.deepEqual(refused(revoked, "access_denied").details, {});
			assert.equal(revoked.status === "ok" ? revoked.value : null, k.expected.result.revoked_history_body);
			const stored = await rows(
				sql`SELECT kind,from_phase,to_phase,reason FROM phase_transition WHERE plant_id=${c.plant.id} ORDER BY occurred_at,id`,
			);
			assert.deepEqual(
				stored.map((r) => r.kind),
				["creation", "movement", "movement"],
			);
		});
	});
});

test("AC:CASE-NTF-009 a phase notice mails no organization seat that has not accepted yet", async () => {
	const { plant, owner } = await church("Accepted Later");
	const linked = await connect(plant, "sending_church");
	const advance = ok(await move(owner, 2, "Core group is forming", await revisionOf(plant)));
	assert.ok(advance);
	const mailRows = (
		await rows(sql`SELECT m.id, m.recipient_account_id recipient, m.notice_id notice FROM mail m
		JOIN notice n ON n.id=m.notice_id JOIN phase_transition t ON t.id=n.source_record_id WHERE t.plant_id=${plant.id}`)
	).map(({ id, recipient, notice }) => {
		assert.ok(typeof id === "string" && typeof recipient === "string" && typeof notice === "string");
		return { id, recipient, notice };
	});
	assert.equal(mailRows.length, 1);
	const allowed = () => gatedTransaction(f.db, (tx) => authorizePhaseNotices(tx, mailRows));
	assert.equal((await allowed()).size, 1);
	await f.admin.execute(sql`UPDATE seat SET accepted_at=clock_timestamp()+interval '1 day'
		WHERE account_id=${linked.owner.id} AND organization_id=${linked.org.id}`);
	assert.equal((await allowed()).size, 0, "the Owner's seat is not accepted yet");
});

test("AC:PI-CASE-021 the journey reads creation, the one declaration, the reasoned backward correction and the recorded Launch Sunday, with nothing in between", async () => {
	const k = caseOf("intelligence", "PI-CASE-021") as ReturnType<typeof caseOf> & { clock: { now: string } };
	type Event = { kind: string; to?: number; from?: number | null; reason?: string; actual_day?: string };
	const events = (k.given.events as { value: Event[] }).value;
	const [creation, declaration, backward, launch] = events as [Event, Event, Event, Event];
	const today = frozenClock(instant.parse(new Date(k.clock.now).toISOString()));
	const launches = createLaunchWriter({ notices: async () => {}, clock: today });
	const plan = async (who: Seated) => ok(await createLaunchReader(today).readPlan(f.db, who.actor)).plan;
	const { plant, owner } = await church("Case 021 Church");
	assert.equal(creation.to, 1);
	ok(await declare(owner, declaration.to, await revisionOf(plant)));
	ok(await move(owner, backward.to, backward.reason!, await revisionOf(plant)));
	ok(
		await launches.schedule(f.db, owner.actor, {
			requestKey: randomUUID(),
			expectedRevision: (await plan(owner)).revision,
			input: { date: launch.actual_day, reason: null },
		}),
	);
	ok(
		await launches.recordOutcome(f.db, owner.actor, {
			requestKey: randomUUID(),
			expectedRevision: (await plan(owner)).revision,
			input: { actualDate: launch.actual_day, attendance: null, decisions: null, note: null },
		}),
	);
	const h = await historyOf(owner);
	const KIND: Record<string, string> = {
		creation: "church_creation",
		movement: "backward",
		launch_sunday: "launch_recorded",
	};
	assert.deepEqual(
		h.entries.map((e) => KIND[e.kind] ?? e.kind),
		k.expected.result.events,
	);
	const [c0, d0, m0, l0] = h.entries;
	assert.ok(c0 && d0 && m0 && l0);
	assert.deepEqual(c0.kind === "creation" && [c0.fromPhase, c0.toPhase], [creation.from, creation.to]);
	assert.deepEqual(d0.kind === "initial_declaration" && d0.toPhase, declaration.to);
	assert.deepEqual(m0.kind === "movement" && [m0.fromPhase, m0.toPhase, m0.direction, m0.reason], [
		backward.from,
		backward.to,
		"backward",
		backward.reason,
	]);
	assert.equal(l0.kind === "launch_sunday" && l0.actualDate, launch.actual_day);
	assert.equal(h.state.phase, k.expected.result.current_phase);
	assert.equal(h.entries.length - events.length, k.expected.result.invented_intervening_events);
	const stored = await rows(sql`SELECT kind FROM phase_transition WHERE plant_id=${plant.id} ORDER BY occurred_at,id`);
	assert.deepEqual(
		stored.map((r) => r.kind),
		["creation", "initial_declaration", "movement"],
		"no synthetic ladder of moves",
	);
	assert.equal(
		(await one(sql`SELECT count(*)::int AS n FROM meeting WHERE plant_id=${plant.id}`)).n,
		0,
		"no meeting made",
	);
});
