import { createDatabase, closeDatabase } from "../../packages/db/src/client.ts";
import { sql } from "../../packages/db/src/query.ts";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadControl, readPrivateBytes, readPrivateJson, developmentConnection } from "./control.mts";
import {
	migrate as applyVersionedMigration,
	adoptMigrationHistory,
	inspectMigrationProvenance,
} from "../../packages/db/src/schema/migrate.ts";
import { validateCandidate } from "./recovery.mts";
import { OPERATION, readCurrentManifest, restoreWithCurrentManifest } from "./restore.mts";
import { COPY_OPERATION, createEncryptedCopy } from "./copy.mts";
import { READINESS_OPERATION, readiness } from "./readiness.mts";

const commands = [
	"migration-inspect",
	"migration-apply",
	"migration-adopt",
	"backup-check",
	"backup-copy",
	"restore-rehearsal",
	"readiness",
];
const SNAPSHOT_LIMIT = 256 * 1024 * 1024;
async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			control: { type: "string" },
			review: { type: "string" },
			manifest: { type: "string" },
			snapshot: { type: "string" },
			key: { type: "string" },
			out: { type: "string" },
			recopy: { type: "string" },
			evidence: { type: "string" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"Restricted development operations. Commands: migration-inspect, migration-apply, migration-adopt, backup-check, backup-copy, restore-rehearsal, readiness. Requires --control <private host-bound authorization file>. Adoption additionally requires --review <private reviewed per-file SHA-256 map>. restore-rehearsal requires --snapshot <private directory with manifest.json, image.json and objects/<id>> and restores into a fresh closed schema it drops afterwards. backup-copy requires --key <private 32-byte backup key file>, --out <private copy directory> and either --snapshot <directory> or --recopy <copy location in --out>. readiness reads --evidence <private evidence file> when given and reports the customer-data gate. No production action or provider setup.",
		);
		return;
	}
	const command = positionals[0];
	if (positionals.length !== 1 || !commands.includes(command) || !values.control) throw Error("invalid_command");
	const c = await loadControl(values.control, command);
	if (command === "readiness") {
		const evidence = values.evidence ? await readPrivateJson(values.evidence) : {};
		const report = readiness({
			capability: {
				authority: "explicit_scoped_operator",
				verified: true,
				operation_ids: [READINESS_OPERATION],
				environment: "isolated-test",
			},
			evidence,
			now: new Date(),
		});
		console.log(JSON.stringify(report));
		return;
	}
	if (command === "backup-copy") {
		if (!values.key || !values.out || !values.snapshot === !values.recopy) throw Error("copy_arguments_required");
		const out = values.out;
		const safe = (key: string) => {
			if (!/^copy\/[0-9-]{10}\/[0-9a-f-]{36}\/(manifest\.json|key|database|objects\/[0-9a-f-]{36})$/.test(key))
				throw Error("copy_key_invalid");
			return join(out, key);
		};
		const store = {
			put: async (key: string, bytes: Uint8Array) => {
				await mkdir(dirname(safe(key)), { recursive: true, mode: 0o700 });
				await writeFile(safe(key), bytes, { mode: 0o600, flag: "wx" });
			},
			get: (key: string) => readPrivateBytes(safe(key), SNAPSHOT_LIMIT).catch(() => null),
		};
		let source;
		if (values.recopy) source = { copy: values.recopy };
		else {
			const manifest = await readPrivateJson(`${values.snapshot}/manifest.json`);
			const objects = new Map();
			for (const o of Array.isArray(manifest?.objects) ? manifest.objects : [])
				if (/^[0-9a-f-]{36}$/.test(String(o?.id)))
					objects.set(o.id, await readPrivateBytes(`${values.snapshot}/objects/${o.id}`, SNAPSHOT_LIMIT));
			source = {
				snapshot: { manifest, image: await readPrivateBytes(`${values.snapshot}/image.json`, SNAPSHOT_LIMIT), objects },
			};
		}
		const result = await createEncryptedCopy(
			{ store, clock: () => new Date() },
			{
				capability: {
					authority: "authorized_restricted_backup_operator",
					verified: true,
					operation_ids: [COPY_OPERATION],
					environment: "isolated-test",
				},
				keyFile: values.key,
				source,
			},
		);
		if (!result.copy_encrypted) throw Error(result.refusal);
		console.log(JSON.stringify(result));
		return;
	}
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
