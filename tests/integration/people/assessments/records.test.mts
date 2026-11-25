import { fixture, ok, refused, waitingOnLock, type Actor } from "../../../support/fixture.mts";
import { faulted, recorded, untouched } from "../../../support/recorded.mts";
import { pinSchemaClock } from "../../../support/test-database.mts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import {
	authorityOf,
	church,
	isActivity,
	noReminders,
	reads,
	StubClient,
	type Reply,
	type Row,
} from "../people-support.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { PeopleReadContext, type Context, type WriteContext } from "../../../../packages/domain/src/people/core.ts";
import {
	commitmentInputs,
	commitmentInputsJson,
	commitmentOf,
} from "../../../../packages/domain/src/people/commitments/lifecycle.ts";
import {
	commitmentCacheBackfill,
	mergeReferencesBackfill,
} from "../../../../packages/domain/src/people/commitments/backfill.ts";
import { createFacts } from "../../../../packages/domain/src/intelligence/index.ts";
import { getPlant } from "../../../../packages/domain/src/oversight/index.ts";
import { backfill } from "../../../../packages/db/src/schema/migrate.ts";
import {
	assessments,
	commitments,
	getCommitmentDownload,
	interviews,
	peopleMerge,
	peopleUnmerge,
	peopleWriter as people,
	recordCorrections,
	saveCommitmentDocument,
	signCommitmentDocument,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";
import { organizationOwner } from "../../../../packages/contracts/src/people/values.ts";
import { frozenClock, instant } from "../../../../packages/contracts/src/common/time.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";

const database = await fixture({ prefix: "wp014", clock: new Date("2026-10-13T16:00:00Z") });
const { admin, schema } = database;
const db = database.pools.runtime;
const day = (n: number) => new Date(Date.parse(today + "T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

const plants = [database.tenant.id, (await database.plant()).id] as const,
	actors = [
		database.actors.owner,
		database.actors.member,
		await database.actor({ kind: "plant", id: plants[1] }, "admin"),
		database.actors.admin,
	] as const;
const today = (
	await database.admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text d`)
).rows[0]!.d;
type Who = 0 | 1 | 2 | 3;
const ctx = (who: Who = 0) => ({ session: actors[who].session, selected: church(plants[who === 2 ? 1 : 0]) });
const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
const key = () => randomUUID();
const rows = async <T extends Row>(query: SQL) => (await admin.execute<T>(query)).rows;
const count = async (table: string, personId: string) =>
	(await rows(sql`SELECT count(*)::int n FROM ${sql.identifier(table)} WHERE person_id=${sql.param(personId)}`))[0]!.n;
const revisionOf = async (id: string) =>
	(await rows(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`))[0]!.r;
const stageOf = async (id: string) => (await rows(sql`SELECT stage FROM person WHERE id=${sql.param(id)}`))[0]!.stage;
const feed = async (personId: string) =>
	ok(await tx((t) => reads.getActivities(t, ctx(), { personId })))
		.items.filter(isActivity)
		.filter((a) => a.recordId);
type Audit = {
	action: string;
	reason: string | null;
	before_value: { commitment?: { occurredOn: string } } | null;
	after_value: { commitment?: { occurredOn: string } } | null;
	metadata: { event?: string } | null;
};
const audits = (personId: string) =>
	rows<Audit>(
		sql`SELECT * FROM audit_event WHERE subject_id=${sql.param(personId)} AND command_id=id ORDER BY occurred_at,id`,
	);

async function person(name: string, stage = "prospect") {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), {
				requestKey: key(),
				input: { displayName: name, stage, adultClassification: "adult" },
			}),
		),
	).person;
}
async function retire(id: string) {
	const review = ok(await tx((t) => reads.getStatusWarnings(t, ctx(), { personId: id }))).reviewRevision;
	ok(
		await tx(async (t) =>
			people.retirePerson(
				t,
				ctx(),
				{
					requestKey: key(),
					expectedRevision: await revisionOf(id),
					input: { personId: id, reason: "Moved away", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		),
	);
}
const lens = (score: number, notes: string | null = null) => ({ score, notes });
const assess = (personId: string, occurredOn: string, score = 3, who: Who = 0, requestKey: string = key()) =>
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
const interview = (personId: string, result: string, occurredOn = day(3), requestKey: string = key()) =>
	tx((t) =>
		interviews.createInterview(t, ctx(), {
			requestKey,
			input: { personId, occurredOn, ...criteria(), result, nextSteps: "Call next week" },
		}),
	);

after(async () => {
	await database.close();
});

test("AC:TARGET-PPL-012 AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-RETIRE BUG-PR249 Four Cs: server total, chronological latest, no stage change, advisory warning, Owner/Admin only", async () => {
	const alex = await person("Alex Rivera");
	const warnings = async () => ok(await tx((t) => reads.getStatusWarnings(t, ctx(), { personId: alex.id }))).warnings;
	assert.ok((await warnings()).includes("assessment_not_recorded"));

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
	const retryKey = key();
	const late = ok(await assess(alex.id, day(40), 5, 3, retryKey));
	assert.deepEqual(ok(await assess(alex.id, day(40), 5, 3, retryKey)), late);
	refused(await assess(alex.id, day(-1)), "invalid_input");
	assert.equal(await count("four_cs", alex.id), 2);
	const history = ok(await tx((t) => assessments.getAssessments(t, ctx(3), { personId: alex.id })));
	assert.deepEqual(
		[history.latest?.id, history.items.map((a) => [a.occurredOn, a.total]), history.total],
		[
			first.assessment.id,
			[
				[day(3), 4],
				[day(40), 20],
			],
			2,
		],
	);
	assert.deepEqual(history.items[1]!.actor, { kind: "current_account", accountId: actors[3].id });
	assert.equal(history.items[0]!.committed.notes, "Private lens note");
	assert.equal(await stageOf(alex.id), "prospect");
	assert.ok(!(await warnings()).includes("assessment_not_recorded"));

	refused(await tx((t) => assessments.getAssessments(t, ctx(1), { personId: alex.id })));
	refused(await tx((t) => assessments.getAssessments(t, ctx(2), { personId: alex.id })));
	refused(await assess(alex.id, day(2), 3, 1));
	refused(await assess(alex.id, day(2), 3, 2));
	assert.equal(await count("four_cs", alex.id), 2);

	assert.deepEqual(
		(await feed(alex.id)).map((a) => [a.action, a.recordId]),
		[
			["assessment_recorded", late.assessment.id],
			["assessment_recorded", first.assessment.id],
		],
	);
	assert.ok(!JSON.stringify(await audits(alex.id)).match(/score|Private lens note/));

	await retire(alex.id);
	assert.equal(ok(await tx((t) => assessments.getAssessments(t, ctx(), { personId: alex.id }))).total, 2);
	refused(await assess(alex.id, day(1)));
});

test("AC:TARGET-PPL-013 interviews: any result advances an earlier stage to interviewed with its history, an advanced stage stays, retries add nothing, no task", async () => {
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
		assert.equal((await rows(sql`SELECT count(*)::int n FROM task WHERE person_id=${sql.param(early.id)}`))[0]!.n, 0);
		assert.deepEqual(
			(await feed(early.id)).map((a) => [a.action, a.stage]),
			[["interview_recorded", { from: "prospect", to: "interviewed" }]],
		);
	}
	const alex = await person("Alex Backdated", "attendee");
	const current = ok(await interview(alex.id, "follow_up", day(2))).interview;
	const older = ok(await interview(alex.id, "qualified", day(30))).interview;
	const read = ok(await tx((t) => interviews.getInterviews(t, ctx(), { personId: alex.id })));
	assert.deepEqual(
		[read.latest?.id, read.items.map((i) => i.id), read.items[0]!.maturity],
		[current.id, [current.id, older.id], { rating: "pass", notes: "Private criterion note" }],
	);
	refused(await tx((t) => interviews.getInterviews(t, ctx(1), { personId: alex.id })));
	assert.ok(!JSON.stringify(await audits(alex.id)).match(/follow_up|qualified|Call next week|Private criterion note/));
});

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
type Stored = { bytes: Uint8Array; type: string | undefined };
function privateStorage() {
	const uploads = new Map<string, Stored>();
	const reads: { during: (() => Promise<void>) | null; count: number } = { during: null, count: 0 };
	const client = new StubClient(async (operation, i) => {
		switch (operation) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "GetObjectCommand": {
				reads.count++;
				const found = uploads.get(i.Key!);
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
	});
	return { bucket: "synthetic-only", client, uploads, reads };
}
const actorOf = (who: Who) => gatedTransaction(db, (t) => authorityOf(t, actors[who]));

test("AC:TARGET-PPL-014 AC:CA021 commitments: card and Core Group together; dated withdrawal and reactivation keep stage and first acquisition; corrections with history", async () => {
	const alex = await person("Alex Rivera"),
		casey = await person("Casey Reed", "leader"),
		foreign = ok(
			await tx((t) => people.createPerson(t, ctx(2), { requestKey: key(), input: { displayName: "Foreign Alex" } })),
		).person;
	const card = (input: object, requestKey: string = key(), personId = alex.id) =>
		tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey,
				input: { personId, kind: "core_group", ...input },
			}),
		);
	const correct = (commitmentId: string, expectedRevision: string, correction: object, reason = "Wrong date entered") =>
		tx((t) =>
			commitments.correctCommitmentLifecycle(t, ctx(), {
				requestKey: key(),
				expectedRevision,
				input: { commitmentId, correction, reason },
			}),
		);

	refused(await card({ occurredOn: day(5), witness: { personId: foreign.id } }));
	assert.equal(await count("commitment", alex.id), 0);

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

	const withdraw = (expectedRevision: string, effectiveOn = day(2), personId = alex.id) =>
		tx((t) =>
			commitments.withdrawCommitment(t, ctx(), {
				requestKey: key(),
				expectedRevision,
				input: { personId, effectiveOn, reason: "Person withdrew" },
			}),
		);
	const auditCount = async () => (await rows(sql`SELECT count(*)::int n FROM audit_event`))[0]!.n;
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
	const oldKey = key();
	const old = ok(await card({ occurredOn: day(9), kind: "launch_team" }, oldKey));
	assert.equal(old.current.state, "withdrawn");
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
	assert.ok(after.firstAcquisition.status === "known");
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

	const repeat = ok(
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId: casey.id, kind: "launch_team", occurredOn: day(1), witness: { external: "Pastor Lee" } },
			}),
		),
	);
	assert.deepEqual([repeat.person.stage, repeat.person.stageChange], ["leader", null]);

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
			correction?.action,
			correction?.reason,
			correction?.before_value?.commitment?.occurredOn,
			correction?.after_value?.commitment?.occurredOn,
		],
		["people.corrected", "Wrong date entered", day(9), day(3)],
	);
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
	for (const id of [old.commitment.id, saved.commitment.id]) {
		const k = (await commitmentsOf()).items.find((i) => i.id === id)!;
		ok(await correct(id, k.revision, { action: "void" }, "Never signed"));
	}
	assert.deepEqual(ok(await card({ occurredOn: day(9), kind: "launch_team" }, oldKey)), old);
	const voided = await commitmentsOf();
	assert.deepEqual(
		[voided.current.state, voided.firstAcquisition, voided.items.every((i) => i.voidedAt), await stageOf(alex.id)],
		["unknown", { status: "none" }, true, "core_group"],
	);
	assert.deepEqual(
		(await feed(alex.id)).map((a) => [a.action, a.stage ?? null]),
		[
			["commitment_corrected", null],
			["commitment_corrected", null],
			["commitment_corrected", null],
			["commitment_recorded", null],
			["commitment_recorded", { from: "prospect", to: "core_group" }],
		],
	);
	const actions = (await audits(alex.id)).map((a) => a.metadata?.event).filter(Boolean);
	assert.deepEqual(
		actions.filter((a) => a === "commitment_withdrawn" || a === "commitment_reactivated"),
		["commitment_withdrawn", "commitment_reactivated"],
	);
	assert.ok(
		!JSON.stringify([...(await audits(alex.id)), ...(await audits(casey.id))]).match(/Signed after class|Pastor Lee/),
	);

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
	ok(await withdraw((await commitmentsOf(pat.id)).current.personRevision, day(3), pat.id));
	const back = ok(await card({ occurredOn: day(1) }, key(), pat.id));
	assert.deepEqual(await since(), ["active", day(1)]);
	ok(await correct(back.commitment.id, "1", { action: "void" }, "Never signed"));
	assert.deepEqual(await since(), ["withdrawn", day(3)]);
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

	refused(await tx((t) => commitments.getCommitments(t, ctx(2), { personId: alex.id })));
});

test("AC:GAP-PPL-014 AC:TARGET-PPL-014 AC:PROVIDER48-002 AC:PROVIDER48-003 the browser puts the document straight into the bucket; the save checks the file and attaches it to the card through the shared write with one audit row", async () => {
	const storage = privateStorage();
	const sam = await person("Sam Direct"),
		witness = await person("Jordan Witness", "leader"),
		foreign = ok(
			await tx((t) => people.createPerson(t, ctx(2), { requestKey: key(), input: { displayName: "Foreign Sam" } })),
		).person;
	const sign = (who: Who, personId: string, bytes: Uint8Array, mime: string) =>
		signCommitmentDocument(db, storage, ctx(who), actors[who].id, { personId, mime, byteLength: bytes.length });
	const keyOf = (uploadId: string) => `private/${plants[0]}/${uploadId}`;
	const put = (signed: { uploadId: string; headers: Record<string, string> }, bytes: Uint8Array) =>
		storage.uploads.set(keyOf(signed.uploadId), { bytes, type: signed.headers["content-type"] });
	const save = async (who: Who, uploadId: string, input = {}, requestKey: string = key()) =>
		saveCommitmentDocument(db, storage, await actorOf(who), {
			requestKey,
			input: { personId: sam.id, kind: "core_group", occurredOn: day(2), documentUploadId: uploadId, ...input },
		});
	const stateOf = async (id: string) =>
		(await rows(sql`SELECT state FROM file_object WHERE id=${sql.param(id)}`))[0]!.state;

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
	const signed = ok(await sign(0, sam.id, document, "image/png"));
	const url = new URL(signed.url);
	assert.ok(url.pathname.endsWith("/" + keyOf(signed.uploadId)), url.pathname);
	assert.equal(url.searchParams.get("X-Amz-Expires"), "300");
	assert.deepEqual(url.searchParams.get("X-Amz-SignedHeaders")?.split(";"), [
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

	refused(await save(0, signed.uploadId));
	put(signed, document);

	const signOut = async () => {
		storage.reads.during = null;
		await admin.execute(sql`DELETE FROM auth_session WHERE id=${sql.param(actors[0].session)}`);
	};
	const owner = await actorOf(0);
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
	const before = storage.reads.count;
	refused(await save(0, signed.uploadId, { witness: { personId: foreign.id } }));
	refused(await save(0, signed.uploadId, { witness: { personId: sam.id } }), "invalid_subject");
	const future = await save(0, signed.uploadId, { occurredOn: day(-1) });
	assert.deepEqual(refused(future, "invalid_input").details, { reason: "future_date" });
	assert.equal(storage.reads.count, before);
	assert.deepEqual([await stateOf(signed.uploadId), await count("commitment", sam.id)], ["pending", 0]);
	const reads = storage.reads.count;
	refused(await save(1, signed.uploadId));
	assert.equal(storage.reads.count, reads);
	refused(await save(2, signed.uploadId));

	const requestKey = key();
	const input = { witness: { personId: witness.id }, notes: "Signed at the picnic" };
	const auditsBefore = (await rows<{ n: number }>(sql`SELECT count(*)::int n FROM audit_event`))[0]!.n;
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
	assert.equal((await rows(sql`SELECT count(*)::int n FROM audit_event`))[0]!.n, auditsBefore + 1);
	assert.equal(await stateOf(signed.uploadId), "ready");
	const history = ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId: sam.id })));
	assert.deepEqual(history.latest, saved.commitment);
	assert.deepEqual(
		(await feed(sam.id)).map((a) => [a.action, a.recordId, a.stage ?? null]),
		[["commitment_recorded", saved.commitment.id, { from: "prospect", to: "core_group" }]],
	);
	assert.ok(!JSON.stringify(await audits(sam.id)).match(/Signed at the picnic|image\/png/));
	assert.deepEqual(ok(await save(3, signed.uploadId, input, requestKey)), saved);
	refused(await save(3, signed.uploadId, input));
	assert.equal(await count("commitment", sam.id), 1);

	const link = ok(await getCommitmentDownload(db, storage, ctx(), { commitmentId: saved.commitment.id }));
	assert.ok(link.url.includes(keyOf(signed.uploadId)) && link.expiresInSeconds === 300, link.url);
	const signedQuery = new URL(link.url).searchParams;
	assert.equal(signedQuery.get("X-Amz-Expires"), "300");
	const signedAt = Date.parse(
		(signedQuery.get("X-Amz-Date") ?? "").replace(
			/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
			"$1-$2-$3T$4:$5:$6Z",
		),
	);
	const ttl = Date.parse(link.expiresAt) - signedAt;
	assert.equal(ttl >= 300_000 && ttl < 301_000, true, String(ttl));
	refused(await getCommitmentDownload(db, storage, ctx(1), { commitmentId: saved.commitment.id }));
	refused(await getCommitmentDownload(db, storage, ctx(2), { commitmentId: saved.commitment.id }));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[3].id)}`);
	refused(await getCommitmentDownload(db, storage, ctx(3), { commitmentId: saved.commitment.id }));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[3].id)}`);

	const fake = Buffer.from("%PDF-1.7 not really a document");
	const bad = ok(await sign(0, sam.id, fake, "application/pdf"));
	put(bad, fake);
	const unreadable = await save(0, bad.uploadId, { occurredOn: day(1) });
	assert.deepEqual(refused(unreadable, "invalid_input").details, { reason: "unreadable_document" });
	assert.deepEqual([await stateOf(bad.uploadId), await count("commitment", sam.id)], ["pending", 1]);

	const unattached = async (id: string) =>
		(await rows(sql`SELECT file_is_referenced(${sql.param(id)}::uuid) AS r`))[0]!.r === false;
	const later: string[] = [];
	for (let n = 0; n < 2; n++) {
		const next = ok(await sign(0, sam.id, png, "image/png"));
		put(next, png);
		later.push(next.uploadId);
	}
	assert.deepEqual([await unattached(later[0]!), await unattached(signed.uploadId)], [true, false]);
	for (const uploadId of later)
		assert.deepEqual(ok(await save(0, uploadId, { occurredOn: day(1) })).commitment.document, {
			status: "attached",
			mediaType: "image/png",
			byteCount: png.length,
		});
	assert.equal(await unattached(later[1]!), false);
});

const quiet = { jobs: [], notices: 0, mail: 0 };
async function churchOf(source = database) {
	const plant = await source.plant(),
		other = await source.plant();
	const seat = async (role: "admin" | "member", at: typeof plant) => ({
		...(await source.actor(at, role)),
		plant: at.id,
	});
	const owner = await seat("admin", plant),
		member = await seat("member", plant),
		outsiders = [await seat("member", other), await seat("admin", other)];
	const pool = source.pools.runtime;
	type Seat = Actor & { plant: string };
	const context = (who: Seat) => ({ session: who.session, selected: church(who.plant) });
	const read = <T,>(body: (t: WriteTx, c: ReturnType<typeof context>) => Promise<T>, who: Seat = owner) =>
		gatedTransaction(pool, (t) => body(t, context(who)));
	const save = async <T,>(body: (t: WriteTx, c: WriteContext) => Promise<Reply<T>>, who: Seat = owner) =>
		withPeopleWrite(pool, await authorityOf(pool, who), body);
	const resend: typeof save = (body, who = owner) => gatedTransaction(pool, (t) => body(t, context(who)));
	const add = async (displayName: string, input: object = {}) =>
		ok(
			await save((t, c) =>
				people.createPerson(t, c, {
					requestKey: key(),
					input: { displayName, adultClassification: "adult", ...input },
				}),
			),
		).person;
	const revision = async (id: string) =>
		(await source.admin.execute<{ r: string }>(sql`SELECT revision::text r FROM person WHERE id=${id}`)).rows[0]!.r;
	const move = (
		personId: string,
		stage: string,
		reason: string,
		expectedRevision: string,
		requestKey: string = key(),
		who: Seat = owner,
	) =>
		save(
			(t, c) =>
				people.changeStatus(
					t,
					c,
					{ requestKey, expectedRevision, input: { personId, stage, reason, handoffs: [] } },
					noReminders,
				),
			who,
		);
	const denied = async (call: (who: Seat, personId: string) => Promise<Reply<unknown>>, personId: string) => {
		for (const who of outsiders) {
			const { correlationId: _, ...known } = refused(await untouched(source.admin, () => call(who, personId)));
			const { correlationId: __, ...unknown } = refused(await call(who, key()));
			assert.deepEqual(known, unknown, "a real person answers as an unknown one");
		}
	};
	const card = (
		personId: string,
		occurredOn: string,
		{
			kind = "core_group",
			requestKey = key(),
			who = owner,
			...input
		}: { kind?: string; requestKey?: string; who?: Seat; witness?: object } = {},
	) =>
		save(
			(t, c) => commitments.createCommitment(t, c, { requestKey, input: { personId, kind, occurredOn, ...input } }),
			who,
		);
	const lifecycle = (
		operation: "withdrawCommitment" | "reactivateCommitment",
		personId: string,
		effectiveOn: string,
		expectedRevision: string,
		{ requestKey = key(), who = owner }: { requestKey?: string; who?: Seat } = {},
	) =>
		save(
			(t, c) => commitments[operation](t, c, { requestKey, expectedRevision, input: { personId, effectiveOn } }),
			who,
		);
	const held = async (personId: string) => ok(await read((t, c) => commitments.getCommitments(t, c, { personId })));
	const facts = async (at?: string) =>
		ok(
			await createFacts(at ? { clock: frozenClock(instant.parse(new Date(at).toISOString())) } : {}).readFacts(
				pool,
				await authorityOf(pool, owner),
				{},
			),
		);
	return {
		plant,
		owner,
		member,
		outsiders,
		read,
		save,
		resend,
		add,
		revision,
		move,
		denied,
		card,
		lifecycle,
		held,
		facts,
	};
}
const rated = (score: number) => ({ score, notes: null });
const fourCs = (score: number) => ({
	committed: rated(score),
	compelled: rated(score),
	contagious: rated(score),
	courageous: rated(score),
});

test("AC:GAP-PPL-006 a missing interview warns without blocking the move, which keeps its reason and order, and a later interview keeps a leader a leader", async () => {
	const w = await churchOf();
	const alex = await w.add("Alex Rivera"),
		casey = await w.add("Casey Reed", { stage: "leader" });
	const warnings = async () => ok(await w.read((t, c) => reads.getStatusWarnings(t, c, { personId: alex.id })));
	const shown = await warnings();
	assert.deepEqual(
		[shown.warnings, shown.hardGate, shown.revision],
		[["assessment_not_recorded", "interview_not_recorded", "commitment_not_recorded"], false, alex.revision],
	);
	const requestKey = key();
	const forward = () => w.move(alex.id, "attendee", "Interview warning acknowledged", alex.revision, requestKey);
	const steps = async (personId = alex.id) =>
		(
			await rows<{ reason: string | null; from: string; to: string; actor_id: string }>(
				sql`SELECT reason,before_value->>'stage' AS from,after_value->>'stage' AS to,actor_id FROM audit_event
				WHERE subject_id=${personId} AND action='people.stage_changed' AND kind<>'noop' ORDER BY occurred_at`,
			)
		).map((x) => [x.from, x.to, x.reason, x.actor_id]);
	await w.denied(
		(who, id) => w.move(id, "attendee", "Interview warning acknowledged", alex.revision, key(), who),
		alex.id,
	);
	await w.denied((who, id) => w.read((t, c) => reads.getStatusWarnings(t, c, { personId: id }), who), alex.id);
	refused(
		await untouched(admin, () =>
			w.move(alex.id, "attendee", "Interview warning acknowledged", alex.revision, key(), w.member),
		),
	);
	await faulted(admin, "audit_event", forward);
	const { value, added } = await recorded(admin, forward);
	const moved = ok(value);
	assert.deepEqual([moved.person.id, moved.person.stage, moved.outcome], [alex.id, "attendee", "changed"]);
	assert.deepEqual(added, { audits: ["people.stage_changed"], ...quiet });
	assert.deepEqual(ok(await untouched(admin, forward)), moved);
	const first = ["prospect", "attendee", "Interview warning acknowledged", w.owner.id];
	assert.deepEqual(await steps(), [first]);
	assert.deepEqual(
		[await stageOf(alex.id), await stageOf(casey.id), await steps(casey.id)],
		["attendee", "leader", []],
	);
	assert.deepEqual((await warnings()).warnings, shown.warnings, "the warning stays until an interview is recorded");
	refused(await untouched(admin, () => w.move(alex.id, "following_up", "Seen before", alex.revision)), "conflict");
	const back = () => w.move(alex.id, "prospect", "Entered by mistake", moved.person.revision);
	await faulted(admin, "audit_event", back);
	assert.deepEqual([await stageOf(alex.id), await steps()], ["attendee", [first]], "the earlier move stays");
	ok(await back());
	assert.deepEqual(await steps(), [first, ["attendee", "prospect", "Entered by mistake", w.owner.id]]);
	const moves = ok(await w.read((t, c) => reads.getActivities(t, c, { personId: alex.id }))).items;
	assert.deepEqual(
		moves.flatMap((m) => (m.kind === "stage_changed" ? [[m.from, m.to]] : [])),
		[
			["attendee", "prospect"],
			["prospect", "attendee"],
		],
	);

	const later = await recorded(admin, () =>
		w.save((t, c) =>
			interviews.createInterview(t, c, {
				requestKey: key(),
				input: {
					personId: casey.id,
					occurredOn: "2026-10-12",
					...criteria(),
					result: "qualified",
					nextSteps: "Discuss commitment",
				},
			}),
		),
	);
	const kept = ok(later.value);
	assert.deepEqual(
		[
			kept.person.personId,
			kept.person.stage,
			kept.person.stageChange,
			kept.interview.occurredOn,
			kept.interview.nextSteps,
		],
		[casey.id, "leader", null, "2026-10-12", "Discuss commitment"],
	);
	assert.deepEqual(later.added, { audits: ["people.recorded"], ...quiet });
	assert.deepEqual([await stageOf(casey.id), await count("interview", casey.id)], ["leader", 1]);
});

test("AC:GAP-PPL-012 AC:TARGET-PPL-012 AC:GAP-PPL-006 dated Four Cs ratings keep every record, the latest by date, the total the server adds up and a corrected score's history", async () => {
	const w = await churchOf();
	const alex = await w.add("Alex Rivera");
	const rate = (
		personId: string,
		occurredOn: string,
		score: number,
		{
			requestKey = key(),
			who = w.owner,
			run = w.save,
			...extra
		}: { requestKey?: string; who?: typeof w.owner; run?: typeof w.save; total?: number } = {},
	) =>
		run(
			(t, c) =>
				assessments.createAssessment(t, c, { requestKey, input: { personId, occurredOn, ...fourCs(score), ...extra } }),
			who,
		);
	const history = async (personId: string) =>
		ok(await w.read((t, c) => assessments.getAssessments(t, c, { personId })));
	ok(await rate(alex.id, "2026-10-01", 2));
	ok(await rate(alex.id, "2026-10-05", 4));
	const requestKey = key();
	const third = (run = w.save) => rate(alex.id, "2026-10-12", 3, { requestKey, run });
	await w.denied((who, id) => rate(id, "2026-10-12", 3, { who }), alex.id);
	refused(await untouched(admin, () => rate(alex.id, "2026-10-12", 3, { who: w.member })));
	for (const table of ["four_cs", "audit_event"]) await faulted(admin, table, third);
	assert.equal((await history(alex.id)).total, 2, "the two earlier records stay");
	const { value, added } = await recorded(admin, third);
	const { assessment, person: after } = ok(value);
	assert.deepEqual(added, { audits: ["people.recorded"], ...quiet });
	assert.deepEqual(ok(await untouched(admin, () => third(w.resend))), ok(value));
	assert.deepEqual([assessment.total, assessment.occurredOn, after.stage], [12, "2026-10-12", "prospect"]);
	assert.deepEqual(
		Object.keys(assessment).sort(),
		[
			"actor",
			"committed",
			"compelled",
			"contagious",
			"courageous",
			"id",
			"occurredOn",
			"personId",
			"recordedAt",
			"revision",
			"total",
		],
		"the record holds human ratings and no model judgment",
	);
	assert.deepEqual(assessment.actor, { kind: "current_account", accountId: w.owner.id });
	const all = await history(alex.id);
	assert.deepEqual(
		[all.total, all.latest?.occurredOn, all.items.map((a) => [a.occurredOn, a.total])],
		[
			3,
			"2026-10-12",
			[
				["2026-10-12", 12],
				["2026-10-05", 16],
				["2026-10-01", 8],
			],
		],
	);

	const jamie = await w.add("Jamie Chen");
	refused(await untouched(admin, () => rate(jamie.id, "2026-10-10", 1, { total: 20 })), "invalid_input");
	const low = ok(await rate(jamie.id, "2026-10-10", 1));
	assert.deepEqual([low.assessment.total, low.person.stage], [4, "prospect"]);
	const same = ok(await rate(jamie.id, "2026-10-10", 2)).assessment;
	const early = ok(await rate(jamie.id, "2026-09-01", 5)).assessment;
	const latest = async () => {
		const { latest, items } = await history(jamie.id);
		return [latest?.id, latest?.occurredOn, items.map((a) => [a.occurredOn, a.total])];
	};
	assert.deepEqual(await latest(), [
		same.id,
		"2026-10-10",
		[
			["2026-10-10", 8],
			["2026-10-10", 4],
			["2026-09-01", 20],
		],
	]);
	const correction = await recorded(admin, () =>
		w.save((t, c) =>
			recordCorrections.correctPersonRecord(t, c, {
				requestKey: key(),
				expectedRevision: early.revision,
				input: {
					recordType: "assessment",
					personId: jamie.id,
					recordId: early.id,
					reason: "Copied the wrong column",
					changes: { compelled: { score: 2, notes: null } },
				},
			}),
		),
	);
	ok(correction.value);
	assert.deepEqual(correction.added, { audits: ["people.corrected"], ...quiet });
	assert.deepEqual(await latest(), [
		same.id,
		"2026-10-10",
		[
			["2026-10-10", 8],
			["2026-10-10", 4],
			["2026-09-01", 17],
		],
	]);
	const { items } = ok(await w.read((t, c) => recordCorrections.listRecordCorrections(t, c, { personId: jamie.id })));
	assert.deepEqual(
		items.map((i) => [i.recordId, i.reason, i.actor, i.changes]),
		[
			[
				early.id,
				"Copied the wrong column",
				{ kind: "current_account", accountId: w.owner.id },
				[{ field: "compelled", old: { score: 5, notes: null }, new: { score: 2, notes: null } }],
			],
		],
	);
	assert.equal(await stageOf(jamie.id), "prospect");

	const full = (who: typeof w.owner) => w.read((t, c) => assessments.getAssessments(t, c, { personId: jamie.id }), who);
	ok(await full(w.owner));
	refused(await full(w.member));
	ok(await w.read((t, c) => reads.getPerson(t, c, { personId: jamie.id }), w.member));
	await w.denied((who, personId) => w.read((t, c) => assessments.getAssessments(t, c, { personId }), who), jamie.id);
	const network = await database.organization("sending_network");
	await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${w.plant.id},${network.id},clock_timestamp(),true,true,true,true,true,true,true)`);
	const director = await database.actor(network, "owner");
	for (const selected of [church(w.plant.id), organizationOwner.parse(network)])
		refused(
			await tx((t) => assessments.getAssessments(t, { session: director.session, selected }, { personId: jamie.id })),
		);
	const view = await getPlant(db, await authorityOf(db, director), w.plant.id);
	assert.equal(view?.sections.people?.status, "shared");
	assert.doesNotMatch(JSON.stringify(view), /compelled|contagious|courageous/);

	const pat = await w.add("Pat Unrated");
	const warned = ok(await w.read((t, c) => reads.getStatusWarnings(t, c, { personId: pat.id })));
	assert.deepEqual([warned.warnings.includes("assessment_not_recorded"), warned.hardGate], [true, false]);
	assert.equal(ok(await w.move(pat.id, "interviewed", "Talked on Sunday", pat.revision)).person.stage, "interviewed");
});

test("AC:GAP-PPL-013 AC:TARGET-PPL-013 an interview keeps its date, recorded day, criteria, result and next steps, counts once and adds no task", async () => {
	const w = await churchOf();
	const talk = (
		personId: string,
		result: string,
		{
			occurredOn = "2026-10-10",
			nextSteps = "Review commitment",
			requestKey = key(),
			who = w.owner,
			run = w.save,
		}: {
			occurredOn?: string;
			nextSteps?: string;
			requestKey?: string;
			who?: typeof w.owner;
			run?: typeof w.save;
		} = {},
	) =>
		run(
			(t, c) =>
				interviews.createInterview(t, c, {
					requestKey,
					input: { personId, occurredOn, ...criteria(), result, nextSteps },
				}),
			who,
		);
	const alex = await w.add("Alex Rivera"),
		casey = await w.add("Casey Reed", { stage: "leader" });
	const requestKey = key();
	const interviewed = (run = w.save) => talk(alex.id, "follow_up", { requestKey, run });
	await w.denied((who, id) => talk(id, "follow_up", { who }), alex.id);
	await w.denied((who, personId) => w.read((t, c) => interviews.getInterviews(t, c, { personId }), who), alex.id);
	refused(await untouched(admin, () => talk(alex.id, "follow_up", { who: w.member })));
	for (const table of ["interview", "person", "audit_event"]) await faulted(admin, table, interviewed);
	assert.deepEqual([await stageOf(alex.id), await count("interview", alex.id)], ["prospect", 0]);
	const { value, added } = await recorded(admin, interviewed);
	const saved = ok(value);
	assert.deepEqual(added, { audits: ["people.recorded"], ...quiet });
	assert.deepEqual(ok(await untouched(admin, () => interviewed(w.resend))), saved);
	assert.deepEqual(
		[
			saved.interview.occurredOn,
			saved.interview.recordedAt.slice(0, 10),
			saved.interview.result,
			saved.interview.nextSteps,
			saved.person.stage,
		],
		["2026-10-10", "2026-10-13", "follow_up", "Review commitment", "interviewed"],
	);
	const kept = ok(await w.read((t, c) => interviews.getInterviews(t, c, { personId: alex.id })));
	assert.deepEqual([kept.total, kept.items], [1, [saved.interview]]);
	assert.deepEqual(
		[
			saved.interview.maturity,
			saved.interview.gifted,
			saved.interview.chemistry,
			saved.interview.rightReasons,
			saved.interview.season,
		].map((x) => x.rating),
		["pass", "pass", "pass", "pass", "pass"],
	);
	const again = () => talk(alex.id, "qualified", { occurredOn: "2026-10-01" });
	await faulted(admin, "audit_event", again);
	assert.deepEqual(
		ok(await w.read((t, c) => interviews.getInterviews(t, c, { personId: alex.id }))),
		kept,
		"the interview saved before stays",
	);
	const advanced = ok(await talk(casey.id, "follow_up"));
	assert.deepEqual(
		[advanced.person.personId, advanced.person.stage, await stageOf(casey.id), await count("interview", casey.id)],
		[casey.id, "leader", "leader", 1],
	);

	const tasks = async () => (await rows(sql`SELECT count(*)::int n FROM task WHERE plant_id=${w.plant.id}`))[0]!.n;
	const stages: unknown[][] = [[], []];
	for (const result of ["qualified", "qualified_with_notes", "not_qualified", "follow_up"])
		for (const [n, stage] of ["prospect", "leader"].entries()) {
			const p = await w.add(`${stage} ${result}`, { stage });
			const call = { requestKey: key(), nextSteps: "Call next week" };
			await faulted(admin, "audit_event", () => talk(p.id, result, call));
			assert.equal(await stageOf(p.id), stage);
			const run = await recorded(admin, () => talk(p.id, result, call));
			const { interview } = ok(run.value);
			assert.deepEqual([interview.result, interview.nextSteps], [result, "Call next week"]);
			assert.deepEqual(run.added, { audits: ["people.recorded"], ...quiet });
			const backdated = ok(await talk(p.id, result, { occurredOn: "2026-09-01", nextSteps: "" }));
			const all = ok(await w.read((t, c) => interviews.getInterviews(t, c, { personId: p.id })));
			assert.deepEqual([all.latest?.id, all.total], [interview.id, 2], "a backdated interview is not the latest");
			assert.equal(backdated.person.stageChange, null);
			stages[n]!.push(await stageOf(p.id));
		}
	assert.deepEqual(stages, [
		["interviewed", "interviewed", "interviewed", "interviewed"],
		["leader", "leader", "leader", "leader"],
	]);
	assert.equal(await tasks(), 0);
	assert.deepEqual(await rows(sql`SELECT id FROM job WHERE tenant_id=${w.plant.id}`), []);
});

test("AC:GAP-PPL-014 AC:TARGET-PPL-014 a commitment card binds its private document once, counts an adult and not a minor, and withdrawal or reactivation never moves the first acquisition", async () => {
	const storage = privateStorage();
	const w = await churchOf();
	const alex = await w.add("Alex Rivera"),
		casey = await w.add("Casey Reed", { stage: "leader", adultClassification: "child" });
	const growth = async () => {
		const { committedAdults, growth } = await w.facts();
		return [committedAdults.exact, growth.lastAcquiredOn, growth.current];
	};
	assert.deepEqual(await growth(), [0, null, 0]);
	const staged = async (bytes: Uint8Array, mime: string, personId: string) => {
		const signed = ok(
			await signCommitmentDocument(
				db,
				storage,
				{ session: w.owner.session, selected: church(w.plant.id) },
				w.owner.id,
				{ personId, mime, byteLength: bytes.length },
			),
		);
		storage.uploads.set(`private/${w.plant.id}/${signed.uploadId}`, { bytes, type: mime });
		return signed.uploadId;
	};
	const attach = async (
		documentUploadId: string,
		personId: string,
		{
			requestKey = key(),
			who = w.owner,
			...input
		}: { requestKey?: string; who?: typeof w.owner; occurredOn?: string; witness?: object },
	) =>
		saveCommitmentDocument(db, storage, await authorityOf(db, who), {
			requestKey,
			input: { personId, kind: "core_group", occurredOn: "2026-10-08", documentUploadId, ...input },
		});
	const fileOf = async (id: string) =>
		(
			await rows(sql`SELECT f.state,f.sha256,f.tenant_id,f.purpose,(SELECT count(*)::int FROM commitment k WHERE k.object_id=f.id) AS binds
			FROM file_object f WHERE f.id=${id}`)
		)[0];
	const lapsed = await staged(png, "image/png", alex.id);
	await pinSchemaClock(admin, schema, new Date("2026-10-13T16:05:00Z"));
	const upload = await staged(png, "image/png", alex.id);
	await pinSchemaClock(admin, schema, new Date("2026-10-13T16:18:00Z"));
	const requestKey = key();
	const sign = () => attach(upload, alex.id, { requestKey });
	await w.denied((who, id) => attach(upload, id, { who }), alex.id);
	await w.denied((who, id) => w.card(id, "2026-10-08", { who }), alex.id);
	await w.denied((who, id) => w.read((t, c) => commitments.getCommitments(t, c, { personId: id }), who), alex.id);
	refused(await untouched(admin, () => attach(upload, alex.id, { who: w.member })));
	refused(await untouched(admin, () => attach(lapsed, alex.id, {})));
	for (const table of ["file_object", "commitment", "person", "audit_event"]) await faulted(admin, table, sign);
	const { value, added } = await recorded(admin, sign);
	const saved = ok(value);
	assert.deepEqual(added, { audits: ["people.recorded"], ...quiet });
	assert.deepEqual(ok(await untouched(admin, sign)), saved);
	assert.deepEqual(await fileOf(upload), {
		state: "ready",
		sha256: "ee5849adb3b038a1b71c76d0cac02c3d4735b01cb84e4de00791cb45ddfad22b",
		tenant_id: w.plant.id,
		purpose: "commitment",
		binds: 1,
	});
	assert.deepEqual(
		[await count("commitment", alex.id), saved.commitment.document.status, await growth()],
		[1, "attached", [1, "2026-10-08", 1]],
	);
	refused(await untouched(admin, () => attach(upload, casey.id, {})));
	ok(await w.card(casey.id, "2026-10-09"));
	const counted = (await w.facts()).committedAdults;
	assert.deepEqual([counted.exact, counted.children], [1, 1], "the minor's card is kept and not counted");
	assert.equal((await w.facts()).growth.lastAcquiredOn, "2026-10-08");

	const acquired = { status: "known", occurredOn: "2026-10-08", evidenceId: saved.commitment.id };
	const change = async (operation: "withdrawCommitment" | "reactivateCommitment", on: string) => {
		const call = { requestKey: key() };
		const revision = await w.revision(alex.id);
		const run = () => w.lifecycle(operation, alex.id, on, revision, call);
		await w.denied((who, id) => w.lifecycle(operation, id, on, revision, { who }), alex.id);
		refused(await untouched(admin, () => w.lifecycle(operation, alex.id, on, "1")), "conflict");
		for (const table of ["commitment_change", "audit_event"]) await faulted(admin, table, run);
		const done = await recorded(admin, run);
		assert.deepEqual(done.added, { audits: ["people.updated"], ...quiet });
		assert.deepEqual(ok(await untouched(admin, run)), ok(done.value));
		const { state, effectiveOn } = ok(done.value).current;
		return [state, effectiveOn];
	};
	assert.deepEqual(await change("withdrawCommitment", "2026-10-12"), ["withdrawn", "2026-10-12"]);
	assert.deepEqual([await growth(), (await w.held(alex.id)).firstAcquisition], [[0, "2026-10-08", 1], acquired]);
	assert.deepEqual(await change("reactivateCommitment", "2026-10-13"), ["active", "2026-10-13"]);
	assert.deepEqual([await growth(), (await w.held(alex.id)).firstAcquisition], [[1, "2026-10-08", 1], acquired]);

	const sharp = createRequire(import.meta.url)("../../../../packages/db/node_modules/sharp");
	const image: Buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2e7d32" } })
		.jpeg()
		.toBuffer();
	const largest = 10 * 1024 * 1024;
	const padding: Buffer[] = [];
	for (let left = largest - image.length; left > 0;) {
		const payload = left - 4 <= 65533 ? left - 4 : Math.min(65533, left - 8);
		const segment = Buffer.alloc(4 + payload, 0x20);
		segment.writeUInt16BE(0xfffe, 0);
		segment.writeUInt16BE(payload + 2, 2);
		padding.push(segment);
		left -= segment.length;
	}
	const photo = Buffer.concat([image.subarray(0, 2), ...padding, image.subarray(2)]);
	assert.equal(photo.length, 10_485_760);
	const lee = await w.add("Lee Leader", { stage: "leader" }),
		stranger = ok(
			await w.save(
				(t, c) => people.createPerson(t, c, { requestKey: key(), input: { displayName: "Foreign Riley" } }),
				w.outsiders[1]!,
			),
		).person;
	const big = await staged(photo, "image/jpeg", lee.id);
	const old = { requestKey: key(), occurredOn: "2026-09-01" };
	refused(await untouched(admin, () => attach(big, lee.id, { ...old, witness: { personId: stranger.id } })));
	refused(await untouched(admin, () => attach(big, stranger.id, { ...old, who: w.outsiders[1]! })));
	await faulted(admin, "audit_event", () => attach(big, lee.id, old));
	assert.deepEqual([(await fileOf(big))!.state, (await fileOf(big))!.binds], ["pending", 0]);
	const signed = ok(await attach(big, lee.id, old));
	assert.deepEqual(
		[
			signed.commitment.document,
			signed.commitment.occurredOn,
			signed.commitment.recordedAt.slice(0, 10),
			signed.person.stage,
			signed.person.stageChange,
		],
		[
			{ status: "attached", mediaType: "image/jpeg", byteCount: 10_485_760 },
			"2026-09-01",
			"2026-10-13",
			"leader",
			null,
		],
	);
	assert.deepEqual([(await fileOf(big))!.state, (await fileOf(big))!.binds], ["ready", 1]);
	const first = { status: "known", occurredOn: "2026-09-01", evidenceId: signed.commitment.id };
	const since = async () => {
		const { current, firstAcquisition, total } = await w.held(lee.id);
		return [current.state, firstAcquisition, total, await stageOf(lee.id)];
	};
	assert.deepEqual(await since(), ["active", first, 1, "leader"]);
	const repeated = ok(await w.card(lee.id, "2026-09-20", { kind: "launch_team", witness: { personId: alex.id } }));
	assert.deepEqual([repeated.person.stage, repeated.person.stageChange], ["leader", null]);
	ok(await w.lifecycle("withdrawCommitment", lee.id, "2026-10-01", await w.revision(lee.id)));
	assert.deepEqual(await since(), ["withdrawn", first, 2, "leader"]);
	ok(await w.card(lee.id, "2026-09-25"));
	assert.deepEqual(await since(), ["withdrawn", first, 3, "leader"], "an older signature never overrides a withdrawal");
	ok(await w.lifecycle("reactivateCommitment", lee.id, "2026-10-12", await w.revision(lee.id)));
	assert.deepEqual(await since(), ["active", first, 3, "leader"]);
	const { growth: after } = await w.facts();
	assert.deepEqual(
		[after.lastAcquiredOn, after.current, after.prior],
		["2026-10-08", 1, 1],
		"rejoining on October 12 is no new acquisition",
	);
});

test("AC:TARGET-PPL-026 a withdrawal lowers the committed adults and keeps the acquisition clock, which counts church-local days from the newest genuine first signature", async () => {
	const own = await fixture({ prefix: "adults", clock: new Date("2026-10-09T16:00:00Z") });
	try {
		const w = await churchOf(own);
		await own.admin.execute(sql`UPDATE auth_session SET expires_at='2026-11-12T16:00:00Z'`);
		const at = (now: string) => pinSchemaClock(own.admin, own.schema, new Date(now));
		const size = async (now?: string) => {
			const { committedAdults: a, growth: g } = await w.facts(now);
			return {
				known: a.known,
				exact: a.exact,
				status: a.status,
				unclassified: a.needsClassifying.map((p) => p.name),
				growth: [g.status, g.lastAcquiredOn, g.daysSince, g.current, g.prior, g.currentWithdrawn],
			};
		};
		for (let n = 1; n <= 27; n++) ok(await w.card((await w.add(`Adult ${n}`)).id, "2026-08-01"));
		const sam = await w.add("Sam Unclassified", { adultClassification: "unknown" });
		ok(await w.card(sam.id, "2026-08-01"));
		const late = await w.add("Lou Late");
		const september = ok(await w.card(late.id, "2026-09-01")).commitment;
		assert.deepEqual([september.occurredOn, september.recordedAt.slice(0, 10)], ["2026-09-01", "2026-10-09"]);
		const sized = (known: number, status: string, ...growth: unknown[]) => ({
			known,
			exact: null,
			status,
			unclassified: ["Sam Unclassified"],
			growth,
		});
		assert.deepEqual(await size(), sized(28, "not_met", "stalled", "2026-09-01", 38, 0, 1, 0));
		const vic = await w.add("Vic Invalid");
		const wrong = ok(await w.card(vic.id, "2026-10-05")).commitment;
		assert.deepEqual(await size(), sized(29, "unknown", "on_track", "2026-10-05", 4, 1, 1, 0));
		const { value, added } = await recorded(own.admin, () =>
			w.save((t, c) =>
				commitments.correctCommitmentLifecycle(t, c, {
					requestKey: key(),
					expectedRevision: wrong.revision,
					input: {
						commitmentId: wrong.id,
						correction: { action: "correct", occurredOn: "2026-08-20" },
						reason: "The card is dated August 20",
					},
				}),
			),
		);
		ok(value);
		assert.deepEqual(added, { audits: ["people.corrected"], ...quiet });
		assert.deepEqual(await size(), sized(29, "unknown", "stalled", "2026-09-01", 38, 0, 2, 0));
		assert.deepEqual(
			ok(await w.read((t, c) => recordCorrections.listRecordCorrections(t, c, { personId: vic.id }))).items.map((i) => [
				i.actor,
				i.reason,
				i.changes,
			]),
			[
				[
					{ kind: "current_account", accountId: w.owner.id },
					"The card is dated August 20",
					[{ field: "occurredOn", old: "2026-10-05", new: "2026-08-20" }],
				],
			],
		);

		await at("2026-10-12T16:00:00Z");
		const nia = await w.add("Nia Newest");
		ok(await w.card(nia.id, "2026-10-12"));
		assert.deepEqual(await size(), sized(30, "met", "on_track", "2026-10-12", 0, 1, 2, 0));

		await at("2026-10-13T16:00:00Z");
		const change = async (operation: "withdrawCommitment" | "reactivateCommitment") => {
			const call = { requestKey: key() };
			const revision = await w.revision(nia.id);
			const run = () => w.lifecycle(operation, nia.id, "2026-10-13", revision, call);
			const done = await recorded(own.admin, run);
			assert.deepEqual(done.added, { audits: ["people.updated"], ...quiet });
			assert.deepEqual(ok(await untouched(own.admin, run)), ok(done.value));
			return ok(done.value).current.state;
		};
		assert.equal(await change("withdrawCommitment"), "withdrawn");
		assert.deepEqual(await size(), sized(29, "unknown", "on_track", "2026-10-12", 1, 1, 2, 1));
		assert.equal(await change("reactivateCommitment"), "active");
		ok(await w.card(nia.id, "2026-10-13", { kind: "launch_team" }));
		const rejoined = await w.facts();
		assert.deepEqual(
			[
				rejoined.committedAdults.evidence.length,
				new Set(rejoined.committedAdults.evidence.map((e) => e.person.id)).size,
			],
			[30, 30],
			"the adult who rejoined counts once",
		);
		const { firstAcquisition } = await w.held(nia.id);
		assert.equal(firstAcquisition.status === "known" && firstAcquisition.occurredOn, "2026-10-12");
		assert.deepEqual(await size(), sized(30, "met", "on_track", "2026-10-12", 1, 1, 2, 0));
		for (const [first, last, ...growth] of [
			["2026-11-01T00:10:00-05:00", "2026-11-01T23:50:00-06:00", "on_track", 20, 1, 0],
			["2026-11-02T00:10:00-06:00", "2026-11-02T23:50:00-06:00", "slowed", 21, 1, 0],
			["2026-11-08T00:10:00-06:00", "2026-11-08T23:50:00-06:00", "slowed", 27, 1, 0],
			["2026-11-09T00:10:00-06:00", "2026-11-09T23:50:00-06:00", "stalled", 28, 0, 1],
		] as const)
			for (const now of [first, last]) {
				const [status, days, current, prior] = growth;
				assert.deepEqual(await size(now), sized(30, "met", status, "2026-10-12", days, current, prior, 0), now);
			}
	} finally {
		await own.close();
	}
});

type Letter = "a" | "b" | "c";
type Step =
	| ["card", Letter, number, string?]
	| ["correct", string, number]
	| ["void", string]
	| ["withdraw" | "withdraw!" | "reactivate" | "stale", Letter, number]
	| ["merge", Letter, Letter]
	| ["unmerge" | "legacy", Letter]
	| ["merge backfill", number];

test("INV-commitment (C100): after every command sequence the cached commitment equals the one function of the valid cards and dated changes", async () => {
	const cases: { name: string; steps: Step[]; expect: Record<string, [string, number | null]> }[] = [
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
			name: "verifier: nested merges made before C100 give each Person its own withdrawal back after the merge backfill",
			steps: [
				["card", "a", 20],
				["card", "b", 15],
				["card", "c", 10],
				["withdraw", "c", 5],
				["merge", "c", "b"],
				["merge", "b", "a"],
				["legacy", "b"],
				["legacy", "a"],
				["merge backfill", 2],
				["unmerge", "a"],
				["unmerge", "b"],
			],
			expect: { a: ["active", 20], b: ["active", 15], c: ["withdrawn", 5] },
		},
	];
	const merged = new Map<string, string>(),
		everyone: string[] = [],
		edited = new Set<string>();
	for (const { name, steps, expect } of cases) {
		const people: Record<string, string> = {},
			cards: Record<string, string> = {};
		for (const letter of new Set(
			steps.flatMap((s) =>
				s
					.slice(1)
					.map(String)
					.filter((x) => /^[abc]$/.test(x)),
			),
		))
			everyone.push((people[letter] = (await person("Inv " + letter + " " + name.slice(0, 20))).id));
		const current = async (personId: string) =>
			ok(await tx((t) => commitments.getCommitments(t, ctx(), { personId }))).current;
		const card = async (id: string) =>
			(await rows<{ r: string }>(sql`SELECT revision::text r FROM commitment WHERE id=${sql.param(id)}`))[0]!.r;
		for (const step of steps) {
			const at = `${name}: ${step[0]} ${step[1]} ${step[2] ?? ""}`;
			if (step[0] === "card") {
				const [, a, b, c] = step;
				const saved = ok(
					await tx((t) =>
						commitments.createCommitment(t, ctx(), {
							requestKey: key(),
							input: { personId: people[a]!, kind: "core_group", occurredOn: day(b) },
						}),
					),
				);
				if (c) cards[c] = saved.commitment.id;
			} else if (step[0] === "correct" || step[0] === "void") {
				const [op, a] = step;
				const correction = step[0] === "void" ? { action: "void" } : { action: "correct", occurredOn: day(step[2]) };
				ok(
					await tx(async (t) =>
						commitments.correctCommitmentLifecycle(t, ctx(), {
							requestKey: key(),
							expectedRevision: await card(cards[a]!),
							input: { commitmentId: cards[a]!, correction, reason: "Sequence " + op },
						}),
					),
				);
			} else if (step[0] === "withdraw" || step[0] === "withdraw!" || step[0] === "reactivate") {
				const [op, a, b] = step;
				const change = op === "reactivate" ? commitments.reactivateCommitment : commitments.withdrawCommitment;
				const result = await tx(async (t) =>
					change(t, ctx(), {
						requestKey: key(),
						expectedRevision: (await current(people[a]!)).personRevision,
						input: { personId: people[a]!, effectiveOn: day(b) },
					}),
				);
				if (op === "withdraw!") refused(result, "invalid_input");
				else ok(result);
			} else if (step[0] === "merge") {
				const [, a, b] = step;
				const review = ok(
					await tx((t) => peopleMerge.getMergeReview(t, ctx(), { sourceId: people[a]!, survivorId: people[b]! })),
				);
				const done = ok(
					await tx((t) =>
						peopleMerge.mergePeople(t, ctx(), {
							requestKey: key(),
							input: {
								sourceId: people[a]!,
								survivorId: people[b]!,
								reviewDigest: review.reviewDigest,
								fieldChoices: {},
							},
						}),
					),
				);
				merged.set(people[b]!, done.mergeId);
				edited.delete(people[b]!);
			} else if (step[0] === "unmerge") {
				const [, a] = step;
				const mergeId = merged.get(people[a]!)!;
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
			} else if (step[0] === "stale") {
				const [, a, b] = step;
				await admin.execute(sql`UPDATE person SET commitment_state='active',commitment_effective_on=${sql.param(day(b))}
 WHERE id=${sql.param(people[a]!)}`);
				edited.add(people[a]!);
				continue;
			} else if (step[0] === "legacy") {
				const [, a] = step;
				await admin.execute(sql`UPDATE person_merge SET moved=moved-'commitment_change'
 WHERE id=${sql.param(merged.get(people[a]!))}`);
				continue;
			} else if (step[0] === "merge backfill") {
				const [, a] = step;
				assert.deepEqual(await backfill(admin, [mergeReferencesBackfill(1)], schema), [
					{ name: "merge_references_c100", changed: a },
				]);
			}
			if (step[0] === "unmerge") edited.clear();
			for (const personId of Object.values(people).filter((id) => !edited.has(id))) {
				const row = (
					await rows(sql`SELECT p.state,p.commitment_state,p.commitment_effective_on::text AS on,
 ${commitmentInputsJson(sql`p.id`, sql`p.plant_id`)} AS inputs FROM person p WHERE p.id=${sql.param(personId)}`)
				)[0]!;
				if (row.state !== "live") continue;
				assert.deepEqual(
					{ state: row.commitment_state, effectiveOn: row.on },
					commitmentOf(commitmentInputs.parse(row.inputs)),
					at,
				);
			}
		}
		for (const [letter, [state, n]] of Object.entries(expect)) {
			const { state: s, effectiveOn } = await current(people[letter]!);
			assert.deepEqual([s, effectiveOn], [state, n === null ? null : day(n)], name);
		}
	}
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

test("INV-concurrency: a save that meets a held lock waits the established way and sees what the holder committed", async () => {
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
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	const { promise: lockTaken, resolve: locked } = Promise.withResolvers<void>();
	const other = admin.transaction(async (a) => {
		await a.execute(sql`UPDATE person SET stage='launch_team',revision=revision+1 WHERE id=${sql.param(lee.id)}`);
		locked();
		await held;
	});
	await lockTaken;
	const saving = saveCommitmentDocument(db, storage, await actorOf(0), {
		requestKey: key(),
		input: { personId: lee.id, kind: "core_group", occurredOn: day(1), documentUploadId: signed.uploadId },
	});
	await waitingOnLock(db);
	release();
	await other;
	const saved = ok(await saving);
	assert.deepEqual(
		[saved.person.stage, saved.person.stageChange, saved.person.revision, await stageOf(lee.id)],
		["launch_team", null, String(BigInt(lee.revision) + 2n), "launch_team"],
	);
	const next = ok(
		await signCommitmentDocument(db, storage, ctx(3), actors[3].id, {
			personId: lee.id,
			mime: "image/png",
			byteLength: png.length,
		}),
	);
	storage.uploads.set(`private/${plants[0]}/${next.uploadId}`, { bytes: png, type: "image/png" });
	const deleting3 = await actorOf(3);
	const { promise: committed, resolve: commit } = Promise.withResolvers<void>();
	const { promise: deleting, resolve: started } = Promise.withResolvers<void>();
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
	await waitingOnLock(db);
	commit();
	await deletion;
	refused(await refusedSave);
	assert.deepEqual(
		[
			await count("commitment", lee.id),
			(await rows(sql`SELECT state FROM file_object WHERE id=${sql.param(next.uploadId)}`))[0]!.state,
		],
		[1, "pending"],
	);
	await admin.execute(sql`DELETE FROM lifecycle_witness WHERE opaque_subject_id=${sql.param(actors[3].id)}`);
});

test("INV-tenancy C13: a seat ended after the request resolved its actor reads no assessments, interviews or commitments", async () => {
	const p = await person("Morgan Lee");
	ok(await assess(p.id, day(1)));
	ok(await interview(p.id, "qualified"));
	const actor = await gatedTransaction(db, (t) => RequestActor.resolve(t, actors[3].session));
	assert.ok(actor instanceof RequestActor);
	const reads: Record<string, (t: WriteTx, c: Context) => Promise<Reply<unknown>>> = {
		getAssessments: (t, c) => assessments.getAssessments(t, c, { personId: p.id }),
		getInterviews: (t, c) => interviews.getInterviews(t, c, { personId: p.id }),
		getCommitments: (t, c) => commitments.getCommitments(t, c, { personId: p.id }),
	};
	const run = (read: (t: WriteTx, c: Context) => Promise<Reply<unknown>>) =>
		gatedTransaction(db, (t) => read(t, new PeopleReadContext(actor)));
	for (const read of Object.values(reads)) ok(await run(read));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[3].id)}`);
	try {
		for (const [name, read] of Object.entries(reads))
			assert.equal((await run(read)).status, "refused", name + " returned data after the seat ended");
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[3].id)}`);
	}
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
	const viewer = new PeopleReadContext(await tx((t) => authorityOf(t, actors[0])));
	const reads = (c: Context): [string, (t: WriteTx) => Promise<Reply<unknown>>][] => [
		["getAssessments", (t) => assessments.getAssessments(t, c, { personId: p.id })],
		["getInterviews", (t) => interviews.getInterviews(t, c, { personId: p.id })],
		["getCommitments", (t) => commitments.getCommitments(t, c, { personId: p.id })],
	];
	const waited: string[] = [];
	for (const [name, c] of [
		["cached", viewer],
		["plain", ctx()],
	] as const)
		for (const [op, run] of reads(c))
			await tx(async (t) => {
				ok(await run(t));
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
