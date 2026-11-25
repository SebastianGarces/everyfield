import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { listPeopleRequest } from "../../../packages/contracts/src/people/index.ts";
import { runDueImports } from "../../../apps/web/src/features/people/import-export/run-imports.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { PeopleReadContext, peopleCsv, peopleReader } from "../../../packages/domain/src/people/index.ts";
import { claimDue, recoverLease } from "../../../packages/domain/src/jobs/queue.ts";
import { approveProposal, executeProposal, retryUnresolvedEffects } from "../../../packages/evry/src/index.ts";
import { ok } from "../../support/fixture.mts";
import { pdf } from "../../integration/platform/fixtures.mjs";
import { png } from "./bucket.mts";
import { caseWorld, NOW, propose, read, rowsOf, sql, type CaseWorld, type Reply } from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familypeople");
});
after(() => w?.close());

const NOTE = "Prefers evenings ✓ “tel. soir” 夜";
test("AC:EVRY-FAMILY-PEOPLE-HOUSEHOLDS-NOTES each household, tag, skill and note change touches only what was named, and only a note's author may change it", async () => {
	const c = await w.church();
	const B = await w.seated(c.P, "admin", { user: { name: "Second Admin" } });
	const [alex, casey] = [c.rivera, c.casey];
	const jamie = await c.person("Jamie Outside");
	await w.admin.execute(
		sql`UPDATE person SET street='200 Main St',city='Chicago' WHERE id IN(${alex},${casey},${jamie})`,
	);
	const person = (id: string) =>
		w.one(sql`SELECT p.street,p.city,p.household_id,p.household_role,p.stage,
			(SELECT coalesce(array_agg(t.name ORDER BY t.name),'{}') FROM person_tag pt JOIN tag t ON t.id=pt.tag_id WHERE pt.person_id=p.id) AS tags,
			(SELECT coalesce(array_agg(s.name||' '||s.category||' '||s.proficiency ORDER BY s.name),'{}') FROM person_skill s WHERE s.person_id=p.id) AS skills,
			(SELECT count(*)::int FROM person_note n WHERE n.person_id=p.id) AS notes FROM person p WHERE p.id=${id}`);
	const jamieBefore = await person(jamie);
	const homes = async (...ids: string[]) =>
		(await Promise.all(ids.map(person))).map((p) => [p.street, p.household_id, p.household_role]);

	await w.apply(c.A, "people.createHouseholdWithHead", { headPersonId: alex, name: "Rivera household" });
	const H = String((await person(alex)).household_id);
	await w.apply(c.A, "people.addToHousehold", { householdId: H, personId: casey, role: "spouse" });
	await w.apply(c.A, "people.updateHousehold", {
		householdId: H,
		patch: { name: "Rivera Reed household", street: "100 Main St", city: "Chicago" },
	});
	assert.deepEqual(
		await homes(alex, casey),
		[
			["200 Main St", H, "head"],
			["200 Main St", H, "spouse"],
		],
		"the household's own address moves nobody",
	);
	await w.apply(c.A, "people.setHouseholdRole", { personId: casey, role: "other" });
	const household = (await w.look(c.A, "people.getHousehold", { householdId: H })).rows;
	assert.deepEqual(
		household.filter((r: { kind: string }) => r.kind === "household").map((r: { label: string }) => r.label),
		["Rivera Reed household"],
	);
	const members = await w.look(c.A, "people.getHouseholdMembers", { householdId: H });
	assert.deepEqual(
		rowsOf(members, "person")
			.map((r) => r.id)
			.sort(),
		[alex, casey].sort(),
		"Jamie is not in it",
	);
	assert.equal((await w.look(c.A, "people.listHouseholds", {})).total, 1);
	await w.apply(c.A, "people.propagateAddress", { householdId: H });
	assert.deepEqual(await homes(alex, casey), [
		["100 Main St", H, "head"],
		["100 Main St", H, "other"],
	]);
	await w.apply(c.A, "people.removeFromHousehold", { personId: casey });
	assert.deepEqual(
		await homes(alex, casey),
		[
			["100 Main St", H, "head"],
			["100 Main St", null, null],
		],
		"leaving keeps the address and the other member",
	);
	await w.apply(c.A, "people.createHouseholdWithHead", { headPersonId: casey, name: "Empty soon" });
	const spare = String((await person(casey)).household_id);
	await w.apply(c.A, "people.removeFromHousehold", { personId: casey });
	await w.apply(c.A, "people.deleteHousehold", { householdId: spare });
	assert.deepEqual(await w.rows(sql`SELECT id FROM household WHERE plant_id=${c.P.id}`), [{ id: H }]);

	for (const name of ["northside", "family"]) await w.apply(c.A, "people.createTag", { name });
	const tag = async (name: string) =>
		String((await w.one(sql`SELECT id FROM tag WHERE plant_id=${c.P.id} AND normalized_name=${name}`)).id);
	const [northside, family] = [await tag("northside"), await tag("family")];
	await w.apply(c.A, "people.assignTag", { personIds: [alex, casey], tagId: northside });
	await w.apply(c.A, "people.assignTag", { personIds: [alex], tagId: family });
	await w.apply(c.A, "people.removeTag", { personIds: [alex], tagId: northside });
	assert.deepEqual([(await person(alex)).tags, (await person(casey)).tags], [["family"], ["northside"]]);
	await w.apply(c.A, "people.updateTag", { tagId: northside, name: "North side" });
	const listed = await w.look(c.A, "people.listTags", {});
	assert.deepEqual(
		rowsOf(listed)
			.map((r) => r.label)
			.sort(),
		["North side", "family"],
	);
	assert.deepEqual(
		rowsOf(await w.look(c.A, "people.getPersonTags", { personId: alex })).map((r) => r.label),
		["family"],
	);
	await w.apply(c.A, "people.deleteTag", { tagId: northside });
	assert.deepEqual([(await person(alex)).tags, (await person(casey)).tags], [["family"], []]);

	await w.apply(c.A, "people.addSkill", {
		personId: alex,
		name: "Greeting",
		category: "hospitality",
		proficiency: "beginner",
	});
	await w.apply(c.A, "people.addSkill", {
		personId: alex,
		name: "Music",
		category: "worship",
		proficiency: "advanced",
	});
	const skill = async (name: string) =>
		String((await w.one(sql`SELECT id FROM person_skill WHERE person_id=${alex} AND name=${name}`)).id);
	await w.apply(c.A, "people.updateSkill", {
		skillId: await skill("Greeting"),
		patch: { proficiency: "intermediate" },
	});
	assert.deepEqual((await person(alex)).skills, ["Greeting hospitality intermediate", "Music worship advanced"]);
	const skills = rowsOf(await w.look(c.A, "people.getPersonSkills", { personId: alex }));
	assert.deepEqual(skills.map((r) => r.label).sort(), ["Greeting", "Music"]);
	await w.apply(c.A, "people.removeSkill", { skillId: await skill("Greeting") });
	assert.deepEqual((await person(alex)).skills, ["Music worship advanced"]);

	await w.apply(c.A, "people.addNote", { personId: alex, body: NOTE });
	const note = () =>
		w.one(sql`SELECT id,body,author_id,removed_at IS NULL AS live FROM person_note WHERE person_id=${alex}`);
	const N = String((await note()).id);
	assert.deepEqual(await note(), { id: N, body: NOTE, author_id: c.A.id, live: true });
	for (const [operation, input] of [
		["people.editNote", { noteId: N, body: "Changed by B", reason: "x" }],
		["people.deleteNote", { noteId: N, reason: "x" }],
	] as const) {
		const card = await w.prepare(B, operation, input);
		assert.equal(card.review.refusal, "Only the person who wrote this note can change it.");
		await assert.rejects(w.approve(B, card), { code: "review_closed" });
	}
	assert.equal((await note()).body, NOTE, "another Admin neither edits nor deletes it");
	await w.apply(c.A, "people.editNote", { noteId: N, body: `${NOTE} (second)`, reason: "Added a word" });
	assert.deepEqual(await note(), { id: N, body: `${NOTE} (second)`, author_id: c.A.id, live: true });

	await w.admin
		.execute(sql`INSERT INTO interview(plant_id,person_id,interviewed_on,recorded_at,maturity,gifted,chemistry,right_reasons,season,maturity_notes,result)
		VALUES(${c.P.id},${alex},'2026-10-01',clock_timestamp(),'pass','pass','pass','pass','pass','INTAKE-CANARY','qualified')`);
	const first = await w.look(c.A, "people.getActivities", { personId: alex, limit: 1 });
	assert.deepEqual([rowsOf(first).length, first.completeness], [1, "partial"]);
	const all = await w.look(c.A, "people.getActivities", { personId: alex });
	assert.doesNotMatch(JSON.stringify(all), /INTAKE-CANARY|interview|CARE-CANARY/i);
	for (const smuggled of [{ types: ["interview"] }, { kinds: ["private_care"] }, { include: "commitment" }]) {
		const asked = await w.ask(c.A, "Show the interview in the activity", [
			() => read("people.getActivities", { personId: alex, ...smuggled }),
		]);
		assert.deepEqual([asked.replies[0].error, asked.cards], ["not_offered", []], JSON.stringify(smuggled));
	}
	assert.doesNotMatch(
		JSON.stringify((await w.look(c.A, "people.getActivities", { personId: alex, limit: 100 })).rows),
		/INTAKE-CANARY/,
	);
	await w.apply(c.A, "people.deleteNote", { noteId: N, reason: "Duplicate" });
	assert.equal((await note()).live, false);
	assert.deepEqual(await person(jamie), jamieBefore, "Jamie was never named");

	const said = "Tidy the Rivera household, tags, skills and notes";
	const stay = await w.prepare(c.A, "people.addToHousehold", { householdId: H, personId: casey, role: "spouse" });
	await c.foreignReview(stay);
	await c.foreign(
		said,
		[
			() => [read("people.getHousehold", { householdId: H }), read("people.getPersonSkills", { personId: alex })],
			() => [read("people.getPersonTags", { personId: alex }), read("people.getActivities", { personId: alex })],
			() => propose("people.addToHousehold", { householdId: H, personId: casey, role: "spouse" }),
			() => propose("people.editNote", { noteId: N, body: "x", reason: "x" }),
		],
		{ secrets: ["Rivera Reed", "100 Main St", NOTE, "Music"], on: { onError: "go_on" } },
	);
	await c.failedWrite(stay, "person");
	assert.deepEqual((await homes(casey))[0]!.slice(1), [H, "spouse"]);
});

const RATING = { rating: "pass" } as const;
const INTERVIEW = {
	occurredOn: "2026-10-11",
	maturity: { rating: "pass", notes: "INTAKE-CANARY steady" },
	gifted: RATING,
	chemistry: { rating: "concern" },
	rightReasons: RATING,
	season: RATING,
	result: "qualified_with_notes",
	nextSteps: "Coffee with Alex in November",
};
const LENSES = { committed: { score: 4 }, compelled: { score: 3 }, contagious: { score: 5 }, courageous: { score: 2 } };
test("AC:EVRY-FAMILY-PEOPLE-RECORDS two assessments, one interview and one genuine commitment keep their own dates, revisions and document, and a withdrawal and rejoin acquire nobody anew", async () => {
	await w.at(NOW);
	const c = await w.church();
	const member = await w.seated(c.P, "member");
	const alex = c.rivera;
	const stage = async (id: string) => (await w.one(sql`SELECT stage FROM person WHERE id=${id}`)).stage;
	const cohort = async () => {
		const { facts } = await w.look(c.A, "intelligence.readCommittedAdultCohort", {});
		return [facts.known, facts.exact];
	};
	const bound = (file: string) =>
		w.rows(
			sql`SELECT k.signed_on::text AS signed_on,f.purpose,f.state FROM commitment k JOIN file_object f ON f.id=k.object_id WHERE f.id=${file}`,
		);
	const commitment = async () => {
		const reply = await w.look(c.A, "people.getCommitments", { personId: alex });
		const [status] = rowsOf(reply).filter((r) => r.fields.record === "commitment_status");
		const cards = rowsOf(reply).filter((r) => r.fields.record === "commitment");
		return { ...status.fields, cards: cards.map((r) => r.fields.occurredOn) };
	};

	for (const [occurredOn, committed] of [
		["2026-10-01", 4],
		["2026-10-10", 5],
	] as const)
		await w.apply(c.A, "people.createAssessment", {
			personId: alex,
			occurredOn,
			...LENSES,
			committed: { score: committed, notes: "As told" },
		});
	const assessments = rowsOf(await w.look(c.A, "people.getAssessments", { personId: alex }));
	assert.deepEqual(
		assessments.map((r) => [r.fields.occurredOn, r.fields.committed, r.fields.committedNotes, r.fields.compelled]),
		[
			["2026-10-10", "5", "As told", "3"],
			["2026-10-01", "4", "As told", "3"],
		],
		"two assessments, the latest first",
	);

	await w.apply(c.A, "people.createInterview", { personId: alex, ...INTERVIEW });
	const [interview] = rowsOf(await w.look(c.A, "people.getInterviews", { personId: alex }));
	assert.deepEqual(
		{ ...interview.fields, personId: null },
		{
			record: "interview",
			personId: null,
			occurredOn: "2026-10-11",
			maturity: "pass",
			maturityNotes: "INTAKE-CANARY steady",
			gifted: "pass",
			giftedNotes: null,
			chemistry: "concern",
			chemistryNotes: null,
			rightReasons: "pass",
			rightReasonsNotes: null,
			season: "pass",
			seasonNotes: null,
			result: "qualified_with_notes",
			nextSteps: "Coffee with Alex in November",
		},
	);
	assert.deepEqual(
		await w.one(
			sql`SELECT interviewed_on::text AS on,to_char(date_trunc('minute',recorded_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS recorded FROM interview WHERE id=${interview.id}`,
		),
		{ on: "2026-10-11", recorded: NOW },
		"the day it happened and the day it was entered stay apart",
	);
	await w.apply(c.A, "people.correctPersonRecord", {
		recordType: "interview",
		recordId: interview.id,
		changes: { chemistry: { rating: "pass", notes: "Met the team" } },
		reason: "Second look",
	});
	const corrections = rowsOf(await w.look(c.A, "people.listRecordCorrections", { personId: alex }));
	assert.equal(corrections.length, 1);
	assert.match(JSON.stringify(corrections), /Second look/);
	assert.match(JSON.stringify(corrections), /concern/, "the earlier rating is kept");
	assert.deepEqual(
		rowsOf(await w.look(c.A, "people.getInterviews", { personId: alex })).map((r) => [
			r.fields.chemistry,
			r.fields.occurredOn,
		]),
		[["pass", "2026-10-11"]],
	);

	const conversation = await w.converse(c.Aa);
	const file = await c.attach(c.A, conversation, "card.pdf", Buffer.from(pdf()));
	const on = { conversation, storage: w.files.storage, attachments: [{ id: file.id, name: file.name }] };
	const signed = await w.prepare(
		c.A,
		"people.createCommitment",
		{ personId: alex, kind: "core_group", occurredOn: "2026-10-08", attachmentId: file.id },
		on,
	);
	await approveProposal(w.db, c.Aa, signed.id, w.witness(signed), null);
	const [claim] = await claimDue(w.db, ["evry_effect"], 1, 60);
	const lease = {
		jobId: claim!.id,
		tenantId: claim!.tenant_id,
		leaseOwner: claim!.lease_owner,
		generation: claim!.claim_generation,
	};
	const run = () =>
		executeProposal(w.db, lease, { reminders: async () => undefined as never, phaseNotices: async () => undefined });
	assert.equal(await run(), "completed");
	const once = await bound(file.id);
	assert.deepEqual(once, [{ signed_on: "2026-10-08", purpose: "commitment", state: "ready" }]);
	await run().catch(() => undefined);
	await w.admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${claim!.id}`);
	await recoverLease(w.admin);
	const replay = await approveProposal(w.db, c.Aa, signed.id, w.witness(signed), null);
	assert.deepEqual([replay.replayed, replay.proposal.outcome], [true, "completed"]);
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, signed.id)).retried, false);
	assert.deepEqual([await w.effect(), await bound(file.id)], [null, once], "a lost response adds no record or bind");
	const reused = await w.prepare(
		c.A,
		"people.createCommitment",
		{ personId: c.casey, kind: "core_group", occurredOn: "2026-10-08", attachmentId: file.id },
		{ ...on, attachments: [] },
	);
	assert.match(String(reused.review.refusal), /already the signed document of another commitment card/);

	const first = await commitment();
	assert.deepEqual(first, {
		record: "commitment_status",
		state: "active",
		effectiveOn: "2026-10-08",
		firstSignedOn: "2026-10-08",
		cards: ["2026-10-08"],
	});
	assert.deepEqual(await cohort(), [1, 1]);
	await w.apply(c.A, "people.withdrawCommitment", { personId: alex, effectiveOn: "2026-10-10", reason: "Moved" });
	assert.deepEqual(await commitment(), { ...first, state: "withdrawn", effectiveOn: "2026-10-10" });
	assert.deepEqual(await cohort(), [0, 0], "no longer eligible now");
	await w.apply(c.A, "people.reactivateCommitment", { personId: alex, effectiveOn: "2026-10-12" });
	assert.deepEqual(await commitment(), { ...first, effectiveOn: "2026-10-12" }, "rejoining acquires nobody anew");
	assert.deepEqual(await cohort(), [1, 1]);
	assert.deepEqual(
		await w.one(
			sql`SELECT count(*)::int AS cards,min(signed_on)::text AS first FROM commitment WHERE person_id=${alex} AND voided_at IS NULL`,
		),
		{ cards: 1, first: "2026-10-08" },
	);

	assert.equal(await stage(c.casey), "leader");
	await w.apply(c.A, "people.createAssessment", { personId: c.casey, occurredOn: "2026-10-12", ...LENSES });
	await w.apply(c.A, "people.createInterview", { personId: c.casey, ...INTERVIEW, result: "not_qualified" });
	await w.apply(c.A, "people.createCommitment", { personId: c.casey, kind: "launch_team", occurredOn: "2026-10-12" });
	const card = String((await w.one(sql`SELECT id FROM commitment WHERE person_id=${c.casey}`)).id);
	await w.apply(c.A, "people.correctCommitmentLifecycle", {
		commitmentId: card,
		correction: { action: "correct", occurredOn: "2026-10-11" },
		reason: "Wrong day",
	});
	assert.deepEqual(
		await w.rows(sql`SELECT signed_on::text AS on,revision::text AS revision FROM commitment WHERE id=${card}`),
		[{ on: "2026-10-11", revision: "2" }],
	);
	assert.equal(await stage(c.casey), "leader", "no later record demotes a Leader");

	const own = String((await w.one(sql`SELECT id FROM commitment WHERE person_id=${alex}`)).id);
	const download = await w.look(c.A, "people.getCommitmentDownload", { commitmentId: own });
	assert.ok(JSON.stringify(download).includes(`/people/${alex}/commitments/${own}/document`));
	assert.equal(JSON.stringify(download).includes(file.key), false, "no storage key");
	const refusedMember = await w.ask(member, "Show the interview", [
		() => [
			read("people.getInterviews", { personId: alex }),
			read("people.getCommitmentDownload", { commitmentId: own }),
			propose("people.withdrawCommitment", { personId: alex, effectiveOn: "2026-10-13" }),
		],
	]);
	assert.deepEqual(
		[refusedMember.replies.map((r) => r.error), refusedMember.cards, refusedMember.proposals],
		[["not_offered", "not_offered", "not_offered"], [], []],
	);

	await w.care(c.A);
	const asked = await w.ask(c.A, "Tell me everything recorded about Alex", [
		() => [
			read("people.getAssessments", { personId: alex }),
			read("people.getInterviews", { personId: alex }),
			read("people.getCommitments", { personId: alex }),
			read("people.listRecordCorrections", { personId: alex }),
		],
	]);
	assert.equal(asked.cards.length, 4);
	assert.doesNotMatch(JSON.stringify([asked.prompts, asked.saved]), /CARE-CANARY|struggling/);

	const said = "Withdraw Alex's commitment and show the interview";
	const later = await w.prepare(c.A, "people.withdrawCommitment", { personId: alex, effectiveOn: "2026-10-13" });
	await c.foreignReview(later);
	await c.foreign(
		said,
		[
			() => [read("people.getInterviews", { personId: alex }), read("people.getAssessments", { personId: alex })],
			() => read("people.getCommitmentDownload", { commitmentId: own }),
			() => propose("people.createInterview", { personId: alex, ...INTERVIEW, maturity: RATING, nextSteps: "x" }),
			() => propose("people.withdrawCommitment", { personId: alex, effectiveOn: "2026-10-13" }),
		],
		{ secrets: ["INTAKE-CANARY", "2026-10-08", "Coffee with Alex"], on: { onError: "go_on" } },
	);
	await c.failedWrite(later, "person");
	assert.equal((await commitment()).state, "withdrawn");
	await c.failedWrite(await w.prepare(c.A, "people.createInterview", { personId: alex, ...INTERVIEW }), "interview");
	assert.equal((await w.look(c.A, "people.getInterviews", { personId: alex })).total, 2);
});

const CSV = [
	"first_name,last_name,email,notes",
	"Finley,New,finley@example.test,=1+1",
	"Alex,Rivera,alex@example.test,",
	"Bad,Address,bad-email,",
	"",
].join("\n");
test("AC:EVRY-FAMILY-PEOPLE-CORE three own people keep identity, stage, order and photo through exact reviews, a merge and its inverse, a checked import and an escaped export", async () => {
	const c = await w.church();
	const [alex, casey] = [c.rivera, c.casey];
	await w.admin.execute(sql`DELETE FROM person WHERE id=${c.chen}`);
	const jamie = await c.person("Jamie Fox", { city: "Evanston", stage: "core_group" });
	await c.person("Alex Rivera", { plant: c.Q.id, city: "Peoria", email: "foreign-alex@example.test" });
	const ALEX = await w.seated(c.P, "member", { user: { name: "Alex Rivera" } });
	await w.admin.execute(
		sql`UPDATE person SET source='vision_meeting',adult_classification='unknown' WHERE id=${jamie}`,
	);
	await w.admin.execute(sql`UPDATE person SET email='alex@example.test',linked_account_id=${ALEX.id} WHERE id=${alex}`);
	const row = (id: string) =>
		w.one(
			sql`SELECT display_name,first_name,last_name,email,phone,city,source,stage,adult_classification,linked_account_id,photo_object_id,state,merged_into_person_id,revision::text AS revision FROM person WHERE id=${id}`,
		);
	const seats = () =>
		w.rows(sql`SELECT account_id,role,ended_at FROM seat WHERE plant_id=${c.P.id} ORDER BY account_id`);
	const granted = await seats();
	const people = () => w.count(sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${c.P.id}`);

	const listed = await w.look(c.A, "people.listPeople", {});
	const screen = ok(
		await gatedTransaction(w.db, async (tx) =>
			peopleReader.listPeople(
				tx,
				new PeopleReadContext(await w.authorityOf(c.A)),
				listPeopleRequest.parse({ page: 1, limit: 100 }),
			),
		),
	) as Reply;
	const shown = rowsOf(listed, "person").map((r) => r.id);
	assert.deepEqual(shown.toSorted(), [alex, casey, jamie].toSorted());
	assert.deepEqual([listed.total, screen.total], [3, 3], "the count People shows");
	const board = await w.look(c.A, "people.getPipelineData", {});
	assert.deepEqual([board.total, board.facts["column.core_group"], board.facts["column.prospect"]], [3, 2, 1]);
	const named = await w.look(c.A, "people.checkForDuplicates", { displayName: "Alex Rivera" });
	assert.deepEqual(
		rowsOf(named, "person").map((r) => r.id),
		[alex],
		"another church's Alex is no candidate",
	);
	for (const reply of [listed, board, await w.look(c.A, "people.getPerson", { personId: alex })])
		assert.doesNotMatch(JSON.stringify(reply), /background|clearance|certif/i);
	assert.notEqual(ALEX.id, alex);
	assert.deepEqual(rowsOf(await w.look(ALEX, "people.getPerson", { personId: alex }))[0].fields.you, true);
	const byAccount = await w.look(c.A, "people.getPerson", { personId: ALEX.id });
	assert.deepEqual([byAccount.status, byAccount.rows], ["not_found", []], "an account id names no Person");

	await w.apply(c.A, "people.createPerson", {
		displayName: "Morgan Lane",
		firstName: "Morgan",
		lastName: "Lane",
		source: "event",
	});
	const morgan = String((await w.one(sql`SELECT id FROM person WHERE display_name='Morgan Lane'`)).id);
	await w.apply(c.A, "people.updatePerson", { personId: morgan, patch: { phone: "555-0101" } });
	await w.apply(c.A, "people.recordAdultClassification", {
		personId: jamie,
		classification: "adult",
		occurredOn: "2026-10-01",
		reason: "Told at the door",
	});
	await w.apply(c.A, "people.correctAdultClassification", {
		personId: jamie,
		classification: "child",
		occurredOn: "2026-10-01",
		reason: "Birth date told",
	});
	assert.deepEqual(
		[(await row(morgan)).phone, (await row(morgan)).source, (await row(jamie)).adult_classification],
		["555-0101", "event", "child"],
	);
	const warned = await w.look(c.A, "people.getStatusWarnings", { personId: morgan, stage: "core_group" });
	assert.match(rowsOf(warned)[0].fields.reminders, /Skips 3 stages: Attendee, Following up, Interviewed/);
	await w.apply(c.A, "people.changeStatus", { personId: morgan, stage: "attendee", reason: "Came twice" });
	await w.apply(c.A, "people.createCommitment", { personId: casey, kind: "core_group", occurredOn: "2026-10-12" });
	assert.deepEqual(
		[(await row(morgan)).stage, (await row(casey)).stage],
		["attendee", "leader"],
		"a Leader stays a Leader",
	);
	const order = async () =>
		(
			await w.rows(
				sql`SELECT id FROM person WHERE plant_id=${c.P.id} AND stage='prospect' AND state='live' ORDER BY pipeline_position,id`,
			)
		).map((r) => r.id);
	const riley = await c.person("Riley Late");
	assert.deepEqual(await order(), [alex, riley]);
	await w.apply(c.A, "people.reorderPipeline", { personId: riley, afterId: null });
	assert.deepEqual(await order(), [riley, alex]);

	const conversation = await w.converse(c.Aa);
	const photo = await c.attach(c.A, conversation, "alex.png", png);
	const at = { conversation, storage: w.files.storage, attachments: [{ id: photo.id, name: photo.name }] };
	const card = await w.prepare(c.A, "people.setPersonPhoto", { personId: alex, uploadId: photo.id }, at);
	await approveProposal(w.db, c.Aa, card.id, w.witness(card), w.files.storage);
	assert.deepEqual([await w.effect(), (await row(alex)).photo_object_id], ["completed", photo.id]);
	const [pictured] = rowsOf(await w.look(c.A, "people.getPersonPhoto", { personId: alex }));
	assert.equal(pictured.id, alex);
	await w.apply(c.A, "people.deletePerson", { personId: riley, reason: "Moved away" });
	assert.equal((await row(riley)).state, "retired");
	await w.apply(c.A, "people.restorePerson", { personId: riley });
	assert.equal((await row(riley)).state, "live");

	const JAMIE = await w.seated(c.P, "member", { user: { name: "Jamie Fox" } });
	await w.admin.execute(sql`UPDATE person SET linked_account_id=${JAMIE.id} WHERE id=${jamie}`);
	for (const [sourceId, survivorId, why] of [
		[jamie, alex, /both have an Everyfield account/],
		[alex, casey, /must be the person you keep/],
	] as const) {
		const refused = await w.prepare(c.A, "people.mergePeople", { sourceId, survivorId });
		assert.match(String(refused.review.refusal), why);
		await assert.rejects(w.approve(c.A, refused), { code: "review_closed" });
	}
	assert.deepEqual([(await row(alex)).state, (await row(jamie)).state], ["live", "live"]);

	const before = await people();
	const uploads = await w.converse(c.Aa);
	const file = await c.attach(c.A, uploads, "people.csv", CSV);
	const on = { conversation: uploads, storage: w.files.storage, attachments: [{ id: file.id, name: file.name }] };
	const header = await w.look(c.A, "people.generateCsvTemplate", {});
	assert.match(JSON.stringify(header), /first_name.*last_name.*email/);
	const preview = await w.quiet(() => w.look(c.A, "people.previewImport", { attachmentId: file.id }, on));
	assert.deepEqual(
		rowsOf(preview, "import").map((r) => [r.fields.status, r.fields.duplicatePersonIds ?? null, r.fields.problems]),
		[
			["valid", null, null],
			["valid", alex, null],
			["invalid", null, "invalid_email"],
		],
	);
	assert.equal(await people(), before, "a preview writes nobody");
	const digest = createHash("sha256").update(CSV).digest("hex");
	const imported = await w.apply(
		c.A,
		"people.executeBulkImport",
		{ attachmentId: file.id, fileDigest: digest, choices: [{ row: 2, choice: "create_and_review" }] },
		{ conversation: uploads, storage: w.files.storage },
	);
	assert.ok(imported.receipt);
	await runDueImports(w.db);
	await runDueImports(w.db);
	assert.equal(await people(), before + 2, "the eligible rows once each");
	const receipt = await w.look(c.A, "people.getImportReceipt", {});
	assert.deepEqual(
		rowsOf(receipt, "file").map((r) => [r.fields.created, r.fields.failed]),
		[["2", "1"]],
	);
	const pairs = rowsOf(await w.look(c.A, "people.listDuplicatePairs", {}));
	assert.deepEqual(
		pairs.map((r) => r.fields.mayDuplicateId),
		[alex],
	);
	const twin = pairs[0].id;

	const exported = ok(
		await gatedTransaction(w.db, async (tx) =>
			peopleCsv.exportPeople(tx, new PeopleReadContext(await w.authorityOf(c.A)), {}),
		),
	) as { text: string };
	assert.ok(exported.text.includes(",'=1+1"), exported.text);
	assert.doesNotMatch(exported.text.split("\n")[0]!, /background/i);
	const counted = await w.look(c.A, "people.exportPeople", {});
	assert.equal(JSON.stringify(counted).includes("=1+1"), false, "Evry gives the count, the file stays in the app");

	await w.admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${c.P.id},${c.P.id},${twin},${c.A.id},'Met at the park',clock_timestamp(),clock_timestamp())`);
	const pair = async () => [await row(alex), await row(twin)].map((r) => ({ ...r, revision: null }));
	const apart = await pair();
	const review = await w.look(c.A, "people.getMergeReview", { sourceId: twin, survivorId: alex });
	assert.equal(rowsOf(review, "merge")[0].fields.blocked, null);
	const merge = async () => {
		await w.apply(c.A, "people.mergePeople", { sourceId: twin, survivorId: alex });
		return rowsOf(await w.look(c.A, "people.previewUnmerge", { personId: alex }))[0];
	};
	const merged = await merge();
	assert.deepEqual(
		[(await row(alex)).linked_account_id, (await row(alex)).photo_object_id, (await row(twin)).merged_into_person_id],
		[ALEX.id, photo.id, alex],
		"the linked person is the one kept",
	);
	const destination = await w.look(c.A, "people.mergedPersonDestination", { personId: twin });
	assert.equal(rowsOf(destination)[0].fields.destinationId, alex);
	assert.deepEqual([merged.fields.movesBack, merged.fields.blocked], ["1 note", null]);
	await w.apply(c.A, "people.unmergePeople", { mergeId: merged.id });
	assert.deepEqual(await pair(), apart, "two people are as they were");
	assert.equal(
		rowsOf(await w.look(c.A, "people.previewUnmerge", { mergeId: merged.id }))[0].fields.blocked,
		"This merge was already undone.",
	);
	const kept = await c.person("Sam Kept");
	const sam = await c.person("Sam Double");
	const samsPhoto = await c.attach(c.A, conversation, "sam.png", png);
	const set = await w.prepare(
		c.A,
		"people.setPersonPhoto",
		{ personId: sam, uploadId: samsPhoto.id },
		{ ...at, attachments: [{ id: samsPhoto.id, name: samsPhoto.name }] },
	);
	await approveProposal(w.db, c.Aa, set.id, w.witness(set), w.files.storage);
	assert.equal(await w.effect(), "completed");
	await w.admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${c.P.id},${c.P.id},${sam},${c.A.id},'Met at the park',clock_timestamp(),clock_timestamp())`);
	await w.admin.execute(sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id)
		VALUES(${c.P.id},'Call Sam','general','medium','not_started',clock_timestamp(),'undated',${sam})`);
	await w.apply(c.A, "people.mergePeople", { sourceId: sam, survivorId: kept });
	assert.equal((await row(kept)).photo_object_id, samsPhoto.id, "the merge carries the only photo");
	const mergeId = rowsOf(await w.look(c.A, "people.previewUnmerge", { personId: kept }))[0].id;
	const whole = () =>
		w.rows(sql`SELECT p.*,(SELECT jsonb_agg(n ORDER BY n.id) FROM person_note n WHERE n.person_id=p.id) AS notes,
			(SELECT jsonb_agg(t ORDER BY t.id) FROM task t WHERE t.person_id=p.id) AS tasks FROM person p WHERE p.id IN(${sam},${kept}) ORDER BY p.id`);
	const unedited = await whole();
	for (const [what, change, undo, why] of [
		[
			"reference",
			sql`UPDATE person_note SET body='Edited',revision=revision+1 WHERE person_id=${kept}`,
			sql`UPDATE person_note SET body='Met at the park',revision=revision-1 WHERE person_id=${kept}`,
			/notes changed after the merge/,
		],
		[
			"account",
			sql`UPDATE person SET linked_account_id=${(await w.seated(c.P, "member")).id},revision=revision+1 WHERE id=${sam}`,
			sql`UPDATE person SET linked_account_id=NULL,revision=revision-1 WHERE id=${sam}`,
			/Sam Double's record changed after the merge/,
		],
		[
			"photo",
			sql`UPDATE person SET photo_object_id=NULL,revision=revision+1 WHERE id=${kept}`,
			sql`UPDATE person SET photo_object_id=${samsPhoto.id},revision=revision-1 WHERE id=${kept}`,
			/changed Sam Kept’s photo, and it was edited again/,
		],
		[
			"external use",
			sql`UPDATE task SET status='in_progress',revision=revision+1 WHERE person_id=${kept}`,
			sql`UPDATE task SET status='not_started',revision=revision-1 WHERE person_id=${kept}`,
			/tasks changed after the merge/,
		],
	] as const) {
		await w.admin.execute(change);
		const held = await whole();
		const refused = await w.prepare(c.A, "people.unmergePeople", { mergeId });
		assert.match(String(refused.review.refusal), why, what);
		await assert.rejects(w.approve(c.A, refused), { code: "review_closed" }, what);
		assert.deepEqual(await whole(), held, `${what}: nothing is undone`);
		await w.admin.execute(undo);
		assert.deepEqual(await whole(), unedited);
	}
	await w.apply(c.A, "people.unmergePeople", { mergeId });
	assert.deepEqual(
		[await row(sam), await row(kept)].map((r) => [r.state, r.photo_object_id]),
		[
			["live", samsPhoto.id],
			["live", null],
		],
		"unchanged, the inverse restores both",
	);
	await w.apply(c.A, "people.removePersonPhoto", { personId: sam });
	assert.equal((await row(sam)).photo_object_id, null);
	assert.deepEqual(
		(await seats()).filter((s) => granted.some((g) => g.account_id === s.account_id)),
		granted,
		"no person change grants or ends a seat",
	);

	const team = await w.one(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${c.P.id},'Worship','active',1) RETURNING id`,
	);
	const role = await w.one(
		sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order) VALUES(${c.P.id},${team.id},'Vocals',false,1) RETURNING id`,
	);
	await w.admin.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${c.P.id},${role.id},${casey},'2026-02-01')`,
	);
	const program = await w.one(
		sql`INSERT INTO training_program(plant_id,name,required,team_id) VALUES(${c.P.id},'Welcome',true,${team.id}) RETURNING id`,
	);
	await w.admin
		.execute(sql`INSERT INTO training_credit(plant_id,program_id,person_id,version,kind,earned_on,recorded_at)
		VALUES(${c.P.id},${program.id},${casey},1,'earned','2026-10-01',clock_timestamp())`);
	for (const reader of [c.A, ALEX]) {
		const [assignment] = rowsOf(await w.look(reader, "teams.personAssignments", { personId: casey }));
		assert.deepEqual(
			[assignment.id, assignment.label, assignment.fields],
			[role.id, "Vocals", { team: "Worship", current: true, since: "2026-02-01", ended: null }],
		);
		const [training] = rowsOf(await w.look(reader, "teams.personTraining", { personId: casey }));
		assert.deepEqual(
			[training.id, training.fields.currentMinistries, training.fields.rolesHeld],
			[casey, "Worship", 1],
		);
		const [credit] = rowsOf(await w.look(reader, "teams.trainingHistory", { personId: casey }));
		assert.deepEqual([credit.label, credit.fields], ["Welcome", { entry: "earned", on: "2026-10-01", version: 1 }]);
		const emails = await w.look(reader, "communication.forPerson", { personId: casey });
		assert.deepEqual([emails.status, emails.total], ["available", 0]);
	}

	const said = "Update Alex, check the pipeline and merge the duplicate";
	const edit = await w.prepare(c.A, "people.changeStatus", {
		personId: morgan,
		stage: "following_up",
		reason: "Called",
	});
	await c.foreignReview(edit);
	await c.foreign(
		said,
		[
			() => [read("people.getPerson", { personId: alex }), read("people.getPersonPhoto", { personId: alex })],
			() => read("people.mergedPersonDestination", { personId: twin }),
			() => propose("people.changeStatus", { personId: morgan, stage: "following_up", reason: "Called" }),
			() => propose("people.mergePeople", { sourceId: twin, survivorId: alex }),
		],
		{ secrets: ["Jamie Fox", "Morgan Lane", "alex@example.test", "555-0101"], on: { onError: "go_on" } },
	);
	await c.failedWrite(edit, "person");
	assert.equal((await row(morgan)).stage, "following_up");
	const again = await w.prepare(c.A, "people.mergePeople", { sourceId: twin, survivorId: alex });
	await c.failedWrite(again, "person_merge");
	assert.equal((await row(twin)).state, "merged");
});
