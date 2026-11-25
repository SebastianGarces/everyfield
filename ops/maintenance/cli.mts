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
import { BackupDirectory, COPY_OPERATION, createEncryptedCopy } from "./copy.mts";
import { BACKUP_KEY_HELP, BackupKeyRefused, takeBackupKey } from "./key.mts";
import { OPERATOR_COMMANDS, runOperator } from "./operator.mts";
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
	const backupKey = takeBackupKey();
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			control: { type: "string" },
			review: { type: "string" },
			manifest: { type: "string" },
			snapshot: { type: "string" },
			out: { type: "string" },
			recopy: { type: "string" },
			evidence: { type: "string" },
			config: { type: "string" },
			copy: { type: "string" },
			target: { type: "string" },
			incident: { type: "string" },
			subject: { type: "string" },
			agents: { type: "string" },
			keys: { type: "string", multiple: true },
			current: { type: "string" },
			load: { type: "boolean" },
			history: { type: "boolean" },
			help: { type: "boolean" },
		},
	});
	if (values.help) {
		console.log(
			"Restricted development operations. Commands: migration-inspect, migration-apply, migration-adopt, backup-check, backup-copy, restore-rehearsal, readiness. Requires --control <private host-bound authorization file>. Adoption additionally requires --review <private reviewed per-file SHA-256 map>. restore-rehearsal requires --snapshot <private directory with manifest.json, image.json and objects/<id>> and restores into a fresh closed schema it drops afterwards. backup-copy requires --out <private copy directory> and either --snapshot <directory> or --recopy <copy location in --out>. readiness reads --evidence <private evidence file> when given and reports the customer-data gate. The restricted backup and recovery commands backup-capture, backup-daily, backup-expire, backup-status, bucket-probe, schedule-install, schedule-uninstall, restore-copy, restore-open and deletion-check take --config <private directory> instead and exit 2 when their check fails; docs/runbooks/recovery.md gives each one. backup-daily, backup-copy and restore-copy --copy read the encryption key from EVERYFIELD_BACKUP_KEY, exactly 64 hex characters; no other command needs it and none reads a key file. Production backups stay off until go-live and are turned on only on Sebastian's words. No production action or provider setup.",
		);
		return;
	}
	const command = positionals[0];
	if (positionals.length === 1 && command !== undefined && Object.hasOwn(OPERATOR_COMMANDS, command)) {
		if (!(await runOperator(command, values, backupKey))) process.exitCode = 2;
		return;
	}
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
		if (!values.out || !values.snapshot === !values.recopy) throw Error("copy_arguments_required");
		const key = backupKey();
		const store = new BackupDirectory(values.out);
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
				key,
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
main().catch((error) => {
	if (error instanceof BackupKeyRefused) console.error(BACKUP_KEY_HELP[error.problem]);
	console.error("Operations command refused or failed. No credentials or raw errors were logged.");
	process.exitCode = 1;
});
