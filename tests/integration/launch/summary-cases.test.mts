import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { instant, type Clock } from "../../../packages/contracts/src/common/index.ts";
import {
	captureFacts,
	createAssessmentJob,
	createAssessments,
	createPrivateCare,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { getPlant } from "../../../packages/domain/src/oversight/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok, refused } from "../../support/fixture.mts";
import { CANARY, ZONE } from "../intelligence/assessment-church.mts";
import { BLANK, launchWorld, NOW, type LaunchWorld, type Who } from "./debrief-world.mts";

let w: LaunchWorld;
before(async () => {
	w = await launchWorld("lchsummary");
	await w.release("methodology-2026.11");
});
after(() => w?.database.close());

const at = (iso: string): Clock => ({ now: () => instant.parse(new Date(iso).toISOString()) });
const job = createAssessmentJob();
const assessments = createAssessments();
async function publishRun(who: Who) {
	ok(await assessments.requestRefresh(w.db, who.actor, { requestId: randomUUID() }));
	await runAssessmentBatch(job, w.db, scriptedAssessmentDrafter(), 20);
	const current = ok(await assessments.readAssessment(w.db, who.actor, {})).current;
	assert.ok(current, "a published run");
	return current;
}
const available = (runId: string, iso: string) =>
	w.admin.execute(sql`UPDATE assessment_run SET available_at=${iso}::timestamptz WHERE id=${runId}`);
async function network(name: string) {
	const org = await w.database.organization("sending_network", { name, timezone: ZONE });
	return { org, director: await w.orgSeat(org) };
}
async function shared(name: string, input: object = {}, { harvest = false } = {}) {
	const n = await network(`${name} Network`);
	const c = await w.launched(input, { harvest, name, network: harvest ? n.org : undefined });
	if (harvest) await w.admin.execute(sql`UPDATE affiliation SET share_meetings=true WHERE plant_id=${c.p.id}`);
	else await w.link(c.p, n.org, { findings: true, meetings: true });
	return { ...c, ...n };
}
const released = async (director: Awaited<ReturnType<LaunchWorld["orgSeat"]>>, plant: { id: string }, iso?: string) =>
	(await getPlant(w.db, director, plant.id, () => {}, iso ? at(iso) : undefined))!.assessment;
const modelBytes = async (plant: { id: string }) =>
	JSON.stringify(
		await w.rows(sql`SELECT facts,model_input,drafts,result,delta FROM assessment_run WHERE plant_id=${plant.id}`),
	);
const launchBytes = async (plant: { id: string }) =>
	JSON.stringify([
		await w.rows(sql`SELECT * FROM launch_debrief WHERE plant_id=${plant.id}`),
		await w.rows(sql`SELECT * FROM launch_summary WHERE plant_id=${plant.id}`),
		await w.rows(sql`SELECT before_value,after_value,metadata,reason FROM audit_event WHERE tenant_id=${plant.id}
			AND action LIKE 'launch.%'`),
	]);
const SHARED_KEYS = ["body", "publishedAt", "version"];

test("AC:B02-030 the separately reviewed public summary is shared as written, with no raw questionnaire and no embargoed model result", async () => {
	const c = await shared("Cedar Church", {}, { harvest: true });
	const run = await publishRun(c.owner);
	await available(run.runId, "2026-10-13T15:00:00.000Z");
	let p = ok(
		await w.debrief(
			c.owner,
			await w.plan(c.owner),
			{ wentWell: "RAW-REFLECTION Mara cried", supportNeeded: "Pray for June", missingNames: "no" },
			true,
		),
	).plan;
	p = ok(await w.summary(c.owner, p, "Service held. Next review is Tuesday.", true)).plan;
	const summary = await w.reader.readPublishedSummary(w.db, c.director, c.p.id);
	assert.deepEqual(Object.keys(summary!).sort(), SHARED_KEYS, "raw answers are not part of it");
	assert.equal(summary!.body, "Service held. Next review is Tuesday.");
	const assessment = await released(c.director, c.p, NOW);
	assert.deepEqual(assessment, { status: "not_assessed" }, "no model result while it is embargoed");
	const told = JSON.stringify([summary, await getPlant(w.db, c.director, c.p.id, () => {}, at(NOW))]);
	for (const raw of ["RAW-REFLECTION", "Mara cried", "Pray for June", run.runId])
		assert.equal(told.includes(raw), false, `no ${raw}`);
	assert.equal(p.summary!.published[0]!.body, summary!.body);
});

test("AC:B02-031 the debrief and summary import no private check-in: the care canary is in neither the model's bytes nor the published summary", async () => {
	const c = await shared("Juniper Church", {}, { harvest: true });
	const care = JSON.stringify(ok(await createPrivateCare().readCurrent(w.db, c.owner.actor, {})));
	assert.ok(care.includes(CANARY), "the planter's own check-in holds the canary");
	const before = await w.footprint(c.p);
	for (const input of [
		{ draftId: null, answers: { ...BLANK, missingNames: "no" }, privateCare: { note: CANARY } },
		{ draftId: null, answers: { ...BLANK, missingNames: "no", careNote: CANARY } },
		{ draftId: null, answers: { ...BLANK, missingNames: "no" }, importFrom: "personal_calendar" },
	])
		refused(
			await w.writer.submitDebrief(w.db, c.owner.actor, { requestKey: w.key(), expectedRevision: "0", input }),
			"invalid_input",
		);
	assert.deepEqual(await w.footprint(c.p), before, "no import path writes anything");
	let p = ok(
		await w.debrief(c.owner, await w.plan(c.owner), { supportNeeded: "Pray for the team", missingNames: "no" }, true),
	).plan;
	p = ok(await w.summary(c.owner, p, "Service held.", true)).plan;
	await publishRun(c.owner);
	const model = await modelBytes(c.p);
	assert.ok(model.includes("committedAdults"), "the model input was captured");
	const summary = JSON.stringify([
		await w.reader.readPublishedSummary(w.db, c.director, c.p.id),
		p,
		await launchBytes(c.p),
	]);
	assert.deepEqual(
		[model.split(CANARY).length - 1, summary.split(CANARY).length - 1],
		[0, 0],
		"private values in the model and in the summary",
	);
});

test("AC:LAUNCH46-015 a saved summary draft publishes nothing and no raw answer is ever published; publishing is its own reviewed step", async () => {
	const c = await shared("Alder Church");
	let p = ok(
		await w.debrief(
			c.owner,
			await w.plan(c.owner),
			{ wentWell: "RAW-REFLECTION: I nearly quit", missingNames: "no" },
			true,
		),
	).plan;
	p = ok(await w.summary(c.owner, p, "We held a service and will review team coverage.")).plan;
	assert.deepEqual(
		[p.summary!.draft!.body, p.summary!.published],
		["We held a service and will review team coverage.", []],
	);
	assert.equal(await w.reader.readPublishedSummary(w.db, c.director, c.p.id), null, "published summary");
	const orgView = async () =>
		JSON.stringify([
			await w.reader.readPublishedSummary(w.db, c.director, c.p.id),
			await getPlant(w.db, c.director, c.p.id),
		]);
	assert.equal((await orgView()).includes("RAW-REFLECTION"), false);
	p = ok(await w.summary(c.owner, p, "We held a service and will review team coverage.", true)).plan;
	const view = await orgView();
	assert.ok(view.includes("We held a service and will review team coverage."));
	assert.equal(view.includes("RAW-REFLECTION"), false, "raw answer publication");
	assert.equal((await launchBytes(c.p)).split("RAW-REFLECTION").length - 1, 1, "only the debrief row holds it");
});

test("AC:LAUNCH46-016 the published summary goes to an organization with shared findings and every source category it draws on, never to one without, a stranger or an ended link", async () => {
	const c = await w.launched();
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "no" }, true)).plan;
	p = ok(await w.summary(c.owner, p, "Service held.", true)).plan;
	const [s1, n1, s2, stranger] = [
		await network("S1"),
		await network("N1"),
		await network("S2"),
		await network("Stranger"),
	];
	const s1Link = await w.link(c.p, s1.org, { findings: true, meetings: true, people: false });
	await w.link(c.p, n1.org, { findings: false, meetings: true, people: true });
	const s2Link = await w.link(c.p, s2.org, { findings: true, meetings: true, people: true });
	const read = async (o: { director: Awaited<ReturnType<LaunchWorld["orgSeat"]>> }) =>
		(await w.reader.readPublishedSummary(w.db, o.director, c.p.id))?.body ?? null;
	assert.deepEqual(
		(await w.one(sql`SELECT source_categories FROM launch_summary WHERE plant_id=${c.p.id}`)).source_categories,
		["meetings"],
		"a planter's summary draws on Meetings",
	);
	assert.deepEqual(
		[await read(s1), await read(n1), await read(s2), await read(stranger)],
		["Service held.", null, "Service held.", null],
	);
	await w.admin.execute(sql`UPDATE launch_summary SET source_categories='{meetings,people}' WHERE plant_id=${c.p.id}`);
	assert.deepEqual(
		[await read(s1), await read(n1), await read(s2)],
		[null, null, "Service held."],
		"a People source needs People shared too",
	);
	await w.admin.execute(sql`UPDATE launch_summary SET source_categories='{meetings}' WHERE plant_id=${c.p.id}`);
	await w.admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${s1Link}`);
	assert.deepEqual([await read(s1), await read(s2)], [null, "Service held."], "the second affiliate stays valid");
	await w.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE id=${s2Link}`);
	assert.equal(await read(s2), null);
	assert.equal(await w.reader.readPublishedSummary(w.db, c.owner.actor, c.p.id), null, "a plant seat is no org read");
});

test("AC:LAUNCH46-017 the published summary is exactly the reviewed human text: no guest row, no private support reflection and no model rewrite", async () => {
	const c = await shared("Rowan Church", {}, { harvest: true });
	ok(await w.guest(c.owner, { displayName: "Alex Rivera" }));
	let p = ok(
		await w.debrief(
			c.owner,
			await w.plan(c.owner),
			{ supportNeeded: "CARE-CANARY private reflection", missingNames: "no" },
			true,
		),
	).plan;
	p = ok(await w.summary(c.owner, p, "Service held. Alex Rivera came. CARE-CANARY")).plan;
	const jobs = (await w.footprint(c.p)).jobs;
	p = ok(await w.summary(c.owner, p, "Service held. Team review Tuesday.", true)).plan;
	assert.equal((await w.footprint(c.p)).jobs, jobs, "no model or redaction job ran");
	assert.deepEqual(
		p.summary!.published.map((s) => s.body),
		["Service held. Team review Tuesday."],
	);
	const summary = await w.reader.readPublishedSummary(w.db, c.director, c.p.id);
	assert.deepEqual(Object.keys(summary!).sort(), SHARED_KEYS, "guest rows");
	assert.equal(summary!.body, "Service held. Team review Tuesday.", "published");
	const view = JSON.stringify([summary, await getPlant(w.db, c.director, c.p.id)]);
	for (const secret of ["Alex Rivera", "CARE-CANARY", CANARY])
		assert.equal(view.includes(secret), false, `no ${secret}`);
});

test("AC:LAUNCH46-018 a summary published at 15:00 is available while the 14:00 assessment stays embargoed with no planter open", async () => {
	const c = await shared("Linden Church", {}, { harvest: true });
	const run = await publishRun(c.owner);
	await available(run.runId, "2026-10-13T14:00:00.000Z");
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "no" }, true)).plan;
	p = ok(await w.summary(c.owner, p, "Service held.", true)).plan;
	await w.admin.execute(
		sql`UPDATE launch_summary SET published_at='2026-10-13T15:00:00Z' WHERE plant_id=${c.p.id} AND published_at IS NOT NULL`,
	);
	const summary = await w.reader.readPublishedSummary(w.db, c.director, c.p.id);
	assert.deepEqual([summary!.body, summary!.publishedAt], ["Service held.", "2026-10-13T15:00:00.000Z"]);
	assert.deepEqual(await released(c.director, c.p, NOW), { status: "not_assessed" }, "assessment released");
	assert.equal((await w.footprint(c.p)).seen, 0, "no eligible open");
	const later = await released(c.director, c.p, "2026-10-16T14:00:00.000Z");
	assert.ok(later.status === "released" && String(later.runId) === String(run.runId), "it is held, not missing");
});

test("AC:LAUNCH46-019 publishing a summary that names a next step makes no task, contact, email or phase change", async () => {
	const c = await w.launched();
	await w.person(c.p, "Alex");
	let p = ok(await w.debrief(c.owner, await w.plan(c.owner), { missingNames: "no" }, true)).plan;
	const before = await w.footprint(c.p);
	p = ok(await w.summary(c.owner, p, "Next step: call Alex", true)).plan;
	const after = await w.footprint(c.p);
	assert.deepEqual(
		{
			new_tasks: after.tasks - before.tasks,
			contacts: after.contacts - before.contacts,
			obligations: after.obligations - before.obligations,
			emails: after.mail - before.mail,
			notices: after.notices - before.notices,
			people: after.people - before.people,
			phase: after.phase,
		},
		{ new_tasks: 0, contacts: 0, obligations: 0, emails: 0, notices: 0, people: 0, phase: 1 },
	);
	assert.deepEqual([after.summaries, after.audits], [before.summaries + 1, before.audits + 1]);
	assert.equal(p.summary!.published[0]!.body, "Next step: call Alex");
});

test("AC:B02-026 an Admin's open at Oct 12 16:00 releases the Oct 10 16:00 result then; with no open it releases 72 hours after availability", async () => {
	const a = await shared("Opened Church", {}, { harvest: true });
	const b = await shared("Unopened Church", {}, { harvest: true });
	const [ra, rb] = [await publishRun(a.owner), await publishRun(b.owner)];
	for (const r of [ra, rb]) await available(r.runId, "2026-10-10T16:00:00.000Z");
	ok(
		await createAssessments({ clock: at("2026-10-12T16:00:00.000Z") }).markAssessmentSeen(w.db, a.admin.actor, {
			runId: ra.runId,
		}),
	);
	assert.deepEqual(
		await w.rows(sql`SELECT account_id,to_char(seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at
			FROM assessment_seen WHERE run_id=${ra.runId}`),
		[{ account_id: a.admin.id, at: "2026-10-12T16:00:00Z" }],
	);
	const status = async (c: typeof a, iso: string) => {
		const r = await released(c.director, c.p, iso);
		return r.status === "released" ? r.runId : r.status;
	};
	assert.deepEqual(
		[await status(a, "2026-10-12T15:59:59.000Z"), await status(a, "2026-10-12T16:00:00.000Z")],
		["not_assessed", ra.runId],
		"release on open: 2026-10-12T16:00:00Z",
	);
	assert.deepEqual(
		[await status(b, "2026-10-13T15:59:59.000Z"), await status(b, NOW)],
		["not_assessed", rb.runId],
		"release without open: 2026-10-13T16:00:00Z",
	);
});

test("AC:B02-027 an email, the model and another Member reading the result give no eligible open, so it stays embargoed until 72 hours after availability", async () => {
	const c = await shared("Quiet Read Church", {}, { harvest: true });
	ok(await assessments.requestRefresh(w.db, c.owner.actor, { requestId: randomUUID() }));
	assert.deepEqual(
		await released(c.director, c.p, "2099-01-01T00:00:00.000Z"),
		{ status: "not_assessed" },
		"a queued draft starts no clock",
	);
	const run = await publishRun(c.owner);
	await available(run.runId, "2026-10-10T17:00:00.000Z");
	assert.equal((await modelBytes(c.p)).includes("committedAdults"), true, "the model read the plant's facts");
	refused(await assessments.readAssessment(w.db, c.member.actor, {}), "access_denied");
	refused(await assessments.markAssessmentSeen(w.db, c.member.actor, { runId: run.runId }), "access_denied");
	refused(await assessments.markAssessmentSeen(w.db, c.director, { runId: run.runId }), "access_denied");
	assert.equal(ok(await assessments.readAssessment(w.db, c.owner.actor, {})).seen, false, "a delivery is no open");
	const quiet = await w.footprint(c.p);
	assert.deepEqual([quiet.seen, quiet.mail], [0, 0], "no open and no assessment email to stand in for one");
	assert.deepEqual(await released(c.director, c.p, NOW), { status: "not_assessed" }, "released");
	assert.deepEqual(
		await released(c.director, c.p, "2026-10-13T16:59:59.000Z"),
		{ status: "not_assessed" },
		"72 hours start at durable availability",
	);
	const due = await released(c.director, c.p, "2026-10-13T17:00:00.000Z");
	assert.ok(due.status === "released" && String(due.runId) === String(run.runId));
	assert.equal(
		(await w.one(sql`SELECT min(seen_at) AS at FROM assessment_seen WHERE run_id=${run.runId}`)).at,
		null,
		"eligible open at",
	);
});

test("AC:B02-028 while a new result is embargoed the organization keeps the previous released one only under current shared findings and categories; the planter keeps both", async () => {
	const c = await shared("Prior Church", {}, { harvest: true });
	await w.admin.execute(sql`UPDATE affiliation SET share_people=true,share_tasks=true,share_ministry_teams=true
		WHERE plant_id=${c.p.id}`);
	const r0 = await publishRun(c.owner);
	ok(await assessments.markAssessmentSeen(w.db, c.owner.actor, { runId: r0.runId }));
	const r1 = await publishRun(c.owner);
	assert.notEqual(r1.runId, r0.runId);
	const prior = await released(c.director, c.p);
	assert.ok(prior.status === "released" && String(prior.runId) === String(r0.runId), "the previous released result");
	assert.deepEqual(prior.concerns, ok(await assessments.readRun(w.db, c.owner.actor, { runId: r0.runId })).concerns);
	await w.admin.execute(sql`UPDATE affiliation SET share_people=false,share_meetings=false,share_tasks=false,
		share_ministry_teams=false WHERE plant_id=${c.p.id}`);
	const narrowed = await released(c.director, c.p);
	assert.ok(narrowed.status === "released" && String(narrowed.runId) === String(r0.runId));
	assert.equal(narrowed.concerns.length + narrowed.withheld, prior.concerns.length, "categories gate each concern");
	await w.admin.execute(sql`UPDATE affiliation SET shared_findings=false WHERE plant_id=${c.p.id}`);
	assert.deepEqual(await released(c.director, c.p), { status: "withheld" }, "oversight result");
	assert.equal(JSON.stringify(await getPlant(w.db, c.director, c.p.id)).includes(r1.runId), false);
	const own = ok(await assessments.readAssessment(w.db, c.owner.actor, {}));
	const history = ok(await assessments.readHistory(w.db, c.owner.actor, {}));
	assert.deepEqual(
		[own.current!.runId, history.runs.map((r) => r.runId)],
		[r1.runId, [r1.runId, r0.runId]],
		"planter prior",
	);
});

test("AC:LAUNCH46-023 the Launch evidence carries submission, date and the missing count, and no raw reflection or private care reaches the Plant Intelligence bytes", async () => {
	const c = await shared("Willow Church", {}, { harvest: true });
	ok(
		await w.debrief(
			c.owner,
			await w.plan(c.owner),
			{
				wentWell: "PRIVATE-REFLECTION we were exhausted",
				supportNeeded: "CARE-CANARY",
				missingNames: "yes",
				missingCount: 3,
			},
			true,
		),
	);
	await w.admin.execute(
		sql`UPDATE launch_debrief SET submitted_at='2026-10-12T16:00:00Z' WHERE plant_id=${c.p.id} AND submitted_at IS NOT NULL`,
	);
	const p = await w.plan(c.owner);
	assert.deepEqual(p.evidence, {
		guestNamesEntered: { status: "not_met", remaining: 3 },
		debriefDone: { status: "met" },
		submittedAt: "2026-10-12T16:00:00.000Z",
	});
	const member = (await w.plan(c.member)).evidence;
	assert.deepEqual(member, p.evidence, "the bounded evidence, without the answers");
	await publishRun(c.owner);
	const pi = JSON.stringify([await modelBytes(c.p), await captureFacts(w.db, c.p.id, null)]);
	for (const secret of ["PRIVATE-REFLECTION", "exhausted", "CARE-CANARY", CANARY])
		assert.equal(pi.includes(secret), false, `no ${secret} in the Plant Intelligence bytes`);
	assert.equal(JSON.stringify(member).includes("PRIVATE-REFLECTION"), false);
});
