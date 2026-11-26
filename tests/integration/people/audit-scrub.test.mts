import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { backfill } from "../../../packages/db/src/schema/migrate.ts";
import { peopleAuditScrubBackfill } from "../../../packages/domain/src/people/audit-backfill.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { ok } from "../../support/fixture.mts";
import { world } from "../target/sql/core/support.mts";
import { reads } from "./people-support.mts";

const w = await world("t677scrub");
const { admin, P, rows, one } = w;
after(async () => {
	await w.database.close();
});

const CANARY = {
	name: "Quillon Scrubcanary",
	renamed: "Quillon R Scrubcanary",
	email: "quillon.scrubcanary@example.test",
	phone: "555 0142 8822",
	street: "19 Scrubcanary Row",
	city: "Scrubcanaryton",
	notes: "Scrubcanary private summary",
	household: "Scrubcanary Burrow",
	movedHousehold: "Scrubcanary Warren",
	guardian: "Ottoline Scrubcanary",
	skill: "Scrubcanary Banjo",
	skillNotes: "Scrubcanary plays on Sundays",
	note: "Scrubcanary note body about a private matter",
	edited: "Scrubcanary note body corrected",
	guest: "Pipit Scrubcanary",
	guestEmail: "pipit.scrubcanary@example.test",
	linked: "Linnet Scrubcanary",
};
const UNTOUCHED = { stage: "core_group", label: "Kept outside the scrub" };

type Values = Record<string, unknown> | null;
let at = Date.parse("2026-10-13T12:00:00Z");
async function plant(
	subject: string,
	action: string,
	kind: string,
	before: Values,
	afterValue: Values,
	metadata: Record<string, unknown> = {},
) {
	const id = randomUUID();
	at += 60_000;
	await admin.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,
		before_value,after_value,before_revision,after_revision,reason,metadata,occurred_at,recorded_at)
		VALUES(${id},${P},${w.actors.admin.id},${action},${kind},'person',${subject},
		${before === null ? null : JSON.stringify(before)}::jsonb,${afterValue === null ? null : JSON.stringify(afterValue)}::jsonb,
		${before === null ? null : "1"},'2',${kind === "edit" ? "Legacy reason" : null},${JSON.stringify(metadata)}::jsonb,
		${new Date(at).toISOString()}::timestamptz,clock_timestamp())`);
	return id;
}
const wholeRow = async (id: string, extra: Record<string, unknown>) => ({
	...(
		await one<{ row: Record<string, unknown> }>(
			sql`SELECT to_jsonb(p)-'revision' AS row FROM person p WHERE id=${id}::uuid`,
		)
	).row,
	...extra,
});
const values = async (id: string) =>
	one<{ before_value: unknown; after_value: unknown }>(
		sql`SELECT before_value,after_value FROM audit_event WHERE id=${id}::uuid`,
	);
const untouchedColumns = () =>
	rows(sql`SELECT to_jsonb(a)-'before_value'-'after_value' AS row FROM audit_event a ORDER BY id`);
const fullRows = (ids: string[]) =>
	rows(sql`SELECT id,to_jsonb(a)::text AS row FROM audit_event a WHERE id=ANY(${sql.param(ids)}::uuid[]) ORDER BY id`);
const leaks = async () =>
	(
		await rows<{ leaked: string }>(sql`SELECT DISTINCT c.value AS leaked FROM audit_event a
			CROSS JOIN unnest(${sql.param(Object.values(CANARY))}::text[]) c(value)
			WHERE a.tenant_id=${P}::uuid AND strpos(lower(concat_ws(' ',a.before_value::text,a.after_value::text)),lower(c.value))>0
			ORDER BY 1`)
	).map((r) => r.leaked);
const history = async (personId: string) => ok(await w.tx((t) => reads.getActivities(t, w.ctx(), { personId }))).items;

test("the people audit scrub leaves legacy people.created/people.updated rows in the shape writers store today", async () => {
	const person = await w.person(CANARY.name, { email: CANARY.email, phone: CANARY.phone });
	const guardian = await w.person(CANARY.guardian);
	const child = await w.person("Child of the scrub", { adultClassification: "child" });
	const guest = await w.person(CANARY.guest, { email: CANARY.guestEmail });
	const linked = await w.person(CANARY.linked);
	const current = await w.person("Current shape person", { email: "current.shape@example.test" });
	await w.update(current, { email: null, city: "Wheaton" });
	const note = ok(
		await w.write.people(peopleWriter.addNote, {
			requestKey: randomUUID(),
			expectedRevision: (await w.personRow(person)).revision,
			input: { personId: person, body: CANARY.note },
		}),
	);
	const household = await w.insert("household", { name: CANARY.movedHousehold });
	const goneHousehold = await w.insert("household", { name: CANARY.household });
	const removedGuardian = randomUUID();
	const merged = await w.merge(await w.person("Unmerge source"), await w.person("Unmerge survivor"));
	const survivor = (
		await one<{ survivor_id: string }>(sql`SELECT survivor_id FROM person_merge WHERE id=${merged.mergeId}::uuid`)
	).survivor_id;
	const skill = randomUUID(),
		photo = randomUUID();

	const legacy = {
		survivorEdit: await plant(survivor, "people.updated", "edit", { city: null }, { city: CANARY.city }),
		create: await plant(
			person,
			"people.created",
			"create",
			null,
			await wholeRow(person, {
				notes: CANARY.notes,
				birth_date: "1984-02-29",
				street: CANARY.street,
				city: CANARY.city,
			}),
		),
		guestCreate: await plant(guest, "people.created", "create", null, await wholeRow(guest, { phone: CANARY.phone }), {
			meetingId: randomUUID(),
			guestId: randomUUID(),
			attended: false,
		}),
		linkCreate: await plant(linked, "people.created", "create", null, await wholeRow(linked, {})),
		linkUpdate: await plant(
			person,
			"people.updated",
			"edit",
			{ linked_account_id: null },
			{ linked_account_id: w.actors.member.id },
		),
		contact: await plant(
			person,
			"people.updated",
			"edit",
			{ display_name: CANARY.name, email: CANARY.email, phone: CANARY.phone, street: CANARY.street, city: CANARY.city },
			{ display_name: CANARY.renamed, email: null, phone: null, street: null, city: CANARY.street },
		),
		joined: await plant(
			person,
			"people.updated",
			"edit",
			{ membership: null, street: null },
			{ membership: { householdId: goneHousehold, role: "other", name: CANARY.household }, street: CANARY.street },
		),
		moved: await plant(
			person,
			"people.updated",
			"edit",
			{ membership: { householdId: goneHousehold, role: "other", name: CANARY.household } },
			{ membership: { householdId: household, role: "spouse", name: CANARY.movedHousehold } },
		),
		guardianAdded: await plant(
			child,
			"people.updated",
			"edit",
			{ guardian: null },
			{ guardian: { personId: guardian, displayName: CANARY.guardian } },
		),
		guardianRemoved: await plant(
			child,
			"people.updated",
			"edit",
			{ guardian: { personId: removedGuardian, displayName: CANARY.guardian } },
			{ guardian: null },
		),
		skill: await plant(
			person,
			"people.updated",
			"edit",
			{ skill: null },
			{
				skill: { id: skill, category: "music", proficiency: "advanced", name: CANARY.skill, notes: CANARY.skillNotes },
			},
		),
		lifecycle: await plant(
			person,
			"people.updated",
			"edit",
			{ commitment: { state: null, effectiveOn: null }, photo: null, notes: CANARY.notes },
			{ commitment: { state: "active", effectiveOn: "2026-09-01" }, photo, notes: null },
		),
		propagated: await plant(
			guardian,
			"people.updated",
			"edit",
			{ propagated: null, street: CANARY.street, city: CANARY.city },
			{ propagated: { people: [person, child] }, street: null, city: null },
		),
		partlyScrubbed: await plant(
			person,
			"people.updated",
			"edit",
			{ stage: "prospect", phone: CANARY.phone },
			{ stage: "core_group", phone: null, fields: ["source", "email"] },
		),
		noteEdit: await plant(
			person,
			"people.updated",
			"edit",
			{ body: CANARY.note },
			{ body: CANARY.edited },
			{ category: "note", noteId: note.noteId, correction: true },
		),
		noteDelete: await plant(
			person,
			"people.updated",
			"edit",
			{ body: CANARY.edited },
			{ body: "" },
			{ category: "note", noteId: note.noteId, correction: true },
		),
	};
	const shaped = {
		create: await plant(person, "people.created", "create", null, { stage: "prospect" }),
		update: await plant(
			person,
			"people.updated",
			"edit",
			{ stage: "prospect" },
			{ stage: "core_group", fields: ["city"] },
		),
		fieldsOnly: await plant(person, "people.updated", "edit", {}, { fields: ["display_name", "email"] }),
	};
	const other = {
		stage: await plant(person, "people.stage_changed", "stage_change", { stage: "prospect" }, UNTOUCHED),
		corrected: await plant(person, "people.corrected", "correct", { stage: "prospect" }, UNTOUCHED),
	};
	const written = (
		await rows<{ id: string }>(sql`SELECT id FROM audit_event WHERE tenant_id=${P}::uuid
			AND id<>ALL(${sql.param([...Object.values(legacy), ...Object.values(shaped), ...Object.values(other)])}::uuid[])`)
	).map((r) => r.id);
	assert.ok(written.length > 0, "writers stored rows in today's shape");

	await admin.execute(sql`DELETE FROM household WHERE id=${goneHousehold}::uuid`);
	const legacyIds = Object.values(legacy);
	const keptIds = [...Object.values(shaped), ...Object.values(other), ...written];
	const subjects = [person, child, guardian, guest, linked];
	const historyBefore = await Promise.all(subjects.map(history));
	const staysBefore = ok(await w.preview(merged.mergeId)).staysFields;
	assert.deepEqual(staysBefore, ["address"], "the unmerge check sees a field a legacy row edited");
	assert.deepEqual((await leaks()).sort(), Object.values(CANARY).sort(), "every canary is planted before the scrub");
	const keptBefore = await fullRows(keptIds);
	const columnsBefore = await untouchedColumns();

	assert.deepEqual(await backfill(admin, [peopleAuditScrubBackfill(3)], w.database.schema), [
		{ name: "people_audit_values_scrub_t677", changed: legacyIds.length },
	]);
	assert.deepEqual(
		await rows(
			sql`SELECT name,changed::int AS changed FROM schema_backfill WHERE name='people_audit_values_scrub_t677'`,
		),
		[{ name: "people_audit_values_scrub_t677", changed: legacyIds.length }],
	);

	const scrubbed = Object.fromEntries(
		await Promise.all(Object.entries(legacy).map(async ([name, id]) => [name, await values(id)] as const)),
	);
	assert.deepEqual(scrubbed, {
		survivorEdit: { before_value: {}, after_value: { fields: ["city"] } },
		create: { before_value: null, after_value: { stage: "prospect" } },
		guestCreate: { before_value: null, after_value: { stage: "prospect" } },
		linkCreate: { before_value: null, after_value: { stage: "prospect" } },
		linkUpdate: { before_value: {}, after_value: { fields: ["linked_account_id"] } },
		contact: { before_value: {}, after_value: { fields: ["city", "display_name", "email", "phone", "street"] } },
		joined: {
			before_value: { membership: null },
			after_value: { membership: { householdId: goneHousehold, role: "other" }, fields: ["street"] },
		},
		moved: {
			before_value: { membership: { householdId: goneHousehold, role: "other" } },
			after_value: { membership: { householdId: household, role: "spouse" } },
		},
		guardianAdded: { before_value: { guardian: null }, after_value: { guardian: { personId: guardian } } },
		guardianRemoved: { before_value: { guardian: { personId: removedGuardian } }, after_value: { guardian: null } },
		skill: {
			before_value: { skill: null },
			after_value: { skill: { id: skill, category: "music", proficiency: "advanced" } },
		},
		lifecycle: {
			before_value: { commitment: { state: null, effectiveOn: null }, photo: null },
			after_value: { commitment: { state: "active", effectiveOn: "2026-09-01" }, photo, fields: ["notes"] },
		},
		propagated: {
			before_value: { propagated: null },
			after_value: { propagated: { people: [person, child] }, fields: ["city", "street"] },
		},
		partlyScrubbed: {
			before_value: { stage: "prospect" },
			after_value: { stage: "core_group", fields: ["email", "phone", "source"] },
		},
		noteEdit: { before_value: null, after_value: null },
		noteDelete: { before_value: null, after_value: null },
	});
	assert.deepEqual(await leaks(), [], "no canary is left in any audit value of the church");
	assert.deepEqual(
		await rows(sql`SELECT body FROM person_note WHERE id=${note.noteId}::uuid`),
		[{ body: CANARY.note }],
		"the note text stays on person_note",
	);
	assert.deepEqual(await fullRows(keptIds), keptBefore, "rows already in shape and other actions stay byte-identical");
	assert.deepEqual(
		await untouchedColumns(),
		columnsBefore,
		"only before_value and after_value change, no row is added or lost",
	);

	assert.deepEqual(await Promise.all(subjects.map(history)), historyBefore, "history reads the same after the scrub");
	assert.deepEqual(ok(await w.preview(merged.mergeId)).staysFields, staysBefore);
	const households = (await history(person)).flatMap((i) =>
		i.kind === "activity" && i.household ? [[i.household.from?.name ?? null, i.household.to?.name ?? null]] : [],
	);
	assert.deepEqual(households, [
		["a deleted household", CANARY.movedHousehold],
		[null, "a deleted household"],
	]);
	const guardians = (await history(child)).flatMap((i) =>
		i.kind === "activity" && i.guardian ? [[i.guardian.change, i.guardian.displayName]] : [],
	);
	assert.deepEqual(guardians, [
		["removed", "A removed person"],
		["added", CANARY.guardian],
	]);

	const all = await fullRows([...legacyIds, ...keptIds]);
	assert.equal(await w.admin.transaction((tx) => peopleAuditScrubBackfill(2).run(tx)), 0);
	assert.deepEqual(await fullRows([...legacyIds, ...keptIds]), all, "a second run changes nothing");
	assert.deepEqual(await backfill(admin, [peopleAuditScrubBackfill()], w.database.schema), [], "migrate skips it");
});
