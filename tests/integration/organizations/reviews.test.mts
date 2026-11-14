import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";

import { fixture } from "../../support/fixture.mts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import {
	pipelineWriter,
	readPipelineBoard,
	readPipelinePersonRecord,
} from "../../../packages/domain/src/organizations/pipeline.ts";
import { pipelineImportWriter, previewPipelineImport } from "../../../packages/domain/src/organizations/import.ts";
import { pipelineDataWriter, readPipelineExport } from "../../../packages/domain/src/organizations/data.ts";
import {
	readAnswerReview,
	readAnswerReviews,
	reviewWriter,
} from "../../../packages/domain/src/organizations/reviews.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailPayload,
} from "../../../apps/web/src/server/jobs/mail.ts";
import {
	authorizeNotificationMail,
	createNotificationWorker,
} from "../../../apps/web/src/server/jobs/notification-worker.ts";

// Kept answers sent for review (T-385, D-1507, D-1509) against a migrated database. Grace Austin, America/Chicago:
// Dana is the Owner, Luis an Admin, Ana and Ben Members with no duty, Pat a Member who is Jordan's responsible staff.
// Jordan Reyes is imported from applications.xlsx, so his kept-answers note holds "Describe your calling", "Spouse's
// name", "Statement of faith" and "Ordination history" (with the form's other kept columns). Dana sends the two
// credentialing questions to Ben as "Credentialing questions".

const database = await fixture({ prefix: "answerreview", max: 6 });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());

type Actor = { id: string; session: string; email?: string };
type Org = { kind: "organization"; id: string };
let grace: Org, hill: Org;
let dana: Actor, luis: Actor, ana: Actor, ben: Actor, pat: Actor, hillOwner: Actor;
let benSeat: string, patSeat: string, hillSeat: string;
let jordan: string, sam: string, noteId: string;
let ordinaryNote: string;

const GROUP = "Credentialing questions";
const CHOSEN = ["Statement of faith", "Ordination history"];
const FAITH = "I hold to the Apostles' Creed and the network's statement of faith.";
const ORDINATION = "Licensed at Grace Austin in 2022; ordination council planned for spring.";
const CALLING = "East Austin, among young families.";
const ORIGIN = "http://app.example.test";

const authority = (a: Actor) => RequestActor.resolve(db, a.session as never);
const ok = <T,>(r: { status: string; value?: T; refusal?: unknown }): T => {
	assert.equal(r.status, "ok", JSON.stringify(r));
	return r.value as T;
};
const refusal = (r: { status: string; refusal?: unknown }) => {
	assert.equal(r.status, "refused", JSON.stringify(r));
	return r.refusal;
};
const named = (org: Org, role: "owner" | "admin" | "member", name: string) =>
	database.actor(org as never, role, { user: { name } });
const seatOf = async (a: Actor, org: Org) =>
	(
		await admin.execute(
			sql`SELECT id FROM seat WHERE account_id=${a.id}::uuid AND organization_id=${org.id}::uuid AND ended_at IS NULL`,
		)
	).rows[0]!.id as string;
const record = async (a: Actor, personId = jordan) =>
	ok(await readPipelinePersonRecord(db, await authority(a), { personId }));
const keptNote = async (a: Actor = dana) => {
	const n = (await record(a)).notes.find((x) => x.id === noteId)!;
	assert.equal(n.state, "current");
	return n as Extract<typeof n, { state: "current" }>;
};
const send = async (a: Actor, extra: Partial<Record<string, unknown>> = {}) =>
	reviewWriter.sendAnswers(db, await authority(a), {
		reviewId: randomUUID(),
		noteId,
		groupName: GROUP,
		questions: CHOSEN,
		reviewerSeatId: benSeat,
		...extra,
	});
const withdraw = async (a: Actor, reviewId: string) =>
	reviewWriter.withdrawReview(db, await authority(a), { reviewId });
const open = async (a: Actor, reviewId: string) => readAnswerReview(db, await authority(a), { reviewId });
const list = async (a: Actor) => ok(await readAnswerReviews(db, await authority(a)));
const sendsOf = async (reviewId: string) =>
	(
		await admin.execute(
			sql`SELECT (SELECT count(*)::int FROM answer_review WHERE id=${reviewId}::uuid) AS sends,
 (SELECT count(*)::int FROM audit_event WHERE metadata->>'reviewId'=${reviewId}) AS audits,
 (SELECT count(*)::int FROM job WHERE producer_key=${`review/${reviewId}`}) AS jobs`,
		)
	).rows[0] as { sends: number; audits: number; jobs: number };

// The notification worker and the notice mail pass, with an outbox in place of the email service.
const outbox: MailPayload[] = [];
const feed = createNotificationProducer({ optOutKeys: { current: randomBytes(32) } });
let mail: ReturnType<typeof createMailService>;
let worker: ReturnType<typeof createNotificationWorker>;

before(async () => {
	grace = (await database.organization("sending_church", {
		name: "Grace Austin",
		timezone: "America/Chicago",
	})) as never;
	hill = (await database.organization("sending_network", { name: "Hill Country Network" })) as never;
	dana = await named(grace, "owner", "Dana");
	luis = await named(grace, "admin", "Luis");
	ana = await named(grace, "member", "Ana");
	ben = await named(grace, "member", "Ben");
	pat = await named(grace, "member", "Pat");
	hillOwner = await named(hill, "owner", "Hana");
	benSeat = await seatOf(ben, grace);
	patSeat = await seatOf(pat, grace);
	hillSeat = await seatOf(hillOwner, hill);
	mail = createMailService({
		db,
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

	// Jordan and Sam come from applications.xlsx with Pat as their responsible staff.
	const bytes = new Uint8Array(readFileSync(new URL("./import-files/applications.xlsx", import.meta.url)));
	const p = ok(
		await previewPipelineImport(db, await authority(dana), { fileName: "applications.xlsx", file: bytes, columns: null }),
	) as { fileDigest: string; reviewDigest: string; columns: { choice: string }[]; rows: { row: number }[] };
	const result = ok(
		await pipelineImportWriter.importPeople(db, await authority(dana), {
			importId: randomUUID(),
			fileName: "applications.xlsx",
			file: bytes,
			fileDigest: p.fileDigest,
			reviewDigest: p.reviewDigest,
			columns: p.columns.map((c) => c.choice),
			stageId: ok(await readPipelineBoard(db, await authority(dana), {})).stages[0]!.id,
			responsibleSeatId: patSeat,
			duplicates: [],
		}),
	) as { added: { row: number; personId: string }[] };
	jordan = result.added.find((a) => a.row === 1)!.personId;
	sam = result.added.find((a) => a.row === 2)!.personId;
	noteId = (await record(dana)).notes[0]!.id;
	ordinaryNote = randomUUID();
	ok(await pipelineWriter.addNote(db, await authority(dana), { personId: jordan, noteId: ordinaryNote, body: "Met for coffee" }));
});

test("only an Owner or Admin sends kept answers, and only from a kept-answers note", async () => {
	const kept = await keptNote(dana);
	assert.deepEqual(kept.questions, [
		"ID",
		"Start time",
		"Completion time",
		"Phone number",
		"Describe your calling",
		"Spouse's name",
		"Statement of faith",
		"Ordination history",
	]);
	const plain = (await record(dana)).notes.find((n) => n.id === ordinaryNote)!;
	assert.equal(plain.state === "current" && plain.questions, null);
	// Pat reads the note as Jordan's responsible staff, but cannot send it; Ana and Ben cannot either.
	assert.deepEqual((await keptNote(pat)).questions?.length, 8);
	for (const a of [pat, ana, ben]) assert.deepEqual(refusal(await send(a)), { code: "unavailable" });
	assert.deepEqual(refusal(await send(dana, { noteId: ordinaryNote })), { code: "unavailable" });
	assert.deepEqual(refusal(await send(dana, { questions: ["Statement of faith", "Favorite color"] })), {
		code: "invalid_input",
		field: "questions",
	});
	// The reviewer is a current seat of Grace Austin: not another organization's.
	assert.deepEqual(refusal(await send(dana, { reviewerSeatId: hillSeat })), {
		code: "invalid_input",
		field: "reviewerSeatId",
	});
	const count = await admin.execute(sql`SELECT count(*)::int AS n FROM answer_review WHERE organization_id=${grace.id}::uuid`);
	assert.equal(count.rows[0]!.n, 0);
});

let reviewId: string;
test("sending twice with one ID makes one send, shown on the note", async () => {
	reviewId = randomUUID();
	const first = ok(await send(dana, { reviewId }));
	const second = ok(await send(dana, { reviewId }));
	assert.deepEqual(first, { reviewId });
	assert.deepEqual(second, { reviewId });
	assert.deepEqual(await sendsOf(reviewId), { sends: 1, audits: 1, jobs: 1 });
	// The same ID for a different send is a conflict, and writes nothing.
	assert.deepEqual(refusal(await send(dana, { reviewId, groupName: "Other" })), { code: "conflict" });
	assert.deepEqual(await sendsOf(reviewId), { sends: 1, audits: 1, jobs: 1 });
	const kept = await keptNote(luis);
	const asOf = (await record(dana)).asOf;
	assert.deepEqual(kept.reviews, [{ id: reviewId, reviewer: "Ben", groupName: GROUP, sentOn: asOf, questions: CHOSEN }]);
});

test("Ben gets one notice and one email naming Jordan, the group and Dana, with no answer text", async () => {
	assert.equal(await worker.run(db, new Date().toISOString()), 1);
	const page = ok(await feed.readFeedPage(db, await authority(ben), {}));
	const entries = page.feed.items.filter((i) => i.category === "answer_review");
	assert.deepEqual(
		entries.map((i) => ({ title: i.title, body: i.body, subject: i.subject })),
		[
			{
				title: "Answers to review: Jordan Reyes",
				body: `Dana sent you “${GROUP}” for Jordan Reyes to review.`,
				subject: { kind: "answer_review", id: reviewId },
			},
		],
	);
	assert.equal(await runDueMail(db, mail, MAIL_PASSES.notice, 50, Infinity), 1);
	const email = outbox.at(-1)!;
	assert.equal(email.to, ben.email);
	assert.equal(email.subject, "Answers to review: Jordan Reyes");
	assert.ok(email.text.includes(`${ORIGIN}/organization/reviews/${reviewId}`), email.text);
	for (const text of [JSON.stringify(entries), email.subject, email.text])
		for (const secret of [FAITH, ORDINATION, CALLING, ...CHOSEN]) assert.ok(!text.includes(secret), text);
	// Nobody else in Grace Austin is told.
	for (const a of [dana, luis, pat]) {
		const theirs = ok(await feed.readFeedPage(db, await authority(a), {}));
		assert.equal(theirs.feed.items.filter((i) => i.category === "answer_review").length, 0);
	}
});

test("only Ben reads the send: the chosen questions with their answers and nothing else", async () => {
	const read = ok(await open(ben, reviewId));
	assert.deepEqual(read, {
		id: reviewId,
		person: "Jordan Reyes",
		groupName: GROUP,
		sender: "Dana",
		sentOn: (await record(dana)).asOf,
		shared: true,
		answers: [
			{ question: "Statement of faith", answer: FAITH },
			{ question: "Ordination history", answer: ORDINATION },
		],
	});
	assert.deepEqual(
		(await list(ben)).items.map((i) => [i.id, i.person, i.groupName, i.sender, i.shared]),
		[[reviewId, "Jordan Reyes", GROUP, "Dana", true]],
	);
	// Luis (not the reviewer), Ana, Pat and Hill Country Network's Owner cannot read it.
	for (const a of [luis, ana, pat, hillOwner]) assert.deepEqual(refusal(await open(a, reviewId)), { code: "unavailable" });
	for (const a of [luis, ana, pat, hillOwner]) assert.deepEqual((await list(a)).items, []);
	// Ben still has no access to Jordan's record.
	assert.deepEqual(refusal(await readPipelinePersonRecord(db, await authority(ben), { personId: jordan })), {
		code: "unavailable",
	});
});

test("Ben reads the note's answers as edited, and a question taken out as no longer available", async () => {
	const kept = await keptNote(dana);
	const edited = kept.body.replace(FAITH, "I affirm the Nicene Creed.");
	ok(await pipelineWriter.editNote(db, await authority(dana), { noteId, expectedRevision: kept.revision, body: edited }));
	assert.deepEqual((ok(await open(ben, reviewId)) as { answers: unknown }).answers, [
		{ question: "Statement of faith", answer: "I affirm the Nicene Creed." },
		{ question: "Ordination history", answer: ORDINATION },
	]);
	const again = await keptNote(dana);
	const without = again.body.replace(`\n\nOrdination history\n${ORDINATION}`, "");
	assert.notEqual(without, again.body);
	ok(await pipelineWriter.editNote(db, await authority(dana), { noteId, expectedRevision: again.revision, body: without }));
	const read = ok(await open(ben, reviewId));
	assert.deepEqual((read as { answers: unknown }).answers, [
		{ question: "Statement of faith", answer: "I affirm the Nicene Creed." },
		{ question: "Ordination history", answer: null },
	]);
	assert.ok(!JSON.stringify(read).includes(ORDINATION));
});

test("withdrawal: Ben sees the send as no longer shared, with no question or answer, and history records both", async () => {
	ok(await withdraw(dana, reviewId));
	ok(await withdraw(dana, reviewId));
	const read = ok(await open(ben, reviewId));
	assert.deepEqual(read, {
		id: reviewId,
		person: "Jordan Reyes",
		groupName: GROUP,
		sender: "Dana",
		sentOn: (await record(dana)).asOf,
		shared: false,
	});
	assert.deepEqual(
		(await list(ben)).items.map((i) => [i.id, i.shared]),
		[[reviewId, false]],
	);
	assert.deepEqual((await keptNote(dana)).reviews, []);
	assert.deepEqual(refusal(await withdraw(pat, reviewId)), { code: "unavailable" });
	// Ben's notice leaves the bell with the send.
	const page = ok(await feed.readFeedPage(db, await authority(ben), {}));
	assert.equal(page.feed.items.filter((i) => i.category === "answer_review").length, 0);

	const history = (await record(dana)).history.filter((h) => h.kind.startsWith("review_"));
	const asOf = (await record(dana)).asOf;
	assert.deepEqual(history, [
		{ id: history[0]!.id, on: asOf, actor: "Dana", kind: "review_withdrawn" },
		{ id: history[1]!.id, on: asOf, actor: "Dana", kind: "review_sent", reviewer: "Ben" },
	]);
	// The audit rows hold ids, actor and change kind only.
	const rows = (
		await admin.execute(
			sql`SELECT kind,actor_id,subject_id,metadata FROM audit_event WHERE metadata->>'reviewId'=${reviewId} ORDER BY occurred_at`,
		)
	).rows as { kind: string; actor_id: string; subject_id: string; metadata: unknown }[];
	assert.deepEqual(rows, [
		{ kind: "create", actor_id: dana.id, subject_id: jordan, metadata: { category: "answer_review", reviewId } },
		{ kind: "remove", actor_id: dana.id, subject_id: jordan, metadata: { category: "answer_review", reviewId } },
	]);
});

test("an ended seat, the note's removal and Jordan's removal on request each stop sharing", async () => {
	// Ben's seat ends: he cannot read anything of Grace Austin. When he holds a new seat there, the send to his old seat
	// shows as no longer shared.
	const toOldSeat = ok(await send(dana)).reviewId;
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE id=${benSeat}::uuid`);
	assert.deepEqual(refusal(await open(ben, toOldSeat)), { code: "unavailable" });
	await admin.execute(sql`INSERT INTO seat SELECT (jsonb_populate_record(NULL::seat,
 to_jsonb(s)||jsonb_build_object('id',gen_random_uuid(),'ended_at',NULL))).* FROM seat s WHERE s.id=${benSeat}::uuid`);
	benSeat = await seatOf(ben, grace);
	assert.deepEqual(ok(await open(ben, toOldSeat)).shared, false);

	// Dana removes the note.
	const beforeRemoval = ok(await send(dana)).reviewId;
	assert.equal(ok(await open(ben, beforeRemoval)).shared, true);
	const kept = await keptNote(dana);
	ok(await pipelineWriter.removeNote(db, await authority(dana), { noteId, expectedRevision: kept.revision }));
	assert.deepEqual(ok(await open(ben, beforeRemoval)).shared, false);

	// Sam's answers go to Ben, then Sam is removed on request: the send stays, with no name and no text.
	const samNote = (await record(dana, sam)).notes[0]!.id;
	const samReview = ok(await send(dana, { noteId: samNote, questions: ["Statement of faith"] })).reviewId;
	assert.deepEqual((ok(await open(ben, samReview)) as { answers: unknown }).answers, [
		{ question: "Statement of faith", answer: "The Nicene Creed" },
	]);
	const samRecord = await record(dana, sam);
	ok(await pipelineDataWriter.removePerson(db, await authority(dana), { personId: sam, expectedRevision: samRecord.revision }));
	const read = ok(await open(ben, samReview));
	assert.deepEqual(read, { ...read, person: "Former participant", shared: false });
	assert.ok(!JSON.stringify(await list(ben)).includes("Nicene"));
	assert.deepEqual(
		(await list(ben)).items.map((i) => [i.id, i.shared]),
		[
			[samReview, false],
			[beforeRemoval, false],
			[toOldSeat, false],
			[reviewId, false],
		],
	);
});

test("sends stay out of the pipeline export", async () => {
	const exported = ok(await readPipelineExport(db, await authority(dana), {})) as { text: string };
	for (const secret of [GROUP, FAITH, "Nicene", ...CHOSEN]) assert.ok(!exported.text.includes(secret), secret);
});
