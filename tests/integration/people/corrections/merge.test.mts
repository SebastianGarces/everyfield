import { fixture, ok, refused, waitingOnLock } from "../../../support/fixture.mts";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";

import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { createSignals } from "../../../../packages/domain/src/intelligence/index.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import {
	assessments,
	checkForDuplicates,
	commitments,
	interviews,
	peopleMerge,
	peopleReader,
	peopleUnmerge,
	peopleWriter as people,
	personFields,
	readPersonPage,
	recordCorrections,
} from "../../../../packages/domain/src/people/index.ts";

// Duplicate review, merge, guarded Unmerge and record corrections through their public operations on a scratch schema.
const database = await fixture({ prefix: "wp015" });
const { admin, schema } = database;
const db = database.pools.runtime;
let today;
const day = (n) => new Date(Date.parse(today + "T12:00:00Z") - n * 86_400_000).toISOString().slice(0, 10);

const plants = [database.tenant.id, (await database.plant()).id],
	actors = [
		database.actors.owner,
		database.actors.member,
		await database.actor({ kind: "plant", id: plants[1] }, "admin"),
		database.actors.admin,
	];
today = (await database.admin.execute(sql`SELECT (clock_timestamp() AT TIME ZONE 'America/Chicago')::date::text d`))
	.rows[0].d;
// 0: plant A owner, 1: plant A member, 2: plant B admin, 3: plant A admin.
const ctx = (who = 0) => ({ session: actors[who].session, selected: { kind: "plant", id: plants[who === 2 ? 1 : 0] } });
const tx = (body) => db.transaction(body);
const key = () => randomUUID();
const rows = async (query) => (await admin.execute(query)).rows;
const one = async (query) => (await rows(query))[0];
const personRow = (id) =>
	one(sql`SELECT state,merged_into_person_id,revision::text,display_name,email,stage,commitment_state,household_id
 FROM person WHERE id=${sql.param(id)}`);

async function person(name, input = {}) {
	return ok(
		await tx((t) =>
			people.createPerson(t, ctx(), {
				requestKey: key(),
				input: { displayName: name, adultClassification: "adult", ...input },
			}),
		),
	).person;
}
const review = (sourceId, survivorId, who = 0) =>
	tx((t) => peopleMerge.getMergeReview(t, ctx(who), { sourceId, survivorId }));
async function merge(sourceId, survivorId, fieldChoices = {}, who = 0, requestKey = key()) {
	const r = ok(await review(sourceId, survivorId, who));
	return tx((t) =>
		peopleMerge.mergePeople(t, ctx(who), {
			requestKey,
			input: { sourceId, survivorId, reviewDigest: r.reviewDigest, fieldChoices },
		}),
	);
}
const addSkill = (personId, name, who = 3) =>
	tx((t) => personFields.addSkill(t, ctx(who), { requestKey: key(), input: { personId, name, category: "tech" } }));
const skillsOf = async (personId) =>
	(await rows(sql`SELECT name FROM person_skill WHERE person_id=${sql.param(personId)} ORDER BY name`)).map(
		(r) => r.name,
	);

after(async () => {
	await database.close();
});

test("AC:REQ-PPL-024 a write racing a merge waits for it and never leaves a current reference on the retired source", async () => {
	const keep = await person("Jordan Lee"),
		gone = await person("Jordan L.");
	const r = ok(await review(gone.id, keep.id));
	let release;
	const hold = new Promise((resolve) => (release = resolve));
	let merged;
	const mergeWritten = new Promise((resolve) => (merged = resolve));
	// The merge holds its transaction open until the racing write has started.
	const first = tx(async (t) => {
		ok(
			await peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: gone.id, survivorId: keep.id, reviewDigest: r.reviewDigest },
			}),
		);
		merged();
		await hold;
	});
	await mergeWritten;
	let settled = false;
	const racing = addSkill(gone.id, "Sound").then((result) => ((settled = true), result));
	// The skill write blocks on the merge's row lock: Postgres shows it waiting, and it has not settled.
	await waitingOnLock(db);
	assert.equal(settled, false, "the skill write must wait for the merge to commit");
	release();
	await first;
	refused(await racing);
	assert.deepEqual([await skillsOf(gone.id), await skillsOf(keep.id)], [[], []]);
	assert.equal((await personRow(gone.id)).state, "merged");
});

const unmergePreview = (mergeId, who = 0) => tx((t) => peopleUnmerge.previewUnmerge(t, ctx(who), { mergeId }));
async function unmerge(mergeId, who = 0, requestKey = key()) {
	const preview = ok(await unmergePreview(mergeId, who));
	return tx((t) =>
		peopleUnmerge.unmergePeople(t, ctx(who), {
			requestKey,
			expectedRevision: preview.reviewRevision,
			input: { mergeId },
		}),
	);
}
const lens = (score) => ({ score, notes: "Private lens " + score });
const criteria = (rating) =>
	Object.fromEntries(
		["maturity", "gifted", "chemistry", "rightReasons", "season"].map((n) => [n, { rating, notes: null }]),
	);
const tagIds = async (personId) =>
	(await rows(sql`SELECT tag_id FROM person_tag WHERE person_id=${sql.param(personId)} ORDER BY tag_id`)).map(
		(r) => r.tag_id,
	);
const owners = async (table, ids) =>
	(
		await rows(sql`SELECT person_id FROM ${sql.identifier(table)} WHERE id=ANY(${sql.param(ids)}::uuid[]) ORDER BY id`)
	).map((r) => r.person_id);
const audits = (subjectIds) =>
	// Every column, the stored retry reply included: privacy checks read the whole audit row.
	rows(sql`SELECT * FROM audit_event WHERE subject_id=ANY(${sql.param(subjectIds)}::uuid[])
 AND action IN ('people.merged','people.unmerged','people.corrected') ORDER BY occurred_at,id`);

test("AC:TARGET-PPL-017 AC:TARGET-PPL-025 AC:CA022 AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-MERGE AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-UNMERGE AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-MERGE AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-UNMERGE AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-MERGE AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-UNMERGE AC:PERSONREF-SHARED-RECEIPT-AUDIT-PERSON-SUBJECT-MERGE AC:PERSONREF-ACCOUNT-LINK-MERGE AC:ROLE43-011 INV-merge-choices reviewed merge moves every people reference to the survivor, and Unmerge restores both people exactly", async () => {
	// D is account-linked and survives; S is its unlinked duplicate with its own records, tags, note and household.
	const d = await person("Dana Ruiz", { email: "dana@example.test", stage: "attendee" });
	const s = await person("Dana R.", { email: "DANA@example.test ", phone: "555 010 2000", stage: "core_group" });
	const earlier = await person("Dana Ruiz (old)");
	await admin.execute(sql`UPDATE person SET linked_account_id=${sql.param(actors[1].id)} WHERE id=${sql.param(d.id)}`);
	const [shared, own, household] = [randomUUID(), randomUUID(), randomUUID()];
	for (const [id, name] of [
		[shared, "Volunteer"],
		[own, "Musician"],
	])
		await admin.execute(
			sql`INSERT INTO tag(id,plant_id,name,normalized_name) VALUES(${sql.param(id)},${sql.param(plants[0])},${name},${name.toLowerCase()})`,
		);
	await admin.execute(
		sql`INSERT INTO household(id,plant_id,name) VALUES(${sql.param(household)},${sql.param(plants[0])},'Ruiz household')`,
	);
	await admin.execute(
		sql`UPDATE person SET household_id=${sql.param(household)},household_role='head' WHERE id=${sql.param(s.id)}`,
	);
	await admin.execute(sql`INSERT INTO person_tag(plant_id,person_id,tag_id) VALUES
 (${sql.param(plants[0])},${sql.param(d.id)},${sql.param(shared)}),(${sql.param(plants[0])},${sql.param(s.id)},${sql.param(shared)}),
 (${sql.param(plants[0])},${sql.param(s.id)},${sql.param(own)})`);
	ok(await addSkill(s.id, "Sound"));
	const note = ok(
		await tx(async (t) =>
			people.addNote(t, ctx(3), {
				requestKey: key(),
				expectedRevision: (await personRow(s.id)).revision,
				input: { personId: s.id, body: "Met at the picnic" },
			}),
		),
	);
	const assessment = ok(
		await tx((t) =>
			assessments.createAssessment(t, ctx(3), {
				requestKey: key(),
				input: {
					personId: s.id,
					occurredOn: day(5),
					committed: lens(4),
					compelled: lens(4),
					contagious: lens(4),
					courageous: lens(4),
				},
			}),
		),
	).assessment;
	const interview = ok(
		await tx((t) =>
			interviews.createInterview(t, ctx(), {
				requestKey: key(),
				input: { personId: s.id, occurredOn: day(4), ...criteria("pass"), result: "qualified", nextSteps: null },
			}),
		),
	).interview;
	const card = ok(
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId: s.id, kind: "core_group", occurredOn: day(3) },
			}),
		),
	).commitment;
	// Each record kind carries a correction, which moves with its record (F1 at 9e1275b).
	const fix = (recordType, personId, recordId, expectedRevision, changes, reason = "Typo") =>
		tx((t) =>
			recordCorrections.correctPersonRecord(t, ctx(), {
				requestKey: key(),
				expectedRevision,
				input: { recordType, personId, recordId, reason, changes },
			}),
		);
	const corrected = [
		ok(await fix("assessment", s.id, assessment.id, assessment.revision, { courageous: lens(5) })).correctionId,
		ok(await fix("interview", s.id, interview.id, interview.revision, { result: "follow_up" })).correctionId,
		ok(await fix("commitment", s.id, card.id, card.revision, { notes: "Signed after service" })).correctionId,
	].sort();
	const correctionOwners = async () =>
		(
			await rows(sql`SELECT person_id FROM record_correction WHERE id=ANY(${sql.param(corrected)}::uuid[]) ORDER BY id`)
		).map((x) => x.person_id);
	const correctionTrail = async () =>
		(
			await rows(sql`SELECT (SELECT count(*)::int FROM record_correction WHERE record_id=${sql.param(assessment.id)}) n,
 (SELECT count(*)::int FROM audit_event WHERE action='people.corrected') a,
 (SELECT courageous FROM four_cs WHERE id=${sql.param(assessment.id)}) score`)
		)[0];
	// An earlier merge of a third record into S: its redirect follows S to the survivor.
	ok(await merge(earlier.id, s.id));
	const before = { d: await personRow(d.id), s: await personRow(s.id) };

	// The review names every differing field, the stage kept, the records that move and no blocker.
	const r = ok(await review(s.id, d.id));
	assert.deepEqual(
		r.fields.map((f) => f.field),
		["displayName", "email", "phone", "household"],
	);
	assert.deepEqual([r.survivor.linkedAccount, r.source.linkedAccount], [true, false]);
	assert.deepEqual(r.stage, { source: "core_group", survivor: "attendee", result: "core_group" });
	assert.deepEqual(r.commitment, { result: "active", effectiveOn: day(3) });
	assert.deepEqual(Object.fromEntries(r.references.map((x) => [x.kind, [x.count, x.treatment]])), {
		assessment: [1, "move"],
		correction: [3, "move"],
		commitment: [1, "move"],
		interview: [1, "move"],
		merged_person: [1, "move"],
		note: [1, "move"],
		skill: [1, "move"],
		tag: [2, "deduplicate"],
	});
	assert.deepEqual(r.blockers, { causes: [], references: [] });
	// Members review nothing; another church cannot name these people.
	refused(await review(s.id, d.id, 1));
	refused(await review(s.id, d.id, 2));

	// A merge against a state that changed after the review writes nothing.
	ok(await addSkill(d.id, "Hospitality"));
	refused(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: s.id, survivorId: d.id, reviewDigest: r.reviewDigest },
			}),
		),
		"conflict",
	);
	assert.equal((await personRow(s.id)).state, "live");

	// The reviewed merge, keeping S's phone; a retry returns the same result and changes nothing more.
	const request = {
		requestKey: key(),
		input: {
			sourceId: s.id,
			survivorId: d.id,
			reviewDigest: ok(await review(s.id, d.id)).reviewDigest,
			fieldChoices: { phone: "source" },
		},
	};
	const merged = ok(await tx((t) => peopleMerge.mergePeople(t, ctx(), request)));
	// The source is no longer live, so the same pair cannot be reviewed again.
	refused(await review(s.id, d.id));
	const repeated = ok(await tx((t) => peopleMerge.mergePeople(t, ctx(), request)));
	assert.deepEqual(repeated, merged);
	assert.equal((await rows(sql`SELECT count(*)::int n FROM person_merge WHERE source_id=${sql.param(s.id)}`))[0].n, 1);

	const after = { d: await personRow(d.id), s: await personRow(s.id) };
	assert.deepEqual([after.s.state, after.s.merged_into_person_id, after.s.household_id], ["merged", d.id, null]);
	assert.deepEqual(
		[after.d.display_name, after.d.email, after.d.stage, after.d.commitment_state],
		["Dana Ruiz", "dana@example.test", "core_group", "active"],
	);
	assert.equal((await one(sql`SELECT phone FROM person WHERE id=${sql.param(d.id)}`)).phone, "555 010 2000");
	assert.equal((await personRow(earlier.id)).merged_into_person_id, d.id);
	// Every current reference is on the survivor; the shared tag is held once; nothing points at S.
	assert.deepEqual(await tagIds(d.id), [shared, own].sort());
	assert.deepEqual(await tagIds(s.id), []);
	assert.deepEqual(await skillsOf(d.id), ["Hospitality", "Sound"]);
	assert.deepEqual(await owners("four_cs", [assessment.id]), [d.id]);
	assert.deepEqual(await correctionOwners(), [d.id, d.id, d.id]);
	// A correction form kept from before the merge is refused, whether it names S or D, and leaves no trace (F3).
	const trail = await correctionTrail();
	assert.equal(trail.score, 5);
	refused(await fix("assessment", s.id, assessment.id, "2", { courageous: lens(1) }, "Old form"));
	refused(await fix("assessment", d.id, assessment.id, "2", { courageous: lens(1) }, "Old form"), "conflict");
	assert.deepEqual(await correctionTrail(), trail);
	assert.equal(ok(await corrections(d.id)).items[0].reason, "Typo");
	assert.deepEqual(await owners("interview", [interview.id]), [d.id]);
	assert.deepEqual(await owners("commitment", [card.id]), [d.id]);
	assert.deepEqual(await owners("person_note", [note.noteId]), [d.id]);
	// Authorship and original recording stay: the note keeps its author, the assessment its recorder.
	assert.equal(
		(await one(sql`SELECT author_id FROM person_note WHERE id=${sql.param(note.noteId)}`)).author_id,
		actors[3].id,
	);
	const moved = ok(await tx((t) => assessments.getAssessments(t, ctx(), { personId: d.id })));
	assert.deepEqual([moved.total, moved.items[0].actor], [1, { kind: "current_account", accountId: actors[3].id }]);
	// The account link and its grants stay with D; S keeps none.
	assert.equal(
		(await one(sql`SELECT linked_account_id FROM person WHERE id=${sql.param(s.id)}`)).linked_account_id,
		null,
	);
	// S opens D, and S's history shows on D with the merge.
	assert.deepEqual(ok(await tx((t) => peopleMerge.mergedPersonDestination(t, ctx(1), { personId: s.id }))), {
		personId: s.id,
		status: "merged",
		destinationId: d.id,
		mergeId: merged.mergeId,
	});
	const feed = ok(await tx((t) => peopleReader.getActivities(t, ctx(), { personId: d.id, limit: 100 }))).items;
	assert.ok(feed.some((a) => a.action === "interview_recorded" && a.recordId === interview.id));
	assert.ok(feed.some((a) => a.action === "person_merged" && a.recordId === merged.mergeId));
	assert.ok(feed.some((a) => a.kind === "note" && a.body === "Met at the picnic"));
	// No new reference can name S.
	refused(await addSkill(s.id, "Late"));
	// The merge's central audit row names the merge but holds no contact value, name or private record content.
	assert.equal((await audits([d.id])).length, 1);
	assert.ok(
		!JSON.stringify(await audits([d.id, s.id])).match(
			/555 010 2000|dana@example|Dana R\.|Private lens|Met at the picnic/,
		),
	);

	// Unmerge previews exactly what it restores and restores both people as they were.
	const preview = ok(await unmergePreview(merged.mergeId));
	assert.deepEqual([preview.state, preview.conflicts, preview.fields], ["merged", [], ["phone"]]);
	refused(await unmergePreview(merged.mergeId, 1));
	refused(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, ctx(1), {
				requestKey: key(),
				expectedRevision: preview.reviewRevision,
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	const restored = ok(await unmerge(merged.mergeId));
	assert.equal(restored.outcome, "changed");
	const back = { d: await personRow(d.id), s: await personRow(s.id) };
	assert.deepEqual(
		[back.s.state, back.s.merged_into_person_id, back.s.household_id, back.s.display_name],
		["live", null, household, "Dana R."],
	);
	assert.deepEqual(
		[back.d.stage, back.d.commitment_state, back.d.email],
		[before.d.stage, before.d.commitment_state, before.d.email],
	);
	assert.equal((await one(sql`SELECT phone FROM person WHERE id=${sql.param(d.id)}`)).phone, null);
	assert.deepEqual([await tagIds(d.id), await tagIds(s.id)], [[shared], [shared, own].sort()]);
	assert.deepEqual([await skillsOf(d.id), await skillsOf(s.id)], [["Hospitality"], ["Sound"]]);
	assert.deepEqual(await owners("four_cs", [assessment.id]), [s.id]);
	assert.deepEqual(await correctionOwners(), [s.id, s.id, s.id]);
	// A form reviewed while the record sat on D is refused after Unmerge (F3).
	const current = (await one(sql`SELECT revision::text r FROM four_cs WHERE id=${sql.param(assessment.id)}`)).r;
	refused(await fix("assessment", d.id, assessment.id, current, { courageous: lens(1) }, "Old form"), "conflict");
	assert.deepEqual(await correctionTrail(), trail);
	assert.deepEqual(await owners("person_note", [note.noteId]), [s.id]);
	assert.equal((await personRow(earlier.id)).merged_into_person_id, s.id);
	// A repeat changes nothing more; the merge stays in history as reversed.
	assert.equal(
		ok(
			await tx((t) =>
				peopleUnmerge.unmergePeople(t, ctx(), {
					requestKey: key(),
					expectedRevision: back.d.revision,
					input: { mergeId: merged.mergeId },
				}),
			),
		).outcome,
		"noop",
	);
	assert.equal(ok(await unmergePreview(merged.mergeId)).state, "unmerged");
	assert.equal((await personRow(s.id)).revision, back.s.revision);
});

test("AC:TARGET-PPL-025 AC:EVRY-PERSON-UNMERGE AC:PERSONREF-ASSESSMENT-INTERVIEW-COMMITMENT-CONFLICT AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-CONFLICT Unmerge refuses after a later edit, new reference or chained merge and changes nothing", async () => {
	const cases = [
		[
			"survivor edit",
			["survivor_changed"],
			async (d) =>
				ok(
					await tx(async (t) =>
						people.updatePerson(t, ctx(), {
							requestKey: key(),
							expectedRevision: (await personRow(d.id)).revision,
							input: { personId: d.id, patch: { phone: "555 010 3000" } },
						}),
					),
				),
		],
		[
			"new reference",
			["references_changed"],
			async (d) =>
				ok(
					await tx((t) =>
						assessments.createAssessment(t, ctx(), {
							requestKey: key(),
							input: {
								personId: d.id,
								occurredOn: day(1),
								committed: lens(2),
								compelled: lens(2),
								contagious: lens(2),
								courageous: lens(2),
							},
						}),
					),
				),
		],
		[
			"chained merge",
			["source_changed", "survivor_changed", "references_changed"],
			async (d) => ok(await merge(d.id, (await person("Chain survivor")).id)),
		],
	];
	for (const [name, causes, later] of cases) {
		const d = await person("Unmerge " + name),
			s = await person("Unmerge " + name + " duplicate");
		ok(await addSkill(s.id, "Teaching"));
		const merged = ok(await merge(s.id, d.id));
		await later(d);
		const state = { d: await personRow(d.id), s: await personRow(s.id), skills: await skillsOf(d.id) };
		assert.deepEqual(ok(await unmergePreview(merged.mergeId)).conflicts, causes, name);
		const error = refused(
			await tx((t) =>
				peopleUnmerge.unmergePeople(t, ctx(), {
					requestKey: key(),
					expectedRevision: state.d.revision,
					input: { mergeId: merged.mergeId },
				}),
			),
			"inverse_conflict",
		);
		assert.deepEqual(error.details.causes, causes, name);
		assert.deepEqual({ d: await personRow(d.id), s: await personRow(s.id), skills: await skillsOf(d.id) }, state, name);
	}
});

test("AC:PERSONREF-ACCOUNT-LINK-CONFLICT AC:TARGET-PPL-017 AC:TARGET-PPL-016 INV-survivor merge refuses linked-account collisions and references their package has not registered; hints never merge", async () => {
	const a = await person("Avery Stone", { email: "avery@example.test" }),
		b = await person("Avery Stone"),
		c = await person("Avery S.");
	await admin.execute(sql`UPDATE person SET linked_account_id=${sql.param(actors[0].id)} WHERE id=${sql.param(a.id)}`);
	await admin.execute(sql`UPDATE person SET linked_account_id=${sql.param(actors[3].id)} WHERE id=${sql.param(b.id)}`);
	const blocked = async (sourceId, survivorId, causes, references = []) => {
		assert.deepEqual(ok(await review(sourceId, survivorId)).blockers, { causes, references });
		const error = refused(await merge(sourceId, survivorId), "merge_blocked");
		assert.deepEqual(error.details, { causes, references });
		assert.equal((await personRow(sourceId)).state, "live");
	};
	// Two linked people cannot merge; the linked person must survive.
	await blocked(b.id, a.id, ["linked_account_collision"]);
	await blocked(a.id, c.id, ["linked_source"]);
	// A current task on the source belongs to a package that has not registered its merge behavior yet.
	const duty = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
 VALUES(${sql.param(duty)},${sql.param(plants[0])},'Call','follow_up','medium','not_started',clock_timestamp(),'undated',${sql.param(c.id)})`);
	await admin.execute(
		sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${sql.param(plants[0])},${sql.param(duty)},${sql.param(actors[0].id)})`,
	);
	await blocked(c.id, a.id, ["unregistered_reference"], ["task"]);
	// Same-name duplicate hints stay hints: nobody is merged.
	const hints = ok(
		await tx((t) => checkForDuplicates(t, ctx(1), { displayName: "avery  stone", excludePersonId: c.id })),
	);
	assert.deepEqual(
		hints.items.map((h) => [h.personId, h.match, h.signals]),
		[
			[a.id, "potential", ["name"]],
			[b.id, "potential", ["name"]],
		],
	);
	assert.equal(
		(await rows(sql`SELECT count(*)::int n FROM person WHERE display_name LIKE 'Avery%' AND state='live'`))[0].n,
		3,
	);
});

test("AC:REQ-PPL-016 the person page shows the duplicate hints checkForDuplicates gives for that person's own facts", async () => {
	// Unique facts, so other tests' people in this church never match.
	const tag = randomBytes(4).toString("hex"),
		digits = String(1e9 + (randomBytes(4).readUInt32BE() % 1e9)).slice(1);
	const p = await person(`  Jordan   Lee${tag} `, {
		email: ` Jordan${tag}@Example.test `,
		phone: `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`,
	});
	const name = await person(`jordan lee${tag}`),
		email = await person("J. Lee", { email: `jordan${tag}@example.test` }),
		phone = await person("Phone twin", { phone: `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}` });
	await person(`Jordan Leeds${tag}`, { phone: digits.slice(3) });
	const page = ok(await tx((t) => readPersonPage(t, ctx(1), { personId: p.id }, 50, { duplicates: true })));
	const own = page.found.person;
	const hints = ok(
		await tx((t) =>
			checkForDuplicates(t, ctx(1), {
				displayName: own.displayName,
				email: own.email,
				phone: own.phone,
				excludePersonId: p.id,
			}),
		),
	);
	assert.deepEqual(page.duplicates, hints);
	assert.deepEqual(
		new Map(hints.items.map((h) => [h.personId, [h.match, h.signals]])),
		new Map([
			[email.id, ["exact", ["email"]]],
			[phone.id, ["exact", ["phone"]]],
			[name.id, ["potential", ["name"]]],
		]),
	);
});

// `reason` is spread into the input: `{}` leaves the key out, as the browser does for a blank field.
const correct = (
	recordType,
	personId,
	recordId,
	expectedRevision,
	changes,
	who = 0,
	requestKey = key(),
	reason: { reason?: string } = { reason: "Entered from the wrong form" },
) =>
	tx((t) =>
		recordCorrections.correctPersonRecord(t, ctx(who), {
			requestKey,
			expectedRevision,
			input: { recordType, personId, recordId, ...reason, changes },
		}),
	);
const corrections = (personId, who = 0) =>
	tx((t) => recordCorrections.listRecordCorrections(t, ctx(who), { personId }));

test("AC:TARGET-PPL-015 AC:CA013 AC:CA021 INV-correction-patch INV-optional-reason corrections keep the recorder, recompute the total, never move the stage, take an optional reason, clear a note sent as null and keep old and new values out of audit", async () => {
	const p = await person("Morgan Hale", { stage: "leader" });
	const a = ok(
		await tx((t) =>
			assessments.createAssessment(t, ctx(3), {
				requestKey: key(),
				input: {
					personId: p.id,
					occurredOn: day(6),
					committed: lens(3),
					compelled: lens(3),
					contagious: lens(3),
					courageous: lens(3),
				},
			}),
		),
	).assessment;
	// A correction against an outdated view, by a Member or from another church writes nothing.
	refused(await correct("assessment", p.id, a.id, "2", { committed: lens(5) }), "conflict");
	refused(await correct("assessment", p.id, a.id, a.revision, { committed: lens(5) }, 1));
	refused(await correct("assessment", p.id, a.id, a.revision, { committed: lens(5) }, 2));
	// Original recorder, recorded instant and totals are not correction fields.
	refused(await correct("assessment", p.id, a.id, a.revision, { total: 20 }), "invalid_input");
	refused(
		await correct("assessment", p.id, a.id, a.revision, { recordedAt: new Date().toISOString() }),
		"invalid_input",
	);
	// A reason over 5000 characters is refused.
	refused(
		await correct("assessment", p.id, a.id, a.revision, { committed: lens(5) }, 0, key(), { reason: "x".repeat(5001) }),
		"invalid_input",
	);
	assert.equal(ok(await corrections(p.id)).total, 0);

	const requestKey = key();
	const changed = ok(
		await correct(
			"assessment",
			p.id,
			a.id,
			a.revision,
			{ committed: { score: 5, notes: "Corrected note" } },
			0,
			requestKey,
		),
	);
	assert.deepEqual([changed.outcome, changed.revision], ["changed", "2"]);
	assert.deepEqual(
		ok(
			await correct(
				"assessment",
				p.id,
				a.id,
				a.revision,
				{ committed: { score: 5, notes: "Corrected note" } },
				0,
				requestKey,
			),
		),
		changed,
	);
	// Correcting to the values it already holds changes nothing more.
	assert.equal(
		ok(await correct("assessment", p.id, a.id, "2", { committed: { score: 5, notes: "Corrected note" } })).outcome,
		"noop",
	);
	const read = ok(await tx((t) => assessments.getAssessments(t, ctx(), { personId: p.id }))).latest;
	assert.deepEqual(
		[read.total, read.revision, read.actor, read.recordedAt],
		[14, "2", { kind: "current_account", accountId: actors[3].id }, a.recordedAt],
	);

	// An interview result correction never replays or demotes the stage.
	const i = ok(
		await tx((t) =>
			interviews.createInterview(t, ctx(), {
				requestKey: key(),
				input: { personId: p.id, occurredOn: day(5), ...criteria("pass"), result: "qualified", nextSteps: null },
			}),
		),
	).interview;
	// The reason is optional: an omitted one is saved as no reason.
	ok(await correct("interview", p.id, i.id, i.revision, { result: "not_qualified", occurredOn: day(7) }, 0, key(), {}));
	refused(await correct("interview", p.id, i.id, "2", { occurredOn: day(-1) }), "invalid_input");
	assert.equal((await personRow(p.id)).stage, "leader");

	// A card's date correction (CA013) and a note correction show in the same history.
	const card = ok(
		await tx((t) =>
			commitments.createCommitment(t, ctx(), {
				requestKey: key(),
				input: { personId: p.id, kind: "core_group", occurredOn: day(20), notes: "Signed at lunch" },
			}),
		),
	).commitment;
	ok(
		await tx((t) =>
			commitments.correctCommitmentLifecycle(t, ctx(3), {
				requestKey: key(),
				expectedRevision: card.revision,
				input: {
					commitmentId: card.id,
					correction: { action: "correct", occurredOn: day(40) },
					reason: "Correct source date",
				},
			}),
		),
	);
	// A blank reason is saved as no reason too.
	ok(await correct("commitment", p.id, card.id, "2", { notes: "Signed at the picnic" }, 0, key(), { reason: " \n " }));
	const history = ok(await corrections(p.id));
	assert.deepEqual(
		history.items.map((x) => [x.recordType, x.recordId, x.changes, x.actor.accountId]),
		[
			["commitment", card.id, [{ field: "notes", old: "Signed at lunch", new: "Signed at the picnic" }], actors[0].id],
			["commitment", card.id, [{ field: "occurredOn", old: day(20), new: day(40) }], actors[3].id],
			[
				"interview",
				i.id,
				[
					{ field: "occurredOn", old: day(5), new: day(7) },
					{ field: "result", old: "qualified", new: "not_qualified" },
				],
				actors[0].id,
			],
			[
				"assessment",
				a.id,
				[
					{
						field: "committed",
						old: { score: 3, notes: "Private lens 3" },
						new: { score: 5, notes: "Corrected note" },
					},
				],
				actors[0].id,
			],
		],
	);
	assert.deepEqual(
		history.items.map((x) => x.reason),
		[null, "Correct source date", null, "Entered from the wrong form"],
	);
	refused(await corrections(p.id, 1));
	// The application role may move a correction to another Person on merge, never rewrite what it recorded.
	await assert.rejects(
		db.execute(
			sql`UPDATE record_correction SET reason='Rewritten',after_value='{}' WHERE person_id=${sql.param(p.id)}`,
		),
		(error) => /permission denied for table record_correction/.test(error.cause?.message),
	);
	// Platform audit names each corrected record and holds no value, note or reason (audit.md).
	const audit = JSON.stringify(
		(await audits([p.id])).filter((r) => r.metadata.event !== "commitment_corrected" || r.reason === null),
	);
	assert.ok(!audit.match(/Corrected note|not_qualified|Signed at|wrong form|"score"/), audit);
	const feed = ok(await tx((t) => peopleReader.getActivities(t, ctx(), { personId: p.id, limit: 100 }))).items;
	assert.deepEqual(
		feed.filter((x) => /_corrected$/.test(x.action ?? "")).map((x) => [x.action, x.recordId]),
		[
			["commitment_corrected", card.id],
			["commitment_corrected", card.id],
			["interview_corrected", i.id],
			["assessment_corrected", a.id],
		],
	);
	// A cleared note is sent as null: it stores no note, and the history records the old value going to null.
	ok(await correct("assessment", p.id, a.id, "2", { committed: { score: 5, notes: null } }));
	ok(await correct("interview", p.id, i.id, "2", { nextSteps: "Call on Tuesday" }));
	ok(await correct("interview", p.id, i.id, "3", { nextSteps: null }));
	ok(await correct("commitment", p.id, card.id, "3", { notes: null }));
	const cleared = await tx(async (t) => [
		ok(await assessments.getAssessments(t, ctx(), { personId: p.id })).latest.committed,
		ok(await interviews.getInterviews(t, ctx(), { personId: p.id })).latest.nextSteps,
		ok(await commitments.getCommitments(t, ctx(), { personId: p.id })).items.find((x) => x.id === card.id).notes,
	]);
	assert.deepEqual(cleared, [{ score: 5, notes: null }, null, null]);
	assert.deepEqual(
		ok(await corrections(p.id))
			.items.slice(0, 4)
			.map((x) => [x.recordId, x.changes]),
		[
			[card.id, [{ field: "notes", old: "Signed at the picnic", new: null }]],
			[i.id, [{ field: "nextSteps", old: "Call on Tuesday", new: null }]],
			[i.id, [{ field: "nextSteps", old: null, new: "Call on Tuesday" }]],
			[a.id, [{ field: "committed", old: { score: 5, notes: "Corrected note" }, new: { score: 5, notes: null } }]],
		],
	);
});

test("AC:ADR1-017 organization duplicates are hints for a human, and an organization merge and Unmerge follow the same rules", async () => {
	const org = randomUUID(),
		other = randomUUID(),
		staff = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	for (const id of [org, other])
		await admin.execute(
			sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${sql.param(id)},'sending_church','Synthetic','America/Chicago',1)`,
		);
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(staff.user)},${sql.param(staff.id + "@example.test")},true,'Synthetic')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(staff.id)},${sql.param(staff.user)},'active','planter')`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(staff.session)},${sql.param(staff.user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${sql.param(staff.id)},${sql.param(org)},'admin',clock_timestamp())`,
	);
	const octx = {
		session: staff.session,
		selected: { kind: "organization", id: org, organizationKind: "sending_church" },
	};
	// An organization Member with no pipeline duty for these people (F4).
	const member = { id: randomUUID(), user: randomUUID(), session: randomUUID() };
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(member.user)},${sql.param(member.id + "@example.test")},true,'Synthetic')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(member.id)},${sql.param(member.user)},'active','planter')`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(member.session)},${sql.param(member.user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${sql.param(member.id)},${sql.param(org)},'member',clock_timestamp())`,
	);
	const mctx = { ...octx, session: member.session };
	const orgPerson = async (name, email, owner = org) => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,organization_id,display_name,email,source,state,created_at,revision)
 VALUES(${sql.param(id)},${sql.param(owner)},${sql.param(owner)},${name},${email},'other','live',clock_timestamp(),1)`);
		return id;
	};
	const p = await orgPerson("Casey Lee", "casey@example.test"),
		q = await orgPerson("Casey L.", "Casey@Example.test"),
		foreign = await orgPerson("Casey Lee", "casey@example.test", other);
	await admin.execute(sql`UPDATE person SET linked_account_id=${sql.param(actors[1].id)} WHERE id=${sql.param(p)}`);
	const found = ok(await tx((t) => peopleMerge.findDuplicates(t, octx, { personId: p })));
	assert.deepEqual(
		found.items.map((h) => [h.personId, h.match, h.signals]),
		[[q, "exact", ["email"]]],
	);
	assert.deepEqual([(await personRow(p)).state, (await personRow(q)).state], ["live", "live"]);
	// Another organization's identity cannot be reviewed or merged.
	refused(await tx((t) => peopleMerge.getMergeReview(t, octx, { sourceId: foreign, survivorId: p })));
	// Plant-only facts are not organization merge fields.
	const r = ok(await tx((t) => peopleMerge.getMergeReview(t, octx, { sourceId: q, survivorId: p })));
	assert.deepEqual([r.stage, r.commitment, r.fields.map((f) => f.field)], [null, null, ["displayName", "email"]]);
	refused(
		await tx((t) =>
			peopleMerge.mergePeople(t, octx, {
				requestKey: key(),
				input: { sourceId: q, survivorId: p, reviewDigest: r.reviewDigest, fieldChoices: { household: "source" } },
			}),
		),
		"invalid_input",
	);
	const merged = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, octx, {
				requestKey: key(),
				input: { sourceId: q, survivorId: p, reviewDigest: r.reviewDigest, fieldChoices: { displayName: "survivor" } },
			}),
		),
	);
	assert.deepEqual(
		[
			(await personRow(q)).state,
			(await personRow(q)).merged_into_person_id,
			(await one(sql`SELECT linked_account_id FROM person WHERE id=${sql.param(p)}`)).linked_account_id,
		],
		["merged", p, actors[1].id],
	);
	// The Owner or Admin follows the merged Person; the Member sees no identity or state, as getPerson refuses it too.
	assert.equal(ok(await tx((t) => peopleMerge.mergedPersonDestination(t, octx, { personId: q }))).destinationId, p);
	refused(await tx((t) => peopleMerge.mergedPersonDestination(t, mctx, { personId: q })));
	refused(await tx((t) => peopleReader.getPerson(t, mctx, { personId: p })));
	const preview = ok(await tx((t) => peopleUnmerge.previewUnmerge(t, octx, { mergeId: merged.mergeId })));
	const back = ok(
		await tx((t) =>
			peopleUnmerge.unmergePeople(t, octx, {
				requestKey: key(),
				expectedRevision: preview.reviewRevision,
				input: { mergeId: merged.mergeId },
			}),
		),
	);
	assert.deepEqual([back.outcome, (await personRow(q)).state], ["changed", "live"]);
	assert.deepEqual(
		(await rows(sql`SELECT action FROM audit_event WHERE subject_id=${sql.param(p)} ORDER BY occurred_at`)).map(
			(x) => x.action,
		),
		["people.merged", "people.unmerged"],
	);
});

test("AC:REQ-PPL-024 the reference registry names every Person foreign key in the database exactly once", async () => {
	const declared = await rows(sql`SELECT c.conrelid::regclass::text AS t,a.attname AS col FROM pg_constraint c
 JOIN LATERAL unnest(c.conkey) WITH ORDINALITY k(n,i) ON k.i=1 JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n
 WHERE c.contype='f' AND c.confrelid=${schema + ".person"}::regclass ORDER BY 1,2`);
	assert.deepEqual(
		registry.map((e) => `${e.table}.${e.column}`).sort(),
		declared.map((d) => `${d.t.replace(schema + ".", "")}.${d.col}`).sort(),
	);
});

// WP-039 slice 2: a candidate attestation follows its Person through merge, Unmerge, retirement and conflict.
const signals = createSignals();
const authority = (who = 3) => tx((t) => RequestActor.resolve(t, actors[who].session));
async function attestCandidate(personId, who = 3) {
	return ok(
		await signals.attestCandidate(db, await authority(who), {
			requestKey: key(),
			expectedRevision: "0",
			input: { personId, periodStart: day(70), periodEnd: day(1), attended: true, volunteered: true },
		}),
	).candidate;
}
const candidates = async (who = 3) => ok(await signals.readAttestations(db, await authority(who), {})).candidates;
const attestationOf = (personId) =>
	one(
		sql`SELECT id,person_id,state,revision::text FROM attestation WHERE person_id=${sql.param(personId)} AND key='leadership_candidate'`,
	);
const attestationRows = (personId) =>
	rows(
		sql`SELECT revision::text, kind FROM attestation_revision WHERE person_id=${sql.param(personId)} ORDER BY revision`,
	);
const mergeReceipts = async (sourceId) =>
	(await one(sql`SELECT count(*)::int n FROM person_merge WHERE source_id=${sql.param(sourceId)}`)).n;

test("AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-MERGE AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-UNMERGE merge moves the candidate attestation to the survivor, keeps the source's history and Unmerge returns it", async () => {
	const p1 = await person("Alex Rivera"),
		p2 = await person("Alex Chen");
	const made = await attestCandidate(p2.id);
	const before = await attestationOf(p2.id);
	assert.equal(made.personName, "Alex Chen");
	const reviewed = ok(await review(p2.id, p1.id));
	assert.deepEqual(
		reviewed.references.filter((x) => x.kind === "attestation"),
		[{ kind: "attestation", count: 1, treatment: "move" }],
	);
	assert.deepEqual(reviewed.blockers, { causes: [], references: [] });
	const requestKey = key();
	const merged = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey,
				input: { sourceId: p2.id, survivorId: p1.id, reviewDigest: reviewed.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	const moved = await attestationOf(p1.id);
	assert.equal(moved.id, before.id, "the same current attestation");
	assert.equal(await attestationOf(p2.id), undefined);
	assert.deepEqual(
		(await candidates()).map((x) => [x.personId, x.personName, x.established]),
		[[p1.id, "Alex Rivera", true]],
	);
	// P2's history stays on P2, and one receipt exists.
	assert.deepEqual(await attestationRows(p2.id), [{ revision: "1", kind: "answered" }]);
	assert.equal(await mergeReceipts(p2.id), 1);
	// A repeat with the same request key writes nothing again.
	const auditsBefore = (await one(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${sql.param(p1.id)}`)).n;
	const again = await tx((t) =>
		peopleMerge.mergePeople(t, ctx(), {
			requestKey,
			input: { sourceId: p2.id, survivorId: p1.id, reviewDigest: reviewed.reviewDigest, fieldChoices: {} },
		}),
	);
	assert.equal(ok(again).mergeId, merged.mergeId);
	assert.equal(await mergeReceipts(p2.id), 1);
	assert.equal((await attestationOf(p1.id)).revision, moved.revision);
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${sql.param(p1.id)}`)).n,
		auditsBefore,
	);
	// Unmerge returns the attestation to P2.
	ok(await unmerge(merged.mergeId));
	const home = await attestationOf(p2.id);
	assert.equal(home.id, before.id);
	assert.equal(await attestationOf(p1.id), undefined);
	assert.deepEqual(
		(await candidates()).map((x) => [x.personId, x.established]),
		[[p2.id, true]],
	);
	assert.deepEqual(await attestationRows(p2.id), [{ revision: "1", kind: "answered" }]);
	// A repeat Unmerge is a no-op.
	assert.equal(ok(await unmerge(merged.mergeId)).outcome, "noop");
	assert.equal((await attestationOf(p2.id)).revision, home.revision);
});

test("AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-RETIRE retiring a Person keeps its candidate row, marked retired, and its history", async () => {
	const p3 = await person("Riley Stone");
	await attestCandidate(p3.id);
	assert.equal(
		(await candidates()).some((x) => x.personId === p3.id),
		true,
	);
	const current = await personRow(p3.id);
	const reviewRevision = ok(
		await tx((t) => peopleReader.getStatusWarnings(t, ctx(), { personId: p3.id })),
	).reviewRevision;
	ok(
		await tx((t) =>
			people.retirePerson(
				t,
				ctx(),
				{
					requestKey: key(),
					expectedRevision: current.revision,
					input: { personId: p3.id, reason: "Moved away", reviewRevision, handoffs: [] },
				},
				async () => {
					throw Error("unexpected task reminder replan");
				},
			),
		),
	);
	assert.equal((await personRow(p3.id)).state, "retired");
	assert.deepEqual(
		(await candidates()).filter((x) => x.personId === p3.id).map((x) => [x.personName, x.personState, x.state]),
		[["Riley Stone", "retired", "answered"]],
	);
	const page = ok(await signals.readAttestations(db, await authority(), {}));
	assert.equal(page.history.filter((x) => x.personId === p3.id).length, 1);
	assert.equal(
		page.people.some((x) => x.id === p3.id),
		false,
	);
	assert.equal((await attestationOf(p3.id)).state, "answered");
	// A retired Person cannot get a new attestation.
	refused(
		await signals.attestCandidate(db, await authority(), {
			requestKey: key(),
			expectedRevision: "1",
			input: { personId: p3.id, periodStart: day(70), periodEnd: day(1), attended: true, volunteered: true },
		}),
		"not_found",
	);
});

test("AC:PERSONREF-CANDIDATE-PERSON-ATTESTATION-CONFLICT a stale reviewed reference state changes no reference; a survivor that already holds one keeps it and the source's stays as history", async () => {
	const p1 = await person("Jordan Kim"),
		p2 = await person("Jordan Kimball");
	const made = await attestCandidate(p2.id);
	// The review names attestation revision 1. A correction afterwards makes it stale.
	const stale = ok(await review(p2.id, p1.id));
	ok(
		await signals.correctCandidate(db, await authority(), {
			requestKey: key(),
			expectedRevision: made.revision,
			input: {
				action: "correct",
				personId: p2.id,
				periodStart: day(70),
				periodEnd: day(1),
				attended: true,
				volunteered: false,
			},
		}),
	);
	const beforeStale = await attestationOf(p2.id);
	refused(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: p2.id, survivorId: p1.id, reviewDigest: stale.reviewDigest, fieldChoices: {} },
			}),
		),
		"conflict",
	);
	assert.deepEqual(await attestationOf(p2.id), beforeStale);
	assert.equal(await attestationOf(p1.id), undefined);
	assert.equal((await personRow(p2.id)).state, "live");
	// A foreign survivor is unavailable and changes nothing.
	const foreign = ok(
		await tx((t) =>
			people.createPerson(t, ctx(2), {
				requestKey: key(),
				input: { displayName: "Foreign canary", adultClassification: "adult" },
			}),
		),
	).person;
	refused(await review(p2.id, foreign.id));
	// P1 already holds a current attestation: P1's stays current and P2's stays on P2.
	await attestCandidate(p1.id);
	const p1Before = await attestationOf(p1.id);
	const reviewed = ok(await review(p2.id, p1.id));
	assert.deepEqual(
		reviewed.references.filter((x) => x.kind === "attestation"),
		[{ kind: "attestation", count: 1, treatment: "deduplicate" }],
	);
	const merged = ok(
		await tx((t) =>
			peopleMerge.mergePeople(t, ctx(), {
				requestKey: key(),
				input: { sourceId: p2.id, survivorId: p1.id, reviewDigest: reviewed.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	assert.deepEqual(await attestationOf(p1.id), p1Before);
	assert.equal((await attestationOf(p2.id)).state, "answered", "kept on P2 as history");
	assert.deepEqual(
		(await candidates()).map((x) => x.personId).filter((id) => [p1.id, p2.id].includes(id)),
		[p1.id],
	);
	// Unmerge restores P2's, and P1's is unchanged.
	ok(await unmerge(merged.mergeId));
	assert.deepEqual(await attestationOf(p1.id), p1Before);
	assert.equal((await attestationOf(p2.id)).state, "answered");
	assert.deepEqual(
		(await candidates())
			.map((x) => x.personId)
			.filter((id) => [p1.id, p2.id].includes(id))
			.sort(),
		[p1.id, p2.id].sort(),
	);
});
