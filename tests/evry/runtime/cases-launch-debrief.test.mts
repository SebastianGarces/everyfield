import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createLaunchReader } from "../../../packages/domain/src/launch/reads.ts";
import { createLaunchWriter } from "../../../packages/domain/src/launch/writes.ts";
import { captureFacts, createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { approveProposal } from "../../../packages/evry/src/index.ts";
import { nativePorts } from "../evals/settings-ports.mts";
import { ok, type Actor } from "../../support/fixture.mts";
import {
	caseWorld,
	NOW,
	proposes,
	reads,
	refusal,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Play,
	type Reply,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("caselchdebrief", { native: nativePorts() });
});
after(() => w?.close());

const reader = createLaunchReader();
const writer = createLaunchWriter({ notices: async () => undefined });
const BLANK = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
const planOf = async (who: Actor): Promise<Reply> => ok(await reader.readPlan(w.db, await w.authorityOf(who))).plan;
async function launched(c: Church, attendance = 40) {
	const auth = await w.authorityOf(c.A);
	let p = await planOf(c.A);
	ok(
		await writer.schedule(w.db, auth, {
			requestKey: randomUUID(),
			expectedRevision: p.launch?.revision ?? p.revision,
			input: { date: "2026-10-20", reason: null },
		}),
	);
	await w.admin.execute(sql`UPDATE launch SET target_date='2026-10-11' WHERE plant_id=${c.P.id}`);
	p = await planOf(c.A);
	ok(
		await writer.recordOutcome(w.db, auth, {
			requestKey: randomUUID(),
			expectedRevision: p.revision,
			input: { actualDate: "2026-10-11", attendance, decisions: null, note: null },
		}),
	);
}
async function submit(who: Actor, answers: object) {
	const p = await planOf(who);
	return ok(
		await writer.submitDebrief(w.db, await w.authorityOf(who), {
			requestKey: randomUUID(),
			expectedRevision: p.debrief.draft?.revision ?? "0",
			input: { draftId: p.debrief.draft?.id ?? null, answers: { ...BLANK, ...answers } },
		}),
	);
}
async function draft(who: Actor, answers: object) {
	const p = await planOf(who);
	return ok(
		await writer.saveDebriefDraft(w.db, await w.authorityOf(who), {
			requestKey: randomUUID(),
			expectedRevision: p.debrief.draft?.revision ?? "0",
			input: { draftId: p.debrief.draft?.id ?? null, answers: { ...BLANK, ...answers } },
		}),
	);
}
async function privateCare(who: Actor, note: string) {
	await w.admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${who.id}`);
	const care = createPrivateCare();
	const authority = await w.authorityOf(who);
	const current = ok(await care.readCurrent(w.db, authority, {}));
	const answers = { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" };
	ok(
		await care.save(w.db, authority, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: { answers, note },
		}),
	);
}
async function visionFollowUps(c: Church, contacted: number) {
	const record = (id: string, kind: string) =>
		w.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${c.P.id}) ON CONFLICT DO NOTHING`);
	const meeting = randomUUID();
	await record(meeting, "meeting");
	await w.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision,actual_occurrence_at,vision_number) VALUES(${meeting},${c.P.id},'vision_meeting','2026-09-20',
		'18:00','America/Chicago','2026-09-20T23:00:00Z','r1','completed',1,'2026-09-20T23:00:00Z',1)`);
	for (let i = 0; i < contacted; i++) {
		const person = await c.person(`Vision Guest ${i + 1}`);
		const [obligation, task, outcome] = [randomUUID(), randomUUID(), randomUUID()];
		await record(obligation, "obligation");
		await record(task, "task");
		await record(outcome, "contact_outcome");
		await w.admin
			.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
			formula_version,due_date) VALUES(${obligation},${c.P.id},${meeting},${person},'follow_up','2026-09-20T23:00:00Z',
			'2026-09-20','America/Chicago','f1','2026-09-22')`);
		await w.admin
			.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,
			completed_at) VALUES(${task},${c.P.id},'Follow up','follow_up','medium','complete','2026-09-20T23:00:00Z','undated',
			${obligation},'2026-09-21T09:00:00Z')`);
		await w.admin
			.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,task_id,obligation_id,outcome,occurred_at,
			recorded_at,completes_task) VALUES(${outcome},${c.P.id},${person},${task},${obligation},'contacted',
			'2026-09-21T09:00:00Z','2026-09-21T09:00:00Z',true)`);
	}
}
const phaseAudits = (c: Church) =>
	w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${c.P.id} AND action LIKE 'phase.%'`);

test("AC:B02-022 Evry reads the same 3 unnamed guests as the native plan, a review of a changed debrief is refused as a revision conflict, and no private care reaches the model", async () => {
	const c = await w.church();
	await launched(c);
	await privateCare(c.A, "CARE-CANARY");
	await submit(c.A, { missingNames: "yes", missingCount: 3, supportNeeded: "Pray for the team" });
	assert.deepEqual((await planOf(c.A)).evidence.guestNamesEntered, { status: "not_met", remaining: 3 }, "native");
	const said = "How many Launch Sunday guests are still not entered by name? Mark them all entered.";
	const read = reads("launch.readDebrief", {});
	const asked = await w.ask(c.A, said, [read, proposes("launch.submitDebrief", { guestsNotNamed: 0 })]);
	const [debrief] = asked.replies;
	assert.deepEqual(
		[debrief.facts.guestsNotNamed, debrief.facts.attendance, debrief.facts.debrief, debrief.facts.debriefSubmitted],
		[3, 40, "submitted", true],
		"Evry remaining",
	);
	assert.ok(asked.offered.includes("launch.readDebrief"));
	const [card] = asked.proposals;
	assert.ok(card, JSON.stringify(asked.replies));
	assert.equal(card.status, "pending");
	assert.equal((await planOf(c.A)).evidence.guestNamesEntered.remaining, 3, "nothing changes before approval");
	await draft(c.A, { wentWell: "Another tab" });
	const stale = await w.approve(c.A, card);
	assert.deepEqual([stale.review.outcome, stale.review.receipt?.code], ["refused", "revision_conflict"], "stale");
	assert.deepEqual((await planOf(c.A)).evidence.guestNamesEntered, { status: "not_met", remaining: 3 });
	const told = JSON.stringify([asked.prompts, asked.replies, asked.saved, stale.review]);
	assert.equal(told.includes("CARE-CANARY"), false, "private care");
	assert.deepEqual(
		asked.offered.filter((o) => /care|personalCalendar/i.test(o)),
		[],
	);
	const fresh = await w.ask(c.A, said, [proposes("launch.submitDebrief", { guestsNotNamed: 0 })]);
	assert.equal((await w.approve(c.A, fresh.proposals[0]!)).review.outcome, "completed");
	assert.deepEqual((await planOf(c.A)).evidence.guestNamesEntered, { status: "met", remaining: null });
	await c.foreign(said, [read], { secrets: ["CARE-CANARY", "Pray for the team"] });
});

test("AC:LAUNCH46-020 only a current Owner or Admin of the plant writes a guest or the debrief through a fresh review; a Member, a foreign Admin, a revoked Admin and a stale review write nothing", async () => {
	const c = await w.church();
	await launched(c);
	const owner = await w.seated(c.P, "owner");
	const member = await w.seated(c.P, "member");
	const revoked = await w.seated(c.P, "admin");
	const foreignAdmin = await w.seated(c.Q, "admin");
	const said = "Add this Launch Sunday guest.";
	const guests = async () =>
		(
			await w.rows<{
				name: string;
			}>(sql`SELECT pe.display_name AS name FROM launch_guest g JOIN person pe ON pe.id=g.person_id
			WHERE g.plant_id=${c.P.id} ORDER BY pe.display_name`)
		).map((r) => r.name);
	const write = async (who: Actor, name: string) => {
		const asked = await w.ask(who, said, [proposes("launch.addGuestAttendance", { displayName: name })]);
		const [card] = asked.proposals;
		if (!card || card.review.refusal) return false;
		return (await w.approve(who, card)).review.outcome === "completed";
	};
	const revokedCard = (await w.ask(revoked, said, [proposes("launch.addGuestAttendance", { displayName: "Ivy" })]))
		.proposals[0]!;
	assert.equal(revokedCard.status, "pending");
	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${revoked.id}`);

	const allowed = [
		await write(owner, "Mara"),
		await write(c.A, "Noor"),
		await w.quiet(async () => {
			const asked = await w.ask(member, said, [proposes("launch.addGuestAttendance", { displayName: "Theo" })]);
			assert.deepEqual([asked.replies[0].error, asked.proposals], ["not_offered", []]);
			return false;
		}),
		await write(foreignAdmin, "Theo"),
		await (async () => {
			const who = await w.actorOf(revoked);
			const code = await refusal(approveProposal(w.db, who, revokedCard.id, w.witness(revokedCard), null));
			assert.equal(code, "not_found", "a revoked seat's review is gone");
			return false;
		})(),
	];
	assert.deepEqual(allowed, [true, true, false, false, false], "fresh write allowed");
	assert.deepEqual(await guests(), ["Mara", "Noor"]);
	assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM launch_guest WHERE plant_id=${c.Q.id}`), 0);
	const pending = await w.ask(c.A, said, [proposes("launch.addGuestAttendance", { displayName: "June" })]);
	await c.foreignReview(pending.proposals[0]!);

	const debrief = await w.ask(c.A, "Submit the debrief: no guests are missing.", [
		proposes("launch.submitDebrief", { guestsNotNamed: 0 }),
	]);
	await draft(owner, { wentWell: "Owner changed the draft" });
	const stale = await w.approve(c.A, debrief.proposals[0]!);
	assert.deepEqual([stale.review.outcome, stale.review.receipt?.code], ["refused", "revision_conflict"]);
	assert.equal((await planOf(c.A)).debrief.submitted, null, "the stale review submitted nothing");
	assert.deepEqual(await guests(), ["Mara", "Noor"]);
});

const PHASE6: Play = [
	reads("intelligence.readExitCriteria", { phase: 6 }),
	reads("launch.readWorkspace", { filter: "all" }),
];
async function phaseSix() {
	const c = await w.church({ phase: 6 });
	await launched(c, 50);
	const alex = await c.person("Alex");
	ok(
		await writer.addGuestAttendance(w.db, await w.authorityOf(c.A), {
			requestKey: randomUUID(),
			input: { personId: alex },
		}),
	);
	await visionFollowUps(c, 2);
	const facts = await captureFacts(w.db, c.P.id, NOW);
	assert.deepEqual(
		[facts!.followUps.status, facts!.followUps.measured, facts!.followUps.onTime, facts!.followUps.contacted],
		["measured", 2, 2, 2],
		"the prelaunch Vision follow-ups succeeded within 48 hours",
	);
	return c;
}
function noPostlaunchSignal(asked: { replies: Reply[] }) {
	const [exit, workspace] = asked.replies;
	assert.deepEqual(rowsOf(exit, "criterion"), [], "exit criteria");
	assert.deepEqual(
		rowsOf(exit).map((r) => [r.kind, r.id, r.fields.phase, r.fields.current, r.fields.next]),
		[["phase", "6", "6", true, null]],
	);
	const keys = asked.replies.flatMap((r) => [
		...Object.keys(r.facts ?? {}),
		...rowsOf(r).flatMap((row) => Object.keys(row.fields ?? {})),
	]);
	assert.deepEqual(
		keys.filter((k) => /follow|contact|onTime|within/i.test(k)),
		[],
		"no postlaunch 48 hour follow-up is borrowed",
	);
	assert.equal(workspace.facts.countdown, "completed");
}

test("AC:CASE-LCH-011 Phase 6 with a named Launch guest and successful prelaunch Vision follow-ups reads no postlaunch 48 hour follow-up and no exit criterion", async () => {
	const c = await phaseSix();
	const before = await phaseAudits(c);
	const asked = await w.quiet(() =>
		w.ask(c.A, "Did we follow up with our Launch Sunday guests within 48 hours?", [
			...PHASE6,
			reads("launch.readDebrief", {}),
		]),
	);
	noPostlaunchSignal(asked);
	const debrief = asked.replies[2];
	assert.deepEqual(
		rowsOf(debrief, "person").map((r) => r.label),
		["Alex"],
	);
	assert.equal((await w.one(sql`SELECT phase FROM plant WHERE id=${c.P.id}`)).phase, 6, "phase 6");
	assert.equal(await phaseAudits(c), before);
});

test("AC:GAP-LCH-011 Phase 6 with Sunday headcount 50 and prelaunch Vision follow-ups leaves the postlaunch contact signal unmeasured with no criterion and no phase change; a foreign context and a source outage answer nothing", async () => {
	const c = await phaseSix();
	const before = await phaseAudits(c);
	const said = "Are we meeting the 48 hour guest follow-up after launch in Phase 6?";
	const asked = await w.quiet(() => w.ask(c.A, said, PHASE6));
	noPostlaunchSignal(asked);
	assert.equal((await planOf(c.A)).outcome.attendance, 50);
	assert.deepEqual(
		[(await w.one(sql`SELECT phase FROM plant WHERE id=${c.P.id}`)).phase, await phaseAudits(c)],
		[6, before],
		"automatic phase changes",
	);
	const foreign = await c.foreign(said, PHASE6, { secrets: ["Vision Guest", "Alex", c.P.id] });
	assert.equal(foreign.replies[0].error, "not_offered", "the foreign context is refused");
	await c.outage(said, [reads("intelligence.readExitCriteria", { phase: 6 })], "launch");
	assert.deepEqual((await planOf(c.A)).outcome.attendance, 50, "prior committed outcomes retained");
});
