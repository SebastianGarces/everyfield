import { createDatabase, closeDatabase } from "../../packages/db/src/client.ts";
import { sql } from "../../packages/db/src/query.ts";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { loadControl, readPrivateBytes, readPrivateJson, developmentConnection } from "./control.mts";
import {
	migrate as applyVersionedMigration,
	adoptMigrationHistory,
	inspectMigrationProvenance,
} from "../../packages/db/src/schema/migrate.ts";
import { validateCandidate } from "./recovery.mts";
import { OPERATION, readCurrentManifest, restoreWithCurrentManifest } from "./restore.mts";

const commands = ["migration-inspect", "migration-apply", "migration-adopt", "backup-check", "restore-rehearsal"];
const SNAPSHOT_LIMIT = 256 * 1024 * 1024;
async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			control: { type: "string" },
			review: { type: "string" },
			manifest: { type: "string" },
			snapshot: { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"Restricted development operations. Commands: migration-inspect, migration-apply, migration-adopt, backup-check, restore-rehearsal. Requires --control <private host-bound authorization file>. Adoption additionally requires --review <private reviewed per-file SHA-256 map>. restore-rehearsal requires --snapshot <private directory with manifest.json, image.json and objects/<id>> and restores into a fresh closed schema it drops afterwards. No production action or provider setup.",
		);
		return;
	}
	const command = positionals[0];
	if (positionals.length !== 1 || !commands.includes(command) || !values.control) throw Error("invalid_command");
	const c = await loadControl(values.control, command);
	if (command === "backup-check") {
		if (!values.manifest) throw Error("manifest_required");
		const result = validateCandidate(await readPrivateJson(values.manifest), new Date());
		console.log(
			JSON.stringify({
				candidate_manifest_valid: true,
				bytes_verified: false,
				live_recovery_proven: result.liveRecoveryProven,
				key_custody_proven: false,
				restore_executed: false,
			}),
		);
		return;
	}
	const connectionString = developmentConnection(c, process.env.DATABASE_URL_UNPOOLED ?? "");
	const schema = c.database.schema;
	const db = createDatabase({
		connectionString,
		max: 1,
		...(command === "restore-rehearsal" ? { options: `-c search_path=${schema},pg_catalog,pg_temp` } : {}),
	});
	try {
		const actual = await db.execute(sql`SELECT current_user AS role,current_database() AS name`);
		if (actual.rows[0].role !== c.database.role || actual.rows[0].name !== c.database.name)
			throw Error("target_mismatch");
		if (command === "restore-rehearsal") {
			if (!values.snapshot) throw Error("snapshot_required");
			const dir = values.snapshot;
			const manifest = await readPrivateJson(`${dir}/manifest.json`);
			const objects = new Map();
			for (const o of Array.isArray(manifest?.objects) ? manifest.objects : [])
				if (/^[0-9a-f-]{36}$/.test(String(o?.id)))
					objects.set(o.id, await readPrivateBytes(`${dir}/objects/${o.id}`, SNAPSHOT_LIMIT).catch(() => null));
			for (const [id, bytes] of objects) if (!bytes) objects.delete(id);
			// The fresh target is closed to every app login and dropped when the rehearsal ends; its bytes stay in memory.
			const targetSchema = `${schema.slice(0, 40)}_rehearsal_${randomBytes(6).toString("hex")}`;
			try {
				const result = await restoreWithCurrentManifest(
					{ admin: db, source: schema, targetSchema, objects: { put: async () => {} }, clock: () => new Date() },
					{
						capability: {
							authority: "authorized_restricted_recovery_operator",
							verified: true,
							operation_ids: [OPERATION],
							environment: "isolated-test",
						},
						target: "isolated",
						snapshot: { manifest, image: await readPrivateBytes(`${dir}/image.json`, SNAPSHOT_LIMIT), objects },
						current: () => readCurrentManifest(db),
					},
				);
				console.log(JSON.stringify({ ...result, subjects: result.subjects.length, target: null }));
			} finally {
				await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${targetSchema} CASCADE`));
			}
		} else if (command === "migration-inspect") {
			console.log(JSON.stringify(await inspectMigrationProvenance(db, c.database.schema)));
		} else if (command === "migration-apply") {
			console.log(JSON.stringify({ applied: await applyVersionedMigration(db, c.database.schema) }));
		} else {
			if (!values.review) throw Error("adoption_review_required");
			const adopted = await adoptMigrationHistory(db, c.database.schema, await readPrivateJson(values.review));
			console.log(JSON.stringify({ adopted, original_application_proven: false }));
		}
	} finally {
		await closeDatabase(db);
	}
}
main().catch(() => {
	console.error("Operations command refused or failed. No credentials or raw errors were logged.");
	process.exitCode = 1;
});
