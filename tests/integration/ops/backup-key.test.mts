import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
	backupConfig,
	type BackupConfig,
	fakePrograms,
	filesUnder,
	holdsKey,
	runBackupCli,
} from "../../support/backup-cli.mts";
import { fakeBucket } from "../../support/fake-bucket.mts";

const KEY = "c0ffee".padEnd(64, "0123456789abcdef");
const GENERIC = "Operations command refused or failed. No credentials or raw errors were logged.\n";
const APPROVED_AT = "2026-11-24T00:00:00Z";
const COPY = "copy/2026-11-24/00000000-0000-4000-8000-000000000000";
const dir = mkdtempSync(join(tmpdir(), "backup-key-"));
let connections = 0;
const database = createServer((socket) => {
	connections++;
	socket.destroy();
});
let backups: Awaited<ReturnType<typeof fakeBucket>>;
let local: URL;
before(async () => {
	backups = await fakeBucket();
	await new Promise<void>((done) => database.listen(0, "127.0.0.1", done));
	local = new URL(`postgres://ci:ci@127.0.0.1:${(database.address() as AddressInfo).port}/everyfield_ci`);
});
after(async () => {
	await backups.close();
	await new Promise((done) => database.close(done));
	rmSync(dir, { recursive: true, force: true });
});

const BACKUP = ["backup-copy", "backup-capture", "backup-daily", "backup-expire", "backup-status", "bucket-probe"];
const SCHEDULE = ["schedule-install", "schedule-uninstall"];
let made = 0;
const config = (
	context: BackupConfig["context"],
	{
		url = local,
		bucket = "drill-files",
		...rest
	}: { url?: URL; bucket?: string; production?: BackupConfig["production"] } = {},
) =>
	backupConfig(join(dir, `config-${made++}`), {
		context,
		operations:
			context === "restricted-backup"
				? [...BACKUP, ...SCHEDULE]
				: context === "restricted-recovery"
					? ["restore-copy", "restore-open", "deletion-check"]
					: ["readiness"],
		url,
		files: { endpoint: backups.endpoint, bucket },
		backups: backups.endpoint,
		...rest,
	});
const run = (args: string[], key?: string, env: Record<string, string> = {}) =>
	runBackupCli(args, { ...env, EVERYFIELD_BACKUP_KEY: key });

const BAD: [string, string | undefined, "missing" | "malformed"][] = [
	["unset", undefined, "missing"],
	["empty", "", "missing"],
	["short", KEY.slice(1), "malformed"],
	["long", `${KEY}0`, "malformed"],
	["not hex", `${KEY.slice(1)}g`, "malformed"],
	["leading space", ` ${KEY}`, "malformed"],
	["trailing newline", `${KEY}\n`, "malformed"],
];

test("INV-backup: a missing or malformed key stops every command that needs it before it reads or stores anything, and a leftover key file is neither read nor changed", async () => {
	const backup = config("restricted-backup");
	const recovery = config("restricted-recovery");
	const leftover = randomBytes(32);
	for (const at of [backup, recovery]) writeFileSync(join(at, "backup.key"), leftover, { mode: 0o600 });
	const out = join(dir, "copies");
	mkdirSync(out, { mode: 0o700 });
	const control = ["--control", join(backup, "control.json"), "--out", out];
	const commands: [string, string[]][] = [
		["backup-daily", ["--config", backup]],
		["backup-copy", [...control, "--snapshot", dir]],
		["backup-copy", [...control, "--recopy", COPY]],
		["restore-copy", ["--config", recovery, "--copy", COPY, "--target", "restored", "--current", recovery]],
	];
	const requests = backups.requests();
	for (const [name, value, problem] of BAD)
		await Promise.all(
			commands.map(async ([command, args]) => {
				const { code, stdout, stderr } = await run([command, ...args], value);
				const what = `${command} with the key ${name}`;
				assert.equal(code, 1, what);
				assert.equal(stdout, command === "backup-copy" ? "" : `{"refused":"backup_key_${problem}"}\n`, what);
				assert.equal(
					stderr,
					`EVERYFIELD_BACKUP_KEY is ${problem}. Set it to exactly 64 hex characters for this command only.\n${GENERIC}`,
					what,
				);
			}),
		);
	assert.equal(backups.requests(), requests);
	assert.equal(connections, 0);
	assert.equal(filesUnder(out).size, 0);
	for (const at of [backup, recovery]) assert.deepEqual(readFileSync(join(at, "backup.key")), leftover);

	const good = await run(["backup-daily", "--config", backup], KEY);
	assert.equal(good.code, 2);
	assert.equal(JSON.parse(good.stdout).backup.refusal, "capture_failed");
	assert.ok(backups.requests() > requests && connections > 0);
	assert.equal(holdsKey(good.stdout + good.stderr, KEY), false);
});

test("INV-backup: commands that seal and open nothing work without the key", async () => {
	const backup = ["--config", config("restricted-backup")];
	const recovery = config("restricted-recovery");
	const operator = join(config("migration-operator"), "control.json");
	const snapshot = join(dir, "snapshot");
	mkdirSync(snapshot, { mode: 0o700 });
	for (const [name, text] of [
		["manifest.json", '{"objects":[]}'],
		["image.json", "{}"],
	] as const)
		writeFileSync(join(snapshot, name), text, { mode: 0o600 });
	for (const [args, code] of [
		[["backup-expire", ...backup], 0],
		[["backup-status", ...backup], 2],
		[["bucket-probe", ...backup], 0],
		[["schedule-install", ...backup, "--agents", join(dir, "agents-keyless")], 0],
		[["schedule-uninstall", ...backup, "--agents", join(dir, "agents-keyless")], 0],
		[["readiness", "--control", operator], 0],
	] as const) {
		const result = await run([...args]);
		assert.equal(result.code, code, `${args[0]}: ${result.stdout}${result.stderr}`);
		assert.equal(result.stderr, "");
	}
	for (const args of [
		["backup-capture", ...backup, "--out", join(dir, "captured")],
		["restore-copy", "--config", recovery, "--snapshot", snapshot, "--target", "restored", "--current", recovery],
		["restore-open", "--config", recovery, "--target", "restored"],
		["deletion-check", "--config", recovery, "--subject", "00000000-0000-4000-8000-000000000000"],
	]) {
		const reached = connections;
		const result = await run(args);
		assert.deepEqual([result.code, result.stdout, result.stderr], [1, '{"refused":"failed"}\n', GENERIC], args[0]);
		assert.ok(connections > reached, args[0]);
	}
});

test("INV-backup: a production database or bucket is refused with the key set, unless the owner approved that exact source", async () => {
	const production = new URL("postgres://app:pw@db.example.test/everyfield");
	const approved = {
		host: "db.example.test",
		bucket: "everyfield",
		approvedBy: "owner",
		approvedAt: APPROVED_AT,
	} as const;
	const reached = connections;
	for (const [name, settings] of [
		["a production host", { url: production }],
		["a production host and bucket", { url: production, bucket: "everyfield" }],
		["the app's production bucket", { bucket: "everyfield" }],
		[
			"an approval of another host",
			{ url: production, bucket: "everyfield", production: { ...approved, host: "other.example.test" } },
		],
		["an approval of another bucket", { url: production, production: approved }],
	] as const) {
		const at = config("restricted-backup", settings);
		const captured = await run(["backup-capture", "--config", at, "--out", join(at, "out")], KEY);
		assert.deepEqual([captured.code, captured.stdout], [1, '{"refused":"production_source_refused"}\n'], name);
		const daily = await run(["backup-daily", "--config", at], KEY);
		assert.equal(daily.code, 2, name);
		assert.deepEqual(
			JSON.parse(daily.stdout).backup,
			{ copy_complete: false, refusal: "production_source_refused" },
			name,
		);
	}
	assert.equal(connections, reached);
	assert.deepEqual([...backups.objects.keys()], ["schedule.json"]);
});

test("INV-backup: the key reaches no child program, output, schedule file or store", async () => {
	const bin = fakePrograms(join(dir, "bin"), { neonctl: '{"endpoints":[],"branches":[]}', launchctl: "" });
	const agents = join(dir, "agents");
	const backup = config("restricted-backup", { url: new URL("postgres://o:p@ep-drill-test.aws.neon.tech/neondb") });
	const unreachable = config("restricted-backup");
	writeFileSync(
		join(unreachable, "tigris.env"),
		"AWS_ACCESS_KEY_ID=k\nAWS_SECRET_ACCESS_KEY=s\nAWS_ENDPOINT_URL_S3=http://127.0.0.1:1\n",
		{ mode: 0o600 },
	);
	let output = "";
	for (const args of [
		["--help"],
		["schedule-install", "--config", backup, "--agents", agents],
		["backup-daily", "--config", backup],
		["backup-capture", "--config", backup, "--out", join(dir, "neon-out")],
		["backup-daily", "--config", unreachable],
	]) {
		const { stdout, stderr } = await run(args, KEY, { PATH: bin });
		output += stdout + stderr;
	}
	for (const [path, bytes] of filesUnder(agents)) {
		assert.match(path, /\.plist$/);
		assert.equal(holdsKey(bytes, KEY), false, path);
		assert.doesNotMatch(bytes.toString(), /EVERYFIELD_BACKUP_KEY/);
	}
	const removed = await run(["schedule-uninstall", "--config", backup, "--agents", agents, "--load"], KEY, {
		PATH: bin,
	});
	assert.equal(removed.code, 0);
	for (const program of ["neonctl", "launchctl"]) {
		const seen = readFileSync(join(bin, `${program}.env`), "utf8");
		assert.match(seen, /^PATH=/m);
		assert.doesNotMatch(seen, /EVERYFIELD_BACKUP_KEY/);
		assert.equal(holdsKey(seen, KEY), false);
	}
	assert.equal(holdsKey(output + removed.stdout + removed.stderr, KEY), false);
	assert.match(output, /production_source_refused/);
	for (const [key, { bytes }] of backups.objects) assert.equal(holdsKey(bytes, KEY), false, key);
});
