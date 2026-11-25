import { fixture, ok, refused, waitingOnLock } from "../../../support/fixture.mts";
import { faulted, recorded, touched, untouched } from "../../../support/recorded.mts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import {
	actionOf,
	authorityOf,
	church,
	isActivity,
	noReminders,
	reads,
	type Reply,
	type Row,
	StubClient,
	withStatus,
} from "../people-support.mts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { runDueObjectCleanup } from "../../../../packages/domain/src/jobs/object-cleanup.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { PeopleReadContext, type WriteContext } from "../../../../packages/domain/src/people/core.ts";
import {
	interviews,
	peopleWriter as people,
	personFields as fields,
	readPersonPhoto,
	uploadPersonPhoto,
	withPeopleWrite,
} from "../../../../packages/domain/src/people/index.ts";
import { leave } from "../../../../apps/web/src/features/people/fields/leave.ts";
import { recordId } from "../../../../packages/contracts/src/common/values.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";

const database = await fixture({ prefix: "wp012" });
const { admin } = database;
const db = database.pools.runtime;

const plants = [database.tenant.id, (await database.plant()).id] as const,
	actors = [
		database.actors.admin,
		database.actors.member,
		await database.actor({ kind: "plant", id: plants[1] }, "admin"),
		await database.actor({ kind: "plant", id: plants[1] }, "member"),
	] as const;
type Household = Extract<Awaited<ReturnType<typeof fields.getHousehold>>, { status: "ok" }>["value"];
const inHousehold = (result: Household) => withStatus(result, "available");
type Who = 0 | 1 | 2 | 3;
const ctx = (who: Who = 0) => ({ session: actors[who].session, selected: church(plants[who >= 2 ? 1 : 0]) });
const tx = <T,>(body: (t: WriteTx) => Promise<T>) => gatedTransaction(db, body);
const write = async <T,>(who: Who, body: (t: WriteTx, c: WriteContext) => Promise<Reply<T>>) =>
	withPeopleWrite(db, await tx((t) => authorityOf(t, actors[who])), body);
const key = () => randomUUID();
const rows = async <T extends Row>(query: SQL) => (await admin.execute<T>(query)).rows;
type Audit = {
	kind: string;
	action: string;
	subject_type: string;
	before_value: object | null;
	after_value: { skill?: { proficiency: string } | null } | null;
};
const audit = (subject: string) =>
	rows<Audit>(
		sql`SELECT kind,action,subject_type,before_value,after_value FROM audit_event WHERE subject_id=${sql.param(subject)} AND command_id=id ORDER BY occurred_at,id`,
	);

async function person(name: string, fields = {}, who: Who = 0) {
	return ok(
		await write(who, async (t, c) =>
			people.createPerson(t, c, { requestKey: key(), input: { displayName: name, ...fields } }),
		),
	).person;
}
async function retirement(p: { id: string; revision: string }) {
	const review = ok(await tx((t) => reads.getStatusWarnings(t, ctx(), { personId: p.id }))).reviewRevision;
	return () =>
		write(0, async (t, c) =>
			people.retirePerson(
				t,
				c,
				{
					requestKey: key(),
					expectedRevision: p.revision,
					input: { personId: p.id, reason: "Moved away", reviewRevision: review, handoffs: [] },
				},
				noReminders,
			),
		);
}
const retire = async (p: { id: string; revision: string }) => ok(await (await retirement(p))());
async function inTurn(...calls: (() => Promise<Reply<unknown>>)[]) {
	const { promise: held, resolve: release } = Promise.withResolvers<void>();
	const { promise: taken, resolve: locked } = Promise.withResolvers<void>();
	const holder = admin.transaction(async (a) => {
		await a.execute(sql`SELECT id FROM plant WHERE id=${plants[0]} FOR UPDATE`);
		locked();
		await held;
	});
	await taken;
	const waiting: Promise<Reply<unknown>>[] = [];
	for (const call of calls) {
		waiting.push(call());
		await waitingOnLock(db, { count: waiting.length });
	}
	release();
	await holder;
	return Promise.all(waiting);
}
const quiet = { jobs: [], notices: 0, mail: 0 };
const updated = { audits: ["people.updated"], ...quiet };
async function foreignRefused(call: (who: Who, id: string) => Promise<Reply<unknown>>, id: string) {
	for (const who of [2, 3] as const) {
		const { correlationId: _, ...known } = refused(await untouched(admin, () => call(who, id)));
		const { correlationId: __, ...unknown } = refused(await call(who, key()));
		assert.deepEqual(known, unknown, "a real id answers as an unknown one");
	}
}
const revisionOf = async (id: string) =>
	(await rows<{ r: string }>(sql`SELECT revision::text r FROM person WHERE id=${sql.param(id)}`))[0]!.r;

after(async () => {
	await database.close();
});

test("AC:GAP-PPL-010 AC:TARGET-PPL-010 AC:PERSONREF-HOUSEHOLD-TAG-SKILL-NOTE-RETIRE plant-local tag names, nullable color, one link per pair and deletion with history", async () => {
	const alex = await person("Alex Rivera"),
		jamie = await person("Jamie Chen");
	const create = (name: string, color: string | null | undefined, who: Who = 0) =>
		write(who, async (t, c) =>
			fields.createTag(t, c, { requestKey: key(), input: color === undefined ? { name } : { name, color } }),
		);
	const family = ok(await create("family", null)).tag;
	const north = ok(await create(" Northside ", "#3A7BD5"));
	assert.deepEqual(
		{ name: north.tag.name, color: north.tag.color, outcome: north.outcome },
		{
			name: "Northside",
			color: "#3a7bd5",
			outcome: "changed",
		},
	);
	const same = ok(await create("NORTHSIDE  ", "red"));
	assert.deepEqual([same.outcome, same.tag.id, same.tag.color], ["noop", north.tag.id, "#3a7bd5"]);
	const foreign = ok(await create("Northside", null, 2)).tag;
	assert.notEqual(foreign.id, north.tag.id);
	refused(await create("Northside", null, 1));
	const racers = ["Welcome", " welcome "];
	const raced = (await inTurn(...racers.map((name) => () => create(name, null)))).map(
		(r) => ok(r) as { outcome: string; tag: { id: string; name: string; color: string | null } },
	);
	assert.deepEqual(
		raced.map((r) => [r.outcome, r.tag.name, r.tag.color, r.tag.id]),
		[
			["changed", "Welcome", null, raced[0]!.tag.id],
			["noop", "Welcome", null, raced[0]!.tag.id],
		],
	);
	assert.deepEqual(
		await rows(sql`SELECT normalized_name,color FROM tag WHERE plant_id=${plants[0]} AND name ILIKE '%welcome%'`),
		[{ normalized_name: "welcome", color: null }],
	);
	const welcome = "Welcome";
	const renamed = ok(
		await write(0, async (t, c) =>
			fields.updateTag(t, c, {
				requestKey: key(),
				expectedRevision: north.tag.revision,
				input: { tagId: north.tag.id, name: "North  side" },
			}),
		),
	).tag;
	assert.deepEqual([renamed.name, renamed.color], ["North  side", "#3a7bd5"]);
	const cleared = ok(
		await write(0, async (t, c) =>
			fields.updateTag(t, c, {
				requestKey: key(),
				expectedRevision: renamed.revision,
				input: { tagId: north.tag.id, color: null },
			}),
		),
	).tag;
	assert.deepEqual([cleared.name, cleared.color], ["North  side", null]);
	refused(
		await write(0, async (t, c) =>
			fields.updateTag(t, c, {
				requestKey: key(),
				expectedRevision: cleared.revision,
				input: { tagId: north.tag.id, name: "Family" },
			}),
		),
		"conflict",
	);
	const elsewhere = ok(
		await write(2, async (t, c) =>
			fields.updateTag(t, c, {
				requestKey: key(),
				expectedRevision: foreign.revision,
				input: { tagId: foreign.id, name: "Family" },
			}),
		),
	);
	assert.deepEqual([elsewhere.outcome, elsewhere.tag.name], ["changed", "Family"]);

	const assign = { requestKey: key(), input: { personId: alex.id, tagId: north.tag.id } };
	ok(
		await write(0, async (t, c) =>
			fields.assignTag(t, c, { requestKey: key(), input: { personId: alex.id, tagId: family.id } }),
		),
	);
	const attach = (input = assign) => write(0, async (t, c) => fields.assignTag(t, c, input));
	const links = async () =>
		(
			await rows<{ name: string }>(sql`SELECT t.name FROM person_tag pt JOIN tag t ON t.id=pt.tag_id
			WHERE pt.person_id=${alex.id}`)
		)
			.map((t) => t.name)
			.sort();
	const feed = async () =>
		ok(await tx((t) => reads.getActivities(t, ctx(), { personId: alex.id }))).items.map(actionOf);
	await faulted(admin, "audit_event", () => attach());
	assert.deepEqual(await links(), ["family"], "the earlier tag stays");
	assert.deepEqual(await feed(), ["updated", "created"]);
	const { value: assigned, added: assignment } = await recorded(admin, () => touched(admin, () => attach()));
	const first = ok(assigned.value);
	assert.deepEqual([assignment, assigned.tables], [updated, ["audit_event", "person_tag", "plant", "record"]]);
	assert.deepEqual(ok(await untouched(admin, () => attach())), first);
	const again = await touched(admin, () => attach({ ...assign, requestKey: key() }));
	const repeat = ok(again.value);
	assert.deepEqual(
		first.tags.map((t) => t.name),
		["family", "North  side"],
	);
	assert.deepEqual([repeat.outcome, repeat.tags, again.tables], ["noop", first.tags, ["audit_event", "record"]]);
	assert.deepEqual(await links(), ["North  side", "family"]);
	assert.deepEqual(await feed(), ["updated", "updated", "created"], "a repeat adds no activity");
	assert.deepEqual(
		(await audit(alex.id)).filter((a) => a.kind !== "create").map((a) => [a.kind, a.after_value]),
		[
			["edit", { tags: ["family"] }],
			["edit", { tags: ["family", "North  side"] }],
			["noop", null],
		],
	);
	const stranger = await person("Foreign Alex", {}, 2);
	for (const input of [
		{ personId: alex.id, tagId: foreign.id },
		{ personId: stranger.id, tagId: north.tag.id },
		{ personId: stranger.id, tagId: foreign.id },
	])
		refused(await untouched(admin, () => attach({ requestKey: key(), input })));
	const linkAs = (who: Who, personId: string, tagId: string, link: "assignTag" | "removeTag" = "assignTag") =>
		write(who, async (t, c) => fields[link](t, c, { requestKey: key(), input: { personId, tagId } }));
	refused(await untouched(admin, () => linkAs(1, alex.id, north.tag.id)));
	await foreignRefused((who, id) => linkAs(who, id, north.tag.id), alex.id);
	await foreignRefused((who, id) => linkAs(who, id, foreign.id), alex.id);
	await foreignRefused((who, id) => linkAs(who, alex.id, id, "removeTag"), north.tag.id);
	await foreignRefused((who, id) => tx((t) => fields.getPersonTags(t, ctx(who), { personId: id })), alex.id);
	await foreignRefused(
		(who, tagId) =>
			write(who, async (t, c) =>
				fields.updateTag(t, c, {
					requestKey: key(),
					expectedRevision: cleared.revision,
					input: { tagId, name: "Taken" },
				}),
			),
		north.tag.id,
	);
	await foreignRefused(
		(who, tagId) =>
			write(who, async (t, c) =>
				fields.deleteTag(t, c, { requestKey: key(), expectedRevision: cleared.revision, input: { tagId } }),
			),
		north.tag.id,
	);
	assert.deepEqual(
		ok(await tx((t) => fields.listTags(t, ctx(3), {}))).items.map((t) => t.name),
		["Family"],
	);
	ok(await linkAs(2, stranger.id, foreign.id));

	ok(
		await write(0, async (t, c) =>
			fields.assignTag(t, c, { requestKey: key(), input: { personId: jamie.id, tagId: north.tag.id } }),
		),
	);
	await retire(jamie);
	refused(
		await write(0, async (t, c) =>
			fields.assignTag(t, c, { requestKey: key(), input: { personId: jamie.id, tagId: family.id } }),
		),
	);
	const listed = ok(await tx((t) => fields.listTags(t, ctx(1), {}))).items;
	assert.deepEqual(
		listed.map((t) => [t.name, t.linkedPeople]),
		[
			["family", 1],
			["North  side", 1],
			[welcome, 0],
		],
	);
	const items = ok(await tx((t) => reads.getActivities(t, ctx(), { personId: jamie.id }))).items;
	assert.deepEqual(items.map(actionOf), ["retired", "updated", "created"]);

	const unlinked = await recorded(admin, () => touched(admin, () => linkAs(0, alex.id, north.tag.id, "removeTag")));
	assert.deepEqual(
		[unlinked.added, unlinked.value.tables],
		[updated, ["audit_event", "person_tag", "plant", "record"]],
	);
	assert.deepEqual(
		ok(unlinked.value.value).tags.map((t) => t.name),
		["family"],
	);
	assert.deepEqual(await links(), ["family"]);
	assert.equal(ok(await linkAs(0, alex.id, north.tag.id, "removeTag")).outcome, "noop");
	ok(await linkAs(0, alex.id, north.tag.id));
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM person_tag WHERE tag_id=${foreign.id}`), [{ n: 1 }]);
	const { value: removedTag, added: deletion } = await recorded(admin, () =>
		write(0, async (t, c) =>
			fields.deleteTag(t, c, {
				requestKey: key(),
				expectedRevision: cleared.revision,
				input: { tagId: north.tag.id },
			}),
		),
	);
	const deleted = ok(removedTag);
	assert.equal(deleted.removedLinks, 2);
	assert.deepEqual(deletion, { audits: ["people.retired"], ...quiet });
	assert.deepEqual(
		await rows(sql`SELECT count(*)::int n FROM person_tag WHERE tag_id=${foreign.id}`),
		[{ n: 1 }],
		"the other church's tag keeps its link",
	);
	assert.deepEqual(
		ok(await tx((t) => fields.getPersonTags(t, ctx(), { personId: alex.id }))).tags.map((t) => t.name),
		["family"],
	);
	assert.equal((await audit(north.tag.id)).at(-1)!.action, "people.retired");
	const remove = () =>
		write(0, async (t, c) =>
			fields.removeTag(t, c, { requestKey: key(), input: { personId: alex.id, tagId: family.id } }),
		);
	assert.deepEqual([ok(await remove()).tags, ok(await remove()).outcome], [[], "noop"]);
	assert.equal(
		(await audit(alex.id)).filter((a) => JSON.stringify(a.after_value ?? "").includes("North  side")).length,
		2,
	);
});

test("AC:GAP-PPL-011 AC:TARGET-PPL-011 skills keep closed categories, null clears and refuse stale or foreign edits", async () => {
	const alex = await person("Alex Rivera");
	const add = async (name: string, category: string, proficiency?: string) =>
		ok(
			await write(0, async (t, c) =>
				fields.addSkill(t, c, {
					requestKey: key(),
					input: { personId: alex.id, name, category, proficiency, notes: "Sunday team" },
				}),
			),
		);
	await add("Music", "other", "advanced");
	const added = await add(" Hospitality ", "other", "beginner");
	const hospitality = added.skills.find((s) => s.name === "Hospitality")!;
	assert.deepEqual(
		added.skills.map((s) => [s.category, s.name, s.proficiency]),
		[
			["other", "Hospitality", "beginner"],
			["other", "Music", "advanced"],
		],
	);
	const update = (rev: string, patch: object, who: Who = 0, skillId = hospitality.id) =>
		write(who, async (t, c) =>
			fields.updateSkill(t, c, { requestKey: key(), expectedRevision: rev, input: { skillId, patch } }),
		);
	const remove = (rev: string, who: Who = 0, skillId = hospitality.id) =>
		write(who, async (t, c) =>
			fields.removeSkill(t, c, { requestKey: key(), expectedRevision: rev, input: { skillId } }),
		);
	ok(
		await write(0, async (t, c) =>
			interviews.createInterview(t, c, {
				requestKey: key(),
				input: {
					personId: alex.id,
					occurredOn: "2026-10-10",
					...Object.fromEntries(
						["maturity", "chemistry", "rightReasons", "season"].map((name) => [name, { rating: "pass" }]),
					),
					gifted: { rating: "pass", notes: "Hospitality, beginner" },
					result: "qualified",
				},
			}),
		),
	);
	const recordedInterviews = async () =>
		ok(await tx((t) => interviews.getInterviews(t, ctx(), { personId: alex.id }))).items;
	const interviewed = await recordedInterviews();
	const team = key(),
		role = key();
	await admin.execute(
		sql`INSERT INTO record(id,kind,tenant_id) VALUES(${team},'team',${plants[0]}),(${role},'team_role',${plants[0]}) ON CONFLICT DO NOTHING`,
	);
	await admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${plants[0]},'Welcome','active',1)`,
	);
	await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,desired_skills)
		VALUES(${role},${plants[0]},${team},'Greeter',false,1,'Hospitality, beginner')`);
	const wanted = () => rows(sql`SELECT desired_skills,revision::text r FROM team_role WHERE id=${role}`);
	const asked = await wanted();
	assert.equal(asked[0]!.desired_skills, "Hospitality, beginner");
	assert.deepEqual(interviewed[0]!.gifted, { rating: "pass", notes: "Hospitality, beginner" });
	const raise = () => update(hospitality.revision, { proficiency: "advanced" });
	await faulted(admin, "audit_event", raise);
	assert.deepEqual(
		ok(await tx((t) => fields.getPersonSkills(t, ctx(), { personId: alex.id }))).skills,
		added.skills,
		"the skills saved before stay as they were",
	);
	const change = await recorded(admin, () => touched(admin, raise));
	const advanced = ok(change.value.value);
	assert.deepEqual(Object.fromEntries(advanced.skills.map((s) => [s.name, s.proficiency])), {
		Music: "advanced",
		Hospitality: "advanced",
	});
	assert.deepEqual(
		advanced.skills.map((skill) => Object.keys(skill).sort()),
		Array(2).fill(["category", "id", "name", "notes", "personId", "proficiency", "revision"]),
		"a skill holds no background check, certification or model judgment",
	);
	assert.deepEqual([change.added, change.value.tables], [updated, ["audit_event", "person_skill", "plant", "record"]]);
	refused(await untouched(admin, () => update(hospitality.revision, { proficiency: null })), "conflict");
	refused(await untouched(admin, () => remove(hospitality.revision)), "conflict");
	const current = advanced.skills.find((s) => s.id === hospitality.id)!;
	refused(await untouched(admin, () => update(current.revision, { proficiency: null }, 1)));
	refused(await untouched(admin, () => remove(current.revision, 1)));
	await foreignRefused(
		(who, id) => update(current.revision, { proficiency: null }, who, recordId.parse(id)),
		hospitality.id,
	);
	await foreignRefused((who, id) => remove(current.revision, who, recordId.parse(id)), hospitality.id);
	await foreignRefused((who, id) => tx((t) => fields.getPersonSkills(t, ctx(who), { personId: id })), alex.id);
	await foreignRefused(
		(who, personId) =>
			write(who, async (t, c) =>
				fields.addSkill(t, c, { requestKey: key(), input: { personId, name: "Sound", category: "tech" } }),
			),
		alex.id,
	);
	const cleared = ok(await update(current.revision, { proficiency: null, notes: null }));
	assert.deepEqual(
		ok(await tx((t) => fields.getPersonSkills(t, ctx(1), { personId: alex.id }))).skills.find(
			(s) => s.id === hospitality.id,
		),
		{ ...cleared.skills.find((s) => s.id === hospitality.id), proficiency: null, notes: null },
	);
	const latest = cleared.skills.find((s) => s.id === hospitality.id)!;
	const { value: removal, added: removing } = await recorded(admin, () =>
		touched(admin, () => remove(latest.revision)),
	);
	const removed = ok(removal.value);
	assert.deepEqual([removing, removal.tables], [updated, ["audit_event", "person_skill", "plant", "record"]]);
	assert.deepEqual(
		removed.skills.map((s) => [s.name, s.proficiency]),
		[["Music", "advanced"]],
	);
	refused(await untouched(admin, () => update(latest.revision, { proficiency: "expert" })));
	assert.deepEqual(await wanted(), asked, "the role that asks for the skill is not rewritten");
	assert.deepEqual(await recordedInterviews(), interviewed, "the interview that names the skill is not rewritten");
	assert.deepEqual(
		removed.skills.map((s) => s.name),
		["Music"],
	);
	assert.deepEqual(
		(await audit(alex.id))
			.filter((a) => a.kind === "edit" && a.after_value?.skill !== undefined)
			.map((a) => (a.after_value?.skill === null ? "removed" : a.after_value?.skill?.proficiency)),
		["advanced", "beginner", "advanced", null, "removed"],
	);
	assert.deepEqual(
		(await audit(alex.id)).filter((a) => a.after_value?.skill === null).map((a) => a.before_value),
		[{ skill: { id: hospitality.id, name: "Hospitality", category: "other", proficiency: null, notes: null } }],
	);
});

test("AC:TARGET-PPL-011 every category and proficiency saves, reads back and clears to no level", async () => {
	const sam = await person("Sam Skilled");
	const categories = ["worship", "tech", "admin", "teaching", "hospitality", "leadership", "other"];
	const levels = ["beginner", "intermediate", "advanced", "expert", null];
	const skillsOf = async () => ok(await tx((t) => fields.getPersonSkills(t, ctx(), { personId: sam.id }))).skills;
	const patch = async (patch: object) => {
		const [skill] = await skillsOf();
		ok(
			await write(0, async (t, c) =>
				fields.updateSkill(t, c, {
					requestKey: key(),
					expectedRevision: skill!.revision,
					input: { skillId: skill!.id, patch },
				}),
			),
		);
		const [after] = await skillsOf();
		return [after!.category, after!.proficiency, after!.notes];
	};
	ok(
		await write(0, async (t, c) =>
			fields.addSkill(t, c, { requestKey: key(), input: { personId: sam.id, name: "Anything", category: "other" } }),
		),
	);
	assert.deepEqual([(await skillsOf())[0]!.proficiency, (await skillsOf())[0]!.notes], [null, null]);
	for (const category of categories)
		for (const level of levels) {
			assert.deepEqual(await patch({ category, proficiency: level, notes: `${category} ${level}` }), [
				category,
				level,
				`${category} ${level}`,
			]);
			assert.deepEqual(await patch({ proficiency: null, notes: null }), [category, null, null]);
		}
});

test("AC:TARGET-PPL-009 AC:PERSONREF-PERSON-REDIRECT-MERGE-HISTORY-RETIRE households: coherent head, address copy only when blank, deliberate propagation and safe deletion", async () => {
	const head = await person("Alex Rivera"),
		casey = await person("Casey Reed", { street: "1 Own St", city: "Evanston" }),
		jamie = await person("Jamie Chen"),
		retiring = await person("Riley Stone");
	await retire(retiring);
	const create = (p: { id: string; revision: string }, rev: string) =>
		write(0, async (t, c) =>
			fields.createHouseholdWithHead(t, c, {
				requestKey: key(),
				expectedRevision: rev,
				input: { name: "Rivera household", street: "9 Elm St", city: "Chicago", headPersonId: p.id },
			}),
		);
	const beginning = await rows(sql`SELECT count(*)::int n FROM household`);
	refused(await untouched(admin, async () => create(retiring, await revisionOf(retiring.id))));
	const leaving = await person("Lee Leaving");
	const [gone, late] = await inTurn(await retirement(leaving), () => create(leaving, leaving.revision));
	ok(gone!);
	refused(late!);
	assert.deepEqual(await rows(sql`SELECT count(*)::int n FROM household`), beginning, "no household without a person");
	const staying = await person("Sky Staying");
	const [made, stale] = await inTurn(() => create(staying, staying.revision), await retirement(staying));
	refused(stale!, "conflict");
	const kept = inHousehold((ok(made!) as { result: Household }).result);
	assert.deepEqual(
		kept.members.map((m) => [m.personId, m.role]),
		[[staying.id, "head"]],
	);
	const stayed = await revisionOf(staying.id);
	ok(
		await write(0, async (t, c) =>
			leave(t, c, { requestKey: key(), expectedRevision: stayed, input: { personId: staying.id } }, true),
		),
	);
	refused(await untouched(admin, () => create(head, "9")), "conflict");
	const creating = {
		requestKey: key(),
		expectedRevision: head.revision,
		input: { name: "Rivera household", street: "9 Elm St", city: "Chicago", headPersonId: head.id },
	};
	const start = () => write(0, async (t, c) => fields.createHouseholdWithHead(t, c, creating));
	await faulted(admin, "audit_event", start);
	const creation = await recorded(admin, start);
	assert.deepEqual(creation.added, updated);
	const started = ok(creation.value);
	assert.deepEqual(ok(await untouched(admin, start)), started);
	const created = inHousehold(started.result);
	const h = created.household;
	assert.deepEqual(
		created.members.map((m) => [m.displayName, m.role, m.street, m.city]),
		[["Alex Rivera", "head", "9 Elm St", "Chicago"]],
	);
	const join = async (p: { id: string }, role: string, rev?: string) =>
		write(0, async (t, c) =>
			fields.addToHousehold(t, c, {
				requestKey: key(),
				expectedRevision: rev ?? (await revisionOf(p.id)),
				input: { householdId: h.id, personId: p.id, role },
			}),
		);
	ok(await join(casey, "spouse"));
	const joined = inHousehold(ok(await join(jamie, "child")).result);
	assert.deepEqual(
		joined.members.map((m) => [m.displayName, m.role, m.street]),
		[
			["Alex Rivera", "head", "9 Elm St"],
			["Casey Reed", "spouse", "1 Own St"],
			["Jamie Chen", "child", "9 Elm St"],
		],
	);
	refused(await untouched(admin, () => join(head, "head", "1")), "conflict");
	const stranger = await person("Foreign Riley", {}, 2);
	const joinAs = (who: Who, householdId: string, p: { id: string; revision: string }) =>
		write(who, async (t, c) =>
			fields.addToHousehold(t, c, {
				requestKey: key(),
				expectedRevision: p.revision,
				input: { householdId, personId: p.id, role: "other" },
			}),
		);
	refused(await untouched(admin, () => joinAs(0, h.id, stranger)));
	refused(await untouched(admin, () => joinAs(1, h.id, retiring)));
	await foreignRefused((who, id) => joinAs(who, id, stranger), h.id);
	await foreignRefused((who, id) => joinAs(who, id, jamie), h.id);
	await foreignRefused((who, id) => tx((t) => fields.getHousehold(t, ctx(who), { householdId: id })), h.id);
	await foreignRefused((who, id) => tx((t) => fields.getHousehold(t, ctx(who), { personId: id })), head.id);
	const theirs = inHousehold(
		ok(
			await write(2, async (t, c) =>
				fields.createHouseholdWithHead(t, c, {
					requestKey: key(),
					expectedRevision: stranger.revision,
					input: { name: "Foreign household", headPersonId: stranger.id },
				}),
			),
		).result,
	);
	assert.deepEqual(
		theirs.members.map((m) => m.personId),
		[stranger.id],
	);
	refused(await untouched(admin, () => joinAs(0, theirs.household.id, retiring)));
	const crossing = () =>
		rows(
			sql`SELECT count(*)::int n FROM person p JOIN household x ON x.id=p.household_id WHERE x.plant_id<>p.tenant_id`,
		);
	assert.deepEqual(await crossing(), [{ n: 0 }]);

	const preview = inHousehold(ok(await tx((t) => fields.getHouseholdMembers(t, ctx(), { householdId: h.id }))));
	const edited = inHousehold(
		ok(
			await write(0, async (t, c) =>
				fields.updateHousehold(t, c, {
					requestKey: key(),
					expectedRevision: preview.household.revision,
					input: { householdId: h.id, patch: { street: "10 Oak Ave" } },
				}),
			),
		).result,
	);
	const reviewed = preview.members.map((m) => ({ personId: m.personId, revision: m.revision }));
	const propagate = (rev: string, members = reviewed) =>
		write(0, async (t, c) =>
			fields.propagateAddress(t, c, {
				requestKey: key(),
				expectedRevision: rev,
				input: { householdId: h.id, members },
			}),
		);
	refused(await untouched(admin, () => propagate(preview.household.revision)), "conflict");
	assert.equal((await rows(sql`SELECT street FROM person WHERE id=${sql.param(casey.id)}`))[0]!.street, "1 Own St");
	refused(await untouched(admin, () => propagate(edited.household.revision, reviewed.slice(1))), "conflict");
	const caseyRevision = await revisionOf(casey.id);
	ok(
		await write(0, async (t, c) =>
			people.updatePerson(t, c, {
				requestKey: key(),
				expectedRevision: caseyRevision,
				input: { personId: casey.id, patch: { street: "2 New St" } },
			}),
		),
	);
	refused(await untouched(admin, () => propagate(edited.household.revision)), "conflict");
	assert.equal((await rows(sql`SELECT street FROM person WHERE id=${sql.param(casey.id)}`))[0]!.street, "2 New St");
	const fresh = inHousehold(ok(await tx((t) => fields.getHouseholdMembers(t, ctx(), { householdId: h.id }))));
	const propagation = await recorded(admin, () =>
		propagate(
			fresh.household.revision,
			fresh.members.map((m) => ({ personId: m.personId, revision: m.revision })),
		),
	);
	assert.deepEqual(propagation.added, updated);
	const propagated = ok(propagation.value);
	assert.equal(propagated.updatedPeople, 3);
	assert.deepEqual(new Set(inHousehold(propagated.result).members.map((m) => m.street)), new Set(["10 Oak Ave"]));
	assert.deepEqual(await rows(sql`SELECT DISTINCT street FROM person WHERE household_id=${sql.param(h.id)}`), [
		{ street: "10 Oak Ave" },
	]);

	const left = ok(
		await write(0, async (t, c) =>
			fields.removeFromHousehold(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(casey.id),
				input: { personId: casey.id },
			}),
		),
	);
	assert.equal(inHousehold(left.result).household.memberCount, 2);
	assert.equal((await rows(sql`SELECT street FROM person WHERE id=${sql.param(casey.id)}`))[0]!.street, "10 Oak Ave");
	const current = inHousehold(ok(await tx((t) => fields.getHousehold(t, ctx(), { personId: head.id })))).household;
	refused(
		await write(0, async (t, c) =>
			fields.deleteHousehold(t, c, {
				requestKey: key(),
				expectedRevision: current.revision,
				input: { householdId: h.id },
			}),
		),
		"conflict",
	);

	const role = ok(
		await write(0, async (t, c) =>
			fields.setHouseholdRole(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(jamie.id),
				input: { personId: jamie.id, role: "other" },
			}),
		),
	);
	assert.deepEqual(
		inHousehold(role.result).members.map((m) => m.role),
		["head", "other"],
	);
	await retire({ id: jamie.id, revision: await revisionOf(jamie.id) });
	ok(
		await write(0, async (t, c) =>
			fields.removeFromHousehold(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(head.id),
				input: { personId: head.id },
			}),
		),
	);
	const empty = inHousehold(ok(await tx((t) => fields.getHousehold(t, ctx(), { householdId: h.id }))));
	assert.deepEqual([empty.household.memberCount, empty.members], [0, []]);
	const discard = (revision: string) =>
		write(0, async (t, c) =>
			fields.deleteHousehold(t, c, { requestKey: key(), expectedRevision: revision, input: { householdId: h.id } }),
		);
	const caseyJoins = await revisionOf(casey.id);
	const [joinedFirst, deletedLate] = await inTurn(
		() => join(casey, "other", caseyJoins),
		() => discard(empty.household.revision),
	);
	ok(joinedFirst!);
	refused(deletedLate!, "conflict");
	assert.equal((await rows(sql`SELECT household_id FROM person WHERE id=${casey.id}`))[0]!.household_id, h.id);
	const again = inHousehold(
		ok(
			await write(0, async (t, c) =>
				fields.removeFromHousehold(t, c, {
					requestKey: key(),
					expectedRevision: await revisionOf(casey.id),
					input: { personId: casey.id },
				}),
			),
		).result,
	);
	const joining = await person("Drew Joining");
	const [retiredFirst, joinedRetired] = await inTurn(await retirement(joining), () => join(joining, "other", "1"));
	ok(retiredFirst!);
	refused(joinedRetired!);
	const caseyReturns = await revisionOf(casey.id);
	const [deletedFirst, joinedLate] = await inTurn(
		() => discard(again.household.revision),
		() => join(casey, "other", caseyReturns),
	);
	ok(deletedFirst!);
	refused(joinedLate!);
	assert.deepEqual(await rows(sql`SELECT id FROM household WHERE plant_id=${plants[0]}`), []);
	assert.deepEqual(await rows(sql`SELECT id FROM person WHERE household_id IS NOT NULL AND plant_id=${plants[0]}`), []);
	assert.deepEqual(await crossing(), [{ n: 0 }]);
	assert.deepEqual(
		await rows(sql`SELECT x.id FROM household x WHERE NOT EXISTS(SELECT FROM person p WHERE p.household_id=x.id)`),
		[],
		"no household is left without a member",
	);
	assert.deepEqual(ok(await tx((t) => fields.getHousehold(t, ctx(), { personId: jamie.id }))), { status: "none" });
	const history = ok(await tx((t) => reads.getActivities(t, ctx(), { personId: jamie.id }))).items;
	assert.deepEqual(
		history
			.filter(isActivity)
			.filter((a) => a.household)
			.map((a) => [a.action, a.household?.from?.role ?? null, a.household?.to?.name, a.household?.to?.role]),
		[
			["updated", "child", "Rivera household", "other"],
			["updated", null, "Rivera household", "child"],
		],
	);
	assert.equal((await audit(h.id)).at(-1)!.action, "people.retired");
	assert.equal(ok(await tx((t) => fields.listHouseholds(t, ctx(), {}))).total, 0);
});

test("AC:TARGET-PPL-009 leave-and-delete: one transaction, a replay answers ok, a refused delete keeps the member", async () => {
	const start = async (name: string) => {
		const p = await person(name);
		const made = inHousehold(
			ok(
				await write(0, async (t, c) =>
					fields.createHouseholdWithHead(t, c, {
						requestKey: key(),
						expectedRevision: p.revision,
						input: { name: `${name} household`, headPersonId: p.id },
					}),
				),
			).result,
		).household;
		return { p, h: made };
	};
	const households = async (id: string) => rows(sql`SELECT id FROM household WHERE id=${sql.param(id)}`);
	const membership = async (id: string) =>
		(await rows<{ household_id: string | null }>(sql`SELECT household_id FROM person WHERE id=${sql.param(id)}`))[0]!
			.household_id;
	const leaving = (p: { id: string }, k: string, rev: string, deleteEmpty: boolean) =>
		write(0, (t, c) => leave(t, c, { requestKey: k, expectedRevision: rev, input: { personId: p.id } }, deleteEmpty));

	const one = await start("Morgan Lee");
	const k = key(),
		rev = await revisionOf(one.p.id);
	const first = ok(await leaving(one.p, k, rev, true));
	assert.equal(inHousehold(first.result).household.memberCount, 0);
	assert.equal(await membership(one.p.id), null);
	assert.deepEqual(await households(one.h.id), []);
	const again = ok(await leaving(one.p, k, rev, true));
	assert.deepEqual(again, first, "the replay answers with the committed leave");
	assert.deepEqual(await households(one.h.id), []);

	const two = await start("Sam Ortiz");
	ok(await leaving(two.p, key(), await revisionOf(two.p.id), false));
	assert.equal(await membership(two.p.id), null);
	assert.equal((await households(two.h.id)).length, 1);

	const three = await start("Ari Banks");
	const other = await person("Noa Banks");
	ok(
		await write(0, async (t, c) =>
			fields.addToHousehold(t, c, {
				requestKey: key(),
				expectedRevision: other.revision,
				input: { householdId: three.h.id, personId: other.id, role: "spouse" },
			}),
		),
	);
	const before = await revisionOf(three.p.id);
	refused(await leaving(three.p, key(), before, true), "conflict");
	assert.equal(await membership(three.p.id), three.h.id);
	assert.equal(await revisionOf(three.p.id), before);
	assert.equal((await households(three.h.id)).length, 1);
});

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
function privateStorage() {
	const objects = new Map<string, Buffer>();
	const client = new StubClient(async (operation, i) => {
		switch (operation) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand":
				assert.match(i.Key!, new RegExp(`^private/${plants[0]}/[a-f0-9-]{36}$`));
				assert.equal(i.ACL, "private");
				assert.ok(i.Body instanceof Uint8Array);
				objects.set(i.Key!, Buffer.from(i.Body));
				return {};
			case "GetObjectCommand": {
				const body = objects.get(i.Key!)!;
				return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
			}
			case "DeleteObjectCommand":
				objects.delete(i.Key!);
				return {};
			default:
				throw Error("unexpected provider operation");
		}
	});
	return { objects, bucket: "synthetic-only", client };
}
test("AC:TARGET-PPL-005 AC:PROVIDER48-002 AC:PROVIDER48-003 person photo: verified private bytes, exact-version reads, replace, remove and revoked or foreign access", async () => {
	const storage = privateStorage();
	const alex = await person("Alex Rivera");
	const upload = async (bytes: Uint8Array, who: Who = 0) => {
		const pending = ok(
			await write(who, async (t, c) =>
				fields.requestPersonPhotoUpload(t, c, {
					requestKey: key(),
					personId: alex.id,
					mime: "image/png",
					byteLength: bytes.length,
				}),
			),
		);
		return { pending, stored: await uploadPersonPhoto(db, storage, ctx(who), { uploadId: pending.uploadId, bytes }) };
	};
	const set = async (uploadId: string, who: Who = 0) =>
		write(who, async (t, c) =>
			fields.setPersonPhoto(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(alex.id),
				input: { personId: alex.id, uploadId },
			}),
		);
	const first = await upload(png);
	ok(first.stored);
	ok(await set(first.pending.uploadId));
	const version = { personId: alex.id, versionId: first.pending.uploadId };
	assert.deepEqual(ok(await tx((t) => fields.getPersonPhoto(t, ctx(1), { personId: alex.id }))), {
		status: "available",
		...version,
	});
	const delivered = ok(await readPersonPhoto(db, storage, ctx(1), version));
	assert.deepEqual([Buffer.from(delivered.bytes), delivered.mediaType], [png, "image/png"]);

	const broken = ok(
		await write(0, async (t, c) =>
			fields.requestPersonPhotoUpload(t, c, { requestKey: key(), personId: alex.id, mime: "image/png", byteLength: 9 }),
		),
	);
	refused(
		await uploadPersonPhoto(db, storage, ctx(), { uploadId: broken.uploadId, bytes: Buffer.from("not a png") }),
		"invalid_input",
	);
	refused(await set(broken.uploadId));
	refused(
		await write(1, async (t, c) =>
			fields.requestPersonPhotoUpload(t, c, {
				requestKey: key(),
				personId: alex.id,
				mime: "image/png",
				byteLength: png.length,
			}),
		),
	);
	assert.deepEqual(ok(await tx((t) => fields.getPersonPhoto(t, ctx(), { personId: alex.id }))), {
		status: "available",
		...version,
	});
	refused(await readPersonPhoto(db, storage, ctx(2), version));
	refused(await tx((t) => fields.getPersonPhoto(t, ctx(2), { personId: alex.id })));

	const second = await upload(png);
	const replaced = ok(await set(second.pending.uploadId));
	assert.equal(withStatus(replaced.photo, "available").versionId, second.pending.uploadId);
	refused(await readPersonPhoto(db, storage, ctx(), version));
	assert.ok(
		ok(await readPersonPhoto(db, storage, ctx(), { personId: alex.id, versionId: second.pending.uploadId })).bytes
			.length,
	);
	const cleanup = await rows(
		sql`SELECT subject_record_id FROM job WHERE kind='object_cleanup' AND eligible_at<=clock_timestamp()`,
	);
	assert.ok(cleanup.some((j) => j.subject_record_id === first.pending.uploadId));
	const other = await person("Casey Reed");
	refused(
		await write(0, async (t, c) =>
			fields.setPersonPhoto(t, c, {
				requestKey: key(),
				expectedRevision: other.revision,
				input: { personId: other.id, uploadId: second.pending.uploadId },
			}),
		),
	);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[1].id)}`);
	refused(await readPersonPhoto(db, storage, ctx(1), { personId: alex.id, versionId: second.pending.uploadId }));
	await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[1].id)}`);

	const removed = ok(
		await write(0, async (t, c) =>
			fields.removePersonPhoto(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(alex.id),
				input: { personId: alex.id },
			}),
		),
	);
	assert.deepEqual(removed.photo, { status: "absent" });
	refused(await readPersonPhoto(db, storage, ctx(), { personId: alex.id, versionId: second.pending.uploadId }));
	assert.equal(storage.objects.size, 2);
	assert.equal(await runDueObjectCleanup(db, storage, 10), 2);
	assert.equal(storage.objects.size, 0);
	const third = await upload(png);
	ok(await set(third.pending.uploadId));
	await retire({ id: alex.id, revision: await revisionOf(alex.id) });
	refused(await tx((t) => fields.getPersonPhoto(t, ctx(), { personId: alex.id })));
	refused(await readPersonPhoto(db, storage, ctx(), { personId: alex.id, versionId: third.pending.uploadId }));
});

const sharp = createRequire(import.meta.url)("../../../../packages/db/node_modules/sharp");
async function jpegOf(size: number) {
	const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#2e7d32" } })
		.jpeg()
		.toBuffer();
	const parts = [image.subarray(0, 2)];
	for (let left = size - image.length; left > 0;) {
		const payload = Math.min(65533, left - 4);
		assert.ok(payload >= 0, "a size the padding can reach");
		const segment = Buffer.alloc(4 + payload, 0x20);
		segment.writeUInt16BE(0xfffe, 0);
		segment.writeUInt16BE(payload + 2, 2);
		parts.push(segment);
		left -= segment.length;
	}
	parts.push(image.subarray(2));
	const bytes = Buffer.concat(parts);
	assert.equal(bytes.length, size);
	return bytes;
}

test("AC:TARGET-PPL-005 peo-51 peo-52 a 1.5 MB photo saves, and a replay of its request key after a lost answer answers the saved change with one upload", async () => {
	const storage = privateStorage();
	const { answer } = storage.client;
	let puts = 0;
	storage.client.answer = async (operation, input) => {
		if (operation === "PutObjectCommand") puts++;
		return answer(operation, input);
	};
	const sam = await person("Sam Ortiz");
	const photo = await jpegOf(1_500_000);
	const change = async (requestKey: string, expectedRevision: string, bytes: Uint8Array) => {
		const staged = ok(
			await write(0, async (t, c) =>
				fields.requestPersonPhotoUpload(t, c, {
					requestKey,
					personId: sam.id,
					mime: "image/jpeg",
					byteLength: bytes.length,
				}),
			),
		);
		ok(await uploadPersonPhoto(db, storage, ctx(), { uploadId: staged.uploadId, bytes }));
		const saved = ok(
			await write(0, async (t, c) =>
				fields.setPersonPhoto(t, c, {
					requestKey,
					expectedRevision,
					input: { personId: sam.id, uploadId: staged.uploadId },
				}),
			),
		);
		return { uploadId: staged.uploadId, saved };
	};
	const uploads = async () =>
		(
			await rows<{ n: number }>(
				sql`SELECT count(*)::int n FROM file_object WHERE tenant_id=${sql.param(plants[0])} AND purpose='person_photo'`,
			)
		)[0]!.n;
	const updates = async () =>
		(
			await rows<{ n: number }>(
				sql`SELECT count(*)::int n FROM audit_event WHERE subject_id=${sql.param(sam.id)} AND command_id=id AND action='people.updated'`,
			)
		)[0]!.n;
	const before = { uploads: await uploads(), updates: await updates() };

	const requestKey = key();
	const first = await change(requestKey, sam.revision, photo);
	assert.equal(first.saved.outcome, "changed");
	assert.deepEqual(first.saved.photo, { status: "available", personId: sam.id, versionId: first.uploadId });
	const replay = await change(requestKey, sam.revision, photo);
	assert.deepEqual(replay, first);
	assert.equal((await uploads()) - before.uploads, 1);
	assert.equal(puts, 1);
	assert.equal(storage.objects.size, 1);
	assert.equal(await revisionOf(sam.id), String(Number(sam.revision) + 1));
	assert.equal((await updates()) - before.updates, 1);
	assert.deepEqual(ok(await tx((t) => fields.getPersonPhoto(t, ctx(1), { personId: sam.id }))), first.saved.photo);
	const delivered = ok(await readPersonPhoto(db, storage, ctx(1), { personId: sam.id, versionId: first.uploadId }));
	assert.deepEqual([Buffer.from(delivered.bytes).equals(photo), delivered.mediaType], [true, "image/jpeg"]);

	const stage = (requestKey: string, byteLength: number) =>
		write(0, async (t, c) =>
			fields.requestPersonPhotoUpload(t, c, { requestKey, personId: sam.id, mime: "image/jpeg", byteLength }),
		);
	assert.equal(ok(await stage(requestKey, photo.length)).uploadId, first.uploadId);
	assert.notEqual(ok(await stage(key(), photo.length)).uploadId, first.uploadId);
	refused(await stage(requestKey, photo.length - 1), "conflict");

	const largest = await jpegOf(3 * 1024 * 1024);
	const big = await change(key(), await revisionOf(sam.id), largest);
	assert.equal(big.saved.outcome, "changed");
	refused(await stage(key(), largest.length + 1), "invalid_input");
});

test("INV-tenancy C13: a seat ended after the request resolved its actor reads no people-fields data", async () => {
	const p = await person("Morgan Lee");
	const home = inHousehold(
		ok(
			await write(0, async (t, c) =>
				fields.createHouseholdWithHead(t, c, {
					requestKey: key(),
					expectedRevision: await revisionOf(p.id),
					input: { name: "Lee household", headPersonId: p.id },
				}),
			),
		).result,
	).household;
	const storage = privateStorage();
	const pending = ok(
		await write(0, async (t, c) =>
			fields.requestPersonPhotoUpload(t, c, {
				requestKey: key(),
				personId: p.id,
				mime: "image/png",
				byteLength: png.length,
			}),
		),
	);
	ok(await uploadPersonPhoto(db, storage, ctx(), { uploadId: pending.uploadId, bytes: png }));
	ok(
		await write(0, async (t, c) =>
			fields.setPersonPhoto(t, c, {
				requestKey: key(),
				expectedRevision: await revisionOf(p.id),
				input: { personId: p.id, uploadId: pending.uploadId },
			}),
		),
	);
	const actor = await gatedTransaction(db, (t) => RequestActor.resolve(t, actors[1].session));
	assert.ok(actor instanceof RequestActor);
	const reads: Record<string, (t: WriteTx, c: PeopleReadContext) => Promise<Reply<unknown>>> = {
		listTags: (t, c) => fields.listTags(t, c, {}),
		getPersonTags: (t, c) => fields.getPersonTags(t, c, { personId: p.id }),
		getPersonSkills: (t, c) => fields.getPersonSkills(t, c, { personId: p.id }),
		listHouseholds: (t, c) => fields.listHouseholds(t, c, {}),
		getHousehold: (t, c) => fields.getHousehold(t, c, { householdId: home.id }),
		getHouseholdByPerson: (t, c) => fields.getHousehold(t, c, { personId: p.id }),
		getHouseholdMembers: (t, c) => fields.getHouseholdMembers(t, c, { householdId: home.id }),
		getPersonPhoto: (t, c) => fields.getPersonPhoto(t, c, { personId: p.id }),
		readPersonPhoto: (_t, c) => readPersonPhoto(db, storage, c, { personId: p.id, versionId: pending.uploadId }),
	};
	const run = (read: (t: WriteTx, c: PeopleReadContext) => Promise<Reply<unknown>>) =>
		gatedTransaction(db, (t) => read(t, new PeopleReadContext(actor)));
	for (const read of Object.values(reads)) ok(await run(read));
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${sql.param(actors[1].id)}`);
	try {
		for (const [name, read] of Object.entries(reads)) {
			const result = await run(read);
			assert.equal(result.status, "refused", name + " returned data after the seat ended");
		}
	} finally {
		await admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${sql.param(actors[1].id)}`);
	}
});
