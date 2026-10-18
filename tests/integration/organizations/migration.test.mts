import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, copyFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { migrate, migrationArtifact } from "../../../packages/db/src/schema/migrate.ts";

test("INV-schema: fresh and upgraded affiliation schemas use canonical ministry_teams and preserve existing consent", async () => {
	const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
	if (
		source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" ||
		process.env.NODE_ENV === "production"
	)
		throw Error("Only shared development direct endpoint allowed");
	source.searchParams.set("sslmode", "verify-full");
	const schema = "wp007upgrade_" + randomUUID().replaceAll("-", ""),
		fresh = "wp007fresh_" + randomUUID().replaceAll("-", ""),
		db = createDatabase({ connectionString: source.href, max: 2 });
	const old = await mkdtemp(tmpdir() + "/wp007-migrations-"),
		migrations = new URL("../../../packages/db/migrations/", import.meta.url);
	try {
		for (const name of await readdir(migrations))
			if (/^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 5)
				await copyFile(new URL(name, migrations), old + "/" + name);
		await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
		await db.execute(sql.raw(`CREATE SCHEMA ${fresh}`));
		await migrate(db, schema, pathToFileURL(old + "/"));
		const p = randomUUID(),
			o = randomUUID();
		await db.execute(sql.raw(`SET search_path=${schema},pg_catalog,pg_temp`));
		await db.execute(
			sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(p)},'Synthetic','UTC',7,14,0,16,1,1)`,
		);
		await db.execute(
			sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${sql.param(o)},'sending_church','Synthetic','UTC',1)`,
		);
		// This is deliberately the pre-0005 historical input, never a current caller.
		await db.execute(
			sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry,share_wiki,share_activity,shared_findings) VALUES(${sql.param(p)},${sql.param(o)},clock_timestamp(),false,false,false,true,false,false,false)`,
		);
		const ledger = await db.execute(
			sql.raw(`SELECT name,sha256,applied_at FROM ${schema}.schema_migration ORDER BY name`),
		);
		assert.deepEqual(
			await migrate(db, schema),
			(await migrationArtifact()).filter((f) => Number(f.name.slice(0, 4)) >= 5).map((f) => f.name),
		);
		await migrate(db, fresh);
		const columns = async (s: string) =>
			(
				await db.execute(
					sql`SELECT column_name,data_type,is_nullable,column_default,is_generated FROM information_schema.columns WHERE table_schema=${sql.param(s)} AND table_name='affiliation' ORDER BY ordinal_position`,
				)
			).rows;
		assert.deepEqual(await columns(schema), await columns(fresh));
		assert.equal(
			(await columns(schema)).some((r) => r.column_name === "share_ministry"),
			false,
		);
		assert.deepEqual(
			(
				await db.execute(
					statement(`SELECT share_ministry_teams,consent_revision FROM ${schema}.affiliation WHERE plant_id=$1`, [p]),
				)
			).rows,
			[{ share_ministry_teams: true, consent_revision: "1" }],
		);
		await db.execute(statement(`UPDATE ${schema}.affiliation SET share_ministry_teams=false WHERE plant_id=$1`, [p]));
		assert.equal(
			(await db.execute(statement(`SELECT share_ministry_teams FROM ${schema}.affiliation WHERE plant_id=$1`, [p])))
				.rows[0].share_ministry_teams,
			false,
		);
		assert.deepEqual(
			(
				await db.execute(
					sql.raw(`SELECT name,sha256,applied_at FROM ${schema}.schema_migration WHERE name<'0005_' ORDER BY name`),
				)
			).rows,
			ledger.rows,
		);
		assert.deepEqual(await migrate(db, schema), []);
	} finally {
		await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${fresh} CASCADE`));
		await closeDatabase(db);
		await rm(old, { recursive: true, force: true });
	}
});

function statement(text: string, values: readonly unknown[]) {
	return sql.join(
		text
			.split(/(\$\d+)/)
			.filter(Boolean)
			.map((part) => (/^\$\d+$/.test(part) ? sql`${values[Number(part.slice(1)) - 1]}` : sql.raw(part))),
		sql``,
	);
}
