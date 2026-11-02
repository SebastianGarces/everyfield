import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { CRITERION_KEYS, DECLARATION_REASON } from "../../../packages/contracts/src/phases/index.ts";
import {
	authorizePhaseNotices,
	createPhaseWriter,
	phaseReader,
	readCatalog,
	readinessOf,
	readReadiness,
} from "../../../packages/domain/src/phases/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { createNotificationService } from "../../../apps/web/src/server/jobs/notifications.ts";
import { phaseNotices } from "../../../apps/web/src/server/phases/notices.ts";

// WP-038: the journey a church plant declares and moves through. Every write runs through the phase writer the
// /intelligence actions call, on its own schema of the development or CI database.

let f, writer, onboarding;
let faultyNotices = false;
const ok = (r) => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value;
};
const refused = (r, code) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	assert.equal(r.error.code, code);
	return r.error;
};
const rows = async (q) => (await f.admin.execute(q)).rows;
const one = async (q) => (await rows(q))[0];
const history = (who) => phaseReader.readHistory(f.db, who.actor);
const declare = (who, phase, expectedRevision, requestKey = randomUUID()) =>
	writer.declare(f.db, who.actor, { requestKey, expectedRevision, input: { phase } });
const move = (who, toPhase, reason, expectedRevision, requestKey = randomUUID()) =>
	writer.transition(f.db, who.actor, { requestKey, expectedRevision, input: { toPhase, reason } });
const revisionOf = async (plant) => (await one(sql`SELECT revision::text AS r FROM plant WHERE id=${plant.id}`)).r;
/** Every row a phase write could add, to prove a refusal wrote nothing. */
const footprint = (plant) =>
	one(sql`SELECT (SELECT count(*)::int FROM phase_transition WHERE plant_id=${plant.id}) transitions,
		(SELECT count(*)::int FROM audit_event WHERE tenant_id=${plant.id}) audits,
		(SELECT count(*)::int FROM notice) notices, (SELECT count(*)::int FROM job) jobs,
		(SELECT phase FROM plant WHERE id=${plant.id}) phase, (SELECT revision::text FROM plant WHERE id=${plant.id}) revision`);

/** An account with a seat in `w`, and its request actor. */
async function seated(w, role) {
	const a = await f.account();
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
/** A church plant created the way onboarding creates one: plant, Owner seat and its creation entry in one command. */
async function church(name = "Harvest Point") {
	const a = await f.account("pending_domain");
	await f.admin.execute(sql`UPDATE account SET registration_kind='planter' WHERE id=${a.id}`);
	const create = { requestKey: randomUUID(), expectedRevision: "1", input: { name, confirmed: true } };
	const run = () =>
		f.db.transaction((tx) =>
			onboarding.createPlant(tx, { session: a.session, selected: { kind: "account", id: a.id } }, create),
		);
	const created = ok(await run());
	const owner = { ...a, actor: await f.actor(a.session) };
	return { plant: created.plant, owner, replayCreation: run };
}
/** A church at `phase`, moved there by its Owner. */
async function churchAt(phase) {
	const c = await church();
	if (phase !== 1) ok(await move(c.owner, phase, "Setting up the test church", await revisionOf(c.plant)));
	return c;
}
/** A sending church or network connected to the plant, with one Owner. */
async function connect(plant, kind = "sending_church") {
	const org = await f.workspace(kind);
	const owner = await seated(org, "owner");
	await f.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${plant.id},${org.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	return { org, owner };
}
const noticesFor = (plant) =>
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
		async notices(tx, advance) {
			await notices(tx, advance);
			if (faultyNotices) throw Error("required_notice_insert_failed");
		},
	});
	onboarding = createOnboardingProducer({
		relationships: async () => {},
		async enqueue() {},
	});
});
after(() => f?.close());

test("AC:DC-021 AC:DC-027 AC:DC-029 AC:DC-031 AC:ROLE43-014 AC:DC-001 creation starts at Phase 1 with one creation entry and no 0→1 move", async () => {
	const { plant, owner } = await church();
	// No Discovery article was read: creation does not wait for it and invents no Phase 0.
	assert.equal((await one(sql`SELECT count(*)::int n FROM reading WHERE account_id=${owner.id}`)).n, 0);
	const h = ok(await history(owner));
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
	// The methodology's software-only `playbook_checklist` row is the reference's readiness_milestones.
	assert.deepEqual(
		catalog.phases.flatMap((p) => p.criteria.filter((x) => x.softwareOnly).map((x) => [p.phase, x.key])),
		[[4, "readiness_milestones"]],
	);
	assert.deepEqual(
		catalog.phases.map((p) => p.terminal),
		[false, false, false, false, false, false, true],
	);
});

test("AC:PHASE-CASE-004 readiness is an advisory conjunction: Unknown holds it back without failing it", async () => {
	const phase1 = (await readCatalog()).phases[1];
	const keys = phase1.criteria.map((x) => x.key);
	const cluster = (...statuses) => Object.fromEntries(keys.map((k, i) => [k, statuses[i]]));
	const verdict = (...statuses) => {
		const r = readinessOf(phase1, cluster(...statuses));
		return [r.verdict, r.ready, r.humanTransitionAllowed];
	};
	assert.deepEqual(verdict("met", "met", "met", "met", "met"), ["ready", true, true]);
	// Four met and one Unknown: not ready, and the person may still move.
	assert.deepEqual(verdict("met", "met", "met", "met", "unknown"), ["approaching", false, true]);
	const r = readinessOf(phase1, cluster("met", "met", "met", "met", "unknown"));
	assert.deepEqual(
		r.criteria.filter((x) => x.status !== "met").map((x) => [x.key, x.status]),
		[["geographic_area", "unknown"]],
	);
	assert.deepEqual(verdict("met", "not_met", "met", "met", "met"), ["approaching", false, true]);
	assert.deepEqual(verdict("met", "not_met", "unknown", "met", "met"), ["not_ready", false, true]);
	assert.deepEqual(verdict("unknown", "unknown", "unknown", "not_tracked", "unknown"), ["unknown", false, true]);
	// Until WP-040 there is no measured source: every criterion reads Unknown and nothing is measured.
	const live = readReadiness(await readCatalog());
	assert.ok(live.every((x) => !x.measured && x.criteria.every((c) => c.status === "unknown")));
	assert.deepEqual(
		live.map((x) => x.verdict),
		["unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "terminal"],
	);
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
	// No synthesized entries for phases 1 and 2.
	assert.deepEqual(stored, [
		{ kind: "creation", from_phase: null, to_phase: 1, reason: "Plant created in EveryField." },
		{ kind: "initial_declaration", from_phase: 1, to_phase: 3, reason: DECLARATION_REASON },
	]);
	assert.deepEqual(
		ok(await history(owner)).entries.map((e) => e.kind),
		["creation", "initial_declaration"],
	);
	// A second declaration, by anyone, is refused and changes nothing.
	const before = await footprint(plant);
	refused(await declare(admin, 4, d.state.revision), "already_declared");
	refused(await declare(owner, 2, d.state.revision), "already_declared");
	assert.deepEqual(await footprint(plant), before);
	// Retrying the original creation replays it without demoting the declared phase.
	ok(await replayCreation());
	assert.equal((await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase, 3);
});

test("AC:PHASE-CASE-001 two Admins declaring at the same moment leave exactly one declaration", async () => {
	const { plant } = await church();
	const [a, b] = [await seated(plant, "admin"), await seated(plant, "admin")];
	const revision = await revisionOf(plant);
	const results = await Promise.all([declare(a, 2, revision), declare(b, 3, revision)]);
	const won = results.filter((r) => r.status === "ok");
	assert.equal(won.length, 1);
	refused(
		results.find((r) => r.status !== "ok"),
		"already_declared",
	);
	const declared = await rows(
		sql`SELECT to_phase FROM phase_transition WHERE plant_id=${plant.id} AND kind='initial_declaration'`,
	);
	assert.equal(declared.length, 1);
	assert.equal((await one(sql`SELECT phase FROM plant WHERE id=${plant.id}`)).phase, declared[0].to_phase);
	assert.equal(won[0].value.state.phase, declared[0].to_phase);
});

test("AC:DC-022 onboarding and the journey view share one declaration slot", async () => {
	const { plant, owner } = await church();
	const ctx = { session: owner.session, selected: plant };
	const resume = ok(await f.db.transaction((tx) => onboarding.getResume(tx, ctx, {})));
	const journey = {
		requestKey: randomUUID(),
		expectedRevision: resume.revision,
		input: { journey: { answer: "existing", phase: 2 }, launch: { answer: "no_date" } },
	};
	const saved = ok(await f.db.transaction((tx) => onboarding.declareJourney(tx, ctx, journey)));
	assert.equal(saved.currentPhase, 2);
	refused(await declare(owner, 3, saved.revision), "already_declared");
	const h = ok(await history(owner));
	assert.equal(h.state.declarable, false);
	assert.deepEqual(
		h.entries.map((e) => [e.kind, e.fromPhase, e.toPhase]),
		[
			["creation", null, 1],
			["initial_declaration", 1, 2],
		],
	);
	// After a move, neither path may declare.
	const other = await church();
	const moved = ok(await move(other.owner, 2, "Launch team is forming", await revisionOf(other.plant)));
	refused(await declare(other.owner, 4, moved.state.revision), "already_declared");
	const octx = { session: other.owner.session, selected: other.plant };
	const late = {
		requestKey: randomUUID(),
		expectedRevision: moved.state.revision,
		input: { journey: { answer: "existing", phase: 4 }, launch: { answer: "no_date" } },
	};
	refused(await f.db.transaction((tx) => onboarding.declareJourney(tx, octx, late)), "already_declared");
});

test("AC:PHASE-CASE-009 phases are integers 0 to 6, reasons are trimmed and the reserved sentence is refused", async () => {
	const { plant, owner } = await church();
	const revision = await revisionOf(plant);
	const before = await footprint(plant);
	for (const phase of [-1, 7, 1.5, "2", null]) {
		refused(await declare(owner, phase, revision), "invalid_input");
		refused(await move(owner, phase, "A real reason", revision), "invalid_input");
	}
	const reason = async (problem, text) =>
		assert.equal(refused(await move(owner, 2, text, revision), "invalid_reason").details.problem, problem);
	await reason("empty", "   \n\t ");
	await reason("too_long", "x".repeat(2001));
	await reason("reserved", `  ${DECLARATION_REASON}  `);
	// A caller can name neither the kind nor the starting phase.
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
	assert.deepEqual(await footprint(plant), before);
	const moved = ok(await move(owner, 0, "  return to actual Discovery context  ", revision));
	assert.equal(moved.entry.reason, "return to actual Discovery context");
	assert.equal(
		(await one(sql`SELECT reason FROM phase_transition WHERE plant_id=${plant.id} AND kind='movement'`)).reason,
		"return to actual Discovery context",
	);
	assert.equal(ok(await move(owner, 1, "x".repeat(2000), moved.state.revision)).entry.reason.length, 2000);
});

test("AC:PHASE-CASE-007 a reasoned move records from, to, direction, reason, actor and time; the history only grows", async () => {
	const { plant, owner } = await churchAt(2);
	const admin = await seated(plant, "admin");
	const start = ok(await history(owner)).entries;
	const steps = [
		[admin, 4, "Training finished early", "skip_forward", 2],
		[owner, 1, "Core group shrank after the move", "backward", 4],
		[admin, 0, "Back to discernment", "backward", 1],
		[owner, 1, "Discernment is done", "forward", 0],
	];
	let revision = await revisionOf(plant);
	for (const [who, to, reason, direction, from] of steps) {
		const r = ok(await move(who, to, reason, revision));
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
		assert.ok(Math.abs(Date.parse(r.entry.occurredAt) - Date.now()) < 60_000);
		revision = r.state.revision;
	}
	const h = ok(await history(owner));
	// Earlier entries are exactly as they were: a correction is a new entry, never an edit.
	assert.deepEqual(h.entries.slice(0, start.length), start);
	assert.deepEqual(
		h.entries.slice(start.length).map((e) => [e.fromPhase, e.toPhase, e.direction]),
		[
			[2, 4, "skip_forward"],
			[4, 1, "backward"],
			[1, 0, "backward"],
			[0, 1, "forward"],
		],
	);
	assert.equal(h.state.phase, 1);
});

test("AC:PHASE-CASE-002 two moves from the same reviewed revision: one wins from Phase 1, the other sees the change", async () => {
	const { plant } = await church();
	const [a, b] = [await seated(plant, "admin"), await seated(plant, "admin")];
	const revision = await revisionOf(plant);
	const results = await Promise.all([
		move(a, 3, "Training starts now", revision),
		move(b, 2, "Launch team is forming", revision),
	]);
	const won = results.find((r) => r.status === "ok").value;
	assert.equal(won.entry.fromPhase, 1);
	const lost = refused(
		results.find((r) => r.status !== "ok"),
		"revision_conflict",
	);
	assert.deepEqual(lost.details.state, won.state);
	const moves = await rows(sql`SELECT from_phase FROM phase_transition WHERE plant_id=${plant.id} AND kind='movement'`);
	assert.deepEqual(moves, [{ from_phase: 1 }]);
});

test("AC:PHASE-CASE-003 the same phase returns a noop receipt and changes nothing else", async () => {
	const { plant, owner } = await churchAt(3);
	await connect(plant);
	const before = await footprint(plant);
	const entries = ok(await history(owner)).entries;
	const key = randomUUID();
	const receipt = ok(await move(owner, 3, "Checking where we are", before.revision, key));
	assert.equal(receipt.outcome, "noop");
	assert.deepEqual(receipt.state, { phase: 3, revision: before.revision, declarable: false });
	assert.deepEqual(ok(await move(owner, 3, "Checking where we are", before.revision, key)), receipt);
	const after = await footprint(plant);
	// One noop receipt row and its audit row; the phase, revision, notices and jobs are unchanged.
	assert.deepEqual(after, { ...before, transitions: before.transitions + 1, audits: before.audits + 1 });
	assert.deepEqual(
		await rows(
			sql`SELECT id,kind,from_phase,to_phase FROM phase_transition WHERE plant_id=${plant.id} AND kind='noop'`,
		),
		[{ id: receipt.receiptId, kind: "noop", from_phase: 3, to_phase: 3 }],
	);
	assert.deepEqual(ok(await history(owner)).entries, entries);
	// The same key with another request is refused rather than replayed.
	refused(await move(owner, 4, "Something else", before.revision, key), "idempotency_conflict");
});

test("AC:PHASE-CASE-005 a move, its audit and its notice commit together; a notice fault leaves nothing", async () => {
	const { plant, owner } = await church();
	await connect(plant);
	const before = await footprint(plant);
	faultyNotices = true;
	await assert.rejects(move(owner, 2, "Launch team is forming", before.revision));
	faultyNotices = false;
	assert.deepEqual(await footprint(plant), before);
	assert.equal(ok(await history(owner)).entries.length, 1);
	const moved = ok(await move(owner, 2, "Launch team is forming", before.revision));
	const audits = await rows(
		sql`SELECT action,kind,before_value,after_value FROM audit_event WHERE tenant_id=${plant.id} AND action LIKE 'phase.%' AND action<>'phase.created'`,
	);
	assert.deepEqual(audits, [
		{ action: "phase.transitioned", kind: "edit", before_value: { phase: 1 }, after_value: { phase: 2 } },
	]);
	assert.equal(
		(
			await one(
				sql`SELECT count(*)::int n FROM audit_event WHERE tenant_id=${plant.id} AND action LIKE 'intelligence.%'`,
			)
		).n,
		0,
	);
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM job WHERE kind='assessment' AND tenant_id=${plant.id}`)).n,
		0,
	);
	assert.equal(moved.state.phase, 2);
});

test("AC:CASE-NTF-009 a forward move notifies each connected organization once; declaration, backward and noop do not", async () => {
	const { plant, owner } = await church("Grace Commons");
	const church1 = await connect(plant, "sending_church");
	const network = await connect(plant, "sending_network");
	let revision = await revisionOf(plant);
	// A declaration is not an advance.
	revision = ok(await declare(owner, 2, revision)).state.revision;
	assert.deepEqual(await noticesFor(plant), []);
	// A skip forward is an advance: one notice for each organization, owned by it, to its Owner.
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
	// A replay of the same move adds nothing.
	assert.deepEqual(ok(await move(owner, 4, "Training is complete", revision, key)), advance);
	assert.equal((await noticesFor(plant)).length, 2);
	// A backward correction and a noop add nothing.
	revision = ok(await move(owner, 3, "Pre-launch was too early", advance.state.revision)).state.revision;
	ok(await move(owner, 3, "Still here", revision));
	assert.equal((await noticesFor(plant)).length, 2);
	// Ending one organization's link leaves the other organization's notice in place, and later advances reach it alone.
	await f.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE organization_id=${church1.org.id}`);
	assert.ok((await noticesFor(plant)).every((n) => n.cancelled_at === null));
	ok(await move(owner, 4, "Pre-launch for real", revision));
	const last = await noticesFor(plant);
	assert.equal(last.length, 3);
	assert.equal(last.at(-1).tenant_id, network.org.id);
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
	assert.equal(ok(await history(admin)).entries.length, 1);
	// The Admin's seat ends after the request read its actor: the next read returns no history body, and writes fail.
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${admin.id}`);
	const gone = refused(await history(admin), "access_denied");
	assert.deepEqual(gone.details, {});
	refused(await move(admin, 3, "After the seat ended", revision), "access_denied");
	assert.deepEqual(await footprint(plant), before);
	ok(await history(owner));
});
