import { createDatabase, closeDatabase } from "../../../../packages/db/src/client.ts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client } from "../../../../packages/db/node_modules/@aws-sdk/client-s3/dist-cjs/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";

import { migrate } from "../../../../packages/db/src/schema/migrate.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import {
	assessments,
	commitments,
	getCommitmentDownload,
	interviews,
	peopleReader,
	peopleWriter as people,
	uploadCommitmentDocument,
} from "../../../../packages/domain/src/people/index.ts";

// Four Cs assessments, interviews and commitments through their public operations on a scratch schema.
const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const localCi =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!localCi && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only approved shared development or disposable CI endpoint allowed");
if (!localCi) source.searchParams.set("sslmode", "verify-full");
const schema = "wp014_" + randomUUID().replaceAll("-", ""),
	role = "wp014_" + randomBytes(8).toString("hex");
const admin = createDatabase({
	connectionString: source.href,
	max: 4,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
let today;
// A church-local date `n` days before today.
const day = (n) => new Date(Date.parse(today + "T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

const plants = [randomUUID(), randomUUID()],
	actors = Array.from({ length: 4 }, () => ({ id: randomUUID(), user: randomUUID(), session: randomUUID() }));
// 0: plant A owner, 1: plant A member, 2: plant B admin, 3: plant A admin.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const ok = (result) => {
	assert.equal(result.status, "ok", JSON.stringify(result));
	return result.value;
};
const refused = (result, code = "unavailable") => {
	assert.equal(result.status, "refused", JSON.stringify(result));
	assert.equal(result.error.code, code);
};
const tx = (body) => db.transaction(body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const count = async (table, personId) =>
	(await rows(sql`SELECT count(*)::int n FROM ${sql.identifier(table)} WHERE person_id=${sql.param(personId)}`))[0].n;
const revisionOf = async (id) => (await rows(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`))[0].r;
const stageOf = async (id) => (await rows(sql`SELECT stage FROM person WHERE id=${sql.param(id)}`))[0].stage;
const feed = async (personId) =>
	ok(await tx((t) => peopleReader.getActivities(t, ctx(), { personId }))).items.filter((a) => a.recordId);
const audits = (personId) =>
	// Every column, the stored retry reply included: privacy checks read the whole audit row.
	rows(
		sql`SELECT * FROM audit_event WHERE subject_id=${sql.param(personId)} AND command_id=id ORDER BY occurred_at,id`,
	);

async function person(name, stage = "prospect") {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), {
				requestKey: key(),
				input: { displayName: name, stage, adultClassification: "adult" },
			}),
		),
	).person;
}
async function retire(id) {
	const review = ok(await tx((t) => peopleReader.getStatusWarnings(t, ctx(), { personId: id }))).reviewRevision;
	ok(
		await tx(async (t) =>
			people.retirePerson(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(id),
				input: { personId: id, reason: "Moved away", reviewRevision: review, handoffs: [] },
			}),
		),
	);
}
const lens = (score, notes = null) => ({ score, notes });
const assess = (personId, occurredOn, score = 3, who = 0, requestKey = key()) =>
	tx((t) =>
		assessments.createAssessment(t, ctx(who), {
			requestKey,
			input: {
				personId,
				occurredOn,
				committed: lens(score, "Private lens note"),
				compelled: lens(score),
				contagious: lens(score),
				courageous: lens(score),
			},
		}),
	);
const criteria = (rating = "pass") => ({
	maturity: { rating, notes: "Private criterion note" },
	gifted: { rating },
	chemistry: { rating },
	rightReasons: { rating },
	season: { rating },
});
const interview = (personId, result, occurredOn = day(3), requestKey = key()) =>
	tx((t) =>
		interviews.createInterview(t, ctx(), {
			requestKey,
			input: { personId, occurredOn, ...criteria(), result, nextSteps: "Call next week" },
		}),
	);

before(async () => {
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	const password = randomBytes(32).toString("hex");
	await admin.execute(
		sql.raw(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
	);
	await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
	const url = new URL(source);
	url.username = role;
	url.password = password;
	db = createDatabase({ connectionString: url.href, max: 4, options: `-c search_path=${schema},pg_catalog,pg_temp` });
	for (const a of actors) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(a.user)},${sql.param(a.id + "@example.test")},true,'Synthetic')`,
		);
		await admin.execute(
			sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(a.id)},${sql.param(a.user)},'active','planter')`,
		);
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(a.session)},${sql.param(a.user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
		);
	}
	for (const id of plants)
		await admin.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(id)},'Synthetic','America/Chicago',7,14,1,8,1,1)`,
		);
	for (const [i, plant, roleName] of [
		[0, plants[0], "owner"],
		[1, plants[0], "member"],
		[2, plants[1], "admin"],
		[3, plants[0], "admin"],
	])
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${sql.param(actors[i].id)},${sql.param(plant)},${sql.param(roleName)},clock_timestamp())`,
		);
	today = (await rows(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text d`))[0].d;
});
after(async () => {
	if (db) await closeDatabase(db);
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	} finally {
		await closeDatabase(admin);
	}
});

test("AC:GAP-PPL-012 AC:TARGET-PPL-012 AC:GAP-PPL-006 AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-RETIRE Four Cs: server total, chronological latest, no stage change, advisory warning, Owner/Admin only", async () => {
	const alex = await person("Alex Rivera");
	const warnings = async () =>
		ok(await tx((t) => peopleReader.getStatusWarnings(t, ctx(), { personId: alex.id }))).warnings;
	assert.ok((await warnings()).includes("assessment_not_recorded"));

	// Four scores of 1 total 4; a request that sends its own total is refused and records nothing.
	const first = ok(await assess(alex.id, day(3), 1));
	assert.equal(first.assessment.total, 4);
	assert.deepEqual(first.person, { personId: alex.id, stage: "prospect", revision: alex.revision, stageChange: null });
	const forged = await tx((t) =>
		assessments.createAssessment(t, ctx(), {
			requestKey: key(),
			input: {
				personId: alex.id,
				occurredOn: day(1),
				...Object.fromEntries(["committed", "compelled", "contagious", "courageous"].map((n) => [n, lens(1)])),
				total: 20,
			},
		}),
	);
	refused(forged, "invalid_input");
	// A retry returns the first result; a later-recorded entry with an earlier date is history, not latest.
	const retryKey = key();
	const late = ok(await assess(alex.id, day(40), 5, 3, retryKey));
	assert.deepEqual(ok(await assess(alex.id, day(40), 5, 3, retryKey)), late);
	refused(await assess(alex.id, day(-1)), "invalid_input");
	assert.equal(await count("four_cs", alex.id), 2);
	const history = ok(await tx((t) => assessments.getAssessments(t, ctx(3), { personId: alex.id })));
	assert.deepEqual(
		[history.latest.id, history.items.map((a) => [a.occurredOn, a.total]), history.total],
		[
			first.assessment.id,
			[
				[day(3), 4],
				[day(40), 20],
			],
			2,
		],
	);
	assert.deepEqual(history.items[1].actor, { kind: "current_account", accountId: actors[3].id });
	assert.equal(history.items[0].committed.notes, "Private lens note");
	// Advisory only: recording never moves the stage, and the warning clears.
	assert.equal(await stageOf(alex.id), "prospect");
	assert.ok(!(await warnings()).includes("assessment_not_recorded"));

	// Members and other churches see no qualification record and cannot record one.
	refused(await tx((t) => assessments.getAssessments(t, ctx(1), { personId: alex.id })));
	refused(await tx((t) => assessments.getAssessments(t, ctx(2), { personId: alex.id })));
	refused(await assess(alex.id, day(2), 3, 1));
	refused(await assess(alex.id, day(2), 3, 2));
	assert.equal(await count("four_cs", alex.id), 2);

	// History shows each assessment; platform audit never holds a score or a note.
	assert.deepEqual(
		(await feed(alex.id)).map((a) => [a.action, a.recordId]),
		[
			["assessment_recorded", first.assessment.id],
			["assessment_recorded", late.assessment.id],
		],
	);
	assert.ok(!JSON.stringify(await audits(alex.id)).match(/score|Private lens note/));

	// A retired Person keeps its history and takes no new record.
	await retire(alex.id);
	assert.equal(ok(await tx((t) => assessments.getAssessments(t, ctx(), { personId: alex.id }))).total, 2);
	refused(await assess(alex.id, day(1)));
});

test("AC:GAP-PPL-013 AC:TARGET-PPL-013 AC:GAP-PPL-006 interviews: any result advances an earlier stage to interviewed with its history, an advanced stage stays, retries add nothing, no task", async () => {
	for (const result of ["qualified", "qualified_with_notes", "not_qualified", "follow_up"]) {
		const early = await person("Alex " + result),
			leader = await person("Casey " + result, "leader");
		const requestKey = key();
		const recorded = ok(await interview(early.id, result, day(3), requestKey));
		assert.deepEqual(recorded.person.stageChange, { from: "prospect", to: "interviewed" });
		assert.equal(recorded.interview.nextSteps, "Call next week");
		assert.deepEqual(ok(await interview(early.id, result, day(3), requestKey)), recorded);
		assert.deepEqual([await stageOf(early.id), await count("interview", early.id)], ["interviewed", 1]);
		const kept = ok(await interview(leader.id, result));
		assert.deepEqual(
			[kept.person.stage, kept.person.stageChange, await stageOf(leader.id)],
			["leader", null, "leader"],
		);
		assert.equal((await rows(sql`SELECT count(*)::int n FROM task WHERE person_id=${sql.param(early.id)}`))[0].n, 0);
		// The stage advance is in the same history entry as the interview.
		assert.deepEqual(
			(await feed(early.id)).map((a) => [a.action, a.stage]),
			[["interview_recorded", { from: "prospect", to: "interviewed" }]],
		);
	}
	// A backdated second interview is history; the latest is by interview date.
	const alex = await person("Alex Backdated", "attendee");
	const current = ok(await interview(alex.id, "follow_up", day(2))).interview;
	const older = ok(await interview(alex.id, "qualified", day(30))).interview;
	const read = ok(await tx((t) => interviews.getInterviews(t, ctx(), { personId: alex.id })));
	assert.deepEqual(
		[read.latest.id, read.items.map((i) => i.id), read.items[0].maturity],
		[current.id, [current.id, older.id], { rating: "pass", notes: "Private criterion note" }],
	);
	refused(await tx((t) => interviews.getInterviews(t, ctx(1), { personId: alex.id })));
	assert.ok(!JSON.stringify(await audits(alex.id)).match(/follow_up|qualified|Call next week|Private criterion note/));
});

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
/** A private bucket: uploads keep their bytes; download links are signed locally by the real AWS signer. */
function privateStorage() {
	const objects = new Map();
	const signer = new S3Client({
		region: "auto",
		endpoint: "https://storage.example.test",
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	});
	signer.send = async (command) => {
		const i = command.input;
		switch (command.constructor.name) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand":
				assert.match(i.Key, new RegExp(`^private/${plants[0]}/[a-f0-9-]{36}$`));
				objects.set(i.Key, Buffer.from(i.Body));
				return {};
			default:
				throw Error("unexpected provider operation");
		}
	};
	return { bucket: "synthetic-only", client: signer, objects };
}

test("AC:GAP-PPL-014 AC:TARGET-PPL-014 AC:CA021 AC:TARGET-PPL-026 AC:PROVIDER48-002 AC:PROVIDER48-003 commitments: card, document and Core Group together; dated withdrawal and reactivation keep stage and first acquisition; corrections with history", async () => {
	const storage = privateStorage();
	const alex = await person("Alex Rivera"),
		casey = await person("Casey Reed", "leader"),
		foreign = ok(
			await tx((t) => people.createPerson(t, ctx(2), { requestKey: key(), input: { displayName: "Foreign Alex" } })),
		).person;
	const upload = async (bytes, mime = "image/png") => {
		const pending = ok(
			await tx((t) =>
				commitments.requestCommitmentUpload(t, ctx(), { personId: alex.id, mime, byteLength: bytes.length }),
			),
		);
		return {
			id: pending.uploadId,
			stored: await uploadCommitmentDocument(db, storage, ctx(), { uploadId: pending.uploadId, bytes }),
		};
	};
	const card = (input, requestKey = key()) =>
		tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey,
				input: { personId: alex.id, kind: "core_group", ...input },
			}),
		);

	// Files over 10 MiB are refused before upload; bytes that are not the declared image fail and attach nothing.
	refused(
		await tx((t) =>
			commitments.requestCommitmentUpload(t, ctx(), {
				personId: alex.id,
				mime: "application/pdf",
				byteLength: 10 * 1024 * 1024 + 1,
			}),
		),
		"invalid_input",
	);
	const broken = await upload(Buffer.from("not an image"));
	refused(broken.stored, "invalid_input");
	refused(await card({ occurredOn: day(5), documentUploadId: broken.id }));
	// A witness from another church is refused.
	refused(await card({ occurredOn: day(5), witness: { personId: foreign.id } }));
	assert.equal(await count("commitment", alex.id), 0);

	// The card, its document, the Core Group advance and the active commitment come back together; a retry adds nothing.
	const document = await upload(png);
	ok(document.stored);
	const requestKey = key();
	const input = {
		occurredOn: day(5),
		witness: { personId: casey.id },
		notes: "Signed after class",
		documentUploadId: document.id,
	};
	const saved = ok(await card(input, requestKey));
	assert.deepEqual(ok(await card(input, requestKey)), saved);
	assert.deepEqual(
		[
			saved.person.stageChange,
			saved.current.state,
			saved.current.effectiveOn,
			saved.commitment.document,
			saved.commitment.witness,
		],
		[
			{ from: "prospect", to: "core_group" },
			"active",
			day(5),
			{ status: "attached", mediaType: "image/png", byteCount: png.length },
			{ kind: "person", personId: casey.id, displayName: "Casey Reed" },
		],
	);
	assert.equal(await count("commitment", alex.id), 1);
	// One document belongs to one card.
	refused(await card({ occurredOn: day(4), documentUploadId: document.id }));

	// An Owner or Admin gets a five-minute link to that exact object; a member, another church or an ended seat gets none.
	const link = ok(await getCommitmentDownload(db, storage, ctx(3), { commitmentId: saved.commitment.id }));
	const key0 = (await rows(sql`SELECT opaque_key FROM file_object WHERE id=${sql.param(document.id)}`))[0].opaque_key;
	assert.ok(link.url.includes(key0) && link.url.includes("X-Amz-Expires=300"), link.url);
	assert.equal(Date.parse(link.expiresAt) - Date.now() <= 300_000, true);
	refused(await getCommitmentDownload(db, storage, ctx(1), { commitmentId: saved.commitment.id }));
	refused(await getCommitmentDownload(db, storage, ctx(2), { commitmentId: saved.commitment.id }));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[3].id)}`);
	refused(await getCommitmentDownload(db, storage, ctx(3), { commitmentId: saved.commitment.id }));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[3].id)}`);

	// A stale withdrawal is a conflict and records nothing; a current one keeps the stage and the first acquisition.
	const withdraw = (expectedRevision, effectiveOn = day(2)) =>
		tx((t) =>
			commitments.withdrawCommitment(t, ctx(), {
				requestKey: key(),
				expectedRevision,
				input: { personId: alex.id, effectiveOn, reason: "Person withdrew" },
			}),
		);
	const auditCount = async () => (await rows(sql`SELECT count(*)::int n FROM audit_event`))[0].n;
	const beforeStale = await auditCount();
	refused(await withdraw(alex.revision), "conflict");
	assert.equal(await auditCount(), beforeStale);
	const withdrawn = ok(await withdraw(saved.person.revision));
	assert.deepEqual(
		[withdrawn.current.state, withdrawn.current.effectiveOn, await stageOf(alex.id)],
		["withdrawn", day(2), "core_group"],
	);
	const commitmentsOf = async () => ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId: alex.id })));
	assert.deepEqual((await commitmentsOf()).firstAcquisition, {
		status: "known",
		occurredOn: day(5),
		evidenceId: saved.commitment.id,
	});
	// An older signature recorded later cannot override the withdrawal.
	const oldKey = key();
	const old = ok(await card({ occurredOn: day(9), kind: "launch_team" }, oldKey));
	assert.equal(old.current.state, "withdrawn");
	// Reactivation restores the current commitment without a new acquisition.
	const reactivated = ok(
		await tx((t) =>
			commitments.reactivateCommitment(t, ctx(), {
				requestKey: key(),
				expectedRevision: old.current.personRevision,
				input: { personId: alex.id, effectiveOn: day(1) },
			}),
		),
	);
	const after = await commitmentsOf();
	assert.deepEqual(
		[
			reactivated.current.state,
			after.current.state,
			after.firstAcquisition.occurredOn,
			after.firstAcquisition.evidenceId,
		],
		["active", "active", day(9), old.commitment.id],
	);
	assert.equal(await stageOf(alex.id), "core_group");

	// A repeat launch-team card on a Leader keeps the stage.
	const repeat = ok(
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId: casey.id, kind: "launch_team", occurredOn: day(1), witness: { external: "Pastor Lee" } },
			}),
		),
	);
	assert.deepEqual([repeat.person.stage, repeat.person.stageChange], ["leader", null]);

	// Correcting the invalid earliest card's date moves the first acquisition, with old, new, actor and reason.
	const corrected = ok(
		await tx((t) =>
			commitments.correctCommitmentLifecycle(t, ctx(), {
				requestKey: key(),
				expectedRevision: old.commitment.revision,
				input: {
					commitmentId: old.commitment.id,
					correction: { action: "correct", occurredOn: day(3) },
					reason: "Wrong date entered",
				},
			}),
		),
	);
	assert.equal(corrected.current.state, "active");
	assert.deepEqual((await commitmentsOf()).firstAcquisition, {
		status: "known",
		occurredOn: day(5),
		evidenceId: saved.commitment.id,
	});
	const correction = (await audits(alex.id)).at(-1);
	assert.deepEqual(
		[
			correction.action,
			correction.reason,
			correction.before_value.commitment.occurredOn,
			correction.after_value.commitment.occurredOn,
		],
		["people.corrected", "Wrong date entered", day(9), day(3)],
	);
	// Voiding every valid card leaves the current commitment unknown and no acquisition; stage stays.
	for (const id of [old.commitment.id, saved.commitment.id]) {
		const k = (await commitmentsOf()).items.find((i) => i.id === id);
		ok(
			await tx((t) =>
				commitments.correctCommitmentLifecycle(t, ctx(), {
					requestKey: key(),
					expectedRevision: k.revision,
					input: { commitmentId: id, correction: { action: "void" }, reason: "Never signed" },
				}),
			),
		);
	}
	// A retry of the original create still returns the card as it was saved, after its correction and void.
	assert.deepEqual(ok(await card({ occurredOn: day(9), kind: "launch_team" }, oldKey)), old);
	const voided = await commitmentsOf();
	assert.deepEqual(
		[voided.current.state, voided.firstAcquisition, voided.items.every((i) => i.voidedAt), await stageOf(alex.id)],
		["unknown", { status: "none" }, true, "core_group"],
	);
	assert.deepEqual(
		(await feed(alex.id)).map((a) => [a.action, a.stage ?? null]),
		[
			["commitment_recorded", { from: "prospect", to: "core_group" }],
			["commitment_recorded", null],
			["commitment_corrected", null],
			["commitment_corrected", null],
			["commitment_corrected", null],
		],
	);
	// Withdrawal and reactivation show in history too; no audit row holds a note, witness or document detail.
	const actions = (await audits(alex.id)).map((a) => a.metadata.event).filter(Boolean);
	assert.deepEqual(
		actions.filter((a) => a === "commitment_withdrawn" || a === "commitment_reactivated"),
		["commitment_withdrawn", "commitment_reactivated"],
	);
	assert.ok(
		!JSON.stringify([...(await audits(alex.id)), ...(await audits(casey.id))]).match(
			/Signed after class|Pastor Lee|image\/png/,
		),
	);
	// Another church reads no commitments.
	refused(await tx((t) => commitments.getCommitments(t, ctx(2), { personId: alex.id })));
});

test("INV-tenancy C13: a seat ended after the request resolved its actor reads no assessments, interviews or commitments", async () => {
	const p = await person("Morgan Lee");
	ok(await assess(p.id, day(1)));
	ok(await interview(p.id, "qualified"));
	const actor = await db.transaction((t) => RequestActor.resolve(t, actors[3].session));
	assert.ok(actor instanceof RequestActor);
	const reads = {
		getAssessments: (t, c) => assessments.getAssessments(t, c, { personId: p.id }),
		getInterviews: (t, c) => interviews.getInterviews(t, c, { personId: p.id }),
		getCommitments: (t, c) => commitments.getCommitments(t, c, { personId: p.id }),
	};
	const run = (read) => db.transaction((t) => read(t, new PeopleReadContext(actor)));
	for (const read of Object.values(reads)) ok(await run(read));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[3].id)}`);
	try {
		for (const [name, read] of Object.entries(reads))
			assert.equal((await run(read)).status, "refused", name + " returned data after the seat ended");
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[3].id)}`);
	}
	// A seat demoted to member reads nothing either.
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${sql.param(actors[3].id)}`);
	try {
		for (const [name, read] of Object.entries(reads))
			assert.equal((await run(read)).status, "refused", name + " returned data after the role changed");
	} finally {
		await admin.execute(sql`UPDATE seat SET role='admin' WHERE account_id=${sql.param(actors[3].id)}`);
	}
});
