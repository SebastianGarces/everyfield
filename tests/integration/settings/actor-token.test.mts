import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { accountId } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import { runDuePurges } from "../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { actorToken } from "../../../packages/domain/src/operations/canonical.ts";
import { gatedTransaction, nativeWrite } from "../../../packages/domain/src/operations/writes.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { deletionOperations } from "../../../packages/domain/src/settings/index.ts";
import { fixture, ok, seeds } from "../../support/fixture.mts";
import { frozenClock, testDatabase } from "../../support/test-database.mts";
import { authorityOf, church, memoryStorage } from "../people/people-support.mts";

const f = await fixture({
	prefix: "actor_token",
	max: 4,
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	plant: { name: "P" },
	clock: new Date("2026-10-13T16:00:00Z"),
});
const pools: Partial<typeof f.pools> & { cleanup?: typeof f.admin } = f.pools;
const db = f.pools.runtime;
const migration = await testDatabase({ prefix: "actor_token_migration", migrate: false, max: 2 });
const folders: string[] = [];
after(async () => {
	for (const folder of folders) await rm(folder, { recursive: true, force: true });
	await migration.close();
	await f.close();
});

const deletion = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "purge/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});
const tokensOf = async (ids: readonly string[]) =>
	(
		await f.admin.execute<{ tenant_id: string; actor_id: string | null; tokens: string[] }>(
			sql`SELECT tenant_id::text,max(actor_id::text) AS actor_id,array_agg(DISTINCT actor_token ORDER BY actor_token) AS tokens
			FROM audit_event WHERE id=ANY(${sql.param(ids)}::uuid[]) GROUP BY tenant_id ORDER BY tenant_id`,
		)
	).rows;

test("INV-privacy: a deleted account has one pseudonym token in each church and organization it acted in, and no token spans two tenants", async (t) => {
	const P = f.tenant;
	const Q = await f.plant({ name: "Q" });
	const O = await f.organization("sending_church");
	const A = await f.actor(P, "admin");

	const people: string[] = [];
	for (const plant of [P, Q]) {
		if (plant === Q) {
			await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}::uuid`);
			await f.seat(A, Q, "admin");
		}
		await f.admin.execute(
			sql`UPDATE seat SET accepted_at='2026-01-01T00:00:00Z' WHERE account_id=${A.id}::uuid AND ended_at IS NULL`,
		);
		const authority = await authorityOf(db, A);
		const selected = church(plant.id);
		const created = await nativeWrite(db, authority, selected, (tx) =>
			peopleWriter.createPerson(
				tx,
				{ session: A.session, selected },
				{ requestKey: randomUUID(), input: { displayName: "Jamie" } },
			),
		);
		people.push(ok(created).person.id);
	}
	const untokened = async (tenant: string, subject: string) =>
		(
			await f.admin.execute<{
				id: string;
			}>(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id)
				VALUES(${tenant},${A.id},'people.updated','edit','person',${subject}) RETURNING id::text`)
		).rows[0]!.id;
	for (const [i, plant] of [P, Q].entries()) await untokened(plant.id, people[i]!);

	const removed = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,created_at,retired_at)
		VALUES(${removed},${O.id},${O.id},'Removed person','other','retired',clock_timestamp(),clock_timestamp())`);
	await f.admin
		.execute(sql`INSERT INTO organization_person_removal(id,organization_id,person_record_id,removed_at,witness_checkpoint,revision)
		VALUES(${randomUUID()},${O.id},${removed},clock_timestamp(),1,1)`);
	const seatWrite = (
		await f.admin.execute<{
			id: string;
		}>(sql`INSERT INTO audit_event(tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id)
			VALUES(${O.id},${A.id},${actorToken(O.id, A.id)},'people.updated','edit','person',${removed}) RETURNING id::text`)
	).rows[0]!.id;
	const historyRows = [seatWrite, await untokened(O.id, removed)];
	const laterOrganizationRow = await untokened(O.id, O.id);

	await f.admin.execute(sql`SELECT purge_organization_person_history(${O.id}::uuid,${removed}::uuid)`);
	const afterHistory = await tokensOf(historyRows);
	assert.deepEqual(afterHistory, [{ tenant_id: O.id, actor_id: null, tokens: [actorToken(O.id, A.id)] }]);

	const acted = (
		await f.admin.execute<{ id: string }>(sql`SELECT id::text FROM audit_event WHERE actor_id=${A.id}::uuid`)
	).rows.map((r) => r.id);
	assert.equal(acted.length, 5, "a live and an untokened row in P and Q, and one later row in O");
	assert.ok(acted.includes(laterOrganizationRow));
	const { r } = (
		await f.admin.execute<{ r: string }>(sql`SELECT revision::text AS r FROM account WHERE id=${A.id}::uuid`)
	).rows[0]!;
	const requested = new Date("2026-09-13T16:00:00Z");
	t.mock.timers.enable({ apis: ["Date"], now: requested });
	ok(
		await frozenClock(f.admin, f.schema, requested.toISOString(), () =>
			gatedTransaction(db, (tx) =>
				deletion.requestAccountDeletion(
					tx,
					{ session: A.session, selected: { kind: "account", id: accountId.parse(A.id) } },
					{ requestKey: randomUUID(), expectedRevision: r, input: { confirmed: true } },
				),
			),
		),
	);
	t.mock.timers.setTime(Date.parse("2026-10-13T16:00:00Z"));
	assert.equal(await runDuePurges(db, pools.cleanup!, memoryStorage(), 10), 1);
	t.mock.timers.reset();
	assert.equal(
		(await f.admin.execute(sql`SELECT state FROM lifecycle_witness WHERE opaque_subject_id=${A.id}::uuid`)).rows[0]
			?.state,
		"purged",
	);

	const tenants = [P.id, Q.id, O.id].sort();
	assert.deepEqual(
		await tokensOf([...acted, ...historyRows]),
		tenants.map((tenant) => ({ tenant_id: tenant, actor_id: null, tokens: [actorToken(tenant, A.id)] })),
	);
	assert.equal(new Set(tenants.map((tenant) => actorToken(tenant, A.id))).size, 3);
	const shared = await f.admin.execute(
		sql`SELECT actor_token FROM audit_event WHERE actor_token IS NOT NULL GROUP BY actor_token HAVING count(DISTINCT tenant_id)>1`,
	);
	assert.deepEqual(shared.rows, []);
});

test("INV-privacy: the token migration rewrites an old-form token on a row that still names its actor and leaves purged rows as they were", async () => {
	const { admin, schema } = migration;
	const target = "20261126120000_one_actor_token.sql";
	const names = (await migrationArtifact()).map(({ name }) => name);
	const folder = await mkdtemp(tmpdir() + "/evf-actor-token-");
	folders.push(folder);
	const url = pathToFileURL(folder + "/");
	for (const name of names.filter((name) => name < target))
		await copyFile(new URL("../../../packages/db/migrations/" + name, import.meta.url), new URL(name, url));
	await migrate(admin, schema, url);

	const seed = seeds(admin);
	const P = await seed.plant({ name: "P" });
	const A = await seed.actor(P, "admin");
	const oldForm = createHash("sha256").update(`${P.id}/${A.id}`).digest("hex");
	const current = actorToken(P.id, A.id);
	const row = async (actor: string | null, token: string | null) =>
		(
			await admin.execute<{
				id: string;
			}>(sql`INSERT INTO audit_event(tenant_id,actor_id,actor_token,action,kind,subject_type,subject_id)
				VALUES(${P.id},${actor}::uuid,${token},'people.updated','edit','person',${P.id}) RETURNING id::text`)
		).rows[0]!.id;
	const rows = {
		oldForm: await row(A.id, oldForm),
		current: await row(A.id, current),
		untokened: await row(A.id, null),
		purged: await row(null, oldForm),
	};

	assert.deepEqual(
		await migrate(admin, schema),
		names.filter((name) => name >= target),
	);
	const read = await admin.execute<{ id: string; actor_token: string | null }>(
		sql`SELECT id::text,actor_token FROM audit_event WHERE id=ANY(${sql.param(Object.values(rows))}::uuid[])`,
	);
	const token = Object.fromEntries(read.rows.map((x) => [x.id, x.actor_token]));
	assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([kind, id]) => [kind, token[id]])), {
		oldForm: current,
		current,
		untokened: null,
		purged: oldForm,
	});
	const sqlForm = await admin.execute<{ token: string }>(
		sql`SELECT audit_actor_token(${P.id}::uuid,${A.id}::uuid) AS token`,
	);
	assert.equal(sqlForm.rows[0]!.token, current);
});
