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
	commitmentInputs,
	commitmentInputsJson,
	commitmentOf,
} from "../../../../packages/domain/src/people/commitments/lifecycle.ts";
import {
	commitmentCacheBackfill,
	mergeReferencesBackfill,
} from "../../../../packages/domain/src/people/commitments/backfill.ts";
import { factsOf, parseFacts, referencesDigest } from "../../../../packages/domain/src/people/merge/index.ts";
import { backfill } from "../../../../packages/db/src/schema/migrate.ts";
import {
	assessments,
	commitments,
	getCommitmentDownload,
	interviews,
	peopleMerge,
	peopleReader,
	peopleUnmerge,
	peopleWriter as people,
	recordCorrections,
	saveCommitmentDocument,
	signCommitmentDocument,
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
/** A private bucket: browser PUTs keep their bytes; download links are signed locally by the real AWS signer. */
function privateStorage() {
	// What a browser PUT with a signed URL leaves in the bucket, the server's reads of it and an optional hook while
	// the server reads it back.
	const uploads = new Map();
	const reads = { during: null, count: 0 };
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
			case "GetObjectCommand": {
				reads.count++;
				const found = uploads.get(i.Key);
				if (!found) throw Object.assign(Error("NoSuchKey"), { name: "NoSuchKey" });
				await reads.during?.();
				return {
					ContentLength: found.bytes.length,
					ContentType: found.type,
					Body: { transformToByteArray: async () => found.bytes },
				};
			}
			default:
				throw Error("unexpected provider operation");
		}
	};
	return { bucket: "synthetic-only", client: signer, uploads, reads };
}
/** The request's resolved viewer, as the app passes it to a write. */
const authorityOf = (who) => db.transaction((t) => RequestActor.resolve(t, actors[who].session));

test("AC:GAP-PPL-014 AC:TARGET-PPL-014 AC:CA021 AC:TARGET-PPL-026 commitments: card and Core Group together; dated withdrawal and reactivation keep stage and first acquisition; corrections with history", async () => {
	const alex = await person("Alex Rivera"),
		casey = await person("Casey Reed", "leader"),
		foreign = ok(
			await tx((t) => people.createPerson(t, ctx(2), { requestKey: key(), input: { displayName: "Foreign Alex" } })),
		).person;
	const card = (input, requestKey = key(), personId = alex.id) =>
		tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey,
				input: { personId, kind: "core_group", ...input },
			}),
		);
	const correct = (commitmentId, expectedRevision, correction, reason = "Wrong date entered") =>
		tx((t) =>
			commitments.correctCommitmentLifecycle(t, ctx(), {
				requestKey: key(),
				expectedRevision,
				input: { commitmentId, correction, reason },
			}),
		);

	// A witness from another church is refused.
	refused(await card({ occurredOn: day(5), witness: { personId: foreign.id } }));
	assert.equal(await count("commitment", alex.id), 0);

	// The card, the Core Group advance and the active commitment come back together; a retry adds nothing.
	const requestKey = key();
	const input = { occurredOn: day(5), witness: { personId: casey.id }, notes: "Signed after class" };
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
			{ status: "none" },
			{ kind: "person", personId: casey.id },
		],
	);
	assert.equal(await count("commitment", alex.id), 1);
	// Renaming the witness changes the names the history shows, never the saved card or its retry.
	ok(
		await tx(async (t) =>
			people.updatePerson(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf(casey.id),
				input: { personId: casey.id, patch: { displayName: "Casey Morgan" } },
			}),
		),
	);
	assert.deepEqual(ok(await card(input, requestKey)), saved);
	assert.deepEqual(ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId: alex.id }))).witnessNames, {
		[casey.id]: "Casey Morgan",
	});

	// A stale withdrawal is a conflict and records nothing; a current one keeps the stage and the first acquisition.
	const withdraw = (expectedRevision, effectiveOn = day(2), personId = alex.id) =>
		tx((t) =>
			commitments.withdrawCommitment(t, ctx(), {
				requestKey: key(),
				expectedRevision,
				input: { personId, effectiveOn, reason: "Person withdrew" },
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
	const commitmentsOf = async (personId = alex.id) =>
		ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId })));
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
		await correct(old.commitment.id, old.commitment.revision, { action: "correct", occurredOn: day(3) }),
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
	// BUG-R2-1: a correction to the values the card already has changes nothing: no card revision, no Person revision
	// and no history entry, and the correction history still reads.
	const unchanged = await commitmentsOf();
	const same = ok(
		await correct(old.commitment.id, "2", { action: "correct", occurredOn: day(3), kind: "launch_team" }),
	);
	assert.deepEqual([same.outcome, same.current], ["noop", unchanged.current]);
	assert.deepEqual(await commitmentsOf(), unchanged);
	const history = ok(await tx((t) => recordCorrections.listRecordCorrections(t, ctx(), { personId: alex.id })));
	assert.deepEqual(
		history.items.map((i) => i.recordId),
		[old.commitment.id],
	);
	// Voiding every valid card leaves the current commitment unknown and no acquisition; stage stays.
	for (const id of [old.commitment.id, saved.commitment.id]) {
		const k = (await commitmentsOf()).items.find((i) => i.id === id);
		ok(await correct(id, k.revision, { action: "void" }, "Never signed"));
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
	// Withdrawal and reactivation show in history too; no audit row holds a note or witness detail.
	const actions = (await audits(alex.id)).map((a) => a.metadata?.event).filter(Boolean);
	assert.deepEqual(
		actions.filter((a) => a === "commitment_withdrawn" || a === "commitment_reactivated"),
		["commitment_withdrawn", "commitment_reactivated"],
	);
	assert.ok(
		!JSON.stringify([...(await audits(alex.id)), ...(await audits(casey.id))]).match(/Signed after class|Pastor Lee/),
	);

	// BUG-R2-4: the commitment's effective date follows the card that made it active. Correcting that card's date
	// moves it; voiding that card falls back to the earliest other valid card, or to the withdrawal it ended.
	const pat = await person("Pat Moved");
	const since = async () => {
		const { state, effectiveOn } = (await commitmentsOf(pat.id)).current;
		return [state, effectiveOn];
	};
	const first = ok(await card({ occurredOn: day(6) }, key(), pat.id));
	ok(await correct(first.commitment.id, "1", { action: "correct", occurredOn: day(8) }));
	assert.deepEqual(await since(), ["active", day(8)]);
	ok(await card({ occurredOn: day(4) }, key(), pat.id));
	ok(await correct(first.commitment.id, "2", { action: "void" }, "Never signed"));
	assert.deepEqual(await since(), ["active", day(4)]);
	// A withdrawal after the remaining card's date is accepted.
	ok(await withdraw((await commitmentsOf(pat.id)).current.personRevision, day(3), pat.id));
	const back = ok(await card({ occurredOn: day(1) }, key(), pat.id));
	assert.deepEqual(await since(), ["active", day(1)]);
	ok(await correct(back.commitment.id, "1", { action: "void" }, "Never signed"));
	assert.deepEqual(await since(), ["withdrawn", day(3)]);
	// BUG-R2-4 (verifier, 618ddc7): an explicit reactivation is not a card. Voiding a repeat card signed on the
	// reactivation date keeps the reactivation.
	const quinn = await person("Quinn Rejoined");
	const quinnSince = async () => {
		const { state, effectiveOn } = (await commitmentsOf(quinn.id)).current;
		return [state, effectiveOn];
	};
	ok(await card({ occurredOn: day(10) }, key(), quinn.id));
	ok(await withdraw((await commitmentsOf(quinn.id)).current.personRevision, day(8), quinn.id));
	ok(
		await tx(async (t) =>
			commitments.reactivateCommitment(t, ctx(), {
				requestKey: key(),
				expectedRevision: (await commitmentsOf(quinn.id)).current.personRevision,
				input: { personId: quinn.id, effectiveOn: day(6) },
			}),
		),
	);
	const repeatCard = ok(await card({ occurredOn: day(6) }, key(), quinn.id));
	ok(await correct(repeatCard.commitment.id, "1", { action: "void" }, "Never signed"));
	assert.deepEqual(await quinnSince(), ["active", day(6)]);

	// Another church reads no commitments.
	refused(await tx((t) => commitments.getCommitments(t, ctx(2), { personId: alex.id })));
});

test("AC:GAP-PPL-014 AC:TARGET-PPL-014 AC:PROVIDER48-002 AC:PROVIDER48-003 RT-2 design B: the browser puts the document straight into the bucket; the save checks the file and attaches it to the card through the shared write with one audit row", async () => {
	const storage = privateStorage();
	const sam = await person("Sam Direct"),
		witness = await person("Jordan Witness", "leader"),
		foreign = ok(
			await tx((t) => people.createPerson(t, ctx(2), { requestKey: key(), input: { displayName: "Foreign Sam" } })),
		).person;
	const sign = (who, personId, bytes, mime) =>
		signCommitmentDocument(db, storage, ctx(who), actors[who].id, { personId, mime, byteLength: bytes.length });
	// The browser's PUT: the bucket keeps the bytes under the signed key with the signed type.
	const keyOf = (uploadId) => `private/${plants[0]}/${uploadId}`;
	const put = (signed, bytes) =>
		storage.uploads.set(keyOf(signed.uploadId), { bytes, type: signed.headers["content-type"] });
	const save = async (who, uploadId, input = {}, requestKey = key()) =>
		saveCommitmentDocument(db, storage, await authorityOf(who), {
			requestKey,
			input: { personId: sam.id, kind: "core_group", occurredOn: day(2), documentUploadId: uploadId, ...input },
		});
	const stateOf = async (id) => (await rows(sql`SELECT state FROM file_object WHERE id=${sql.param(id)}`))[0].state;

	// Only a live Owner or Admin of the Person's church can sign, and only up to 10 MiB. The card's document is a PNG:
	// the census runs this suite with loader flags that a PDF parse worker inherits (the PDF check has its own test).
	const document = png;
	refused(await sign(1, sam.id, document, "image/png"));
	refused(await sign(0, foreign.id, document, "image/png"));
	refused(
		await signCommitmentDocument(db, storage, ctx(), actors[0].id, {
			personId: sam.id,
			mime: "application/pdf",
			byteLength: 10 * 1024 * 1024 + 1,
		}),
		"invalid_input",
	);
	// The URL binds the exact key, type and length, writes once and works for five minutes.
	const signed = ok(await sign(0, sam.id, document, "image/png"));
	const url = new URL(signed.url);
	assert.ok(url.pathname.endsWith("/" + keyOf(signed.uploadId)), url.pathname);
	assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
	assert.deepEqual(url.searchParams.get("X-Amz-SignedHeaders").split(";"), [
		"cache-control",
		"content-length",
		"content-type",
		"host",
		"if-none-match",
	]);
	assert.deepEqual(signed.headers, {
		"content-type": "image/png",
		"if-none-match": "*",
		"cache-control": "private, no-store",
	});
	assert.equal(await stateOf(signed.uploadId), "pending");

	// Nothing in the bucket yet: the save is refused and records nothing.
	refused(await save(0, signed.uploadId));
	put(signed, document);

	// A sign-out that lands while the server checks the uploaded bytes refuses the save. The upload stays pending, so a
	// live Owner or Admin can still save the same upload.
	const signOut = async () => {
		storage.reads.during = null;
		await admin.execute(sql`DELETE FROM auth_session WHERE id=${sql.param(actors[0].session)}`);
	};
	const owner = await authorityOf(0);
	storage.reads.during = signOut;
	try {
		refused(
			await saveCommitmentDocument(db, storage, owner, {
				requestKey: key(),
				input: { personId: sam.id, kind: "core_group", occurredOn: day(2), documentUploadId: signed.uploadId },
			}),
		);
		assert.deepEqual([await stateOf(signed.uploadId), await count("commitment", sam.id)], ["pending", 0]);
	} finally {
		storage.reads.during = null;
		await admin.execute(
			sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(actors[0].session)},${sql.param(actors[0].user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day') ON CONFLICT (id) DO NOTHING`,
		);
	}
	// A refused card never uses up its upload: a foreign witness or a future date leaves it pending for the corrected
	// save. BUG-R2-6: a future date names its reason, so the card can say which field to fix.
	refused(await save(0, signed.uploadId, { witness: { personId: foreign.id } }));
	const future = await save(0, signed.uploadId, { occurredOn: day(-1) });
	refused(future, "invalid_input");
	assert.deepEqual(future.error.details, { reason: "future_date" });
	assert.deepEqual([await stateOf(signed.uploadId), await count("commitment", sam.id)], ["pending", 0]);
	// A member and another church cannot save it. BUG-R2-5: a member's save is refused before the server reads the
	// bucket.
	const reads = storage.reads.count;
	refused(await save(1, signed.uploadId));
	assert.equal(storage.reads.count, reads);
	refused(await save(2, signed.uploadId));

	// The card, the document, the Core Group advance and the active commitment, in the established reply shape.
	const requestKey = key();
	const input = { witness: { personId: witness.id }, notes: "Signed at the picnic" };
	const auditsBefore = (await rows(sql`SELECT count(*)::int n FROM audit_event`))[0].n;
	const saved = ok(await save(3, signed.uploadId, input, requestKey));
	assert.deepEqual(
		[
			saved.person.stageChange,
			saved.person.stage,
			saved.current.state,
			saved.current.effectiveOn,
			saved.current.personRevision,
			saved.commitment.document,
			saved.commitment.witness,
			saved.commitment.actor,
			saved.commitment.revision,
			saved.outcome,
		],
		[
			{ from: "prospect", to: "core_group" },
			"core_group",
			"active",
			day(2),
			String(BigInt(sam.revision) + 1n),
			{ status: "attached", mediaType: "image/png", byteCount: document.length },
			{ kind: "person", personId: witness.id },
			{ kind: "current_account", accountId: actors[3].id },
			"1",
			"changed",
		],
	);
	// One audit row for the whole action, and the history and Activity read it as any card.
	assert.equal((await rows(sql`SELECT count(*)::int n FROM audit_event`))[0].n, auditsBefore + 1);
	assert.equal(await stateOf(signed.uploadId), "ready");
	const history = ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId: sam.id })));
	assert.deepEqual(history.latest, saved.commitment);
	assert.deepEqual(
		(await feed(sam.id)).map((a) => [a.action, a.recordId, a.stage ?? null]),
		[["commitment_recorded", saved.commitment.id, { from: "prospect", to: "core_group" }]],
	);
	assert.ok(!JSON.stringify(await audits(sam.id)).match(/Signed at the picnic|image\/png/));
	// A retry with the same request key returns the same reply and writes nothing; the upload attaches to one card only.
	assert.deepEqual(ok(await save(3, signed.uploadId, input, requestKey)), saved);
	refused(await save(3, signed.uploadId, input));
	assert.equal(await count("commitment", sam.id), 1);

	// An Owner or Admin gets a five-minute link to that exact object; a member, another church or an ended seat gets none.
	const link = ok(await getCommitmentDownload(db, storage, ctx(), { commitmentId: saved.commitment.id }));
	assert.ok(link.url.includes(keyOf(signed.uploadId)) && link.expiresInSeconds === 300, link.url);
	assert.equal(Date.parse(link.expiresAt) - Date.now() <= 300_000, true);
	refused(await getCommitmentDownload(db, storage, ctx(1), { commitmentId: saved.commitment.id }));
	refused(await getCommitmentDownload(db, storage, ctx(2), { commitmentId: saved.commitment.id }));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[3].id)}`);
	refused(await getCommitmentDownload(db, storage, ctx(3), { commitmentId: saved.commitment.id }));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[3].id)}`);

	// Bytes that are not a real PDF are refused and stay pending for their cleanup. BUG-R2-6: the refusal names the file.
	const fake = Buffer.from("%PDF-1.7 not really a document");
	const bad = ok(await sign(0, sam.id, fake, "application/pdf"));
	put(bad, fake);
	const unreadable = await save(0, bad.uploadId, { occurredOn: day(1) });
	refused(unreadable, "invalid_input");
	assert.deepEqual(unreadable.error.details, { reason: "unreadable_document" });
	assert.deepEqual([await stateOf(bad.uploadId), await count("commitment", sam.id)], ["pending", 1]);

	// BUG-193 (C36): once one card holds a document, later cards still attach their own new uploads, and the cleanup
	// check sees only attached objects as referenced.
	const unattached = async (id) =>
		(await rows(sql`SELECT file_is_referenced(${sql.param(id)}::uuid) AS r`))[0].r === false;
	const later = [];
	for (let n = 0; n < 2; n++) {
		const next = ok(await sign(0, sam.id, png, "image/png"));
		put(next, png);
		later.push(next.uploadId);
	}
	assert.deepEqual([await unattached(later[0]), await unattached(signed.uploadId)], [true, false]);
	for (const uploadId of later)
		assert.deepEqual(ok(await save(0, uploadId, { occurredOn: day(1) })).commitment.document, {
			status: "attached",
			mediaType: "image/png",
			byteCount: png.length,
		});
	assert.equal(await unattached(later[1]), false);
});

test("INV-commitment (C100): after every command sequence the cached commitment equals the one function of the valid cards and dated changes", async () => {
	// Each step names a Person by letter. Expected values come from the rules: the earliest valid signed date starts the
	// commitment, a withdrawal ends it, only a later card or an explicit reactivation restarts it.
	const cases = [
		{
			name: "late-recorded earlier card moves the start date",
			steps: [
				["card", "a", 6],
				["card", "a", 4],
				["card", "a", 2],
			],
			expect: { a: ["active", 6] },
		},
		{
			name: "correct and void the starting card",
			steps: [
				["card", "a", 6, "k1"],
				["correct", "k1", 8],
				["card", "a", 4],
				["void", "k1"],
			],
			expect: { a: ["active", 4] },
		},
		{
			name: "void a card that restarted a withdrawn commitment",
			steps: [
				["card", "a", 6],
				["withdraw", "a", 3],
				["card", "a", 1, "k2"],
				["void", "k2"],
			],
			expect: { a: ["withdrawn", 3] },
		},
		{
			name: "verifier: explicit reactivation survives voiding a same-date repeat card",
			steps: [
				["card", "a", 10],
				["withdraw", "a", 8],
				["reactivate", "a", 6],
				["card", "a", 6, "k3"],
				["void", "k3"],
			],
			expect: { a: ["active", 6] },
		},
		{
			name: "an older signature never overrides a withdrawal",
			steps: [
				["card", "a", 5],
				["withdraw", "a", 2],
				["card", "a", 9],
			],
			expect: { a: ["withdrawn", 2] },
		},
		{
			name: "a withdrawal dated before a later card is refused",
			steps: [
				["card", "a", 6],
				["card", "a", 2],
				["withdraw!", "a", 4],
			],
			expect: { a: ["active", 6] },
		},
		{
			name: "verifier: merge, then void the survivor's card; the source's card remains",
			steps: [
				["card", "a", 1, "k4"],
				["card", "b", 10],
				["merge", "b", "a"],
				["void", "k4"],
			],
			expect: { a: ["active", 10] },
		},
		{
			name: "merge combines both histories; unmerge gives each Person its own again",
			steps: [
				["card", "a", 6],
				["withdraw", "a", 3],
				["card", "b", 2],
				["merge", "b", "a"],
				["unmerge", "a"],
			],
			expect: { a: ["withdrawn", 3], b: ["active", 2] },
		},
		{
			name: "merge of a withdrawn source into an active survivor",
			steps: [
				["card", "a", 9],
				["card", "b", 8],
				["withdraw", "b", 5],
				["merge", "b", "a"],
			],
			expect: { a: ["withdrawn", 5] },
		},
		{
			name: "verifier: a cache written before C100 never comes back on unmerge (empty source)",
			steps: [
				["card", "a", 6],
				["card", "a", 10],
				["stale", "a", 6],
				["merge", "b", "a"],
				["unmerge", "a"],
			],
			expect: { a: ["active", 10], b: ["unknown", null] },
		},
		{
			name: "verifier: a cache written before C100 never comes back on unmerge (source with a card)",
			steps: [
				["card", "a", 6],
				["card", "a", 10],
				["stale", "a", 6],
				["card", "b", 2],
				["merge", "b", "a"],
				["unmerge", "a"],
			],
			expect: { a: ["active", 10], b: ["active", 2] },
		},
		{
			name: "a merge made before C100 unmerges after the merge backfill and gives the source its withdrawal back",
			steps: [
				["card", "a", 6],
				["card", "b", 8],
				["withdraw", "b", 4],
				["merge", "b", "a"],
				["legacy", "a"],
				["merge backfill", "a"],
				["unmerge", "a"],
			],
			expect: { a: ["active", 6], b: ["withdrawn", 4] },
		},
	];
	const merged = new Map(),
		everyone = [],
		// People made stale by hand, until a merge or Unmerge recomputes them.
		edited = new Set();
	for (const { name, steps, expect } of cases) {
		const people = {},
			cards = {};
		for (const letter of new Set(steps.flatMap((s) => s.slice(1).filter((x) => /^[ab]$/.test(x)))))
			everyone.push((people[letter] = (await person("Inv " + letter + " " + name.slice(0, 20))).id));
		const current = async (personId) => ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId }))).current;
		const card = async (id) =>
			(await rows(sql`SELECT revision::text r FROM commitment WHERE id=${sql.param(id)}`))[0].r;
		for (const [op, a, b, c] of steps) {
			const at = `${name}: ${op} ${a} ${b ?? ""}`;
			if (op === "card") {
				const saved = ok(
					await tx((t) =>
						commitments.createCommitment(t, ctx(), {
							requestKey: key(),
							input: { personId: people[a], kind: "core_group", occurredOn: day(b) },
						}),
					),
				);
				if (c) cards[c] = saved.commitment.id;
			} else if (op === "correct" || op === "void") {
				const correction = op === "void" ? { action: "void" } : { action: "correct", occurredOn: day(b) };
				ok(
					await tx(async (t) =>
						commitments.correctCommitmentLifecycle(t, ctx(), {
							requestKey: key(),
							expectedRevision: await card(cards[a]),
							input: { commitmentId: cards[a], correction, reason: "Sequence " + op },
						}),
					),
					at,
				);
			} else if (op === "withdraw" || op === "withdraw!" || op === "reactivate") {
				const change = op === "reactivate" ? commitments.reactivateCommitment : commitments.withdrawCommitment;
				const result = await tx(async (t) =>
					change(t, ctx(), {
						requestKey: key(),
						expectedRevision: (await current(people[a])).personRevision,
						input: { personId: people[a], effectiveOn: day(b) },
					}),
				);
				if (op === "withdraw!") refused(result, "invalid_input");
				else ok(result, at);
			} else if (op === "merge") {
				const review = ok(
					await tx((t) => peopleMerge.getMergeReview(t, ctx(), { sourceId: people[a], survivorId: people[b] })),
				);
				const done = ok(
					await tx((t) =>
						peopleMerge.mergePeople(t, ctx(), {
							requestKey: key(),
							input: {
								sourceId: people[a],
								survivorId: people[b],
								reviewDigest: review.reviewDigest,
								fieldChoices: {},
							},
						}),
					),
				);
				merged.set(people[b], done.mergeId);
				edited.delete(people[b]);
			} else if (op === "unmerge") {
				const mergeId = merged.get(people[a]);
				const preview = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(), { mergeId })));
				ok(
					await tx((t) =>
						peopleUnmerge.unmergePeople(t, ctx(), {
							requestKey: key(),
							expectedRevision: preview.reviewRevision,
							input: { mergeId },
						}),
					),
				);
			} else if (op === "stale") {
				// A value cached by main before C100: the first recorded card's date.
				await admin.execute(sql`UPDATE person SET commitment_state='active',commitment_effective_on=${sql.param(day(b))}
 WHERE id=${sql.param(people[a])}`);
				edited.add(people[a]);
				continue;
			} else if (op === "legacy") {
				// The merge as main recorded it: no commitment_change in its moved list or reviewed digest.
				const mergeId = merged.get(people[a]);
				const [f] = await rows(sql`SELECT ${factsOf(sql`${sql.param(people[a])}::uuid`, plants[0])} AS f`);
				const before = parseFacts(f.f).refs.filter((r) => r.kind !== "commitment_change");
				await admin.execute(sql`UPDATE person_merge SET moved=moved-'commitment_change',
 references_digest=${sql.param(referencesDigest(before))} WHERE id=${sql.param(mergeId)}`);
				// Without the merge backfill this merge could never be undone.
				assert.deepEqual(ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(), { mergeId }))).conflicts, [
					"references_changed",
				]);
				continue;
			} else if (op === "merge backfill") {
				assert.deepEqual(await backfill(admin, [mergeReferencesBackfill(1)], schema), [
					{ name: "merge_references_c100", changed: 1 },
				]);
			}
			// The invariant: every live Person's cache equals the function of its inputs, after every step.
			if (op === "unmerge") edited.clear();
			for (const personId of Object.values(people).filter((id) => !edited.has(id))) {
				const [row] = await rows(sql`SELECT p.state,p.commitment_state,p.commitment_effective_on::text AS on,
 ${commitmentInputsJson(sql`p.id`, sql`p.plant_id`)} AS inputs FROM person p WHERE p.id=${sql.param(personId)}`);
				if (row.state !== "live") continue;
				assert.deepEqual(
					{ state: row.commitment_state, effectiveOn: row.on },
					commitmentOf(commitmentInputs.parse(row.inputs)),
					at,
				);
			}
		}
		for (const [letter, [state, n]] of Object.entries(expect)) {
			const { state: s, effectiveOn } = await current(people[letter]);
			assert.deepEqual([s, effectiveOn], [state, n === null ? null : day(n)], name);
		}
	}
	// C101: db:migrate's one-time backfill makes stale caches (written before C100) equal the function. It changes only
	// the rows that differ, in batches, and a rerun does nothing.
	const [late, corrected] = everyone;
	await admin.execute(
		sql`UPDATE person SET commitment_state='unknown',commitment_effective_on=NULL WHERE id=${sql.param(late)}`,
	);
	await admin.execute(
		sql`UPDATE person SET commitment_effective_on=${sql.param(day(30))} WHERE id=${sql.param(corrected)}`,
	);
	assert.deepEqual(await backfill(admin, [commitmentCacheBackfill(2)], schema), [
		{ name: "commitment_cache_c100", changed: 2 },
	]);
	const stale = await rows(sql`SELECT p.id,p.commitment_state AS state,p.commitment_effective_on::text AS on,
 ${commitmentInputsJson(sql`p.id`, sql`p.plant_id`)} AS inputs FROM person p WHERE p.plant_id IS NOT NULL AND p.state<>'merged'`);
	assert.deepEqual(
		stale.filter(
			(p) =>
				JSON.stringify({ state: p.state, effectiveOn: p.on }) !==
				JSON.stringify(commitmentOf(commitmentInputs.parse(p.inputs))),
		),
		[],
	);
	assert.deepEqual(
		ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId: late }))).current.effectiveOn,
		day(6),
	);
	assert.deepEqual(await backfill(admin, [commitmentCacheBackfill(2)], schema), []);
});

test("C88 RT-2: a save that meets a held lock waits the established way and sees what the holder committed", async () => {
	const storage = privateStorage();
	const lee = await person("Lee Concurrent", "attendee");
	const signed = ok(
		await signCommitmentDocument(db, storage, ctx(), actors[0].id, {
			personId: lee.id,
			mime: "image/png",
			byteLength: png.length,
		}),
	);
	storage.uploads.set(`private/${plants[0]}/${signed.uploadId}`, { bytes: png, type: "image/png" });
	// Another writer moves Lee to the Launch Team and holds the row until it commits.
	let release;
	const held = new Promise((r) => (release = r));
	let locked;
	const lockTaken = new Promise((r) => (locked = r));
	const other = admin.transaction(async (a) => {
		await a.execute(sql`UPDATE person SET stage='launch_team',revision=revision+1 WHERE id=${sql.param(lee.id)}`);
		locked();
		await held;
	});
	await lockTaken;
	const saving = saveCommitmentDocument(db, storage, await authorityOf(0), {
		requestKey: key(),
		input: { personId: lee.id, kind: "core_group", occurredOn: day(1), documentUploadId: signed.uploadId },
	});
	await new Promise((r) => setTimeout(r, 300));
	release();
	await other;
	const saved = ok(await saving);
	// The save saw the committed Launch Team stage: no move back to Core Group, and its revision follows the other write.
	assert.deepEqual(
		[saved.person.stage, saved.person.stageChange, saved.person.revision, await stageOf(lee.id)],
		["launch_team", null, String(BigInt(lee.revision) + 2n), "launch_team"],
	);
	// A row the save only reads, not locks: an account deletion recorded by a writer that holds the account row. The
	// save never reads it from a snapshot older than that writer's commit, so it is refused and attaches nothing.
	const next = ok(
		await signCommitmentDocument(db, storage, ctx(3), actors[3].id, {
			personId: lee.id,
			mime: "image/png",
			byteLength: png.length,
		}),
	);
	storage.uploads.set(`private/${plants[0]}/${next.uploadId}`, { bytes: png, type: "image/png" });
	// The request resolved its viewer before the deletion started.
	const deleting3 = await authorityOf(3);
	let commit;
	const committed = new Promise((r) => (commit = r));
	let started;
	const deleting = new Promise((r) => (started = r));
	const deletion = admin.transaction(async (a) => {
		await a.execute(sql`SELECT id FROM account WHERE id=${sql.param(actors[3].id)} FOR UPDATE`);
		await a.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_revision,state,witness_checkpoint,
 cleanup_state,request_id,requested_at,cancel_until) VALUES('account',${sql.param(actors[3].id)},1,'pending_deletion',1,
 'not_started',${sql.param(randomUUID())},statement_timestamp(),statement_timestamp()+interval '720 hours')`);
		started();
		await committed;
	});
	await deleting;
	const refusedSave = saveCommitmentDocument(db, storage, deleting3, {
		requestKey: key(),
		input: { personId: lee.id, kind: "launch_team", occurredOn: day(1), documentUploadId: next.uploadId },
	});
	await new Promise((r) => setTimeout(r, 300));
	commit();
	await deletion;
	refused(await refusedSave);
	assert.deepEqual(
		[
			await count("commitment", lee.id),
			(await rows(sql`SELECT state FROM file_object WHERE id=${sql.param(next.uploadId)}`))[0].state,
		],
		[1, "pending"],
	);
	await admin.execute(sql`DELETE FROM lifecycle_witness WHERE opaque_subject_id=${sql.param(actors[3].id)}`);
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

test("INV-reads (C22, C32): assessment, interview and commitment reads hold no lock on the reader's session, so sign-out never waits", async () => {
	const p = await person("Riley Session");
	ok(await assess(p.id, day(1)));
	ok(await interview(p.id, "qualified"));
	ok(
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId: p.id, kind: "core_group", occurredOn: day(1) },
			}),
		),
	);
	const viewer = new PeopleReadContext(await tx((t) => RequestActor.resolve(t, actors[0].session)));
	const reads = (c) => [
		["getAssessments", (t) => assessments.getAssessments(t, c, { personId: p.id })],
		["getInterviews", (t) => interviews.getInterviews(t, c, { personId: p.id })],
		["getCommitments", (t) => commitments.getCommitments(t, c, { personId: p.id })],
	];
	const waited = [];
	for (const [name, c] of [
		["cached", viewer],
		["plain", ctx()],
	])
		for (const [op, run] of reads(c))
			await tx(async (t) => {
				ok(await run(t));
				// The read's transaction is still open: a sign-out or session refresh must not wait for it.
				try {
					await admin.transaction(async (a) => {
						await a.execute(sql`SET LOCAL lock_timeout='250ms'`);
						await a.execute(
							sql`UPDATE auth_session SET expires_at=expires_at WHERE id=${sql.param(actors[0].session)}`,
						);
					});
				} catch {
					waited.push(`${name} ${op}`);
				}
			});
	assert.deepEqual(waited, []);
});
