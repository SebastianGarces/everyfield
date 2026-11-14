import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	prepareProposal,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../../packages/evry/src/index.ts";
import { READ_DOMAINS } from "../../../../../packages/evry/src/catalog/catalog.ts";
import { ORGANIZATION_COMMANDS } from "../../../../../packages/evry/src/adapters/people-organization/commands/index.ts";
import { runDueImports } from "../../../../../apps/web/src/server/people/run-imports.ts";
import { transaction } from "../../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../../apps/web/src/server/jobs/queue.ts";
import { accounts, actor, admin, db, plant, setup, sql, teardown } from "../../../runtime/support.mts";

// WP-064: Evry's reviewed writes for households, tags, skills, notes and imports, through the same path a turn uses:
// the model's propose_change prepares a review, the Owner approves that exact revision and the effect runs once through
// the WP-031 queue. Nothing changes before approval; afterwards the native People records hold the change.

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

before(setup);
after(teardown);

async function turn(who: EvryActor) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const run = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return (operation: string, input: unknown) => prepareProposal(db, who, run, c.id, { operation, input });
}

async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}

const one = async (q: ReturnType<typeof sql>) => (await admin.execute(q)).rows[0] as Record<string, unknown>;
async function addPerson(
	name: string,
	extra: { street?: string; city?: string; household?: string; role?: string } = {},
) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,street,city,household_id,household_role,source,created_at,stage,
			adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${plant},${plant},${name},${extra.street ?? null},${extra.city ?? null},${extra.household ?? null},${extra.role ?? null},
			'other',clock_timestamp(),'attendee','unknown','unknown',1000,'live')`);
	return id;
}
async function addHousehold(name: string, street: string | null, city: string | null) {
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO household(id,plant_id,name,street,city) VALUES(${id},${plant},${name},${street},${city})`,
	);
	return id;
}
const addressOf = async (id: string) =>
	(await one(sql`SELECT concat_ws(', ',street,city) AS a FROM person WHERE id=${id}`)).a;
const notes = async (id: string) => (await one(sql`SELECT count(*)::int n FROM person_note WHERE person_id=${id}`)).n;

test("AC:TARGET-PPL-009 AC:HH-04 adding a person to a household shows the household and role, changes nothing until approval and never edits notes", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const home = await addHousehold("Martinez household", "12 Pecan St", "San Marcos");
	const carmen = await addPerson("Carmen Martinez", { city: "San Marcos", household: home, role: "head" });
	const pedro = await addPerson("Pedro Martinez");
	const proposal = await propose("people.addToHousehold", { householdId: home, personId: pedro, role: "child" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review, {
		target: { kind: "person", id: pedro, label: "Pedro Martinez" },
		changes: [
			{ field: "household", before: null, after: "Martinez household" },
			{ field: "householdRole", before: null, after: "child" },
			// Pedro has no address, so he takes the household's (REQ-PPL-009).
			{ field: "street", before: null, after: "12 Pecan St" },
			{ field: "city", before: null, after: "San Marcos" },
		],
	});
	assert.equal((await one(sql`SELECT household_id FROM person WHERE id=${pedro}`)).household_id, null);

	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.equal(review.outcome, "completed");
	assert.deepEqual(await one(sql`SELECT household_id,household_role FROM person WHERE id=${pedro}`), {
		household_id: home,
		household_role: "child",
	});
	assert.equal(await addressOf(pedro), "12 Pecan St, San Marcos");
	assert.equal(await notes(pedro), 0);

	// Someone already in a household gets a review that says why it can't be approved, and approval is refused.
	const again = await propose("people.addToHousehold", { householdId: home, personId: carmen, role: "spouse" });
	assert.equal(again?.review.refusal, "Carmen Martinez is already in the Martinez household.");
	await assert.rejects(
		() => approveProposal(db, owner, again!.id, { revision: again!.revision, digest: again!.digest }, null),
		(e: { code?: string }) => e.code === "review_closed" || e.code === "review_changed",
	);
});

async function nguyens() {
	const home = await addHousehold("Nguyen household", "9 Elm St", "Austin");
	const ids = {
		minh: await addPerson("Minh Nguyen", { street: "9 Elm St", city: "Austin", household: home, role: "head" }),
		linh: await addPerson("Linh Nguyen", { street: "9 Elm St", city: "Austin", household: home, role: "spouse" }),
		bao: await addPerson("Bao Nguyen", { street: "9 Elm St", city: "Austin", household: home, role: "child" }),
		// Already moved: her own record has the new address.
		thao: await addPerson("Thao Nguyen", { street: "123 Oak St", city: "Austin", household: home, role: "other" }),
	};
	return { home, ids };
}

test("AC:TARGET-PPL-009 AC:HH-05 a household move is one review naming every member's address before and after; each member's result is said truthfully", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const { home, ids } = await nguyens();
	const proposal = await propose("people.propagateAddress", { householdId: home, address: { street: "123 Oak St" } });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.target, { kind: "household", id: home, label: "Nguyen household" });
	assert.deepEqual(proposal.review.changes, [{ field: "street", before: "9 Elm St", after: "123 Oak St" }]);
	const moved = (label: string, id: string) => ({
		id,
		label,
		changes: [{ field: "address", before: "9 Elm St, Austin", after: "123 Oak St, Austin" }],
	});
	assert.deepEqual(proposal.review.people, [
		moved("Minh Nguyen", ids.minh),
		moved("Linh Nguyen", ids.linh),
		moved("Bao Nguyen", ids.bao),
		{ id: ids.thao, label: "Thao Nguyen", changes: [], unchanged: "Already at this address" },
	]);
	for (const id of [ids.minh, ids.linh, ids.bao]) assert.equal(await addressOf(id), "9 Elm St, Austin");

	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	for (const id of Object.values(ids)) assert.equal(await addressOf(id), "123 Oak St, Austin");
	assert.equal((await one(sql`SELECT street FROM household WHERE id=${home}`)).street, "123 Oak St");
	assert.deepEqual(review.receipt?.people, [
		{ id: ids.minh, label: "Minh Nguyen", outcome: "changed" },
		{ id: ids.linh, label: "Linh Nguyen", outcome: "changed" },
		{ id: ids.bao, label: "Bao Nguyen", outcome: "changed" },
		{ id: ids.thao, label: "Thao Nguyen", outcome: "unchanged", reason: "Already at this address" },
	]);
});

test("INV-revision: a member changed between review and approval refuses the whole move, applies nothing and shows them as they are now", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const { home, ids } = await nguyens();
	const proposal = await propose("people.propagateAddress", { householdId: home, address: { street: "123 Oak St" } });
	assert.ok(proposal);
	// Someone edits Linh in People before the Owner approves.
	await admin.execute(sql`UPDATE person SET street='77 Bay Rd',revision=revision+1 WHERE id=${ids.linh}`);
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "refused");
	assert.equal(review.receipt?.code, "revision_conflict");
	assert.deepEqual(review.receipt?.current, [
		{ id: ids.minh, label: "Minh Nguyen", value: "9 Elm St, Austin" },
		{ id: ids.linh, label: "Linh Nguyen", value: "77 Bay Rd, Austin" },
		{ id: ids.bao, label: "Bao Nguyen", value: "9 Elm St, Austin" },
		{ id: ids.thao, label: "Thao Nguyen", value: "123 Oak St, Austin" },
	]);
	assert.equal((await one(sql`SELECT street FROM household WHERE id=${home}`)).street, "9 Elm St");
	for (const [id, address] of [
		[ids.minh, "9 Elm St, Austin"],
		[ids.linh, "77 Bay Rd, Austin"],
		[ids.bao, "9 Elm St, Austin"],
	] as const)
		assert.equal(await addressOf(id), address);
});

test("AC:TARGET-PPL-010 AC:CLN-08 tagging eight people with a new tag is one review that lists them and creates the tag; after approval all eight have it, and no note stands in", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const guests = await Promise.all(Array.from({ length: 8 }, (_, n) => addPerson(`Coffee Guest ${n + 1}`)));
	const proposal = await propose("people.assignTag", { personIds: guests, tagName: "coffee-oct" });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.target, null);
	assert.deepEqual(proposal.review.changes, [
		{ field: "tag", before: null, after: "coffee-oct" },
		{ field: "createTag", before: null, after: "coffee-oct" },
	]);
	assert.deepEqual(
		proposal.review.people?.map((p) => [p.label, p.changes]),
		guests.map((_, n) => [`Coffee Guest ${n + 1}`, [{ field: "tag", before: null, after: "coffee-oct" }]]),
	);
	assert.equal((await one(sql`SELECT count(*)::int n FROM tag WHERE plant_id=${plant} AND name='coffee-oct'`)).n, 0);

	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	const tagged = await admin.execute(sql`SELECT pt.person_id FROM person_tag pt JOIN tag t ON t.id=pt.tag_id
		WHERE t.plant_id=${plant} AND t.name='coffee-oct'`);
	assert.deepEqual(tagged.rows.map((r) => r.person_id).sort(), [...guests].sort());
	assert.deepEqual(
		review.receipt?.people?.map((p) => p.outcome),
		guests.map(() => "changed"),
	);
	for (const id of guests) assert.equal(await notes(id), 0);

	// The same tag again by name finds the existing tag: nothing is created, and people who have it are said so.
	const again = await propose("people.assignTag", { personIds: guests.slice(0, 1), tagName: "Coffee-Oct " });
	assert.equal(again?.review.target?.label, "coffee-oct");
	assert.deepEqual(again?.review.people?.[0]?.unchanged, "Already has this tag");
});

test("AC:TARGET-PPL-008 a note is added, edited and deleted only through its own review, and only its author may change it", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const maria = await addPerson("Maria Santos");
	const added = await propose("people.addNote", { personId: maria, body: "wants to help with kids" });
	assert.deepEqual(added?.review, {
		target: { kind: "person", id: maria, label: "Maria Santos" },
		changes: [{ field: "note", before: null, after: "wants to help with kids" }],
	});
	assert.equal(await notes(maria), 0);
	assert.equal((await approveAndRun(owner, added!)).outcome, "completed");
	const note = await one(sql`SELECT id,body FROM person_note WHERE person_id=${maria}`);
	assert.equal(note.body, "wants to help with kids");

	const edited = await propose("people.editNote", {
		noteId: note.id,
		body: "wants to help with kids on Sundays",
		reason: "She told us which day",
	});
	assert.deepEqual(edited?.review.changes, [
		{ field: "note", before: "wants to help with kids", after: "wants to help with kids on Sundays" },
		{ field: "reason", before: null, after: "She told us which day" },
	]);
	assert.equal((await one(sql`SELECT body FROM person_note WHERE id=${note.id}`)).body, "wants to help with kids");
	assert.equal((await approveAndRun(owner, edited!)).outcome, "completed");
	assert.equal(
		(await one(sql`SELECT body FROM person_note WHERE id=${note.id}`)).body,
		"wants to help with kids on Sundays",
	);

	const removed = await propose("people.deleteNote", { noteId: note.id, reason: "Duplicate" });
	assert.deepEqual(removed?.review.changes, [
		{ field: "note", before: "wants to help with kids on Sundays", after: null },
		{ field: "reason", before: null, after: "Duplicate" },
	]);
	assert.equal((await approveAndRun(owner, removed!)).outcome, "completed");
	assert.notEqual((await one(sql`SELECT removed_at FROM person_note WHERE id=${note.id}`)).removed_at, null);

	// A note someone else wrote: the review says only its author can change it.
	const other = randomUUID();
	await admin.execute(sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${other},${plant},${plant},${maria},${accounts.member.id},'from the member',clock_timestamp(),clock_timestamp())`);
	const foreign = await propose("people.editNote", { noteId: other, body: "changed", reason: "x" });
	assert.equal(foreign?.review.refusal, "Only the person who wrote this note can change it.");
});

test("AC:TARGET-PPL-011 a skill's review shows its category and level, and the skill is on the person after approval", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const sam = await addPerson("Sam Patel");
	const proposal = await propose("people.addSkill", {
		personId: sam,
		name: "Sound",
		category: "tech",
		proficiency: "advanced",
	});
	assert.deepEqual(proposal?.review.changes, [
		{ field: "skill", before: null, after: "Sound" },
		{ field: "category", before: null, after: "tech" },
		{ field: "proficiency", before: null, after: "advanced" },
	]);
	assert.equal((await one(sql`SELECT count(*)::int n FROM person_skill WHERE person_id=${sam}`)).n, 0);
	assert.equal((await approveAndRun(owner, proposal!)).outcome, "completed");
	assert.deepEqual(await one(sql`SELECT name,category,proficiency FROM person_skill WHERE person_id=${sam}`), {
		name: "Sound",
		category: "tech",
		proficiency: "advanced",
	});
});

const CSV = [
	"first_name,last_name,email,phone,street,city,state,postal_code,country,source,source_details,notes",
	"Ivy,Import,ivy@example.org,,,Austin,,,,,,",
	"Jude,Import,jude@example.org,,,Austin,,,,,,",
	",,nobody@example.org,,,,,,,,,",
	"Kai,Import,not-an-email,,,,,,,,,",
].join("\n");

test("AC:TARGET-PPL-018 AC:CLN-05 an import's review lists each row's planned outcome; after approval the people created match the receipt and the latest import reads back without a key", async () => {
	const owner = await actor("owner");
	const propose = await turn(owner);
	const imported = async () =>
		(await one(sql`SELECT count(*)::int n FROM person WHERE plant_id=${plant} AND display_name LIKE '% Import'`)).n;
	const proposal = await propose("people.executeBulkImport", { file: CSV });
	assert.ok(proposal);
	assert.deepEqual(proposal.review.rows, [
		{ row: 1, outcome: "create", label: "Ivy Import", reason: null },
		{ row: 2, outcome: "create", label: "Jude Import", reason: null },
		{ row: 3, outcome: "fail", label: null, reason: "a first or last name is required" },
		{ row: 4, outcome: "fail", label: null, reason: "email: the email address is not valid" },
	]);
	assert.equal(await imported(), 0);

	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.deepEqual(review.receipt?.import, {
		status: "in_progress",
		counts: { created: 0, skipped: 0, failed: 2, remaining: 2 },
		failed: [
			{ row: 3, reason: "a first or last name is required" },
			{ row: 4, reason: "email: the email address is not valid" },
		],
	});
	await runDueImports(db);
	assert.equal(await imported(), 2);

	// "How did the import go": the latest import, with no request key.
	const receipt = READ_DOMAINS.peopleOrganization.find((a) => a.operation === "people.getImportReceipt")!;
	const read = await invokeRead(db, owner, receipt as never, {});
	const file = read.rows.find((r) => r.kind === "file")!;
	assert.deepEqual(
		[file.fields.created, file.fields.failed, file.fields.requestKey],
		["2", "2", `evry:${proposal.id}:1`],
	);
	assert.deepEqual(
		read.rows.filter((r) => r.kind === "import" && r.fields.status === "failed").map((r) => r.fields.reason),
		["a first or last name is required", "email: the email address is not valid"],
	);
});

test("INV-authority: a Member gets no review for any household, tag, note, skill or import change and no import receipt", async () => {
	const member = await actor("member");
	for (const operation of Object.keys(ORGANIZATION_COMMANDS))
		await assert.rejects(
			() =>
				prepareProposal(
					db,
					member,
					{ turnId: randomUUID(), tenantId: plant, leaseOwner: "x", generation: "1" },
					randomUUID(),
					{ operation, input: {} },
				),
			(e: { code?: string }) => e.code === "access_denied",
			operation,
		);
	const receipt = READ_DOMAINS.peopleOrganization.find((a) => a.operation === "people.getImportReceipt")!;
	await assert.rejects(
		() => invokeRead(db, member, receipt as never, {}),
		(e: { code?: string }) => e.code === "access_denied",
	);
});
