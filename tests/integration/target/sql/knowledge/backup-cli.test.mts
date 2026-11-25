import "../../../platform/setup.mts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sql } from "../../../../../packages/db/src/query.ts";
import { backupConfig, fakePrograms, filesUnder, holdsKey, runBackupCli } from "../../../../support/backup-cli.mts";
import { fakeBucket } from "../../../../support/fake-bucket.mts";
import { seeds } from "../../../../support/fixture.mts";
import { testDatabase, testDatabaseUrl } from "../../../../support/test-database.mts";
import { dropTarget, readyFile, schemaExists, type Store } from "./support.mts";

const SETUP = new URL("../../../platform/setup.mts", import.meta.url).href;
const DOCUMENT = Buffer.from("%PDF-1.7 launch plan D for Harvest Point");
const url = testDatabaseUrl();
const disposable = ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/everyfield_ci";
if (disposable) url.hostname = "127.0.0.1";

const database = await testDatabase({ prefix: "backupcli" });
const { admin, schema } = database;
const dir = mkdtempSync(join(tmpdir(), "backup-cli-"));
const target = `${schema.slice(0, 40)}_back`;
after(async () => {
	await dropTarget(admin, target);
	rmSync(dir, { recursive: true, force: true });
	await database.close();
});

test(
	"INV-backup: the CLI captures, encrypts, stores, reads back and restores disposable data with a throwaway key, and another key restores nothing",
	{ skip: disposable ? false : "restore-copy takes only a disposable or drill database" },
	async (step) => {
		const [backups, files] = [await fakeBucket(), await fakeBucket("drill-files")];
		step.after(() => Promise.all([backups.close(), files.close()]));
		backups.settings.now = new Date();
		const plant = await seeds(admin).plant({ name: "Harvest Point" });
		const live: Store = new Map();
		const file = await readyFile(admin, live, plant.id, DOCUMENT);
		files.objects.set(file.key, { bytes: DOCUMENT, modifiedAt: new Date(0) });

		const shared = {
			url,
			schema,
			files: { endpoint: files.endpoint, bucket: "drill-files" },
			backups: backups.endpoint,
		};
		const backup = backupConfig(join(dir, "backup"), {
			...shared,
			context: "restricted-backup",
			operations: ["backup-capture", "backup-copy", "backup-daily", "backup-status"],
		});
		const recovery = backupConfig(join(dir, "recovery"), {
			...shared,
			context: "restricted-recovery",
			operations: ["restore-copy"],
		});
		const bin = fakePrograms(join(dir, "bin"), { git: "a".repeat(40) });
		const [key, other] = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
		let output = "";
		const run = async (args: string[], value: string, expected: number) => {
			const env = {
				PATH: bin,
				DATABASE_URL_UNPOOLED: url.href,
				EVERYFIELD_DISPOSABLE_DATABASE: process.env.EVERYFIELD_DISPOSABLE_DATABASE,
				EVERYFIELD_BACKUP_KEY: value,
			};
			const { code, stdout, stderr } = await runBackupCli(args, env, ["--import", SETUP]);
			output += stdout + stderr;
			assert.equal(code, expected, `${args[0]}: ${stdout}${stderr}`);
			return stdout;
		};

		const snapshot = join(dir, "snapshot");
		const copies = join(dir, "copies");
		mkdirSync(copies, { mode: 0o700 });
		await run(["backup-capture", "--config", backup, "--out", snapshot], key, 0);
		const copy = ["backup-copy", "--control", join(backup, "control.json"), "--out", copies];
		const sealed = JSON.parse(await run([...copy, "--snapshot", snapshot], key, 0));
		const stored = filesUnder(copies).size;
		await run([...copy, "--recopy", sealed.location], other, 1);
		assert.equal(filesUnder(copies).size, stored);
		const recopied = JSON.parse(await run([...copy, "--recopy", sealed.location], key, 0));
		assert.notEqual(recopied.location, sealed.location);

		const { backup: taken } = JSON.parse(await run(["backup-daily", "--config", backup], key, 0));
		assert.deepEqual([taken.copy_complete, taken.files], [true, 1]);
		const status = JSON.parse(await run(["backup-status", "--config", backup], key, 2));
		assert.deepEqual(status.failing, ["app_key_restriction_open"]);

		files.objects.clear();
		const restore = ["restore-copy", "--config", recovery, "--copy", taken.location, "--target", target];
		restore.push("--current", recovery);
		await run(restore, other, 1);
		assert.equal(await schemaExists(admin, target), false);
		assert.equal(files.objects.size, 0);
		const restored = JSON.parse(await run(restore, key, 0));
		assert.equal(restored.restore_success, true);
		const { rows } = await admin.execute(
			sql`SELECT name FROM ${sql.raw(`${target}.plant`)} WHERE id=${plant.id}::uuid`,
		);
		assert.deepEqual(rows, [{ name: "Harvest Point" }]);
		assert.deepEqual(
			[...files.objects.values()].map((o) => o.bytes),
			[DOCUMENT],
		);

		const seen = readFileSync(join(bin, "git.env"), "utf8");
		assert.match(seen, /^PATH=/m);
		assert.doesNotMatch(seen, /EVERYFIELD_BACKUP_KEY/);
		for (const value of [key, other]) {
			assert.equal(holdsKey(output, value), false);
			for (const [path, bytes] of filesUnder(dir)) assert.equal(holdsKey(bytes, value), false, path);
			for (const [at, { bytes }] of backups.objects) assert.equal(holdsKey(bytes, value), false, at);
		}
	},
);
