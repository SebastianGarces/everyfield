import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { fixture, ok, type Actor } from "../../../support/fixture.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const given = (c: Case, name: string) => c.given[name] ?? assert.fail(`no fixture ${name}`);

const database = await fixture({
	prefix: "tencases",
	plant: { name: "Harvest Point" },
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
});
after(() => database.close());
const { admin } = database;
const P = database.tenant.id;
const Q = (await database.plant({ name: "Grace Hill", timezone: "America/New_York" })).id;
const S1 = (await database.organization("sending_church", { name: "Grace Austin" })).id;
const S2 = (await database.organization("sending_church", { name: "Cedar Park Church" })).id;
type Runner = Pick<typeof admin, "execute">;
const rowsOf = async (query: SQL, pool: Runner = admin) => (await pool.execute(query)).rows;
const actorOf = async (who: Actor, pool = database.pools.runtime) => {
	const actor = await RequestActor.resolve(pool, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const code = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code;

const OWNER = ["tenant_id", "plant_id", "organization_id"] as const;
type OwnerColumn = (typeof OWNER)[number];
const isOwner = (column: string): column is OwnerColumn => (OWNER as readonly string[]).includes(column);
type Fk = { oid: number; child: string; parent: string; name: string; cols: string[]; rcols: string[] };
type Column = { name: string; type: string; notnull: boolean; generated: boolean; pk: boolean };
const ROOTS = new Set(["tenant", "plant", "organization"]);

const fks =
	(await rowsOf(sql`SELECT c.oid::int AS oid, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
	c.conname AS name,
	array(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o) AS cols,
	array(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,o) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.o) AS rcols
	FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
	WHERE c.contype='f' AND n.nspname=current_schema() ORDER BY 2,4`)) as Fk[];
const bare = (table: string) => table.split(".").pop()!;

async function columnsOf(table: string) {
	return (await rowsOf(sql`SELECT a.attname::text AS name, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull AS notnull,
		a.attgenerated<>'' AS generated,
		EXISTS(SELECT FROM pg_index i WHERE i.indrelid=a.attrelid AND i.indisprimary AND a.attnum=ANY(i.indkey)) AS pk
		FROM pg_attribute a WHERE a.attrelid=${table}::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`)) as Column[];
}

const rootOf = (table: string, column: string) =>
	fks.find((f) => f.child === table && f.cols.length === 1 && f.cols[0] === column && ROOTS.has(bare(f.parent)))
		?.parent;
const homeOf = (table: string, column: string) => {
	const root = rootOf(table, column);
	return root === "organization" || (root !== "plant" && column === "organization_id") ? S1 : P;
};
const variantsOf = (owner: string) => ({
	foreign_plant: owner === P ? Q : P,
	foreign_org: owner === S1 ? S2 : S1,
});
const ROLLBACK = Symbol("rollback");
let serial = 1000;
const valueOf = (columns: Column[], name: string) => {
	const type = columns.find((c) => c.name === name)?.type ?? assert.fail(`no column ${name}`);
	return type === "uuid" ? randomUUID() : /int|numeric/.test(type) ? String(++serial) : `probe-${++serial}`;
};
type Outcome = { accepted: boolean; code?: string; constraint?: string };

async function relax(tx: Runner, table: string, keep: number) {
	await tx.execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`));
	const constraints = (await rowsOf(
		sql`SELECT c.oid::int AS oid, c.conname AS name, c.contype AS type, c.confrelid::regclass::text AS parent,
		array(SELECT a.attname::text FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n) AS cols
		FROM pg_constraint c WHERE c.conrelid=${table}::regclass AND c.contype IN ('c','f','x')`,
		tx,
	)) as { oid: number; name: string; type: string; parent: string; cols: string[] }[];
	for (const c of constraints) {
		const ownerOnly = c.cols.length > 0 && c.cols.every(isOwner);
		const kept =
			c.oid === keep || (c.type === "f" && ownerOnly && ROOTS.has(bare(c.parent))) || (c.type === "c" && ownerOnly);
		if (!kept) await tx.execute(sql.raw(`ALTER TABLE ${table} DROP CONSTRAINT "${c.name}"`));
	}
	for (const c of await columnsOf(table))
		if (c.notnull && !c.pk && !isOwner(c.name))
			await tx.execute(sql.raw(`ALTER TABLE ${table} ALTER COLUMN "${c.name}" DROP NOT NULL`));
}

async function insertRow(tx: Runner, table: string, row: Record<string, unknown>, columns: Column[]) {
	const typed = new Map(columns.map((c) => [c.name, c.type]));
	for (const c of columns) if (c.pk && !(c.name in row)) row[c.name] = valueOf(columns, c.name);
	const names = Object.keys(row);
	await tx.execute(
		sql`INSERT INTO ${sql.raw(table)}(${sql.raw(names.map((n) => `"${n}"`).join(","))}) VALUES(${sql.join(
			names.map((n) => sql`${row[n]}::${sql.raw(typed.get(n)!)}`),
			sql`,`,
		)})`,
	);
}

async function probe(fk: Fk) {
	const outcomes: Record<string, Outcome> = {};
	await admin
		.transaction(async (tx) => {
			await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
			for (const table of new Set([fk.child, fk.parent])) await relax(tx, table, fk.oid);
			const childColumns = await columnsOf(fk.child);
			const parentColumns = fk.child === fk.parent ? childColumns : await columnsOf(fk.parent);
			const pairs = fk.cols.map((c, i) => [c, fk.rcols[i]!] as const);
			const ownerPair = pairs.find(([c]) => isOwner(c)) ?? assert.fail(`${fk.name} has no owner column`);
			const owner = homeOf(fk.child, ownerPair[0]);
			const parentRow: Record<string, unknown> = {};
			for (const c of parentColumns)
				if (isOwner(c.name) && !c.generated)
					parentRow[c.name] =
						homeOf(fk.parent, c.name) === owner || rootOf(fk.parent, c.name) === undefined ? owner : null;
			for (const [, r] of pairs) if (!isOwner(r)) parentRow[r] = valueOf(parentColumns, r);
			for (const [c, r] of pairs) if (isOwner(c)) parentRow[r] = owner;
			try {
				await insertRow(tx, fk.parent, parentRow, parentColumns);
			} catch (error) {
				outcomes.parent = {
					accepted: false,
					code: code(error),
					constraint: String((error as { cause?: unknown }).cause),
				};
				throw ROLLBACK;
			}
			const childOf = (value: string | null, rest: string | null) => {
				const row: Record<string, unknown> = {};
				for (const c of childColumns)
					if (isOwner(c.name) && !c.generated)
						row[c.name] = homeOf(fk.child, c.name) === owner || rootOf(fk.child, c.name) === undefined ? rest : null;
				for (const [c, r] of pairs) row[c] = isOwner(c) ? value : parentRow[r];
				if (fk.child === fk.parent)
					for (const c of childColumns)
						if (c.pk && !fk.cols.includes(c.name)) row[c.name] = valueOf(childColumns, c.name);
				return row;
			};
			const { foreign_plant, foreign_org } = variantsOf(owner);
			const shapes: Record<string, Record<string, unknown>> = {
				same_owner: childOf(owner, owner),
				foreign_plant: childOf(foreign_plant, foreign_plant),
				foreign_org: childOf(foreign_org, foreign_org),
				null_owner: childOf(null, owner === P ? Q : S2),
			};
			const both = childColumns.filter((c) => c.name === "plant_id" || c.name === "organization_id");
			if (both.length === 2) shapes.double_owner = { ...childOf(owner, owner), plant_id: P, organization_id: S1 };
			for (const [name, row] of Object.entries(shapes)) {
				await tx.execute(sql`SAVEPOINT shape`);
				try {
					await insertRow(tx, fk.child, row, childColumns);
					outcomes[name] = { accepted: true };
				} catch (error) {
					const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
					outcomes[name] = { accepted: false, code: cause?.code, constraint: cause?.constraint };
				}
				await tx.execute(sql`ROLLBACK TO SAVEPOINT shape`);
			}
			throw ROLLBACK;
		})
		.catch((error: unknown) => {
			if (error !== ROLLBACK) throw error;
		});
	return outcomes;
}

test("AC:TEN-001 every same-owner reference refuses a foreign plant, a foreign organization, a double owner and a missing owner, and accepts its own owner", async () => {
	const c = caseOf("TEN-001");
	const input = given(c, "case-input");
	assert.deepEqual([input.parent_kind, input.child_kind], ["plant", "organization"]);
	const scoped = fks.filter((f) => f.cols.length > 1 && f.cols.some(isOwner));
	assert.ok(scoped.length >= 170, String(scoped.length));
	const parents = new Set(scoped.map((f) => f.parent));
	assert.ok(parents.size >= 40, [...parents].join());
	const probes = new Map<Fk, Record<string, Outcome>>();
	for (const fk of scoped) probes.set(fk, await probe(fk));
	const wrong: string[] = [];
	for (const [fk, outcome] of probes) {
		const name = `${bare(fk.child)}.${fk.name}`;
		if (outcome.parent) wrong.push(`${name}: parent ${outcome.parent.constraint}`);
		if (!outcome.same_owner?.accepted) wrong.push(`${name}: own owner refused ${outcome.same_owner?.code}`);
		const owner = homeOf(fk.child, fk.cols.find(isOwner)!);
		const sameKind = owner === P ? "foreign_plant" : "foreign_org";
		const own = outcome[sameKind];
		if (own?.accepted !== false || own.code !== "23503" || own.constraint !== fk.name)
			wrong.push(`${name}: ${sameKind} ${JSON.stringify(own)}`);
		const other = outcome[owner === P ? "foreign_org" : "foreign_plant"];
		if (other?.accepted !== false || other.code !== "23503") wrong.push(`${name}: other kind ${JSON.stringify(other)}`);
		if (outcome.null_owner?.accepted !== false || !["23502", "23514"].includes(outcome.null_owner.code!))
			wrong.push(`${name}: null owner ${JSON.stringify(outcome.null_owner)}`);
		if (outcome.double_owner && outcome.double_owner.accepted) wrong.push(`${name}: double owner accepted`);
	}
	assert.deepEqual(wrong, []);
	const all = [...probes.values()];
	assert.ok(all.filter((o) => o.double_owner).length >= 4);
	assert.deepEqual(
		{
			insert_accepted: all.some(
				(o) => o.foreign_plant?.accepted || o.foreign_org?.accepted || o.double_owner?.accepted,
			),
			same_owner_control_accepted: all.every((o) => o.same_owner?.accepted === true),
			null_owner_bypass: all.some((o) => o.null_owner?.accepted),
		},
		c.expected.result,
	);

	const keys = (await rowsOf(sql`SELECT c.conrelid::regclass::text AS t,
		array(SELECT a.attname::text FROM unnest(c.conkey) k(n) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n) AS cols
		FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
		WHERE c.contype IN ('p','u') AND n.nspname=current_schema()`)) as { t: string; cols: string[] }[];
	const ROOT_OWNERS = ["account", "plant", "organization"];
	const directOwners = (table: string) => {
		if (ROOT_OWNERS.includes(table)) return new Set(["id"]);
		const columns = new Set<string>();
		if (
			fks.some((f) => f.child === table && f.cols.includes("tenant_id")) ||
			keys.some((k) => k.t === table && k.cols.includes("tenant_id"))
		)
			return new Set(["tenant_id"]);
		for (const f of fks)
			if (f.child === table && [...ROOT_OWNERS, "tenant"].includes(f.parent))
				for (const col of f.cols) if (isOwner(col)) columns.add(col);
		for (const k of keys)
			if (k.t === table && k.cols.length === 2 && k.cols.includes("id"))
				for (const col of k.cols) if (isOwner(col)) columns.add(col);
		return columns;
	};
	const owners = new Map(fks.flatMap((f) => [f.child, f.parent]).map((t) => [t, directOwners(t)]));
	for (let changed = true; changed;) {
		changed = false;
		for (const f of fks.filter((f) => f.cols.length > 1))
			f.cols.forEach((col, i) => {
				const mine = owners.get(f.child)!;
				if (isOwner(col) && owners.get(f.parent)!.has(f.rcols[i]!) && !mine.has(col)) {
					mine.add(col);
					changed = true;
				}
			});
	}
	const ownersOf = (table: string) => owners.get(table)!;
	const notes = JSON.parse(
		readFileSync(new URL("../../../../packages/db/src/schema/annotations.json", import.meta.url), "utf8"),
	) as { tables: Record<string, { foreignKeys?: Record<string, { scope_exception?: string }> }> };
	const crossing = fks.filter((f) => {
		if ([...ROOT_OWNERS, "tenant"].includes(f.parent)) return false;
		const mine = ownersOf(f.child),
			theirs = ownersOf(f.parent);
		return mine.size > 0 && theirs.size > 0 && !f.cols.some((col, i) => mine.has(col) && theirs.has(f.rcols[i]!));
	});
	assert.ok(crossing.length >= 36, String(crossing.length));
	assert.deepEqual(
		crossing
			.map((f) => [f.child, `${f.cols.join(",")}->${f.parent}(${f.rcols.join(",")})`] as const)
			.filter(([table, key]) => !notes.tables[table]?.foreignKeys?.[key]?.scope_exception?.trim())
			.map(([table, key]) => `${table} ${key}`),
		[],
	);
	assert.equal(c.expected.event, null);
});

test("AC:TEN-009 the runtime login owns nothing, cannot change or remove audit history, leaves no scope on a reused pooled connection, and no table claims row-level isolation", async () => {
	const c = caseOf("TEN-009");
	const input = given(c, "case-input");
	assert.deepEqual(
		[input.runtime_role, input.audit_cleanup_role, input.pooled_connection_reused, input.RLS_adopted],
		["nonowner", "cleanup", true, false],
	);
	const runtime = database.pools.runtime;
	const roles = database as unknown as {
		pools: Record<"cleanup", typeof admin>;
		logins: Record<"cleanup", { name: string }>;
	};
	const cleanup = roles.pools.cleanup;
	const login = database.logins.runtime.name;
	const role = (
		await rowsOf(
			sql`SELECT r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,
		pg_has_role(current_user,(SELECT nspowner FROM pg_namespace WHERE nspname=current_schema()),'MEMBER') AS schema_owner,
		(SELECT count(*)::int FROM pg_class k WHERE k.relnamespace=current_schema()::regnamespace
			AND pg_has_role(current_user,k.relowner,'MEMBER')) AS owned,
		has_schema_privilege(current_user,current_schema(),'CREATE') AS creates,
		pg_has_role(current_user,'everyfield_runtime','MEMBER') AS runtime_member,
		pg_has_role(current_user,'everyfield_cleanup','MEMBER') AS cleanup_member
		FROM pg_roles r WHERE r.rolname=current_user`,
			runtime,
		)
	)[0];
	assert.deepEqual(role, {
		rolsuper: false,
		rolbypassrls: false,
		rolcreaterole: false,
		rolcreatedb: false,
		schema_owner: false,
		owned: 0,
		creates: false,
		runtime_member: true,
		cleanup_member: false,
	});
	const grants = async (who: string, table: string) =>
		(
			await rowsOf(sql`SELECT p AS privilege FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
			WHERE has_table_privilege(${who}::name, ${table}::regclass, p) ORDER BY p`)
		).map((r) => r.privilege);
	assert.deepEqual(await grants(login, "audit_event"), ["INSERT", "SELECT"]);
	assert.deepEqual(await grants("everyfield_runtime", "audit_event"), ["INSERT", "SELECT"]);
	assert.deepEqual(await grants("everyfield_cleanup", "audit_event"), ["DELETE", "SELECT", "UPDATE"]);
	assert.deepEqual(await grants(roles.logins.cleanup.name, "audit_event"), ["DELETE", "SELECT", "UPDATE"]);
	assert.deepEqual(await grants(login, "schema_migration"), []);
	const listed = await rowsOf(sql`SELECT grantee,privilege_type FROM information_schema.role_table_grants
		WHERE table_schema=current_schema() AND table_name='audit_event' AND grantee IN ('everyfield_runtime','everyfield_cleanup')
		ORDER BY 1,2`);
	assert.deepEqual(listed, [
		{ grantee: "everyfield_cleanup", privilege_type: "DELETE" },
		{ grantee: "everyfield_cleanup", privilege_type: "SELECT" },
		{ grantee: "everyfield_cleanup", privilege_type: "UPDATE" },
		{ grantee: "everyfield_runtime", privilege_type: "INSERT" },
		{ grantee: "everyfield_runtime", privilege_type: "SELECT" },
	]);
	const strong = await rowsOf(sql`SELECT k.relname AS t, p AS privilege FROM pg_class k
		CROSS JOIN unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER']) p
		WHERE k.relnamespace=current_schema()::regnamespace AND k.relkind IN ('r','p')
		AND (has_table_privilege('everyfield_runtime', k.oid, p) OR has_table_privilege('everyfield_cleanup', k.oid, p))`);
	assert.deepEqual(strong, []);
	const groups =
		await rowsOf(sql`SELECT rolname, rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb AS strong
		FROM pg_roles WHERE rolname IN ('everyfield_runtime','everyfield_cleanup') ORDER BY 1`);
	assert.deepEqual(groups, [
		{ rolname: "everyfield_cleanup", strong: false },
		{ rolname: "everyfield_runtime", strong: false },
	]);

	const A = database.actors.admin;
	const saved = ok(
		await documentsWriter.saveNative(runtime, await actorOf(A, runtime), {
			title: "Harvest plan",
			body: nativeFromText("Ours."),
			expectedRevision: "0",
		}),
	);
	const history = await rowsOf(sql`SELECT id FROM audit_event WHERE tenant_id=${P} ORDER BY recorded_at DESC LIMIT 1`);
	const event = String(history[0]?.id ?? assert.fail("no audit row"));
	const attempt = async (statement: SQL, pool: Runner) =>
		pool.execute(statement).then(
			() => "allowed",
			(error: unknown) => (code(error) === "42501" ? "denied" : assert.fail(String(error))),
		);
	const result = {
		runtime_audit_update_allowed:
			(await attempt(sql`UPDATE audit_event SET metadata='{}'::jsonb WHERE id=${event}`, runtime)) === "allowed",
		runtime_audit_delete_allowed:
			(await attempt(sql`DELETE FROM audit_event WHERE id=${event}`, runtime)) === "allowed",
	};
	for (const statement of [
		"TRUNCATE audit_event",
		"ALTER TABLE audit_event DISABLE TRIGGER USER",
		"CREATE TABLE planted(id int)",
	])
		assert.equal(await attempt(sql.raw(statement), runtime), "denied", statement);
	assert.equal(await attempt(sql`INSERT INTO audit_event(tenant_id) VALUES(${Q})`, cleanup), "denied");
	assert.equal(await attempt(sql`TRUNCATE audit_event`, cleanup), "denied");
	assert.equal((await rowsOf(sql`SELECT count(*)::int AS n FROM audit_event WHERE id=${event}`))[0]!.n, 1);

	const pooled = database.connect("runtime", { max: 1 });
	const theirs = await database.actor({ kind: "plant", id: Q }, "admin");
	ok(
		await documentsWriter.saveNative(pooled, await actorOf(theirs, pooled), {
			title: "Grace plan",
			body: nativeFromText("Theirs."),
			expectedRevision: "0",
		}),
	);
	const session = async () =>
		(
			await rowsOf(
				sql`SELECT pg_backend_pid() AS pid, current_user AS who,
			(SELECT coalesce(json_agg(name ORDER BY name),'[]'::json) FROM pg_settings WHERE source='session' AND name NOT IN ('search_path')) AS settings,
			(SELECT count(*)::int FROM pg_class WHERE relnamespace=pg_my_temp_schema()) AS temp,
			current_setting('everyfield.tenant', true) AS tenant, current_setting('everyfield.actor', true) AS actor`,
				pooled,
			)
		)[0]!;
	const first = await session();
	const titles = async (who: Actor) => {
		const listed = ok(await documentsWriter.listOwned(pooled, await actorOf(who, pooled), {})) as unknown;
		return JSON.stringify(listed);
	};
	const ours = await titles(A);
	const between = await session();
	const theirsListed = await titles(theirs);
	const after = await session();
	assert.equal(between.pid, first.pid);
	assert.equal(after.pid, first.pid);
	assert.ok(ours.includes(saved.id) && !ours.includes("Grace plan"), ours);
	assert.ok(theirsListed.includes("Grace plan") && !theirsListed.includes(saved.id), theirsListed);
	assert.deepEqual(after.settings, first.settings);
	assert.deepEqual([after.temp, after.tenant ?? null, after.actor ?? null], [0, null, null]);
	const crossScope = after.pid === first.pid && (theirsListed.includes(saved.id) || ours.includes("Grace plan"));

	const secured = await rowsOf(sql`SELECT count(*) FILTER (WHERE relrowsecurity OR relforcerowsecurity)::int AS rls,
		(SELECT count(*)::int FROM pg_policies WHERE schemaname=current_schema()) AS policies
		FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relkind IN ('r','p')`);
	assert.deepEqual(secured, [{ rls: 0, policies: 0 }]);
	assert.deepEqual(
		{
			...result,
			cross_scope_context_reused: crossScope,
			RLS_isolation_claimed: secured[0]!.rls !== 0 || secured[0]!.policies !== 0,
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});
