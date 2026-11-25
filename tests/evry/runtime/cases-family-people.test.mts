import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { caseWorld, propose, read, rowsOf, sql, type CaseWorld } from "./case-world.mts";

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
	assert.deepEqual(rowsOf(members, "person").map((r) => r.id).sort(), [alex, casey].sort(), "Jamie is not in it");
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
	assert.deepEqual(rowsOf(listed).map((r) => r.label).sort(), ["North side", "family"]);
	assert.deepEqual(rowsOf(await w.look(c.A, "people.getPersonTags", { personId: alex })).map((r) => r.label), ["family"]);
	await w.apply(c.A, "people.deleteTag", { tagId: northside });
	assert.deepEqual([(await person(alex)).tags, (await person(casey)).tags], [["family"], []]);

	await w.apply(c.A, "people.addSkill", { personId: alex, name: "Greeting", category: "hospitality", proficiency: "beginner" });
	await w.apply(c.A, "people.addSkill", { personId: alex, name: "Music", category: "worship", proficiency: "advanced" });
	const skill = async (name: string) =>
		String((await w.one(sql`SELECT id FROM person_skill WHERE person_id=${alex} AND name=${name}`)).id);
	await w.apply(c.A, "people.updateSkill", { skillId: await skill("Greeting"), patch: { proficiency: "intermediate" } });
	assert.deepEqual((await person(alex)).skills, ["Greeting hospitality intermediate", "Music worship advanced"]);
	const skills = rowsOf(await w.look(c.A, "people.getPersonSkills", { personId: alex }));
	assert.deepEqual(skills.map((r) => r.label).sort(), ["Greeting", "Music"]);
	await w.apply(c.A, "people.removeSkill", { skillId: await skill("Greeting") });
	assert.deepEqual((await person(alex)).skills, ["Music worship advanced"]);

	await w.apply(c.A, "people.addNote", { personId: alex, body: NOTE });
	const note = () => w.one(sql`SELECT id,body,author_id,removed_at IS NULL AS live FROM person_note WHERE person_id=${alex}`);
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
