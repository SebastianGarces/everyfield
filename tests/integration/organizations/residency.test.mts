import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { seeds } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import {
	createOrganizationAdapter,
	pipelineWriter,
	programWriter,
	readEnrollment,
	readMyResidency,
	readResidencyLink,
	readPipelineBoard,
	readPipelinePersonRecord,
	readProgram,
	readResidentReading,
	readVersionReview,
	residentWriter,
} from "../../../packages/domain/src/organizations/index.ts";

// My residency and consented progress (REQ-MUL-003, -004, -013, -014) against a migrated database, through the real
// invitation service and organization adapter. Grace Austin (America/Chicago): Dana Owner, Luis Admin, Ana (Member)
// directs the residency. Casey Lee is enrolled and has a Discovery account at casey@example.test. Jordan Price is a
// second enrollee. Rae is someone else signed in with another email.

const GLOBAL = "00000000-0000-0000-0000-000000000000";
let f: Awaited<ReturnType<typeof fixture>>;
type Actor = { id: string; session: string; email: string };
let grace: { kind: "organization"; id: string; organizationKind: "sending_church" };
let dana: Actor, luis: Actor, ana: Actor, casey: Actor, rae: Actor;
const caseyPerson = randomUUID();
const jordanPerson = randomUUID();
const program = randomUUID();
const caseyEnrollment = randomUUID();
const jordanEnrollment = randomUUID();
const articles = { vision: randomUUID(), team: randomUUID(), other: randomUUID() };
let release = "";
const revisions = { vision: randomUUID(), teamGrace: randomUUID(), otherGrace: randomUUID() };

const authority = (a: { session: string }) => RequestActor.resolve(f.db, sessionId.parse(a.session));
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const record = async (a: Actor, personId = caseyPerson) =>
	ok(await readPipelinePersonRecord(f.db, await authority(a), { personId }));
const enrollment = async (a: Actor, enrollmentId = caseyEnrollment) =>
	ok(await readEnrollment(f.db, await authority(a), { enrollmentId }));
const mine = async () => ok(await readMyResidency(f.db, await authority(casey)));
const milestoneOf = <T extends { title: string }>(list: T[], title: string) => list.find((m) => m.title === title)!;

const adapter = createOrganizationAdapter(
	{
		invitation: async () => {
			throw Error("no relationship invitation here");
		},
		invalidate: (_tx, v) =>
			sql`UPDATE job SET state='superseded' WHERE subject_record_id=${sql.param(v.sourceId)} AND kind='digest' AND false`,
	},
	{ candidates: async () => [] },
);
/** One resident consent command as the web mount runs it: the account's write gate, then the adapter. */
async function asResident(name: "residency.setSharing" | "residency.leave", input: unknown) {
	const owner = { kind: "account" as const, id: casey.id };
	return f.db.transaction(async (tx) => {
		if (!(await RequestActor.claimWrite(tx, sessionId.parse(casey.session), owner))) throw Error("unavailable");
		return adapter[name](tx, sessionId.parse(casey.session), owner, input as never);
	});
}
async function linkRow() {
	return (
		await f.admin.execute(
			sql`SELECT id,revision::text AS revision,consent_revision::text AS consent FROM residency_link WHERE account_id=${casey.id}::uuid AND ended_at IS NULL`,
		)
	).rows[0] as { id: string; revision: string; consent: string } | undefined;
}
async function share(choices: { shareFoundations: boolean; shareMilestones: boolean }) {
	const l = (await linkRow())!;
	await asResident("residency.setSharing", {
		requestKey: randomUUID(),
		expectedRevision: l.revision,
		input: { linkId: l.id, expectedConsentRevision: l.consent, choices },
	});
}
/** What Casey's account holds: seats, organization connections and residency links, ended or not. */
async function accountState() {
	return (
		await f.admin.execute(sql`SELECT (SELECT count(*)::int FROM seat WHERE account_id=${casey.id}::uuid) AS seats,
	 (SELECT count(*)::int FROM affiliation WHERE account_id=${casey.id}::uuid) AS connections,
	 (SELECT count(*)::int FROM residency_link WHERE account_id=${casey.id}::uuid) AS links,
	 (SELECT registration_kind FROM account WHERE id=${casey.id}::uuid) AS kind,
	 (SELECT linked_account_id FROM person WHERE id=${caseyPerson}::uuid) AS linked`)
	).rows[0];
}
async function invite() {
	const r = await record(luis);
	const sent = await f.invitations.inviteResident(await authority(luis), {
		requestKey: randomUUID(),
		expectedRevision: r.organizationRevision,
		input: { organization: grace, personId: caseyPerson, recipientEmail: casey.email },
	});
	return { invitationId: sent.invitation.invitationId as string, proof: await f.proof(sent.invitation.invitationId) };
}
const claim = (i: { invitationId: string; proof: string }, rest: object) => ({
	requestKey: randomUUID(),
	expectedRevision: "1",
	input: { invitationId: i.invitationId, proof: i.proof, ...rest },
});

async function revision(
	id: string,
	article: string,
	tenant: string,
	title: string,
	slug: string,
	release: string | null,
) {
	await f.admin
		.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,
	 body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
	 VALUES(${id},${article},${tenant},${release},1,${title},${slug},${title},${tenant === GLOBAL ? "Body" : "[]"},
	  ${tenant === GLOBAL ? "safe_mdx" : "safe_nodes"},1,1,${randomBytes(32).toString("hex")},clock_timestamp(),true,1,
	  (SELECT id FROM reference_item WHERE canonical_key='framework/start'))`);
}

before(async () => {
	f = await fixture();
	const seed = seeds(f.admin);
	grace = (await seed.organization("sending_church", { name: "Grace Austin", timezone: "America/Chicago" })) as never;
	const staff = async (role: "owner" | "admin" | "member", name: string) => {
		const a = await seed.actor(grace as never, role, { user: { name } });
		return { id: a.id, session: a.session, email: a.email };
	};
	dana = await staff("owner", "Dana");
	luis = await staff("admin", "Luis");
	ana = await staff("member", "Ana");
	const discovery = async (email: string, name: string) => {
		const a = await seed.actor(null, "owner", { email, user: { name } });
		return { id: a.id, session: a.session, email };
	};
	casey = await discovery("casey@example.test", "Casey Lee");
	rae = await discovery("rae@example.test", "Rae");
	const anaSeat = (
		await f.admin.execute(
			sql`SELECT id FROM seat WHERE account_id=${ana.id}::uuid AND organization_id=${grace.id}::uuid`,
		)
	).rows[0]!.id as string;

	// Wiki: one global article, and two of Grace Austin's own published versions.
	release = randomUUID();
	await f.admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${randomUUID()},'section','framework/start',${GLOBAL})`,
	);
	for (const [name, article] of Object.entries(articles))
		await f.admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article',${"residency/" + name},${GLOBAL})`,
		);
	await f.admin
		.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,
	 approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
	 VALUES(${release},${"release-" + release},'memory://synthetic',${randomBytes(32).toString("hex")},'validated',clock_timestamp(),
	  clock_timestamp(),'memory://approval',${randomBytes(32).toString("hex")},'v','profile',1,${GLOBAL},0)`);
	await revision(revisions.vision, articles.vision, GLOBAL, "Casting vision", "framework/vision", release);
	await revision(revisions.teamGrace, articles.team, grace.id, "Building a launch team at Grace", "grace/team", null);
	await revision(revisions.otherGrace, articles.other, grace.id, "Grace staff handbook", "grace/handbook", null);
	for (const [article, rev] of [
		[articles.team, revisions.teamGrace],
		[articles.other, revisions.otherGrace],
	])
		await f.admin
			.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
	 VALUES(${randomUUID()},${grace.id},${article},'published',${rev},1)`);
	await f.admin
		.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
	 VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);

	// The pipeline: Casey with her email and no linked account, Jordan without one.
	const board = ok(await readPipelineBoard(f.db, await authority(dana), {}));
	const potential = board.stages.find((s) => s.label === "Potential leader")!.id;
	for (const [personId, displayName, email] of [
		[caseyPerson, "Casey Lee", "casey@example.test"],
		[jordanPerson, "Jordan Price", null],
	] as const)
		ok(
			await pipelineWriter.addPerson(f.db, await authority(dana), {
				personId,
				displayName,
				email,
				responsibleSeatId: null,
				stageId: potential,
			}),
		);

	// The residency, Ana directing, with a hands-on assignment and a reading list; Casey and Jordan enrolled.
	ok(
		await programWriter.createProgram(f.db, await authority(dana), {
			programId: program,
			kind: "residency",
			name: "Grace Residency",
			directorSeatId: anaSeat,
			plan: {
				rhythm: "monthly",
				expectedMonths: 15,
				stages: [
					{ label: "Assimilating", minMonths: 2, maxMonths: 3 },
					{ label: "Training and planning", minMonths: 6, maxMonths: 9 },
				],
				milestones: [
					["Present your vision to the sending church leadership", null],
					["Write a church planting prospectus", null],
					["Preach on a Sunday", "Preach at a Sunday gathering and debrief with Ana."],
				].map(([title, description]) => ({ lineage: randomUUID(), title, description, handsOn: description !== null })),
				readings: [{ revisionId: revisions.vision }, { revisionId: revisions.teamGrace }],
			},
		}),
	);
	const draft = (
		await f.admin.execute(sql`SELECT revision::text AS r FROM development_program WHERE id=${program}::uuid`)
	).rows[0]!.r as string;
	ok(await programWriter.publishVersion(f.db, await authority(ana), { programId: program, expectedRevision: draft }));
	const stage = (
		await f.admin
			.execute(sql`SELECT s.id FROM development_stage s JOIN development_program p ON p.current_version_id=s.version_id
	 WHERE p.id=${program}::uuid AND s.label='Assimilating'`)
	).rows[0]!.id as string;
	for (const [enrollmentId, personId] of [
		[caseyEnrollment, caseyPerson],
		[jordanEnrollment, jordanPerson],
	])
		ok(
			await programWriter.enroll(f.db, await authority(dana), {
				enrollmentId,
				programId: program,
				personId,
				cohort: "2026",
				startedOn: "2026-10-01",
				expectedEndOn: "2027-12-31",
				stageId: stage,
				nextMeetingAt: "2026-10-20T19:00:00",
			}),
		);
	// Before Casey links, Ana records and confirms one of her milestones in one step: a fact Grace Austin owns.
	const preach = (
		await f.admin
			.execute(sql`SELECT m.id FROM development_milestone m JOIN development_program p ON p.current_version_id=m.version_id
	 WHERE p.id=${program}::uuid AND m.title='Preach on a Sunday'`)
	).rows[0]!.id as string;
	ok(
		await programWriter.recordMilestone(f.db, await authority(ana), {
			enrollmentId: caseyEnrollment,
			milestoneId: preach,
			completedOn: "2026-10-12",
		}),
	);
	// Staff facts about Casey that My residency must never carry.
	const record0 = await record(dana);
	ok(
		await pipelineWriter.recordAssessment(f.db, await authority(dana), {
			personId: caseyPerson,
			expectedRevision: record0.revision,
			assessedOn: "2026-10-01",
			assessor: "Assessment Partners Ltd",
		}),
	);
	ok(
		await pipelineWriter.addNote(f.db, await authority(dana), {
			personId: caseyPerson,
			noteId: randomUUID(),
			body: "Private staff note on Casey",
		}),
	);
	const record1 = await record(dana);
	const resident = board.stages.find((s) => s.label === "Resident")!.id;
	ok(
		await pipelineWriter.movePerson(f.db, await authority(dana), {
			personId: caseyPerson,
			expectedRevision: record1.revision,
			stageId: resident,
			reason: "Secret stage move reason",
		}),
	);
});
after(() => f?.close());

test("an Admin invites Casey to link; the record shows it pending with its date; revoking kills the emailed link", async () => {
	assert.deepEqual((await record(luis)).residency, { status: "not_linked" });
	const sent = await invite();
	const pending = (await record(luis)).residency;
	assert.equal(pending.status, "pending");
	if (pending.status !== "pending") return;
	assert.equal(pending.invitationId, sent.invitationId);
	assert.equal(pending.recipientEmail, "casey@example.test");
	assert.match(pending.sentOn, /^\d{4}-\d{2}-\d{2}$/);
	// The email reached Casey's address.
	assert.ok(
		f.effects.some((e) => e.to === "casey@example.test" && e.text.includes("link your account to Grace Austin")),
	);
	assert.equal((await f.invitations.describe({ proof: sent.proof })).status, "pending");

	await f.invitations.revoke(await authority(luis), {
		requestKey: randomUUID(),
		expectedRevision: pending.revision,
		input: { invitationId: sent.invitationId },
	});
	assert.deepEqual(await f.invitations.describe({ proof: sent.proof }), { status: "unavailable" });
	assert.deepEqual((await record(luis)).residency, { status: "not_linked" });
	await assert.rejects(f.invitations.respondResident(casey.session, claim(sent, { decision: "decline" })));
});

test("someone with another email cannot accept; Casey's decline leaves her account as it was", async () => {
	const before = await accountState();
	const sent = await invite();
	await assert.rejects(
		f.invitations.respondResident(
			rae.session,
			claim(sent, { decision: "accept", choices: { shareFoundations: true, shareMilestones: true } }),
		),
	);
	assert.equal((await f.admin.execute(sql`SELECT count(*)::int AS n FROM residency_link`)).rows[0]!.n, 0);
	const declined = await f.invitations.respondResident(casey.session, claim(sent, { decision: "decline" }));
	assert.equal(declined.status, "declined");
	assert.deepEqual(await accountState(), before);
	assert.deepEqual(ok(await readMyResidency(f.db, await authority(casey))), { status: "not_linked" });
});

test("Casey accepts sharing milestone progress only: no seat, still a Discovery account, and Grace Austin sees her linked", async () => {
	const sent = await invite();
	const accepted = await f.invitations.respondResident(
		casey.session,
		claim(sent, { decision: "accept", choices: { shareFoundations: false, shareMilestones: true } }),
	);
	assert.equal(accepted.status, "accepted");
	const state = await accountState();
	assert.equal(state.seats, 0);
	assert.equal(state.kind, "discovery");
	assert.equal(state.links, 1);
	// Her session still has no seat: it acts as her own account.
	assert.equal((await authority(casey)).actor.context.kind, "account");
	assert.deepEqual((await record(luis)).residency, { status: "linked" });
	assert.equal((await readResidencyLink(f.db, await authority(casey)))?.organizationName, "Grace Austin");
	assert.equal(await readResidencyLink(f.db, await authority(rae)), null);
	assert.deepEqual((await enrollment(ana)).resident, {
		status: "linked",
		milestones: "shared",
		foundations: { status: "not_shared" },
	});
});

test("My residency shows the program, program stage, next meeting in Casey's zone, milestones and reading, and no staff facts", async () => {
	const view = await mine();
	assert.equal(view.status, "linked");
	if (view.status !== "linked") return;
	assert.equal(view.organizationName, "Grace Austin");
	assert.deepEqual(view.sharing, { shareMilestones: true, shareFoundations: false });
	assert.equal(view.timezone, "America/Chicago");
	const [e] = view.enrollments;
	assert.equal(view.enrollments.length, 1);
	assert.deepEqual(e!.program, { name: "Grace Residency", kind: "residency", director: "Ana" });
	assert.equal(e!.stage, "Assimilating");
	assert.deepEqual(e!.nextMeeting, {
		at: "2026-10-20T19:00:00",
		churchAt: "2026-10-20T19:00:00",
		churchTimezone: "America/Chicago",
	});
	assert.deepEqual(
		e!.milestones.map((m) => [m.title, m.completion]),
		[
			["Present your vision to the sending church leadership", null],
			["Write a church planting prospectus", null],
			[
				"Preach on a Sunday",
				{ completedOn: "2026-10-12", confirmedOn: e!.milestones[2]!.completion?.confirmedOn, source: "program_leader" },
			],
		],
	);
	assert.deepEqual(
		e!.readings.map((r) => [r.title, r.source, r.available, r.slug]),
		[
			["Casting vision", "global", true, "framework/vision"],
			["Building a launch team at Grace", "organization", true, null],
		],
	);
	// Nothing the staff record about Casey is in the payload.
	const text = JSON.stringify(view);
	for (const hidden of [
		"Resident",
		"Potential leader",
		"Secret stage move reason",
		"Private staff note",
		"Assessment Partners",
	])
		assert.ok(!text.includes(hidden), hidden);

	// In another zone, the meeting moves to her own time and still names the church's.
	await f.admin.execute(sql`UPDATE account SET personal_timezone='America/Los_Angeles' WHERE id=${casey.id}::uuid`);
	const moved = await mine();
	assert.equal(moved.status === "linked" && moved.timezone, "America/Los_Angeles");
	assert.deepEqual(moved.status === "linked" && moved.enrollments[0]!.nextMeeting, {
		at: "2026-10-20T17:00:00",
		churchAt: "2026-10-20T19:00:00",
		churchTimezone: "America/Chicago",
	});
	await f.admin.execute(sql`UPDATE account SET personal_timezone=NULL WHERE id=${casey.id}::uuid`);
});

test("Casey marks a milestone done; it waits; Ana confirms it; Ana cannot record Casey's milestones in one step", async () => {
	const view = await mine();
	if (view.status !== "linked") throw Error("not linked");
	const vision = milestoneOf(view.enrollments[0]!.milestones, "Present your vision to the sending church leadership");
	const mark = { enrollmentId: caseyEnrollment, milestoneId: vision.id };
	assert.deepEqual(ok(await residentWriter.markMilestone(f.db, await authority(casey), mark)), { outcome: "changed" });
	assert.deepEqual(ok(await residentWriter.markMilestone(f.db, await authority(casey), mark)), { outcome: "noop" });
	const waiting = await mine();
	const today = waiting.status === "linked" ? waiting.today : "";
	const caseySees = () =>
		mine().then((v) =>
			v.status === "linked" ? milestoneOf(v.enrollments[0]!.milestones, vision.title).completion : "gone",
		);
	assert.deepEqual(await caseySees(), { completedOn: today, confirmedOn: null, source: "resident" });
	const anaSees = async () => milestoneOf((await enrollment(ana)).milestones, vision.title).completion;
	assert.deepEqual(await anaSees(), {
		completedOn: today,
		confirmedOn: null,
		recorder: "Casey Lee",
		confirmer: null,
		source: "resident",
	});
	// Only the director confirms; Dana (Owner) is not the director.
	assert.equal((await programWriter.confirmMilestone(f.db, await authority(dana), mark)).status, "refused");
	assert.deepEqual(ok(await programWriter.confirmMilestone(f.db, await authority(ana), mark)), { outcome: "changed" });
	assert.deepEqual(ok(await programWriter.confirmMilestone(f.db, await authority(ana), mark)), { outcome: "noop" });
	assert.deepEqual(await caseySees(), { completedOn: today, confirmedOn: today, source: "resident" });
	assert.equal((await anaSees())?.confirmer, "Ana");

	// While Casey is linked, the one-step record-and-confirm path refuses every milestone of hers.
	const prospectus = milestoneOf(view.enrollments[0]!.milestones, "Write a church planting prospectus");
	const one = await programWriter.recordMilestone(f.db, await authority(ana), {
		enrollmentId: caseyEnrollment,
		milestoneId: prospectus.id,
		completedOn: "2026-10-12",
	});
	assert.deepEqual(one, { status: "refused", refusal: { code: "linked_resident" } });
	// A milestone of a version Casey is not on is refused.
	assert.equal(
		(await residentWriter.markMilestone(f.db, await authority(casey), { ...mark, milestoneId: randomUUID() })).status,
		"refused",
	);
	// Rae, who is not linked, cannot mark Casey's milestones.
	assert.equal((await residentWriter.markMilestone(f.db, await authority(rae), mark)).status, "refused");
});

test("Casey sees Ana's feedback on her own assignment and none written for Jordan", async () => {
	const view = await mine();
	if (view.status !== "linked") throw Error("not linked");
	const preach = milestoneOf(view.enrollments[0]!.milestones, "Preach on a Sunday");
	for (const [enrollmentId, body] of [
		[caseyEnrollment, "Clear outline, Casey. Slow down in the second half."],
		[jordanEnrollment, "Jordan, tighten the opening story."],
	])
		ok(
			await programWriter.addFeedback(f.db, await authority(ana), {
				feedbackId: randomUUID(),
				enrollmentId,
				milestoneId: preach.id,
				body,
			}),
		);
	const after = await mine();
	if (after.status !== "linked") throw Error("not linked");
	const feedback = milestoneOf(after.enrollments[0]!.milestones, "Preach on a Sunday").feedback;
	assert.deepEqual(
		feedback.map((x) => [x.writer, x.body]),
		[["Ana", "Clear outline, Casey. Slow down in the second half."]],
	);
	assert.ok(!JSON.stringify(after).includes("Jordan"));
});

test("foundations: not shared, then a count of the six once Casey shares them, never her reading rows", async () => {
	// Casey completed two foundations, and read one other article.
	const foundations = (await import("../../../docs/reference/discovery-foundations.json", { with: { type: "json" } }))
		.default.articles;
	for (const a of foundations.slice(0, 2)) {
		const rev = randomUUID();
		await f.admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${a.id},'article',${a.slug},${GLOBAL}) ON CONFLICT DO NOTHING`,
		);
		await revision(rev, a.id, GLOBAL, a.title, a.slug, release);
		await f.admin.execute(sql`INSERT INTO reading(account_id,article_id,last_revision_id,observed_fraction,completed_at,
		 completed_revision_id,completed_fraction,policy_version,last_read_meaningful_sequence,bookmarked)
		 VALUES(${casey.id},${a.id},${rev},1,clock_timestamp(),${rev},1,'v1',1,false)`);
	}
	const shown = await enrollment(ana);
	assert.deepEqual(shown.resident, { status: "linked", milestones: "shared", foundations: { status: "not_shared" } });
	await share({ shareFoundations: true, shareMilestones: true });
	const counted = await enrollment(ana);
	assert.deepEqual(counted.resident, {
		status: "linked",
		milestones: "shared",
		foundations: { status: "shared", completed: 2, total: 6 },
	});
	const text = JSON.stringify(counted);
	for (const a of foundations) assert.ok(!text.includes(a.title), a.title);
});

test("milestone sharing off hides Casey's own marks; the milestone Ana recorded before Casey linked stays", async () => {
	// Jordan is unlinked, so Ana recorded his milestone herself; Casey's own confirmed mark is consented progress.
	await share({ shareFoundations: true, shareMilestones: false });
	const shown = await enrollment(ana);
	assert.deepEqual(shown.resident, {
		status: "linked",
		milestones: "not_shared",
		foundations: { status: "shared", completed: 2, total: 6 },
	});
	assert.deepEqual(
		shown.milestones.map((m) => [m.title, m.completion?.source ?? null]),
		[
			["Present your vision to the sending church leadership", null],
			["Write a church planting prospectus", null],
			["Preach on a Sunday", "program_leader"],
		],
	);
	assert.equal(milestoneOf(shown.milestones, "Preach on a Sunday").completion?.completedOn, "2026-10-12");
	assert.equal(shown.status, "active");
	assert.equal(shown.stage.label, "Assimilating");
	// What Casey sees of her own progress is unchanged.
	const view = await mine();
	assert.equal(
		view.status === "linked" &&
			milestoneOf(view.enrollments[0]!.milestones, "Present your vision to the sending church leadership").completion
				?.source,
		"resident",
	);
	// Confirming what she does not share is refused.
	const prospectus =
		view.status === "linked"
			? milestoneOf(view.enrollments[0]!.milestones, "Write a church planting prospectus")
			: null;
	ok(
		await residentWriter.markMilestone(f.db, await authority(casey), {
			enrollmentId: caseyEnrollment,
			milestoneId: prospectus!.id,
		}),
	);
	assert.equal(
		(
			await programWriter.confirmMilestone(f.db, await authority(ana), {
				enrollmentId: caseyEnrollment,
				milestoneId: prospectus!.id,
			})
		).status,
		"refused",
	);
});

test("a new version keeps Casey's own marks on carried milestones, and shows them to Ana only while she shares", async () => {
	// Milestone sharing is off. Ana publishes Version 2 with the same milestones and applies it to Casey.
	const p = ok(await readProgram(f.db, await authority(ana), { programId: program }));
	const v = p.published!;
	const saved = ok(
		await programWriter.savePlan(f.db, await authority(ana), {
			programId: program,
			expectedRevision: p.revision,
			plan: {
				rhythm: v.rhythm,
				expectedMonths: v.expectedMonths,
				stages: v.stages.map((s) => ({ label: s.label, minMonths: s.minMonths, maxMonths: s.maxMonths })),
				milestones: v.milestones.map((m) => ({
					lineage: m.lineage,
					title: m.title,
					description: m.description,
					handsOn: m.handsOn,
				})),
				readings: v.readings.map((r) => ({ revisionId: r.revisionId })),
			},
		}),
	);
	ok(
		await programWriter.publishVersion(f.db, await authority(ana), {
			programId: program,
			expectedRevision: saved.revision,
		}),
	);
	// The review counts only what Grace Austin may see as finished: its own record, not Casey's hidden marks.
	const r = ok(await readVersionReview(f.db, await authority(ana), { enrollmentId: caseyEnrollment }));
	assert.deepEqual(r.carried, ["Preach on a Sunday"]);
	ok(
		await programWriter.applyVersion(f.db, await authority(ana), {
			enrollmentId: caseyEnrollment,
			versionId: r.versionId,
			stageId: r.stageId,
			basis: r.basis,
		}),
	);
	const view = await mine();
	if (view.status !== "linked") throw Error("not linked");
	const own = view.enrollments[0]!.milestones;
	const vision = milestoneOf(own, "Present your vision to the sending church leadership");
	const prospectus = milestoneOf(own, "Write a church planting prospectus");
	assert.equal(vision.completion?.source, "resident");
	assert.notEqual(vision.completion?.confirmedOn, null);
	assert.deepEqual([prospectus.completion?.source, prospectus.completion?.confirmedOn], ["resident", null]);
	assert.equal(milestoneOf(own, "Preach on a Sunday").completion?.source, "program_leader");
	// Marking a milestone already marked on Version 1 changes nothing.
	const mark = { enrollmentId: caseyEnrollment, milestoneId: vision.id };
	assert.deepEqual(ok(await residentWriter.markMilestone(f.db, await authority(casey), mark)), { outcome: "noop" });
	// Once she shares again, Ana sees both marks on Version 2 and confirms the waiting one.
	await share({ shareFoundations: true, shareMilestones: true });
	const shown = await enrollment(ana);
	assert.equal(shown.versionNumber, 2);
	assert.deepEqual(
		shown.milestones.map((m) => [m.title, m.completion?.source ?? null, m.completion?.confirmedOn === null]),
		[
			["Present your vision to the sending church leadership", "resident", false],
			["Write a church planting prospectus", "resident", true],
			["Preach on a Sunday", "program_leader", false],
		],
	);
	const confirm = { enrollmentId: caseyEnrollment, milestoneId: prospectus.id };
	assert.deepEqual(ok(await programWriter.confirmMilestone(f.db, await authority(ana), confirm)), {
		outcome: "changed",
	});
	assert.deepEqual(ok(await programWriter.confirmMilestone(f.db, await authority(ana), confirm)), { outcome: "noop" });
});

test("church reading opens only from Casey's own list; another church article does not; unpublished reads unavailable", async () => {
	const view = await mine();
	if (view.status !== "linked") throw Error("not linked");
	const team = view.enrollments[0]!.readings.find((r) => r.source === "organization")!;
	const opened = ok(await readResidentReading(f.db, await authority(casey), { readingId: team.id }));
	assert.deepEqual(opened.status === "available" && [opened.title, opened.organizationName], [
		"Building a launch team at Grace",
		"Grace Austin",
	]);
	// A reading of a list Casey is not on, or any ID that is not one, opens nothing.
	assert.deepEqual(ok(await readResidentReading(f.db, await authority(casey), { readingId: randomUUID() })), {
		status: "unavailable",
	});
	assert.deepEqual(ok(await readResidentReading(f.db, await authority(rae), { readingId: team.id })), {
		status: "unavailable",
	});
	// Grace Austin unpublishes its version: the item reads as unavailable and opens nothing.
	await f.admin.execute(
		sql`UPDATE article_editor_state SET state='hide' WHERE organization_id=${grace.id}::uuid AND article_id=${articles.team}::uuid`,
	);
	const after = await mine();
	const item = after.status === "linked" ? after.enrollments[0]!.readings.find((r) => r.id === team.id) : null;
	assert.equal(item?.available, false);
	assert.deepEqual(ok(await readResidentReading(f.db, await authority(casey), { readingId: team.id })), {
		status: "unavailable",
	});
});

test("Casey leaves: My residency is gone at once and Grace Austin sees her as not linked; its own facts stay", async () => {
	const l = (await linkRow())!;
	await asResident("residency.leave", {
		requestKey: randomUUID(),
		expectedRevision: l.revision,
		input: { linkId: l.id, expectedConsentRevision: l.consent },
	});
	assert.deepEqual(await mine(), { status: "not_linked" });
	assert.equal(await readResidencyLink(f.db, await authority(casey)), null);
	assert.deepEqual((await record(luis)).residency, { status: "not_linked" });
	const shown = await enrollment(ana);
	assert.deepEqual(shown.resident, { status: "not_linked" });
	assert.equal(shown.status, "active");
	assert.equal((await accountState()).seats, 0);
	// Casey's own marks are hidden once she leaves, so Ana can record them in one step again; her own record stays.
	const vision = milestoneOf(shown.milestones, "Present your vision to the sending church leadership");
	assert.equal(vision.completion, null);
	const recordAs = (milestoneId: string) =>
		authority(ana).then((a) =>
			programWriter.recordMilestone(f.db, a, { enrollmentId: caseyEnrollment, milestoneId, completedOn: "2026-10-16" }),
		);
	assert.deepEqual(ok(await recordAs(vision.id)), { outcome: "changed" });
	assert.deepEqual(ok(await recordAs(vision.id)), { outcome: "noop" });
	const recorded = await enrollment(ana);
	assert.deepEqual(milestoneOf(recorded.milestones, vision.title).completion, {
		completedOn: "2026-10-16",
		confirmedOn: recorded.today,
		recorder: "Ana",
		confirmer: "Ana",
		source: "program_leader",
	});
	const preach = milestoneOf(recorded.milestones, "Preach on a Sunday");
	assert.deepEqual(ok(await recordAs(preach.id)), { outcome: "noop" });
	assert.equal(milestoneOf((await enrollment(ana)).milestones, preach.title).completion?.completedOn, "2026-10-12");
	// Without a live link, nothing of the residency opens and no mark is taken.
	const reading = (await f.admin.execute(sql`SELECT id FROM development_reading LIMIT 1`)).rows[0]!.id as string;
	assert.deepEqual(ok(await readResidentReading(f.db, await authority(casey), { readingId: reading })), {
		status: "unavailable",
	});
});
