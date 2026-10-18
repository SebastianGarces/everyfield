import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { database, transaction, id, account, plant } from "./support.mts";
import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";
import { currentActor } from "../../../packages/domain/src/access/index.ts";

async function permissions(db, schema) {
	return (
		await db.query(
			`SELECT role,tab,priv,has_table_privilege(role,quote_ident($1)||'.'||quote_ident(tab),priv) AS allowed
    FROM unnest(ARRAY['everyfield_runtime','everyfield_cleanup']) role
    CROSS JOIN unnest(ARRAY['lifecycle_witness','document_revision','tenant','record']) tab
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) priv ORDER BY role,tab,priv`,
			[schema],
		)
	).rows;
}

test("INV-privileges: fresh and upgraded grants converge without rewriting applied bytes; restricted LOGIN refusals and exact lifecycle body cleanup", async () => {
	const db = await database();
	const other = db.schema + "_old",
		dir = await mkdtemp(tmpdir() + "/wp006-upgrade-");
	try {
		for (const name of ["0001_early_access.sql", "0002_baseline.sql"])
			await cp(new URL("../../../packages/db/migrations/" + name, import.meta.url), dir + "/" + name);
		await db.admin.query(`CREATE SCHEMA ${other}`);
		await migrate(db.admin, other, pathToFileURL(dir + "/"));
		const oldACL = await permissions(db.admin, other);
		assert.equal(
			oldACL.find((p) => p.role === "everyfield_runtime" && p.tab === "lifecycle_witness" && p.priv === "DELETE")
				.allowed,
			true,
		);
		assert.equal(
			oldACL.find((p) => p.role === "everyfield_cleanup" && p.tab === "record" && p.priv === "DELETE").allowed,
			true,
		);
		const before = (await db.admin.query(`SELECT name,sha256,applied_at FROM ${other}.schema_migration ORDER BY name`))
			.rows;
		await cp(
			new URL("../../../packages/db/migrations/0003_access_privileges.sql", import.meta.url),
			dir + "/0003_access_privileges.sql",
		);
		assert.deepEqual(await migrate(db.admin, other, pathToFileURL(dir + "/")), ["0003_access_privileges.sql"]);
		assert.deepEqual(
			(
				await db.admin.query(
					`SELECT name,sha256,applied_at FROM ${other}.schema_migration WHERE name<>'0003_access_privileges.sql' ORDER BY name`,
				)
			).rows,
			before,
		);
		await migrate(db.admin, other);
		assert.deepEqual(await permissions(db.admin, other), await permissions(db.admin, db.schema));
		assert.deepEqual(await migrate(db.admin, other), []);
		const baseline = await readFile(new URL("../../../packages/db/migrations/0002_baseline.sql", import.meta.url));
		assert.equal(
			(await migrationArtifact())[1].sha256,
			(await import("node:crypto")).createHash("sha256").update(baseline).digest("hex"),
		);
		assert.deepEqual(
			(await db.runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows,
			[{ rolsuper: false, rolbypassrls: false }],
		);
		for (const [pool, sql] of [
			[db.runtime, "DELETE FROM lifecycle_witness"],
			[db.runtime, "DELETE FROM document_revision"],
			[db.runtime, "SELECT * FROM auth_session"],
			[db.cleanup, "DELETE FROM lifecycle_witness"],
			[db.cleanup, "DELETE FROM document_revision"],
			[db.cleanup, "UPDATE tenant SET kind=kind"],
			[db.cleanup, "DELETE FROM tenant"],
			[db.cleanup, "UPDATE record SET kind=kind"],
			[db.cleanup, "DELETE FROM record"],
		])
			await assert.rejects(pool.query(sql), (e) => e.code === "42501");
		const a = await account(db.admin),
			p = await plant(db.admin),
			q = await plant(db.admin),
			doc = id(),
			revision = id(),
			witness = id(),
			request = id();
		await db.admin.query("INSERT INTO document(id,tenant_id,kind,title) VALUES($1,$2,'native','Synthetic')", [
			doc,
			p.id,
		]);
		await db.admin.query(
			"INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,recorded_at) VALUES($1,$2,$3,1,'IMMUTABLE-BODY',$4,clock_timestamp())",
			[revision, p.id, doc, "a".repeat(64)],
		);
		await db.admin.query("UPDATE document SET current_revision_id=$1 WHERE id=$2", [revision, doc]);
		await db.admin.query(
			`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,requester_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
      VALUES($1,'plant',$2,$2,$3,$4,1,'pending_deletion',now()-interval '31 days',now()-interval '1 day',1,'not_started')`,
			[witness, p.id, request, a.id],
		);
		const futureRequest = id(),
			futureDoc = id();
		await db.admin.query("INSERT INTO document(id,tenant_id,kind,title) VALUES($1,$2,'native','Future purge')", [
			futureDoc,
			q.id,
		]);
		await db.admin.query(
			`INSERT INTO lifecycle_witness(kind,opaque_subject_id,plant_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
      VALUES('plant',$1,$1,$2,1,'purging',now(),now()+interval '30 days',1,'not_started')`,
			[q.id, futureRequest],
		);
		await assert.rejects(
			db.cleanup.query("SELECT purge_document_revisions($1,$2,$3,$4)", [q.id, futureRequest, "1", futureDoc]),
			(e) => e.code === "42501",
		);
		const args = [p.id, request, "1", doc];
		await assert.rejects(
			db.runtime.query("SELECT purge_document_revisions($1,$2,$3,$4)", args),
			(e) => e.code === "42501",
		);
		await assert.rejects(
			db.cleanup.query("SELECT purge_document_revisions($1,$2,$3,$4)", args),
			(e) => e.code === "42501",
		);
		assert.deepEqual((await db.admin.query("SELECT body FROM document_revision WHERE id=$1", [revision])).rows, [
			{ body: "IMMUTABLE-BODY" },
		]);
		await db.admin.query("UPDATE lifecycle_witness SET state='purging' WHERE id=$1", [witness]);
		for (const invalid of [
			[q.id, request, "1", doc],
			[p.id, id(), "1", doc],
			[p.id, request, "2", doc],
		])
			await assert.rejects(
				db.cleanup.query("SELECT purge_document_revisions($1,$2,$3,$4)", invalid),
				(e) => e.code === "42501",
			);
		assert.deepEqual((await db.cleanup.query("SELECT purge_document_revisions($1,$2,$3,$4) AS n", args)).rows, [
			{ n: "1" },
		]);
		assert.deepEqual((await db.cleanup.query("SELECT purge_document_revisions($1,$2,$3,$4) AS n", args)).rows, [
			{ n: "0" },
		]);
		assert.deepEqual((await db.admin.query("SELECT current_revision_id FROM document WHERE id=$1", [doc])).rows, [
			{ current_revision_id: null },
		]);
		assert.deepEqual(
			(
				await db.admin.query(
					"SELECT kind,opaque_subject_id,state,request_id,request_revision FROM lifecycle_witness WHERE id=$1",
					[witness],
				)
			).rows,
			[{ kind: "plant", opaque_subject_id: p.id, state: "purging", request_id: request, request_revision: "1" }],
		);
		assert.deepEqual((await db.admin.query("SELECT kind FROM tenant WHERE id=$1", [p.id])).rows, [{ kind: "plant" }]);
	} finally {
		await db.admin.query(`DROP SCHEMA IF EXISTS ${other} CASCADE`);
		await rm(dir, { recursive: true });
		await db.close();
	}
});

test("INV-revocation: a session revoke waits for an in-flight authority transaction and the next access is unavailable", async () => {
	const db = await database();
	const a = await account(db.admin),
		selected = { kind: "account", id: a.id };
	const tx = await db.runtime.connect(),
		revoke = await db.admin.connect();
	try {
		await tx.query("BEGIN");
		assert.deepEqual(await currentActor(tx, a.session, selected), {
			status: "active",
			accountId: a.id,
			context: { kind: "account", owner: selected },
		});
		const pid = (await revoke.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
		const deleting = revoke.query("DELETE FROM auth_session WHERE id=$1", [a.session]);
		let observed = false;
		for (let i = 0; i < 40; i++) {
			const status = (await db.admin.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0];
			if (status?.wait_event_type === "Lock") {
				observed = true;
				break;
			}
		}
		assert.equal(observed, true);
		await tx.query("COMMIT");
		await deleting;
		await tx.query("BEGIN");
		assert.deepEqual(await currentActor(tx, a.session, selected), { status: "unavailable" });
		await tx.query("COMMIT");
	} finally {
		await tx.query("ROLLBACK");
		tx.release();
		revoke.release();
		await db.close();
	}
});

test("INV-membership: legacy inconsistent seats and current lifecycle witnesses fail closed", async () => {
	const db = await database();
	try {
		const a = await account(db.admin),
			p = await plant(db.admin),
			q = await plant(db.admin);
		const { seat } = await import("./support.mts");
		const first = await seat(db.admin, a, p),
			second = id();
		// Simulate pre-constraint corruption only inside this disposable schema.
		await db.admin.query(`DROP INDEX ${db.schema}.seat_uq_0`);
		await db.admin.query(
			"INSERT INTO seat(id,account_id,plant_id,role,accepted_at) VALUES($1,$2,$3,$4,clock_timestamp())",
			[second, a.id, q.id, "member"],
		);
		await transaction(db.runtime, async (tx) => {
			assert.deepEqual(await currentActor(tx, a.session, p), { status: "unavailable" });
			assert.deepEqual(await currentActor(tx, a.session, { kind: "account", id: a.id }), { status: "unavailable" });
		});
		await db.admin.query("DELETE FROM seat WHERE id=$1", [second]);
		await db.admin.query(`CREATE UNIQUE INDEX seat_uq_0 ON ${db.schema}.seat(account_id) WHERE ended_at IS NULL`);
		const request = id(),
			witness = id();
		await db.admin.query(
			`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
      VALUES($1,'plant',$2,$2,$3,1,'pending_deletion',now(),now()+interval '30 days',1,'not_started')`,
			[witness, p.id, request],
		);
		await transaction(db.runtime, async (tx) => {
			assert.deepEqual(await currentActor(tx, a.session, p), { status: "unavailable" });
		});
		await db.admin.query("UPDATE lifecycle_witness SET state='cancelled',cancelled_at=clock_timestamp() WHERE id=$1", [
			witness,
		]);
		await transaction(db.runtime, async (tx) => {
			assert.deepEqual(await currentActor(tx, a.session, p), {
				status: "active",
				accountId: a.id,
				context: { kind: "seat", owner: p, seatId: first, role: "admin", revision: "1" },
			});
		});
		await db.admin.query(
			"INSERT INTO lifecycle_witness(kind,opaque_subject_id,seat_id,request_revision,state,witness_checkpoint,cleanup_state) VALUES('seat',$1,$1,1,'revoked',2,'not_started')",
			[first],
		);
		await transaction(db.runtime, async (tx) => {
			assert.deepEqual(await currentActor(tx, a.session, p), { status: "unavailable" });
		});
	} finally {
		await db.close();
	}
});
