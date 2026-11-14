import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { seeds } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import {
	createOrganizationAdapter,
	pipelineWriter,
	programWriter,
	readMyResidency,
	readPipelineBoard,
	readPipelinePersonRecord,
	residentWriter,
} from "../../../packages/domain/src/organizations/index.ts";
import { createMailService, MAIL_PASSES, runDueMail, type MailPayload } from "../../../apps/web/src/server/jobs/mail.ts";
import {
	authorizeNotificationMail,
	createNotificationWorker,
} from "../../../apps/web/src/server/jobs/notification-worker.ts";

// Residency notices (T-365, D-1414 to D-1416): Ana confirming a milestone Casey marked done, and Ana writing feedback on
// one of Casey's milestones, each give Casey, the linked resident, one bell entry and one email through the notification
// worker and the notice mail pass, only while her link is live. Grace Austin (America/Chicago): Dana Owner, Luis Admin,
// Ana (Member) directs the residency. Casey Lee (casey@example.test) links sharing milestone progress. Jordan Price is
// enrolled without an account. Robin Hale is enrolled and links later.

const ORIGIN = "http://app.example.test";
let f: Awaited<ReturnType<typeof fixture>>;
type Actor = { id: string; session: string; email: string };
let grace: { kind: "organization"; id: string; organizationKind: "sending_church" };
let dana: Actor, luis: Actor, ana: Actor, casey: Actor, robin: Actor, planter: Actor;
const people = { casey: randomUUID(), jordan: randomUUID(), robin: randomUUID() };
const enrollments = { casey: randomUUID(), jordan: randomUUID(), robin: randomUUID() };
const program = randomUUID();
const milestones: Record<"vision" | "prospectus" | "preach", string> = { vision: "", prospectus: "", preach: "" };
const VISION = "Present your vision to the sending church leadership";

const authority = (a: { session: string }) => RequestActor.resolve(f.db, sessionId.parse(a.session));
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};

// The outbox: every email the notice mail pass hands to the email service.
const outbox: MailPayload[] = [];
let mail: ReturnType<typeof createMailService>;
let worker: ReturnType<typeof createNotificationWorker>;
const feed = createNotificationProducer({ optOutKeys: { current: randomBytes(32) } });
/** The scheduled runner's two steps: notice jobs, then the notice mail pass. */
const deliver = () => worker.run(f.db, new Date().toISOString());
const dispatch = () => runDueMail(f.db, mail, MAIL_PASSES.notice, 50, Infinity);

/** What an account's bell shows: unread count and its residency entries, newest first. */
async function bell(a: Actor) {
	const reader = await authority(a);
	const page = ok(await feed.readFeedPage(f.db, reader, {}));
	return {
		unread: page.unread,
		entries: page.feed.items
			.filter((i) => i.category.startsWith("residency_"))
			.map((i) => ({ category: i.category, title: i.title, body: i.body, read: i.read, subject: i.subject })),
	};
}
/** Every residency notice row and its mail, for anyone, oldest first. */
async function noticeRows() {
	return (
		await f.admin.execute(sql`SELECT n.recipient_id AS recipient,split_part(n.logical_key,'/',2) AS category,n.title,
	 n.safe_body AS body,n.archived_at IS NULL AS bell,(SELECT m.state FROM mail m WHERE m.notice_id=n.id) AS mail
	 FROM notice n WHERE n.tenant_id=${grace.id}::uuid AND n.purpose IN ('residency_confirmation','residency_feedback')
	 ORDER BY n.created_at,n.id`)
	).rows as { recipient: string; category: string; title: string; body: string; bell: boolean; mail: string | null }[];
}
async function residencyJobs() {
	return (
		await f.admin.execute(sql`SELECT producer_key AS key,state,error_code AS code FROM job WHERE kind='notification'
	 AND tenant_id=${grace.id}::uuid AND producer_key LIKE 'residency/%' ORDER BY producer_key`)
	).rows as { key: string; state: string; code: string | null }[];
}

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
async function link(a: Actor, personId: string) {
	const r = ok(await readPipelinePersonRecord(f.db, await authority(luis), { personId }));
	const sent = await f.invitations.inviteResident(await authority(luis), {
		requestKey: randomUUID(),
		expectedRevision: r.organizationRevision,
		input: { organization: grace, personId, recipientEmail: a.email },
	});
	const accepted = await f.invitations.respondResident(a.session, {
		requestKey: randomUUID(),
		expectedRevision: "1",
		input: {
			invitationId: sent.invitation.invitationId,
			proof: await f.proof(sent.invitation.invitationId),
			decision: "accept",
			choices: { shareFoundations: false, shareMilestones: true },
		},
	});
	assert.equal(accepted.status, "accepted");
}
async function leave(a: Actor) {
	const l = (
		await f.admin.execute(
			sql`SELECT id,revision::text AS revision,consent_revision::text AS consent FROM residency_link WHERE account_id=${a.id}::uuid AND ended_at IS NULL`,
		)
	).rows[0] as { id: string; revision: string; consent: string };
	const owner = { kind: "account" as const, id: a.id };
	await f.db.transaction(async (tx) => {
		if (!(await RequestActor.claimWrite(tx, sessionId.parse(a.session), owner))) throw Error("unavailable");
		return adapter["residency.leave"](tx, sessionId.parse(a.session), owner, {
			requestKey: randomUUID(),
			expectedRevision: l.revision,
			input: { linkId: l.id, expectedConsentRevision: l.consent },
		} as never);
	});
}
const confirm = async (enrollmentId: string, milestoneId: string) =>
	programWriter.confirmMilestone(f.db, await authority(ana), { enrollmentId, milestoneId });
const feedback = async (enrollmentId: string, milestoneId: string, body: string, feedbackId = randomUUID()) =>
	programWriter.addFeedback(f.db, await authority(ana), { feedbackId, enrollmentId, milestoneId, body });
const mark = async (a: Actor, enrollmentId: string, milestoneId: string) =>
	ok(await residentWriter.markMilestone(f.db, await authority(a), { enrollmentId, milestoneId }));
/** Casey's notification choices, as Settings > Notifications reads them. */
const choices = async (a: Actor) =>
	ok(await feed.getPreferences(f.db, await authority(a))).choices.map((c) => `${c.category}.${c.channel}=${c.enabled}`);

before(async () => {
	f = await fixture();
	mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "notices@example.test",
		authorize: authorizeNotificationMail,
		unsubscribe: { origin: ORIGIN, keys: { current: randomBytes(32) } },
		transport: {
			async send(payload) {
				outbox.push(payload);
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	worker = createNotificationWorker({ mail, origin: ORIGIN });
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
	robin = await discovery("robin@example.test", "Robin Hale");
	const plant = await seed.plant();
	const p = await seed.actor(plant as never, "owner", { user: { name: "Pat" } });
	planter = { id: p.id, session: p.session, email: p.email };
	const anaSeat = (
		await f.admin.execute(
			sql`SELECT id FROM seat WHERE account_id=${ana.id}::uuid AND organization_id=${grace.id}::uuid`,
		)
	).rows[0]!.id as string;

	const board = ok(await readPipelineBoard(f.db, await authority(dana), {}));
	const potential = board.stages.find((s) => s.label === "Potential leader")!.id;
	for (const [personId, displayName, email] of [
		[people.casey, "Casey Lee", "casey@example.test"],
		[people.jordan, "Jordan Price", null],
		[people.robin, "Robin Hale", "robin@example.test"],
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
	ok(
		await programWriter.createProgram(f.db, await authority(dana), {
			programId: program,
			kind: "residency",
			name: "Grace Residency",
			directorSeatId: anaSeat,
			plan: {
				rhythm: "monthly",
				expectedMonths: 15,
				stages: [{ label: "Assimilating", minMonths: 2, maxMonths: 3 }],
				milestones: [
					[VISION, null],
					["Write a church planting prospectus", null],
					["Preach on a Sunday", "Preach at a Sunday gathering and debrief with Ana."],
				].map(([title, description]) => ({ lineage: randomUUID(), title, description, handsOn: description !== null })),
				readings: [],
			},
		}),
	);
	const draft = (
		await f.admin.execute(sql`SELECT revision::text AS r FROM development_program WHERE id=${program}::uuid`)
	).rows[0]!.r as string;
	ok(await programWriter.publishVersion(f.db, await authority(ana), { programId: program, expectedRevision: draft }));
	const ids = (
		await f.admin
			.execute(sql`SELECT m.id,m.title,(SELECT s.id FROM development_stage s WHERE s.version_id=m.version_id) AS stage
	 FROM development_milestone m JOIN development_program p ON p.current_version_id=m.version_id WHERE p.id=${program}::uuid`)
	).rows as { id: string; title: string; stage: string }[];
	milestones.vision = ids.find((m) => m.title === VISION)!.id;
	milestones.prospectus = ids.find((m) => m.title.startsWith("Write"))!.id;
	milestones.preach = ids.find((m) => m.title.startsWith("Preach"))!.id;
	for (const who of ["casey", "jordan", "robin"] as const)
		ok(
			await programWriter.enroll(f.db, await authority(dana), {
				enrollmentId: enrollments[who],
				programId: program,
				personId: people[who],
				cohort: "2026",
				startedOn: "2026-10-01",
				expectedEndOn: "2027-12-31",
				stageId: ids[0]!.stage,
				nextMeetingAt: "2026-10-20T19:00:00",
			}),
		);
});
after(() => f?.close());

test("AC:CASE-NTF-001 Casey's Settings offer only Milestone confirmations and Feedback, both channels on; a seat offers neither", async () => {
	// Before she links, a seatless Discovery account can receive nothing, so nothing is offered.
	assert.deepEqual(await choices(casey), []);
	await link(casey, people.casey);
	assert.deepEqual(await choices(casey), [
		"residency_confirmation.email=true",
		"residency_confirmation.in_app=true",
		"residency_feedback.email=true",
		"residency_feedback.in_app=true",
	]);
	const plantSeat = await choices(planter);
	assert.ok(plantSeat.includes("task_due.email=true"));
	assert.ok(!plantSeat.some((c) => c.startsWith("residency_")));
	assert.ok(!(await choices(ana)).some((c) => c.startsWith("residency_")));
});

test("AC:CASE-NTF-001 Ana confirms Casey's milestone: one bell entry and one email to casey@example.test, nothing for anyone else", async () => {
	// Casey marking her own milestone done tells nobody.
	await mark(casey, enrollments.casey, milestones.vision);
	assert.deepEqual(await residencyJobs(), []);
	const before = await bell(casey);
	assert.deepEqual(ok(await confirm(enrollments.casey, milestones.vision)), { outcome: "changed" });
	// The same request again changes nothing and queues nothing.
	assert.deepEqual(ok(await confirm(enrollments.casey, milestones.vision)), { outcome: "noop" });
	assert.equal(await deliver(), 1);
	assert.equal(await deliver(), 0);

	const after = await bell(casey);
	assert.equal(after.unread, before.unread + 1);
	assert.deepEqual(after.entries, [
		{
			category: "residency_confirmation",
			title: `Grace Austin confirmed “${VISION}”`,
			body: "Your director confirmed this milestone you marked done.",
			read: false,
			subject: { kind: "residency_milestone", id: milestones.vision },
		},
	]);
	assert.equal(await dispatch(), 1);
	assert.equal(outbox.length, 1);
	const email = outbox[0]!;
	assert.equal(email.to, "casey@example.test");
	assert.equal(email.subject, `Grace Austin confirmed “${VISION}”`);
	assert.ok(
		email.text.includes(
			`Open My residency: ${ORIGIN}/my-residency?milestone=${milestones.vision}#milestone-${milestones.vision}`,
		),
		email.text,
	);
	// The category's own email opt-out (NTF-012).
	assert.match(email.text, new RegExp(`Unsubscribe: ${ORIGIN}/email-preferences/\\S+`));
	assert.ok(email.headers?.["List-Unsubscribe"]);

	// Nobody else hears of it, and Casey's account stays seatless.
	for (const other of [ana, dana, luis, robin, planter]) assert.deepEqual((await bell(other)).entries, []);
	assert.deepEqual(
		(await noticeRows()).map((n) => n.recipient),
		[casey.id],
	);
	const seats = (await f.admin.execute(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${casey.id}::uuid`))
		.rows[0]!.n;
	assert.equal(seats, 0);
	assert.equal(
		(await f.admin.execute(sql`SELECT registration_kind AS k FROM account WHERE id=${casey.id}::uuid`)).rows[0]!.k,
		"discovery",
	);
});

test("AC:CASE-NTF-001 feedback on Casey's assignment: one entry and one email naming the milestone, never the feedback text", async () => {
	const words = "Clear outline, Casey. Slow down in the second half.";
	const feedbackId = randomUUID();
	ok(await feedback(enrollments.casey, milestones.preach, words, feedbackId));
	// A replay with the same feedback ID writes nothing more.
	ok(await feedback(enrollments.casey, milestones.preach, words, feedbackId));
	assert.equal(await deliver(), 1);
	assert.equal(await deliver(), 0);
	const entries = (await bell(casey)).entries;
	assert.deepEqual(entries[0], {
		category: "residency_feedback",
		title: "New feedback from Grace Austin on “Preach on a Sunday”",
		body: "Your director wrote feedback on this milestone. Read it in My residency.",
		read: false,
		subject: { kind: "residency_milestone", id: milestones.preach },
	});
	assert.equal(entries.length, 2);
	assert.equal(await dispatch(), 1);
	const email = outbox.at(-1)!;
	assert.equal(email.to, "casey@example.test");
	assert.equal(email.subject, "New feedback from Grace Austin on “Preach on a Sunday”");
	assert.ok(email.text.includes(`/my-residency?milestone=${milestones.preach}#milestone-${milestones.preach}`));
	for (const part of ["Clear outline", "Slow down"]) {
		assert.ok(!email.text.includes(part) && !email.html.includes(part) && !email.subject.includes(part));
		assert.ok(!JSON.stringify(entries).includes(part));
	}
	assert.deepEqual(
		(await noticeRows()).map((n) => [n.recipient, n.category, n.mail]),
		[
			[casey.id, "residency_confirmation", "accepted"],
			[casey.id, "residency_feedback", "accepted"],
		],
	);
	for (const other of [ana, dana, luis, robin, planter]) assert.deepEqual((await bell(other)).entries, []);
});

test("AC:CASE-NTF-001 nothing for an unlinked enrollee's record-and-confirm or feedback; linking later sends nothing earlier", async () => {
	const jobs = (await residencyJobs()).length;
	const notices = (await noticeRows()).length;
	const sent = outbox.length;
	// Jordan has no account; Robin has not linked yet.
	for (const who of ["jordan", "robin"] as const) {
		ok(
			await programWriter.recordMilestone(f.db, await authority(ana), {
				enrollmentId: enrollments[who],
				milestoneId: milestones.vision,
				completedOn: "2026-10-12",
			}),
		);
		ok(await feedback(enrollments[who], milestones.preach, `Notes for ${who}`));
	}
	assert.equal((await residencyJobs()).length, jobs);
	await link(robin, people.robin);
	assert.equal(await deliver(), 0);
	assert.equal(await dispatch(), 0);
	assert.equal((await noticeRows()).length, notices);
	assert.equal(outbox.length, sent);
	assert.deepEqual((await bell(robin)).entries, []);
});

test("AC:CASE-NTF-004 Casey's choices: feedback email off keeps the bell entry; confirmation in-app off keeps the email", async () => {
	const reader = await authority(casey);
	const set = async (category: string, channel: string) => {
		const revision = ok(await feed.getPreferences(f.db, reader)).revision;
		ok(
			await feed.setPreference(f.db, reader, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { choice: { category, channel, enabled: false } },
			}),
		);
	};
	await set("residency_feedback", "email");
	await set("residency_confirmation", "in_app");
	const sent = outbox.length;

	ok(await feedback(enrollments.casey, milestones.preach, "Second sermon notes"));
	assert.equal(await deliver(), 1);
	const afterFeedback = await bell(casey);
	assert.equal(afterFeedback.entries.filter((e) => e.category === "residency_feedback" && !e.read).length, 2);
	assert.equal(await dispatch(), 0);
	assert.equal(outbox.length, sent);

	await mark(casey, enrollments.casey, milestones.prospectus);
	ok(await confirm(enrollments.casey, milestones.prospectus));
	assert.equal(await deliver(), 1);
	// In-app off keeps every confirmation out of the bell, as for any category; the new one is written for email only.
	assert.deepEqual(
		(await bell(casey)).entries.filter((e) => e.category === "residency_confirmation"),
		[],
	);
	assert.deepEqual(
		(await noticeRows()).filter((n) => n.title.includes("prospectus")).map((n) => [n.bell, n.mail]),
		[[false, "pending"]],
	);
	assert.equal(await dispatch(), 1);
	assert.equal(outbox.at(-1)!.subject, "Grace Austin confirmed “Write a church planting prospectus”");
	await set("residency_feedback", "in_app");
	assert.ok((await choices(casey)).includes("residency_feedback.in_app=false"));
});

test("AC:CASE-NTF-003 Casey leaves before dispatch: her entries and count go at once, queued mail and notices are not sent", async () => {
	// Back on: the bell shows feedback again.
	const reader = await authority(casey);
	const revision = ok(await feed.getPreferences(f.db, reader)).revision;
	ok(
		await feed.setPreferences(f.db, reader, {
			requestKey: randomUUID(),
			expectedRevision: revision,
			input: {
				choices: [
					{ category: "residency_feedback", channel: "in_app", enabled: true },
					{ category: "residency_feedback", channel: "email", enabled: true },
				],
			},
		}),
	);
	// One notice written with its email waiting, and one feedback whose job has not run.
	ok(await feedback(enrollments.casey, milestones.preach, "Third sermon notes"));
	assert.equal(await deliver(), 1);
	ok(await feedback(enrollments.casey, milestones.preach, "Fourth sermon notes"));
	const shown = await bell(casey);
	assert.ok(shown.unread > 0 && shown.entries.length > 0);
	const sent = outbox.length;

	await leave(casey);
	assert.deepEqual(await bell(casey), { unread: 0, entries: [] });
	// The job that had not run writes nothing; the email that waited is claimed and not sent.
	assert.equal(await deliver(), 0);
	assert.equal((await residencyJobs()).filter((j) => j.state === "cancelled" && j.code === "suppressed").length, 1);
	await dispatch();
	assert.equal(outbox.length, sent);
	assert.deepEqual(
		(await noticeRows()).map((n) => n.mail),
		["accepted", "accepted", null, "accepted", "cancelled"],
	);
	// A saved entry link opens My residency's not-linked state; her Settings offer no residency choice.
	assert.deepEqual(ok(await readMyResidency(f.db, await authority(casey))), { status: "not_linked" });
	assert.deepEqual(await choices(casey), []);
	// Robin, still linked, is unaffected and never heard of Casey's.
	assert.deepEqual((await bell(robin)).entries, []);
});
