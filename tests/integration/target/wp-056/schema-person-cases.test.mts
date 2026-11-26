import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "../../../../packages/db/src/query.ts";
import { registry } from "../../../../packages/domain/src/people/person-reference-registry/index.ts";
import { commitments } from "../../../../packages/domain/src/people/index.ts";
import { ok } from "../../../support/fixture.mts";
import { key, world, type Row } from "../sql/core/support.mts";
import { accepts, schemaCase } from "./schema-probe.mts";

const w = await world("schema009");
const { P, rows, one, insert, person, personRow, selectable } = w;
after(() => w.database.close());

const PAST = "2026-10-01T12:00:00Z";
type Reference = {
	table: string;
	columns: string[];
	target_columns: string[];
	merge_policy?: string;
	inverse_policy?: string;
	retirement_policy?: string;
};
const source = JSON.parse(
	readFileSync(new URL("../../../../docs/architecture/person-references.json", import.meta.url), "utf8"),
) as { person_references: Reference[]; person_snapshot_references: { table: string; field: string; policy: string }[] };

const meeting = (title: string) =>
	insert("meeting", {
		type: "vision_meeting",
		title,
		local_date: "2026-10-01",
		local_time: "18:00",
		timezone: "America/Chicago",
		starts_at: "2026-10-01T23:00:00Z",
		resolver_version: "1",
		status: "completed",
		attendance_revision: 1,
	});
const attend = (meetingId: string, personId: string, values: Row = {}) =>
	insert("participation", {
		meeting_id: meetingId,
		person_id: personId,
		roster_member: false,
		presence: "attended",
		...values,
	});
const task = (personId: string) =>
	insert("task", {
		title: "Call them",
		category: "follow_up",
		priority: "medium",
		status: "not_started",
		created_at: PAST,
		due_kind: "undated",
		person_id: personId,
	});

async function consumers(p2: string, p1: string) {
	const team = await insert("team", {
		name: `Hospitality ${key()}`,
		state: "active",
		sort_order: 1,
		leader_person_id: p2,
		leader_source: "explicit",
	});
	const role = await insert("team_role", { team_id: team, name: "Greeter", leadership: false, sort_order: 1 });
	await insert("team_tenure", { role_id: role, person_id: p2, started_on: "2026-06-01" });
	const program = await insert("training_program", { name: `Welcome ${key()}`, required: true });
	await insert("training_assignment", {
		program_id: program,
		person_id: p2,
		version: 1,
		state: "active",
		effective_on: "2026-10-01",
	});
	await attend(await meeting("Only theirs"), p2, {
		rsvp: "confirmed",
		rsvp_source: "admin",
		rsvp_at: PAST,
		card_response: "interested",
		card_recorded_at: PAST,
		card_occurred_at: PAST,
		card_author_id: w.actors.owner.id,
	});
	const shared = await meeting("Both came");
	await attend(shared, p1);
	await attend(shared, p2);
	ok(
		await w.tx((t) =>
			commitments.createCommitment(t, w.ctx(), {
				requestKey: key(),
				input: { personId: p2, kind: "core_group", occurredOn: "2026-10-01" },
			}),
		),
	);
	await w.admin.execute(sql`INSERT INTO launch(plant_id,status) VALUES(${P},'planning') ON CONFLICT DO NOTHING`);
	await insert("launch_guest", { person_id: p2, recorded_by: w.actors.owner.id, recorded_at: PAST });
	await task(p2);
	const mailId = key();
	await insert("mail", {
		id: mailId,
		plant_id: undefined,
		tenant_id: P,
		recipient_person_id: p2,
		purpose: "communication",
		logical_key: `communication/${mailId}/${p2}`,
		payload_hash: "payload",
		audience_hash: "audience",
		frozen_payload: JSON.stringify({ subject: "Welcome", to: "old@example.test" }),
		recipient_address_encrypted: "sealed-address",
		address_hash: "hash",
		created_at: PAST,
		state: "scheduled",
		scheduled_at: "2026-11-01T12:00:00Z",
	});
	await insert("interview", {
		person_id: p2,
		interviewed_on: "2026-10-01",
		recorded_at: PAST,
		maturity: "pass",
		gifted: "pass",
		chemistry: "pass",
		right_reasons: "pass",
		season: "pass",
		result: "qualified",
	});
	await insert("person_note", {
		tenant_id: P,
		person_id: p2,
		author_id: w.actors.owner.id,
		body: "Met at the picnic",
		occurred_at: PAST,
		recorded_at: PAST,
	});
	const household = await insert("household", { name: "Chen home" });
	await w.admin.execute(
		sql`UPDATE person SET household_id=${household}::uuid,household_role='head' WHERE id=${p2}::uuid`,
	);
}

const LIVE: Record<string, ReturnType<typeof sql>> = {
	participation: sql`AND x.removed_at IS NULL`,
	obligation: sql`AND x.superseded_at IS NULL`,
};
async function dangling(p2: string) {
	const left: string[] = [];
	for (const e of registry) {
		if (e.treatment === "keep") continue;
		const live = LIVE[e.table] ?? sql``;
		const moving = e.moves ? sql`AND ${e.moves(sql`x`)}` : sql``;
		const n = Number(
			(
				await one(
					sql`SELECT count(*)::int AS n FROM ${sql.identifier(e.table)} x WHERE x.${sql.identifier(e.column)}=${p2}::uuid ${live} ${moving}`,
				)
			).n,
		);
		if (n) left.push(`${e.table}.${e.column}:${n}`);
	}
	return left;
}
const seeded = async (p2: string) =>
	(
		await rows<{ k: string }>(
			sql`SELECT DISTINCT k FROM (${sql.join(
				registry.map(
					(e) =>
						sql`SELECT ${`${e.table}.${e.column}`}::text AS k FROM ${sql.identifier(e.table)} WHERE ${sql.identifier(e.column)}=${p2}::uuid`,
				),
				sql` UNION ALL `,
			)}) u ORDER BY k`,
		)
	).map((r) => r.k);
const newReference = (personId: string) =>
	accepts(
		w.admin,
		sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,person_id)
			VALUES(gen_random_uuid(),${P},'New call','follow_up','medium','not_started',${PAST},'undated',${personId}::uuid)`,
	);

test("AC:SCHEMA-009 every Person reference in the catalog is registered with merge, inverse and retirement policies, and a merged or retired Person keeps no operational reference", async () => {
	const c = schemaCase("SCHEMA-009");
	const declared = (
		await rows<{ t: string; cols: string[]; target: string[] }>(sql`SELECT c.conrelid::regclass::text AS t,
			array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.i) AS cols,
			array(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,i) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.i) AS target
			FROM pg_constraint c WHERE c.contype='f' AND c.confrelid=${w.database.schema + ".person"}::regclass`)
	).map((d) => ({ ...d, t: d.t.replace(w.database.schema + ".", "") }));
	const keyOf = (table: string, cols: readonly string[], target: readonly string[]) =>
		`${table}(${cols.join(",")})->(${target.join(",")})`;
	const catalog = declared.map((d) => keyOf(d.t, d.cols, d.target)).sort();
	const filed = source.person_references.map((r) => keyOf(r.table, r.columns, r.target_columns)).sort();
	assert.deepEqual(filed, catalog, "the source names exactly the catalog's Person foreign keys");
	const registered = new Set(registry.map((e) => `${e.table}.${e.column}`));
	assert.deepEqual(
		declared.map((d) => `${d.t}.${d.cols[0]}`).filter((x) => !registered.has(x)),
		[],
		"every Person foreign key has a merge registration",
	);
	for (const s of source.person_snapshot_references) {
		assert.ok(s.policy.trim().length > 0, `${s.table}.${s.field}`);
		for (const field of s.field.split("/"))
			assert.equal(
				(
					await one(
						sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=${s.table} AND column_name=${field}`,
					)
				).n,
				1,
				`${s.table}.${field} is a real column`,
			);
	}
	const missing = (policy: "merge_policy" | "inverse_policy" | "retirement_policy") =>
		source.person_references.filter((r) => !r[policy]?.trim()).map((r) => `${r.table}.${r.columns[0]}`);

	const p1 = await person("Alex Rivera"),
		p2 = await person("Alex Chen");
	await consumers(p2, p1);
	const families = await seeded(p2);
	for (const family of [
		"team.leader_person_id",
		"team_tenure.person_id",
		"training_assignment.person_id",
		"participation.person_id",
		"commitment.person_id",
		"launch_guest.person_id",
		"task.person_id",
		"mail.recipient_person_id",
		"person_note.person_id",
		"interview.person_id",
	])
		assert.ok(families.includes(family), `${family} seeded: ${families.join()}`);
	assert.equal(await selectable(p2, "Alex Chen"), true);
	assert.notDeepEqual(await dangling(p2), []);
	await w.merge(p2, p1);
	assert.equal((await personRow(p2)).state, "merged");
	assert.equal(await newReference(p2), false, "a merged Person takes no new operational reference");

	const p3 = await person("Jamie Retiring");
	await task(p3);
	await w.retire(p3);
	assert.equal((await personRow(p3)).state, "retired");
	assert.equal(await selectable(p3, "Jamie Retiring"), false);
	assert.equal(await newReference(p3), false, "a retired Person takes no new operational reference");
	assert.equal(await newReference(p1), true);

	const result = {
		registered_fk_count: filed.length,
		registered_frozen_generic_count: source.person_snapshot_references.length,
		missing_collision_policies: missing("merge_policy"),
		missing_inverse_policies: missing("inverse_policy"),
		missing_retirement_policies: missing("retirement_policy"),
		dangling_references: (await dangling(p2)).length,
		operational_P2_visible: await selectable(p2, "Alex Chen"),
	};
	assert.deepEqual(result, {
		...c.expected.result,
		registered_fk_count: catalog.length,
		registered_frozen_generic_count: source.person_snapshot_references.length,
	});
	assert.equal(c.expected.event, null);
});
