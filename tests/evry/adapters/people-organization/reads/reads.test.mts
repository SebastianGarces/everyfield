import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { invokeRead } from "../../../../../packages/evry/src/index.ts";
import { EvryRefusal } from "../../../../../packages/evry/src/context/errors.ts";
import {
	exportPeople,
	generateCsvTemplate,
	getActivities,
	getHousehold,
	getHouseholdMembers,
	getImportReceipt,
	getPersonSkills,
	getPersonTags,
	getPipelineData,
	listHouseholds,
	listTags,
	previewImport,
} from "../../../../../packages/evry/src/adapters/people-organization/reads/index.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { executeBulkImport } from "../../../../../packages/domain/src/people/index.ts";
import { runDueImports } from "../../../../../apps/web/src/server/people/run-imports.ts";
import {
	accounts,
	actor,
	admin,
	db,
	otherPlant,
	people,
	plant,
	queries,
	setup,
	sql,
	teardown,
} from "../../../runtime/support.mts";

before(setup);
after(teardown);

const counted = (start: number) =>
	queries.slice(start).filter((query) => !/^(BEGIN|COMMIT|ROLLBACK)/i.test(query.trim())).length;
const EMAIL = "alex.rivera.secret@example.test";
const PHONE = "555-0199-SECRET";
const STREET = "1 Secret Street";
const PERSON_STREET = "9 Hidden Lane";
const POSTAL = "ZZ9-SECRET";
const NOTE = "Secret pastoral conversation about calling";
const SKILL_NOTE = "private skill coaching note";
const REASON = "secret internal calling assessment";
const SUMMARY = "private summary note";
const CARE = "private care follow up detail";
const HEADER = "first_name,last_name,email,phone,street,city,state,postal_code,country,source,source_details,notes\r\n";
/** One native statement, plus the read timeout. A page keeps this count at any size. */
const READ = 2;
/** Person row, activity page and the read timeout. */
const ACTIVITY = 3;
/** Saved columns, the board, duties for the cards on the page, and the read timeout. */
const PIPELINE = 4;
/** Saved columns, an empty board and the read timeout. Duties are skipped when the page has no cards. */
const PIPELINE_EMPTY = 3;

function hidden(value: unknown, secrets: string[]) {
	const text = JSON.stringify(value);
	for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
}
async function denied(run: () => Promise<unknown>) {
	await assert.rejects(run, (error: unknown) => error instanceof EvryRefusal && error.code === "access_denied");
}
const at = (day: string) => new Date(`${day}T00:00:00.000Z`);
async function addPerson(name: string, position: number) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${id},${plant},${plant},${name},'Naperville','other',clock_timestamp(),'attendee','unknown','unknown',${position},'live')`);
	return id;
}
async function addHousehold(tenant: string, name: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO household(id,plant_id,name,street,city,postal_code)
		VALUES(${id},${tenant},${name},${STREET},'Oak Park',${POSTAL})`);
	return id;
}

test("AC:AC-EVR-143--EVR-143 AC:AC-EVR-READ--EVR-143 AC:TARGET-PPL-019 the pipeline and the export stay inside this church, hide contact values and use one fixed statement count", async () => {
	await admin.execute(sql`UPDATE person SET email=${EMAIL}, phone=${PHONE}, street=${PERSON_STREET}, notes=${SUMMARY}
		WHERE id=${people.alexRivera}`);
	const member = await actor("member");
	const secrets = [EMAIL, PHONE, PERSON_STREET, SUMMARY, "Quinn Foreign", "Neighbor"];
	const start = queries.length;
	const board = await invokeRead(db, member, getPipelineData, {});
	assert.equal(counted(start), PIPELINE);
	assert.equal(board.total, 203);
	assert.equal(board.completeness, "partial");
	assert.equal(board.next, 2);
	assert.deepEqual(
		board.rows.filter((item) => item.fields.column === "prospect").map((item) => [item.label, item.fields.city]),
		[
			["Alex Rivera", "Chicago"],
			["Alex Chen", "Evanston"],
			["Casey Reed", null],
		],
	);
	assert.deepEqual(
		board.rows.filter((item) => item.fields.column === "attendee").map((item) => item.label),
		Array.from({ length: 24 }, (_, index) => `Member ${String(index + 1).padStart(3, "0")}`),
	);
	assert.equal(board.rows.find((item) => item.label === "Alex Rivera")?.fields.coverage, "uncovered");
	assert.equal(board.rows.find((item) => item.label === "Alex Rivera")?.fields.inactivity, "none");
	hidden(board, secrets);

	const page2Start = queries.length;
	const page2 = await invokeRead(db, member, getPipelineData, { page: 2 });
	assert.equal(counted(page2Start), PIPELINE);
	const first = new Set(board.rows.map((item) => item.id));
	assert.equal(
		page2.rows.some((item) => first.has(item.id)),
		false,
	);
	assert.deepEqual(
		page2.rows.filter((item) => item.fields.column === "attendee").map((item) => item.label),
		Array.from({ length: 24 }, (_, index) => `Member ${String(index + 25).padStart(3, "0")}`),
	);

	const wide = queries.length;
	const hundred = await invokeRead(db, member, getPipelineData, { limit: 100 });
	assert.equal(counted(wide), PIPELINE);
	assert.equal(hundred.total, 203);
	assert.equal(hundred.rows.length, 103);

	const found = queries.length;
	const byEmail = await invokeRead(db, member, getPipelineData, { search: EMAIL });
	assert.equal(counted(found), PIPELINE);
	assert.deepEqual(
		byEmail.rows.map((item) => item.label),
		["Alex Rivera"],
	);
	assert.equal(byEmail.total, 1);
	hidden(byEmail, secrets);

	const empty = queries.length;
	const none = await invokeRead(db, member, getPipelineData, { search: "zzz-no-such-person" });
	assert.equal(counted(empty), PIPELINE_EMPTY);
	assert.deepEqual([none.rows, none.total, none.completeness, none.next], [[], 0, "complete", null]);

	const exported = queries.length;
	const file = await invokeRead(db, member, exportPeople, {});
	assert.equal(counted(exported), READ);
	assert.equal(file.total, 203);
	assert.match(file.rows[0]!.label, /^people-\d{4}-\d{2}-\d{2}\.csv$/);
	assert.deepEqual(file.rows[0]!.fields, {
		matched: "203",
		returned: "203",
		completeness: "complete",
		mediaType: "text/csv; charset=utf-8",
	});
	hidden(file, secrets);
	const filtered = queries.length;
	const one = await invokeRead(db, member, exportPeople, { search: EMAIL });
	assert.equal(counted(filtered), READ);
	assert.equal(one.rows[0]!.fields.matched, "1");
	hidden(one, secrets);

	const foreign = await invokeRead(db, await actor("foreign"), getPipelineData, {});
	assert.equal(foreign.total, 2501);
	hidden(foreign, ["Alex Rivera", "Chicago"]);
	await denied(async () => invokeRead(db, await actor("orgOwner"), getPipelineData, {}));
});

test("AC:AC-EVR-113--EVR-113 AC:AC-EVR-READ--EVR-113 AC:AC-EVR-114--EVR-114 AC:AC-EVR-READ--EVR-114 AC:AC-EVR-115--EVR-115 AC:AC-EVR-READ--EVR-115 AC:AC-EVR-140--EVR-140 AC:AC-EVR-READ--EVR-140 AC:AC-EVR-148--EVR-148 AC:AC-EVR-READ--EVR-148 AC:AC-EVR-149--EVR-149 AC:AC-EVR-READ--EVR-149 AC:TARGET-PPL-009 AC:TARGET-PPL-010 AC:TARGET-PPL-011 AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-RETIRE AC:EVRY-FAMILY-PEOPLE-HOUSEHOLDS-NOTES households, tags and skills return safe rows for any seat and the same statement count for one or many", async () => {
	const home = await addHousehold(plant, "Rivera Home");
	const foreignHome = await addHousehold(otherPlant, "Foreign Home");
	for (let number = 1; number <= 25; number++) await addHousehold(plant, `Home ${String(number).padStart(2, "0")}`);
	const sam = await addPerson("Sam Home", 10000);
	const former = await addPerson("Former Home", 10001);
	await admin.execute(
		sql`UPDATE person SET household_id=${home}, household_role='head', street=${PERSON_STREET} WHERE id=${people.alexRivera}`,
	);
	await admin.execute(
		sql`UPDATE person SET household_id=${home}, household_role='child', state='retired', retired_at=clock_timestamp() WHERE id=${former}`,
	);
	const member = await actor("member");
	const alone = queries.length;
	const oneMember = await invokeRead(db, member, getHousehold, { householdId: home });
	assert.equal(counted(alone), READ);
	assert.deepEqual(
		oneMember.rows.map((item) => item.label),
		["Rivera Home", "Alex Rivera"],
	);
	await admin.execute(sql`UPDATE person SET household_id=${home}, household_role='spouse' WHERE id=${sam}`);
	const pair = queries.length;
	const both = await invokeRead(db, member, getHousehold, { householdId: home });
	assert.equal(counted(pair), READ);
	assert.deepEqual(both, {
		operation: "people.getHousehold",
		status: "available",
		rows: [
			{
				kind: "household",
				id: home,
				label: "Rivera Home",
				fields: { name: "Rivera Home", city: "Oak Park", memberCount: "2", revision: "1" },
			},
			{
				kind: "person",
				id: people.alexRivera,
				label: "Alex Rivera",
				fields: { role: "head", city: "Chicago", householdId: home },
			},
			{
				kind: "person",
				id: sam,
				label: "Sam Home",
				fields: { role: "spouse", city: "Naperville", householdId: home },
			},
		],
		total: 3,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: ["street", "postal code", "state", "country", "email", "phone"],
	});
	hidden(both, [STREET, POSTAL, PERSON_STREET, EMAIL, PHONE, "Former Home"]);
	const members = await invokeRead(db, member, getHouseholdMembers, { householdId: home });
	assert.deepEqual(members, { ...both, operation: "people.getHouseholdMembers" });
	const byPerson = await invokeRead(db, member, getHousehold, { personId: people.alexRivera });
	assert.deepEqual(
		byPerson.rows.map((item) => item.id),
		[home, people.alexRivera, sam],
	);
	assert.deepEqual(await invokeRead(db, member, getHousehold, { personId: people.casey }), {
		operation: "people.getHousehold",
		status: "available",
		rows: [],
		total: 0,
		page: 1,
		next: null,
		completeness: "complete",
		exclusions: ["street", "postal code", "state", "country", "email", "phone"],
	});
	assert.equal((await invokeRead(db, member, getHousehold, { householdId: foreignHome })).status, "not_found");
	assert.equal((await invokeRead(db, member, getHousehold, { householdId: randomUUID() })).status, "not_found");
	assert.equal((await invokeRead(db, await actor("foreign"), getHousehold, { householdId: home })).status, "not_found");

	const page1 = queries.length;
	const listed = await invokeRead(db, member, listHouseholds, { limit: 24 });
	assert.equal(counted(page1), READ);
	assert.equal(listed.total, 26);
	assert.equal(listed.next, 2);
	assert.deepEqual(
		listed.rows.map((item) => item.label),
		Array.from({ length: 24 }, (_, index) => `Home ${String(index + 1).padStart(2, "0")}`),
	);
	hidden(listed, [STREET, POSTAL, "Foreign Home"]);
	const page2 = queries.length;
	const rest = await invokeRead(db, member, listHouseholds, { page: 2, limit: 24 });
	assert.equal(counted(page2), READ);
	assert.deepEqual(
		rest.rows.map((item) => item.label),
		["Home 25", "Rivera Home"],
	);
	assert.equal(rest.next, null);
	const foreignList = await invokeRead(db, await actor("foreign"), listHouseholds, { search: "Home" });
	assert.deepEqual(
		foreignList.rows.map((item) => item.label),
		["Foreign Home"],
	);
	await denied(async () => invokeRead(db, await actor("orgOwner"), listHouseholds, {}));

	const greeters = randomUUID();
	const music = randomUUID();
	await admin.execute(sql`INSERT INTO tag(id,plant_id,name,normalized_name,color) VALUES
		(${greeters},${plant},'Greeters','greeters','blue'),
		(${music},${plant},'Music','music','green')`);
	await admin.execute(sql`INSERT INTO tag(id,plant_id,name,normalized_name,color)
		VALUES(${randomUUID()},${otherPlant},'Foreign Tag','foreign tag','red')`);
	await admin.execute(
		sql`INSERT INTO person_tag(plant_id,person_id,tag_id) VALUES(${plant},${people.alexRivera},${greeters})`,
	);
	const tags = queries.length;
	const tagPage = await invokeRead(db, member, listTags, {});
	assert.equal(counted(tags), READ);
	assert.deepEqual(
		tagPage.rows.map((item) => [item.label, item.fields.color, item.fields.linkedPeople]),
		[
			["Greeters", "blue", "1"],
			["Music", "green", "0"],
		],
	);
	hidden(tagPage, ["Foreign Tag"]);
	const personTags = await invokeRead(db, member, getPersonTags, { personId: people.alexRivera });
	assert.deepEqual(personTags.rows, [
		{ kind: "tag", id: greeters, label: "Greeters", fields: { name: "Greeters", color: "blue" } },
	]);
	assert.deepEqual((await invokeRead(db, member, getPersonTags, { personId: people.casey })).rows, []);
	assert.equal((await invokeRead(db, member, getPersonTags, { personId: people.foreign })).status, "not_found");
	assert.equal((await invokeRead(db, member, getPersonTags, { personId: randomUUID() })).status, "not_found");

	const skill = randomUUID();
	await admin.execute(sql`INSERT INTO person_skill(id,plant_id,person_id,name,category,proficiency,notes)
		VALUES(${skill},${plant},${people.alexRivera},'Guitar','worship','beginner',${SKILL_NOTE})`);
	const skills = queries.length;
	const skillPage = await invokeRead(db, member, getPersonSkills, { personId: people.alexRivera });
	assert.equal(counted(skills), READ);
	assert.deepEqual(skillPage.rows, [
		{
			kind: "skill",
			id: skill,
			label: "Guitar",
			fields: { name: "Guitar", category: "worship", proficiency: "beginner" },
		},
	]);
	hidden(skillPage, [SKILL_NOTE]);
	const emptySkills = queries.length;
	assert.deepEqual((await invokeRead(db, member, getPersonSkills, { personId: people.casey })).rows, []);
	assert.equal(counted(emptySkills), READ);
	assert.equal((await invokeRead(db, member, getPersonSkills, { personId: randomUUID() })).status, "not_found");
});

test("AC:TARGET-PPL-025 AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-MERGE AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-UNMERGE AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-CONFLICT AC:INH-NOTES-05 merged history shows on the survivor, leaves after unmerge, and note bodies, reasons and care stay out", async () => {
	const source = await addPerson("Merged Source", 10002);
	const home = randomUUID();
	const note = randomUUID();
	const stageId = randomUUID();
	const moveId = randomUUID();
	const mergeId = randomUUID();
	const careId = randomUUID();
	const recordId = randomUUID();
	await admin.execute(sql`UPDATE person SET state='merged', merged_into_person_id=${people.alexRivera}, retired_at=${at("2020-01-04")}
		WHERE id=${source}`);
	await admin.execute(sql`INSERT INTO person_note(id,tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${note},${plant},${plant},${people.alexRivera},${accounts.owner.id},${NOTE},${at("2020-01-01")},${at("2020-01-01")})`);
	await admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_id,before_value,after_value,occurred_at,recorded_at,after_revision,reason)
		VALUES(${stageId},${plant},${accounts.owner.id},'people.stage_changed','stage_change',${people.alexRivera},
			${JSON.stringify({ stage: "prospect" })}::jsonb,${JSON.stringify({ stage: "attendee" })}::jsonb,
			${at("2020-01-02")},${at("2020-01-02")},1,${REASON})`);
	await admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_id,before_value,after_value,occurred_at,recorded_at,after_revision)
		VALUES(${moveId},${plant},${accounts.owner.id},'people.updated','edit',${people.alexRivera},
			${JSON.stringify({ membership: null })}::jsonb,
			${JSON.stringify({ membership: { householdId: home, name: "Rivera Home", role: "head" } })}::jsonb,
			${at("2020-01-03")},${at("2020-01-03")},1)`);
	await admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_id,metadata,occurred_at,recorded_at,after_revision)
		VALUES(${mergeId},${plant},${accounts.owner.id},'people.merged','merge',${source},
			${JSON.stringify({ event: "person_merged", recordId })}::jsonb,${at("2020-01-04")},${at("2020-01-04")},1)`);
	await admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,outcome,occurred_at,recorded_at,notes)
		VALUES(${careId},${plant},${people.alexRivera},'administrative_completion',${at("2020-01-05")},${at("2020-01-05")},${CARE})`);
	const member = await actor("member");
	const start = queries.length;
	const feed = await invokeRead(db, member, getActivities, { personId: people.alexRivera });
	assert.equal(counted(start), ACTIVITY);
	const secrets = [NOTE, REASON, CARE, accounts.owner.id, recordId, "administrative_completion"];
	hidden(feed, secrets);
	assert.deepEqual(
		feed.rows.map((item) => [
			item.id,
			item.label,
			item.fields.kind,
			item.fields.from ?? null,
			item.fields.to ?? null,
			item.fields.householdTo ?? null,
		]),
		[
			// Newest first, as the person page reads it.
			[mergeId, "person_merged", "activity", null, null, null],
			[moveId, "updated", "activity", null, null, "Rivera Home (head)"],
			[stageId, "Stage", "stage_changed", "prospect", "attendee", null],
			[note, "Note", "note", null, null, null],
		],
	);
	assert.equal(feed.rows.find((item) => item.id === note)?.fields.body, undefined);
	assert.equal(feed.total, 4);
	assert.equal(feed.completeness, "complete");
	const onSource = await invokeRead(db, member, getActivities, { personId: source });
	assert.equal(
		onSource.rows.some((item) => item.id === mergeId),
		true,
	);

	await admin.execute(
		sql`UPDATE person SET state='live', merged_into_person_id=NULL, retired_at=NULL WHERE id=${source}`,
	);
	const after = await invokeRead(db, member, getActivities, { personId: people.alexRivera });
	assert.equal(
		after.rows.some((item) => item.id === mergeId),
		false,
	);
	assert.equal(after.total, 3);
	const restored = await invokeRead(db, member, getActivities, { personId: source });
	assert.deepEqual(
		restored.rows.map((item) => item.id),
		[mergeId],
	);
	hidden(restored, secrets);

	assert.equal((await invokeRead(db, member, getActivities, { personId: people.foreign })).status, "not_found");
	assert.equal((await invokeRead(db, member, getActivities, { personId: randomUUID() })).status, "not_found");
	const guessed = await invokeRead(db, member, getActivities, { personId: randomUUID() });
	hidden(guessed, ["Quinn Foreign", NOTE]);
	await denied(async () => invokeRead(db, await actor("orgOwner"), getActivities, { personId: people.alexRivera }));
});

test("AC:TARGET-PPL-018 AC:EVRY-FAMILY-PEOPLE-CORE a member can read the import header and an export count; only an owner or admin can preview or read a receipt, and neither result contains contact values", async () => {
	const member = await actor("member");
	const owner = await actor("owner");
	const template = queries.length;
	const header = await invokeRead(db, member, generateCsvTemplate, {});
	assert.equal(counted(template), 1);
	assert.deepEqual(header.rows, [
		{
			kind: "file",
			id: "people-import-template.csv",
			label: "people-import-template.csv",
			fields: { mediaType: "text/csv; charset=utf-8", columns: HEADER },
		},
	]);
	hidden(header, [EMAIL, "Alex Rivera", STREET]);

	const csv = [
		"first_name,last_name,email",
		`Alex,Rivera,${EMAIL}`,
		"Ada,Lovelace,ada.lovelace.secret@example.test",
		",,not-an-email",
		"",
	].join("\r\n");
	const previewStart = queries.length;
	const preview = await invokeRead(db, owner, previewImport, { file: csv });
	assert.equal(counted(previewStart), READ);
	const file = preview.rows[0]!;
	assert.equal(file.kind, "file");
	assert.match(String(file.fields.fileDigest), /^[0-9a-f]{64}$/);
	assert.equal(file.fields.fileDigest, file.id);
	assert.match(String(file.fields.reviewDigest), /^[0-9a-f]{64}$/);
	assert.deepEqual(
		preview.rows
			.filter((item) => item.kind === "import")
			.map((item) => [item.label, item.fields.status, item.fields.suggested]),
		[
			["Alex Rivera", "valid", "skip"],
			["Ada Lovelace", "valid", "create"],
			["Row 3", "invalid", null],
		],
	);
	assert.deepEqual(
		preview.rows
			.find((item) => item.label === "Row 3")
			?.fields.problems?.split(",")
			.sort(),
		["invalid_email", "name_required"],
	);
	assert.deepEqual(
		preview.rows.filter((item) => item.kind === "person").map((item) => [item.id, item.label, item.fields.match]),
		[[people.alexRivera, "Alex Rivera", "exact"]],
	);
	hidden(preview, [EMAIL, "ada.lovelace.secret@example.test", "not-an-email"]);
	await denied(() => invokeRead(db, member, previewImport, { file: csv }));
	await assert.rejects(
		() => invokeRead(db, owner, previewImport, { file: "email\r\nmara@example.test\r\n" }),
		(error: unknown) => error instanceof EvryRefusal && error.code === "invalid_input",
	);

	const missing = queries.length;
	assert.equal((await invokeRead(db, owner, getImportReceipt, { requestKey: randomUUID() })).status, "not_found");
	assert.equal(counted(missing), READ);
	await denied(() => invokeRead(db, member, getImportReceipt, { requestKey: randomUUID() }));

	const fresh = ["first_name,last_name,email", "Ada,Lovelace,ada.lovelace.secret@example.test", ""].join("\r\n");
	const reviewed = await invokeRead(db, owner, previewImport, { file: fresh });
	const digest = reviewed.rows[0]!.fields;
	const requestKey = randomUUID();
	const authority = await db.transaction((tx) => RequestActor.resolve(tx, accounts.owner.session as never));
	assert.ok(authority instanceof RequestActor);
	const submitted = await executeBulkImport(db, authority, {
		requestKey,
		file: new TextEncoder().encode(fresh),
		fileDigest: digest.fileDigest,
		reviewDigest: digest.reviewDigest,
		choices: [{ row: 1, choice: "create" }],
	});
	assert.equal(submitted.status, "ok", JSON.stringify(submitted).slice(0, 400));
	await runDueImports(db, 4);
	const receipt = await invokeRead(db, owner, getImportReceipt, { requestKey });
	assert.equal(receipt.status, "available");
	assert.equal(receipt.rows[0]!.fields.created, "1");
	const created = receipt.rows.find((item) => item.kind === "person");
	assert.equal(created?.label, "Imported person");
	assert.match(created?.id ?? "", /^[0-9a-f-]{36}$/);
	hidden(receipt, ["ada.lovelace.secret@example.test", EMAIL]);
	await denied(async () => invokeRead(db, await actor("seatless"), generateCsvTemplate, {}));
});

test("INV-tenancy: a household read takes no lock a sign-out waits for, and the next statement sees the sign-out", async () => {
	const owner = await actor("owner");
	const home = await addHousehold(plant, "Lock Home");
	const session = (await admin.execute(sql`SELECT * FROM auth_session WHERE id=${accounts.owner.session}`)).rows[0]!;
	try {
		await db.transaction(async (tx) => {
			assert.equal((await getHousehold.invoke(tx, owner, { householdId: home })).status, "available");
			const started = performance.now();
			await admin.transaction(async (signOut) => {
				await signOut.execute(sql`SET LOCAL lock_timeout='2s'`);
				await signOut.execute(sql`DELETE FROM auth_session WHERE id=${accounts.owner.session}`);
			});
			assert.ok(performance.now() - started < 2_000, "sign-out does not wait for the read");
			assert.equal((await getHousehold.invoke(tx, owner, { householdId: home })).status, "not_found");
		});
	} finally {
		await admin.execute(
			sql`INSERT INTO auth_session SELECT * FROM json_populate_record(null::auth_session, ${JSON.stringify(session)}::json) ON CONFLICT DO NOTHING`,
		);
	}
});
