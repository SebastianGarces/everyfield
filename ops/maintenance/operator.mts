import { execFileSync } from "node:child_process";
import type { KeyObject } from "node:crypto";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, createDatabase, type Database } from "../../packages/db/src/client.ts";
import { sql } from "../../packages/db/src/query.ts";
import { copyStatus, expireCopies, runBackup } from "./backup.mts";
import { BackupBucket, objectClient, privateEnv, sdk } from "./bucket.mts";
import { captureSnapshot } from "./capture.mts";
import {
	type Control,
	loadControl,
	OperatorRefused,
	pinnedConnection,
	readPrivateBytes,
	readPrivateJson,
} from "./control.mts";
import { openEncryptedCopy } from "./copy.mts";
import { checkDeletion, readBucket } from "./deletion.mts";
import { openDrillTarget, OPEN_OPERATION } from "./drill.mts";
import { keysRestricted, probeAppKeys, probeOtherBuckets } from "./probe.mts";
import { OPERATION, readCurrentManifest, restoreWithCurrentManifest, type Snapshot } from "./restore.mts";
import { installSchedule, uninstallSchedule } from "./schedule.mts";
import { allowSource, fileSource, historyPoint, readNeon, sourceClass } from "./source.mts";

const CHECKOUT = fileURLToPath(new URL("../../", import.meta.url));
const COPY_LIMIT = 256 * 1024 * 1024;
const clock = () => new Date();

export type Flags = {
	config?: string | undefined;
	out?: string | undefined;
	copy?: string | undefined;
	snapshot?: string | undefined;
	target?: string | undefined;
	incident?: string | undefined;
	subject?: string | undefined;
	agents?: string | undefined;
	keys?: string[] | undefined;
	current?: string | undefined;
	load?: boolean | undefined;
	history?: boolean | undefined;
};

const required = (value: string | undefined, name: string): string => {
	if (!value) throw new OperatorRefused(`${name}_required`);
	return value;
};

async function privateDirectory(path: string): Promise<string> {
	const info = await lstat(path);
	const real = await realpath(path);
	const inside = relative(await realpath(CHECKOUT), real);
	if (!info.isDirectory() || info.uid !== process.getuid!() || (info.mode & 0o077) !== 0 || !inside.startsWith(".."))
		throw new OperatorRefused("unsafe_control_directory");
	return real;
}

type Config = { dir: string; control: Control; path: (name: string) => string; backupKey: () => KeyObject };

async function connected<T>(
	config: Config,
	production: "approved" | "never",
	run: (db: Database, url: URL, schema: string, files: Record<string, string>) => Promise<T>,
): Promise<T> {
	const env = await privateEnv(config.path("source.env"));
	const { url, href, database } = pinnedConnection(config.control, env.DATABASE_URL_UNPOOLED ?? "");
	allowSource(url, env.AWS_BUCKET_NAME ?? "", production === "approved" ? config.control.production : undefined);
	const db = createDatabase({ connectionString: href, max: 1 });
	try {
		const [actual] = (await db.execute(sql`SELECT current_user AS role, current_database() AS name`)).rows;
		if (actual?.role !== database.role || actual?.name !== database.name) throw new OperatorRefused("target_mismatch");
		return await run(db, url, database.schema, env);
	} finally {
		await closeDatabase(db);
	}
}

const sourceCommit = () => execFileSync("git", ["-C", CHECKOUT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const capture = (config: Config, fromHistory = false): Promise<Snapshot> =>
	connected(config, "approved", (db, url, schema, env) =>
		captureSnapshot({
			db,
			schema,
			files: fileSource(env),
			sourceCommit: sourceCommit(),
			...(fromHistory ? { recoveredTo: historyPoint(url) } : {}),
		}),
	);

const bucketKey = (config: Config) => config.control.bucketKey ?? config.path("tigris.env");
const bucket = (config: Config) => BackupBucket.open(bucketKey(config));

async function appKeys(config: Config): Promise<"open" | "closed"> {
	const evidence = await readPrivateJson(config.path("app-key-probe.json")).catch(() => null);
	return keysRestricted((evidence as { keys?: unknown } | null)?.keys) ? "closed" : "open";
}
const status = async (config: Config) => copyStatus(await bucket(config), clock(), await appKeys(config));

async function readSnapshot(dir: string): Promise<Snapshot> {
	const manifest = JSON.parse((await readPrivateBytes(join(dir, "manifest.json"), COPY_LIMIT)).toString("utf8"));
	const objects = new Map<string, Uint8Array>();
	for (const o of manifest.objects) objects.set(o.id, await readPrivateBytes(join(dir, "objects", o.id), COPY_LIMIT));
	return { manifest, image: await readPrivateBytes(join(dir, "image.json"), COPY_LIMIT), objects };
}

async function openWithKey(config: Config, copy: string): Promise<Snapshot> {
	const key = config.backupKey();
	return openEncryptedCopy(await bucket(config), copy, key);
}

async function restore(config: Config, flags: Flags) {
	const target = required(flags.target, "target");
	if (!flags.copy === !flags.snapshot) throw new OperatorRefused("copy_or_snapshot_required");
	const snapshot = flags.copy
		? await openWithKey(config, flags.copy)
		: await readSnapshot(await privateDirectory(required(flags.snapshot, "snapshot")));
	const live = await privateDirectory(required(flags.current, "current"));
	const current = async () => {
		const witness = {
			dir: live,
			control: await loadControl(join(live, "control.json"), "restore-copy"),
			path: (n: string) => join(live, n),
			backupKey: config.backupKey,
		};
		return connected(witness, "approved", async (db, _url, schema) =>
			db.transaction(async (tx) => {
				await tx.execute(sql.raw(`SET LOCAL search_path TO ${schema}, pg_catalog, pg_temp`));
				return readCurrentManifest(tx as unknown as Database);
			}),
		);
	};
	return connected(config, "never", async (_db, url, schema, env) => {
		if (!["disposable", "drill"].includes(sourceClass(url, readNeon)))
			throw new OperatorRefused("target_not_isolated_drill");
		const client = objectClient(env);
		const destination = required(env.AWS_BUCKET_NAME, "bucket");
		if (new URL(env.AWS_ENDPOINT_URL_S3 ?? "").hostname !== "127.0.0.1")
			throw new OperatorRefused("target_not_isolated_drill");
		const admin = createDatabase({
			connectionString: url.href,
			max: 1,
			options: `-c search_path=${target},pg_catalog,pg_temp`,
		});
		try {
			const result = await restoreWithCurrentManifest(
				{
					admin,
					source: schema,
					targetSchema: target,
					clock,
					objects: {
						put: async (key, bytes) => {
							await client.send(new sdk.PutObjectCommand({ Bucket: destination, Key: key, Body: bytes }));
						},
					},
				},
				{
					capability: {
						authority: "authorized_restricted_recovery_operator",
						verified: true,
						operation_ids: [OPERATION],
						environment: "isolated-test",
					},
					target: "isolated",
					snapshot,
					current,
					...(flags.incident ? { incidentAt: new Date(flags.incident) } : {}),
				},
			);
			return { ...result, subjects: result.subjects.length, completed_at: clock().toISOString() };
		} finally {
			await closeDatabase(admin);
		}
	});
}

const schedulePaths = (flags: Flags) => flags.agents ?? join(homedir(), "Library/LaunchAgents");

export const OPERATOR_COMMANDS: Record<
	string,
	(config: Config, flags: Flags) => Promise<{ ok: boolean; report: unknown }>
> = {
	"backup-capture": async (config, flags) => {
		const out = required(flags.out, "out");
		await mkdir(out, { mode: 0o700 });
		await privateDirectory(out);
		const snapshot = await capture(config, flags.history === true);
		await mkdir(join(out, "objects"), { mode: 0o700 });
		const put = (name: string, bytes: Uint8Array | string) =>
			writeFile(join(out, name), bytes, { mode: 0o600, flag: "wx" });
		for (const [id, bytes] of snapshot.objects) await put(join("objects", id), bytes);
		await put("image.json", snapshot.image);
		await put("manifest.json", JSON.stringify(snapshot.manifest));
		const m = snapshot.manifest as { createdAt: string; database: unknown };
		return { ok: true, report: { created_at: m.createdAt, database: m.database, files: snapshot.objects.size } };
	},
	"backup-daily": async (config) => {
		const key = config.backupKey();
		const store = await bucket(config);
		const backup = await runBackup({
			bucket: store,
			key,
			capture: () => capture(config),
			clock,
		});
		const expiry = await expireCopies(store, clock());
		return {
			ok: backup.copy_complete && expiry.expiry_proven,
			report: { backup, expiry, status: await status(config) },
		};
	},
	"backup-expire": async (config) => {
		const expiry = await expireCopies(await bucket(config), clock());
		return { ok: expiry.expiry_proven, report: expiry };
	},
	"backup-status": async (config) => {
		const report = await status(config);
		return { ok: report.failing.length === 0, report };
	},
	"bucket-probe": async (config, flags) => {
		if (!flags.keys?.length) {
			const buckets = await probeOtherBuckets(await privateEnv(bucketKey(config)));
			const refused = Object.values(buckets).every((b) => b.list === "refused" && b.read === "refused");
			return { ok: refused, report: { backup_key_on: buckets } };
		}
		const probe = await probeAppKeys(flags.keys);
		const evidence = JSON.stringify({ probed_at: clock().toISOString(), ...probe });
		await writeFile(config.path("app-key-probe.json"), evidence, { mode: 0o600 });
		return { ok: probe.restricted, report: probe };
	},
	"schedule-install": async (config, flags) => {
		if (flags.load && CHECKOUT.includes("/.worktrees/")) throw new OperatorRefused("schedule_checkout_refused");
		const installed = await installSchedule(
			{
				agents: schedulePaths(flags),
				config: config.dir,
				cli: fileURLToPath(new URL("./cli.mts", import.meta.url)),
				logs: join(config.dir, "logs"),
			},
			flags.load === true,
		);
		return { ok: true, report: installed };
	},
	"schedule-uninstall": async (_config, flags) => ({
		ok: true,
		report: await uninstallSchedule(schedulePaths(flags), flags.load === true),
	}),
	"restore-copy": async (config, flags) => {
		const report = await restore(config, flags);
		return { ok: report.restore_success, report };
	},
	"restore-open": async (config, flags) =>
		connected(config, "never", async (admin, connection) => {
			const report = await openDrillTarget(
				{ admin, connection, neon: readNeon },
				{
					capability: {
						authority: "authorized_restricted_recovery_operator",
						verified: true,
						operation_ids: [OPEN_OPERATION],
						environment: "isolated-drill",
					},
					target: required(flags.target, "target"),
				},
			);
			return { ok: report.opened, report };
		}),
	"deletion-check": async (config, flags) =>
		connected(config, "approved", async (db, _url, schema, env) => {
			const store = await readBucket(() => bucket(config));
			const report = await checkDeletion(
				{ db, schema, files: fileSource(env), bucket: store },
				required(flags.subject, "subject"),
			);
			return { ok: report.verdict === "purged", report };
		}),
};

export async function runOperator(command: string, flags: Flags, backupKey: () => KeyObject): Promise<boolean> {
	try {
		return await operate(command, flags, backupKey);
	} catch (error) {
		const code = error instanceof OperatorRefused ? error.code : "failed";
		console.log(JSON.stringify({ refused: code }));
		throw error;
	}
}

async function operate(command: string, flags: Flags, backupKey: () => KeyObject): Promise<boolean> {
	const dir = await privateDirectory(required(flags.config, "config"));
	const path = (name: string) => join(dir, name);
	const control = await loadControl(path("control.json"), command);
	const run = OPERATOR_COMMANDS[command];
	if (!run) throw new OperatorRefused("invalid_command");
	const { ok, report } = await run({ dir, control, path, backupKey }, flags);
	console.log(JSON.stringify(report, null, "\t"));
	return ok;
}
