import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import {
	commitments,
	peopleMerge,
	peopleUnmerge,
	peopleWriter as people,
	recordCorrections,
} from "../../../../../packages/domain/src/people/index.ts";
import { trainingReader, trainingWriter } from "../../../../../packages/domain/src/teams/index.ts";
import { fixture, ok, refused } from "../../../../support/fixture.mts";

// SCHEMA-010: a reviewed merge of P2 into P1 inverts only while its post-merge state is the one Unmerge reviewed. The
// schema's clock runs from the case's instant (2026-10-13T16:00:00Z, America/Chicago).
const database = await fixture({ prefix: "wp092unm", clock: new Date("2026-10-13T16:00:00.000Z") });
const { admin } = database;
const db = database.pools.runtime;
const P = database.tenant.id;
const Q = (await database.plant()).id;
// A: Admin of P. B: Admin of another church Q.
const A = database.actors.admin;
const B = await database.actor({ kind: "plant", id: Q }, "admin");
const ctx = (actor = A) => ({ session: actor.session, selected: { kind: "plant", id: actor === B ? Q : P } });
const tx = (body) => db.transaction(body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const one = async (query) => (await rows(query))[0];
const revisionOf = async (table, id) =>
	(await one(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`)).r;

after(async () => {
	await database.close();
});

async function person(name) {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), { requestKey: key(), input: { displayName: name, adultClassification: "adult" } }),
		),
	).person.id;
}
async function card(personId, occurredOn) {
	return ok(
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId, kind: "core_group", occurredOn },
			}),
		),
	).commitment;
}
/** One required training both people are on, so the merge meets a training collision. */
async function sharedTraining(personIds) {
	const program = ok(
		await tx((t) =>
			trainingWriter.createProgram(t, ctx(), {
				requestKey: key(),
				input: { name: "Welcome " + key(), required: true, teamId: null },
			}),
		),
	).program;
	const viewer = await RequestActor.resolve(db, A.session);
	const seen = ok(await trainingReader.readRequiredTrainingPreview(db, viewer, { programId: program.id, personIds }));
	ok(
		await tx((t) =>
			trainingWriter.setRequiredTrainingParticipants(t, ctx(), {
				requestKey: key(),
				expectedRevision: seen.revision,
				input: { programId: program.id, personIds, rosterDigest: seen.rosterDigest },
			}),
		),
	);
}
/** A delivered or unknown provider effect: email to P1 the provider took and may already have delivered. */
async function delivery(personId, state) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO mail(id,tenant_id,recipient_person_id,purpose,logical_key,payload_hash,audience_hash,
 state,provider_message_id,accepted_at,created_at)
 VALUES(${id},${P},${personId},'notification',${"schema-010/" + id},'hash','audience',${state},${"provider-" + id},
 clock_timestamp(),clock_timestamp())`);
	return id;
}
async function merge(sourceId, survivorId) {
	const review = ok(await tx((t) => peopleMerge.getMergeReview(t, ctx(), { sourceId, survivorId })));
	return ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId, survivorId, reviewDigest: review.reviewDigest },
			}),
		),
	);
}
/** Unmerge against the reviewed post-merge state the preview shows `actor`. */
async function unmerge(mergeId, actor = A) {
	const preview = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(actor), { mergeId })));
	return tx((t) =>
		peopleUnmerge.unmergePeople(t, ctx(actor), {
			requestKey: key(),
			expectedRevision: preview.reviewRevision,
			input: { mergeId },
		}),
	);
}

/** The merged pair as the database holds it: which Person is current, and the merge record. */
const reference = async (p1, p2, mergeId) =>
	one(sql`SELECT (SELECT state FROM person WHERE id=${p2}) AS p2_state,
 (SELECT merged_into_person_id FROM person WHERE id=${p2}) AS p2_merged_into,
 (SELECT state FROM person WHERE id=${p1}) AS p1_state,
 (SELECT unmerged_at IS NOT NULL FROM person_merge WHERE id=${mergeId}) AS unmerged`);
/** Every provider-facing row: a provider undo or resend shows as a new or changed row here. */
const provider = async (mailId) =>
	one(sql`SELECT (SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM mail_attempt) AS attempts,
 (SELECT count(*)::int FROM mail_request) AS requests,(SELECT count(*)::int FROM job WHERE kind='mail') AS jobs,
 (SELECT to_jsonb(m) FROM mail m WHERE m.id=${mailId}) AS effect`);
/** Who holds each training assignment of the pair, and its state. */
const assignments = async (p1, p2) =>
	rows(sql`SELECT CASE person_id WHEN ${p1}::uuid THEN 'P1' ELSE 'P2' END AS owner,state FROM training_assignment
 WHERE person_id IN (${p1}::uuid,${p2}::uuid) ORDER BY 1,2`);
/** Inverse receipts: the audit rows an Unmerge writes for its survivor. */
const inverseReceipts = async (p1) =>
	(await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${p1} AND action='people.unmerged'`)).n;

test("AC:SCHEMA-010 guarded Unmerge refuses a changed post-merge state, keeps P1 current and undoes or resends no mail", async () => {
	// P2 duplicates P1: both are on one required training and each holds a commitment card (training and card collisions),
	// and P1 already has an email the provider accepted with an unknown outcome.
	const p1 = await person("Jordan Lee"),
		p2 = await person("Jordan L.");
	await sharedTraining([p1, p2]);
	await card(p1, "2026-10-01");
	const moved = await card(p2, "2026-10-05");
	const mail = await delivery(p1, "unknown");
	const merged = await merge(p2, p1);
	assert.deepEqual(await reference(p1, p2, merged.mergeId), {
		p2_state: "merged",
		p2_merged_into: p1,
		p1_state: "live",
		unmerged: false,
	});
	assert.equal((await one(sql`SELECT person_id FROM commitment WHERE id=${moved.id}`)).person_id, p1);
	// The training collision: P2's assignment moved to P1 and ended, so P1 holds the one active assignment.
	assert.deepEqual(await assignments(p1, p2), [
		{ owner: "P1", state: "active" },
		{ owner: "P1", state: "removed" },
	]);

	// A moved row changes after the reviewed post-merge state: the card P2 brought is corrected on P1.
	ok(
		await tx(async (t) =>
			recordCorrections.correctPersonRecord(t, ctx(), {
				requestKey: key(),
				expectedRevision: await revisionOf("commitment", moved.id),
				input: {
					recordType: "commitment",
					personId: p1,
					recordId: moved.id,
					reason: "Signed after service",
					changes: { notes: "Corrected" },
				},
			}),
		),
	);
	const effects = await provider(mail);
	const error = refused(await unmerge(merged.mergeId), "inverse_conflict");
	assert.deepEqual(error.details.causes, ["references_changed"]);
	// P1 stays the current reference; no inverse receipt, provider undo or resend.
	assert.deepEqual(await reference(p1, p2, merged.mergeId), {
		p2_state: "merged",
		p2_merged_into: p1,
		p1_state: "live",
		unmerged: false,
	});
	assert.equal(await inverseReceipts(p1), 0);
	assert.deepEqual(await provider(mail), effects);
	assert.equal(effects.effect.state, "unknown");
});

test("AC:SCHEMA-010 clean-poststate-can-inverse: an unchanged post-merge state inverts once, only by an Admin of the church, with no provider undo or resend", async () => {
	const p1 = await person("Casey Park"),
		p2 = await person("Casey P.");
	await sharedTraining([p1, p2]);
	await card(p1, "2026-10-01");
	const moved = await card(p2, "2026-10-05");
	const mail = await delivery(p1, "accepted");
	const merged = await merge(p2, p1);
	const effects = await provider(mail);

	// An Admin of another church Q cannot preview or Unmerge P's merge, and P's state is unchanged.
	refused(await tx((t) => peopleUnmerge.previewUnmerge(t, ctx(B), { mergeId: merged.mergeId })));
	refused(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(B), {
				requestKey: key(),
				expectedRevision: "1",
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	assert.deepEqual(await reference(p1, p2, merged.mergeId), {
		p2_state: "merged",
		p2_merged_into: p1,
		p1_state: "live",
		unmerged: false,
	});
	assert.equal(await inverseReceipts(p1), 0);

	// Nothing changed since the reviewed post-merge state: Unmerge restores P2 as the current reference.
	assert.equal(ok(await unmerge(merged.mergeId)).outcome, "changed");
	assert.deepEqual(await reference(p1, p2, merged.mergeId), {
		p2_state: "live",
		p2_merged_into: null,
		p1_state: "live",
		unmerged: true,
	});
	assert.equal((await one(sql`SELECT person_id FROM commitment WHERE id=${moved.id}`)).person_id, p2);
	assert.deepEqual(await assignments(p1, p2), [
		{ owner: "P1", state: "active" },
		{ owner: "P2", state: "removed" },
	]);
	assert.equal(await inverseReceipts(p1), 1);
	assert.deepEqual(await provider(mail), effects);
	assert.equal(effects.effect.state, "accepted");
});
