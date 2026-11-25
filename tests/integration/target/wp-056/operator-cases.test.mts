import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as tcpServer, type AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";
import { queuedMailTransport } from "../../../../apps/web/src/server/mail/transport.ts";
import { privateStorageFrom } from "../../../../packages/db/src/schema/storage.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { developmentHosts } from "../../../../packages/db/src/development.ts";
import { assertCurrentCatalog } from "../../../../packages/db/src/schema/catalog.ts";
import { inspectMigrationProvenance, migrate } from "../../../../packages/db/src/schema/migrate.ts";
import { messageTemplateInstaller } from "../../../../packages/reference/src/message-templates.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { communicationWriter, withCommunicationWrite } from "../../../../packages/domain/src/communication/index.ts";
import { READ_DOMAINS } from "../../../../packages/evry/src/catalog/catalog.ts";
import { runBackup } from "../../../../ops/maintenance/backup.mts";
import { developmentConnection } from "../../../../ops/maintenance/control.mts";
import { openEncryptedCopy } from "../../../../ops/maintenance/copy.mts";
import { readiness } from "../../../../ops/maintenance/readiness.mts";
import { validateCandidate } from "../../../../ops/maintenance/recovery.mts";
import {
	readCurrentManifest,
	restoreWithCurrentManifest,
	schemaVersion,
} from "../../../../ops/maintenance/restore.mts";
import { allowSource } from "../../../../ops/maintenance/source.mts";
import { seedRefusal } from "../../../../tools/qa/qa-guard.ts";
import { MissingRecording, recorder } from "../../../evry/evals/golden-harness.mts";
import { backupConfig, holdsKey, runBackupCli } from "../../../support/backup-cli.mts";
import { fakeBucket } from "../../../support/fake-bucket.mts";
import { fixture, ok, type Actor } from "../../../support/fixture.mts";
import { touched, untouched } from "../../../support/recorded.mts";
import { testDatabase, testDatabaseUrl } from "../../../support/test-database.mts";
import { resendRecorder } from "../../communication/resend-recorder.mts";
import {
	closedTo,
	dropTarget,
	objectStore,
	operator,
	readyFile,
	schemaExists,
	snapshot,
	type Store,
} from "../sql/knowledge/support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	expected: { result: Record<string, unknown>; event: null };
};
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const at = (path: string) => join(root, path);
const { cases } = JSON.parse(readFileSync(at("docs/acceptance/operations.json"), "utf8")) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const given = (c: Case, name: string) => c.given[name] ?? assert.fail(`no fixture ${name}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));

const NOW = new Date(caseOf("CASE-OPS-005").clock.now);
const database = await fixture({ prefix: "operatorcases", plant: { name: "Harvest Point" }, clock: NOW });
const { admin, schema } = database;
const db = database.pools.runtime;
const P = database.tenant;
const A = database.actors.admin;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "operator-cases-")));
const live: Store = new Map();
const targets: string[] = [];
let connections = 0;
const unknown = tcpServer((socket) => {
	connections++;
	socket.destroy();
});
let unknownUrl = "";
before(async () => {
	await new Promise<void>((resolve) => unknown.listen(0, "127.0.0.1", resolve));
	unknownUrl = `postgres://operator:target-secret@127.0.0.1:${(unknown.address() as AddressInfo).port}/everyfield`;
});
after(async () => {
	unknown.close();
	for (const name of targets) await dropTarget(admin, name);
	rmSync(dir, { recursive: true, force: true });
	await database.close();
});
const rowsOf = async (query: SQL, pool = admin) => (await pool.execute(query)).rows;
const actorOf = async (who: Actor) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const GENERIC = "Operations command refused or failed. No credentials or raw errors were logged.\n";
const clockAt = (now: string) =>
	`data:text/javascript,${encodeURIComponent(`const H=Date;globalThis.Date=new Proxy(H,{construct:(t,a,n)=>Reflect.construct(t,a.length?a:[${Date.parse(now)}],n),get:(t,p,r)=>p==="now"?()=>${Date.parse(now)}:Reflect.get(t,p,r)})`)}`;

function control(name: string, operations: string[], url: URL, context = "migration-operator") {
	const path = join(dir, `${name}.json`);
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			host: hostname(),
			uid: process.getuid!(),
			environment: "development",
			context,
			expiresAt: "2100-01-01T00:00:00Z",
			operations,
			database: { host: url.hostname, name: url.pathname.slice(1), role: url.username, schema },
		}),
		{ mode: 0o600 },
	);
	return path;
}
const TSX = pathToFileURL(createRequire(at("packages/domain/package.json")).resolve("tsx/esm")).href;
const node = (args: string[], env: Record<string, string | undefined>, cwd = root) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
		execFile(
			process.execPath,
			["--conditions=react-server", "--import", TSX, ...args],
			{ cwd, env: { PATH: process.env.PATH, HOME: dir, ...env }, encoding: "utf8" },
			(error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
		),
	);
let restores = 0;
async function rehearse(
	copy: Awaited<ReturnType<typeof snapshot>>,
	current: () => Promise<unknown> = () => readCurrentManifest(admin),
	clock = NOW,
) {
	const target = `${schema.slice(0, 48)}_r${restores++}`;
	targets.push(target);
	const store: Store = new Map();
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objectStore(store), clock: () => clock },
		{ capability: operator, target: "isolated", snapshot: copy, current },
	);
	return { result, store, target };
}

const acceptanceRoot = (name: string, example: Case & Record<string, unknown>, files: Record<string, string>) => {
	const base = join(dir, name);
	const write = (path: string, text: string) => {
		mkdirSync(dirname(join(base, path)), { recursive: true });
		writeFileSync(join(base, path), text);
	};
	write(
		"docs/catalog/index.json",
		JSON.stringify({
			requirement_files: [],
			acceptance_source: "docs/catalog/acceptance.json",
			operation_source: "docs/catalog/operations.json",
			case_files: ["docs/acceptance/cases.json"],
		}),
	);
	write("docs/catalog/acceptance.json", "[]");
	const inventory = JSON.parse(readFileSync(at("docs/catalog/operations.json"), "utf8")) as {
		operations: Record<string, unknown>[];
	};
	write(
		"docs/catalog/operations.json",
		JSON.stringify({ operations: inventory.operations.map((o) => ({ ...o, case_ids: [] })) }),
	);
	write("docs/schema/target.json", JSON.stringify({ type_contracts: {}, tables: [] }));
	write("docs/plan/dag.json", JSON.stringify({ packages: [], vertical_slices: [{ id: "S0", required_packages: [] }] }));
	write("docs/acceptance/case.schema.json", readFileSync(at("docs/acceptance/case.schema.json"), "utf8"));
	write(
		"docs/acceptance/cases.json",
		JSON.stringify({ case_schema: "docs/acceptance/case.schema.json", cases: [example] }),
	);
	for (const [path, text] of Object.entries(files)) write(path, text);
	return base;
};
const acceptance = (base: string, ...args: string[]) =>
	new Promise<{ code: number; stdout: string; stderr: string }>((resolve) =>
		execFile(
			"python3",
			[at("docs/acceptance/check.py"), "--root", base, ...args],
			{ encoding: "utf8" },
			(error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
		),
	);
async function proofOf(id: string) {
	const { run_by: _, ...declared } = caseOf(id) as Case & { run_by?: unknown };
	const example = { ...declared, status: "future-not-run", work_packages: [], feature_ids: [], acceptance_ids: [] };
	const mock = "tests/mocked.test.mts";
	const files = { [mock]: `test("a mocked suite passes", () => {});\n` };
	const unrun = await acceptance(acceptanceRoot(`${id}-unrun`, example, files), "--release");
	const claimed = { ...example, status: "run", run_by: [mock] };
	const claim = await acceptance(acceptanceRoot(`${id}-claimed`, claimed, files));
	const proven = { [mock]: `test("AC:${id} runs for real", () => {});\n` };
	const real = acceptanceRoot(`${id}-real`, claimed, proven);
	const accepted = [await acceptance(real), await acceptance(real, "--release")];
	assert.deepEqual(
		accepted.map((a) => a.code),
		[0, 0],
		accepted.map((a) => a.stderr).join(),
	);
	assert.match(claim.stderr, new RegExp(`${mock} does not run AC:${id}`));
	assert.match(unrun.stderr, new RegExp(`:${id}: selected case is future-not-run, not run`));
	assert.match(unrun.stdout, /Total: 1 selected, 0 run, 1 not run, 0 excepted/);
	return { accepted: claim.code === 0 || unrun.code === 0, status: /1 not run/.test(unrun.stdout) ? "not_run" : "run" };
}

test("AC:CASE-OPS-005 a changed applied checksum or an unknown database applies no migration, the fresh history replays once, and a restore under a stale deletion journal opens nothing", async (t) => {
	const c = caseOf("CASE-OPS-005");
	const { result } = c.expected;
	const repeat = Number(given(c, "execution").repeat);

	await t.test("concurrent and repeated runs of a fresh history apply it once", async () => {
		const fresh = await testDatabase({ prefix: "freshhistory", migrate: false });
		try {
			const runs = await Promise.all([migrate(fresh.admin, fresh.schema), migrate(fresh.admin, fresh.schema)]);
			assert.deepEqual(runs.map((r) => r.length > 0).sort(), [false, true]);
			assert.deepEqual(await migrate(fresh.admin, fresh.schema), []);
			assert.equal((await inspectMigrationProvenance(fresh.admin, fresh.schema)).state, "current");
		} finally {
			await fresh.close();
		}
	});

	await t.test("a changed checksum stops the run before the pending migration", async () => {
		assert.equal(given(c, "behavior-inputs").migration_checksum_matches, false);
		const [last] = await rowsOf(sql`SELECT name,sha256 FROM schema_migration ORDER BY name DESC LIMIT 1`);
		const directory = join(dir, "migrations");
		await cp(at("packages/db/migrations"), directory, { recursive: true });
		writeFileSync(join(directory, "20991231235959_planted.sql"), "CREATE TABLE planted_migration(id int);");
		await admin.execute(sql`UPDATE schema_migration SET sha256=${"0".repeat(64)} WHERE name=${str(last?.name)}`);
		const { tables } = await touched(admin, async () => {
			for (let n = 0; n < repeat; n++)
				await assert.rejects(migrate(admin, schema, pathToFileURL(directory + "/")), {
					message: "migration_checksum_conflict",
				});
		});
		const [planted] = await rowsOf(sql`SELECT to_regclass('planted_migration') IS NOT NULL AS made`);
		assert.equal(tables.length > 0 || planted?.made, result.migration_applied);
		assert.equal((await inspectMigrationProvenance(admin, schema)).state, "conflict");
		await admin.execute(sql`UPDATE schema_migration SET sha256=${str(last?.sha256)} WHERE name=${str(last?.name)}`);
		assert.deepEqual(await migrate(admin, schema), []);
		await assert.rejects(migrate(db, schema), (e) => (e as { cause: { code: string } }).cause.code === "42501");
	});

	await t.test(
		"an unknown target is refused with a verified scoped operator control, before a connection",
		async () => {
			assert.equal(given(c, "behavior-inputs").DB_target, "unknown");
			const url = testDatabaseUrl();
			const development = new URL(`postgres://operator:pw@${[...developmentHosts][0]}/neondb`);
			const before = connections;
			const applied: boolean[] = [];
			for (const target of [
				new URL(unknownUrl),
				url,
				new URL("postgres://operator:pw@ep-unknown.aws.neon.test/neondb"),
			])
				await untouched(admin, async () => {
					for (let n = 0; n < repeat; n++) {
						const file = control("migration", ["migration-apply"], target);
						const { code, stdout, stderr } = await runBackupCli(["migration-apply", "--control", file], {
							DATABASE_URL_UNPOOLED: target.href,
						});
						assert.deepEqual([stdout, stderr], ["", GENERIC]);
						applied.push(code === 0);
					}
				});
			assert.equal(applied.some(Boolean), result.migration_applied);
			assert.equal(connections, before);
			const pinned = JSON.parse(
				readFileSync(control("development", ["migration-apply"], development), "utf8"),
			) as Parameters<typeof developmentConnection>[0];
			assert.equal(new URL(developmentConnection(pinned, development.href)).hostname, development.hostname);
			for (const other of [
				development.href.replace("operator:", "owner:"),
				development.href.replace("/neondb", "/other"),
				development.href.replace(development.hostname, "ep-gentle-dust-1.aws.neon.test"),
			])
				assert.throws(() => developmentConnection(pinned, other), { code: "target_mismatch" });
		},
	);

	await t.test("a restore whose deletion journal is older than its copy stays closed", async () => {
		const leaving = await database.plant({ name: "Leaving" });
		const stale = await readCurrentManifest(admin);
		await admin.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,plant_id,request_id,request_revision,state,requested_at,
			cancel_until,witness_checkpoint,cleanup_state) VALUES('plant',${leaving.id},${leaving.id},${randomUUID()},1,'pending_deletion',
			${c.clock.now}::timestamptz-interval '1 day',${c.clock.now}::timestamptz+interval '29 days',1,'not_started')`);
		const copy = await snapshot(admin, live, { createdAt: NOW });
		for (const current of [async () => stale, async () => null]) {
			const { result: restored, target, store } = await rehearse(copy, current);
			assert.equal(restored.restore_success, false);
			assert.ok(["witness_stale", "witness_missing"].includes(str(restored.refusal)), str(restored.refusal));
			assert.equal(restored.service_opened || (await schemaExists(admin, target)), result.service_reopened);
			assert.equal(store.size, 0);
		}
		const { result: restored, target } = await rehearse(copy);
		assert.equal(restored.restore_success, true, JSON.stringify(restored));
		assert.equal(restored.service_opened || !(await closedTo(db, target)), result.service_reopened);
	});
	assert.equal(c.expected.event, null);
});

test("AC:CASE-OPS-006 a reset aimed at a shared database is refused whatever sentinel is set, and a repeated reference install adds nothing and keeps a church's own copy", async (t) => {
	const c = caseOf("CASE-OPS-006");
	const { result } = c.expected;
	const { tenant_fork, sentinel_present } = given(c, "case-input");
	assert.equal(sentinel_present, true);
	const sentinel = {
		EVERYFIELD_DISPOSABLE_DATABASE: "1",
		CI: "true",
		QA_ROLE_PASSWORD: "a-long-enough-password",
		IDENTITY_MAIL_KEY: "a".repeat(64),
		IDENTITY_ADDRESS_KEY: "b".repeat(64),
	};
	const endpoint = str([...developmentHosts][0]).split(".")[0]!;

	await t.test("no seed or reset runs against a shared endpoint", async () => {
		const allowed: boolean[] = [];
		for (const host of [endpoint, `${endpoint}-pooler`, "ep-gentle-dust-1"]) {
			const shared = `postgres://seed:shared-secret@${host}.shared.invalid/neondb`;
			const refusal = seedRefusal({ ...sentinel, DATABASE_URL: shared });
			allowed.push(refusal === null);
			assert.match(str(refusal), /shared development branch|production database/);
			const seeded = await node([at("tools/qa/qa-seed.ts")], { ...sentinel, DATABASE_URL: shared });
			assert.ok(seeded.stderr.includes(str(refusal)), seeded.stderr);
			assert.equal((seeded.stdout + seeded.stderr).includes("shared-secret"), false);
			allowed.push(seeded.code === 0);
		}
		for (const shared of [unknownUrl, "postgres://reset:shared-secret@db.shared.invalid/neondb"]) {
			const before = connections;
			const reset = await node([at("packages/db/scripts/reset-dev.ts")], { ...sentinel, DATABASE_URL: shared });
			assert.match(reset.stderr, /^Reset refused\./);
			allowed.push(reset.code === 0);
			const saved = { ...process.env };
			try {
				Object.assign(process.env, sentinel, { DATABASE_URL: shared });
				delete process.env.DATABASE_URL_UNPOOLED;
				assert.throws(
					() => testDatabaseUrl(),
					/Approved shared development database or disposable CI database required/,
				);
			} finally {
				for (const name of [...Object.keys(sentinel), "DATABASE_URL", "DATABASE_URL_UNPOOLED"])
					if (saved[name] === undefined) delete process.env[name];
					else process.env[name] = saved[name];
			}
			assert.equal(connections, before);
		}
		assert.equal(allowed.some(Boolean), result.reset_allowed);
		assert.equal(seedRefusal({ ...sentinel, DATABASE_URL: "postgres://seed:pw@ep-qa-one.aws.neon.test/neondb" }), null);
	});

	await t.test("the same reference bytes install nothing more and leave the fork as the church wrote it", async () => {
		assert.equal(given(c, "case-input").reference_replay_same_hash, true);
		const publisher = await database.actor(null, "owner", { account: { registration_kind: "planter" } });
		await admin.execute(
			sql`INSERT INTO platform_grant(account_id,capability) VALUES(${publisher.id},'reference_publish')`,
		);
		const source = {
			path: "docs/reference/communication-system-templates.ts",
			sha256: "07aa5ec09e7499b77d856e079c1c7312cc04dd443146f702e5a143ae6de561ba",
		};
		const caller = { actorId: publisher.id, userId: publisher.user, sessionId: publisher.session };
		const install = () => messageTemplateInstaller(admin).installMessageTemplates(caller, { source });
		const items = async () => Number((await rowsOf(sql`SELECT count(*)::int AS n FROM reference_item`))[0]?.n);
		const actor = await actorOf(A);
		const forked = ok(
			await withCommunicationWrite(db, actor, (tx, ctx) =>
				communicationWriter.forkTemplate(tx, ctx, {
					requestKey: randomUUID(),
					input: { sourceKey: "vision-meeting-invitation" },
				}),
			),
		);
		const fork = ok(
			await withCommunicationWrite(db, actor, (tx, ctx) =>
				communicationWriter.updateTemplate(tx, ctx, {
					requestKey: randomUUID(),
					expectedRevision: forked.revision,
					input: {
						templateId: forked.templateId,
						patch: {
							name: forked.name,
							description: forked.description,
							category: "meeting_invitation",
							meetingType: "vision_meeting",
							subject: tenant_fork,
							bodyHtml: "<p>Welcome {{name}}.</p>",
						},
					},
				} as never),
			),
		);
		await install();
		assert.equal(await items(), 7);
		const { value, tables } = await touched(admin, install);
		const { installed } = value as { installed: number };
		assert.deepEqual([installed, tables.length, await items()], [result.same_hash_reference_inserts, 0, 7]);
		const [kept] = await rowsOf(sql`SELECT subject FROM message_template WHERE id=${fork.templateId}`);
		assert.equal(kept?.subject, result.tenant_fork);
		await untouched(admin, () =>
			assert.rejects(
				messageTemplateInstaller(admin).installMessageTemplates(caller, {
					source: { ...source, sha256: "0".repeat(64) },
				}),
			),
		);
	});
	assert.equal(c.expected.event, null);
});

test("AC:CASE-OPS-007 passing mocked suites are no acceptance without the real run, and a restore with a ready row but no bytes is no success", async () => {
	const c = caseOf("CASE-OPS-007");
	const { result } = c.expected;
	const { mock_SQL_passed, real_native_run, restore_bytes_present } = given(c, "behavior-inputs");
	assert.deepEqual([mock_SQL_passed, real_native_run, restore_bytes_present], [true, false, false]);
	assert.equal((await proofOf(c.id)).accepted, result.application_acceptance);
	const saved = { direct: process.env.DATABASE_URL_UNPOOLED, pooled: process.env.DATABASE_URL };
	try {
		delete process.env.DATABASE_URL_UNPOOLED;
		delete process.env.DATABASE_URL;
		await assert.rejects(
			testDatabase({ prefix: "nowhere" }),
			/Approved shared development database or disposable CI database required/,
		);
	} finally {
		if (saved.direct !== undefined) process.env.DATABASE_URL_UNPOOLED = saved.direct;
		if (saved.pooled !== undefined) process.env.DATABASE_URL = saved.pooled;
	}

	const file = await readyFile(admin, live, P.id, Buffer.from("%PDF-1.7 launch plan D"));
	const copy = await snapshot(admin, live, { createdAt: NOW });
	const whole = await rehearse(copy);
	assert.equal(whole.result.restore_success, true, JSON.stringify(whole.result));
	(copy.objects as Map<string, Uint8Array>).delete(file.id);
	const { result: restored, store, target } = await rehearse(copy);
	assert.equal(restored.restore_success, result.restore_success);
	assert.deepEqual(
		[restored.refusal, restored.file, restored.customer_data_gate],
		["file_missing", file.id, "blocked"],
	);
	assert.deepEqual([await schemaExists(admin, target), store.size], [false, 0]);
	assert.equal(c.expected.event, null);
});

test("AC:CASE-OPS-008 a preview of another checkout or server is not accepted, a production secret stops it before it starts, and a real sender reaches nobody", async (t) => {
	const c = caseOf("CASE-OPS-008");
	const { result } = c.expected;
	assert.deepEqual(given(c, "behavior-inputs"), {
		fixture_type: "test_setup",
		preview_source: "wrong-checkout",
		production_secret_present: true,
		real_sender: true,
	});
	const base = join(dir, "preview");
	const [candidate, other, bin] = [join(base, "candidate-checkout"), join(base, "wrong-checkout"), join(base, "bin")];
	const gitEnv = { PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-C", cwd, "-c", "user.name=Case", "-c", "user.email=case@example.test", ...args], {
			env: gitEnv,
			encoding: "utf8",
		}).trim();
	for (const path of [candidate, other]) {
		mkdirSync(join(path, "packages/db/src"), { recursive: true });
		writeFileSync(
			join(path, "packages/db/src/development.ts"),
			await readFile(at("packages/db/src/development.ts"), "utf8"),
		);
		git(path, "init", "-q", "-b", "main");
		git(path, "add", "-A");
		git(path, "commit", "-q", "-m", path);
	}
	git(candidate, "remote", "add", "origin", candidate);
	const heads = { candidate: git(candidate, "rev-parse", "HEAD"), other: git(other, "rev-parse", "HEAD") };
	assert.notEqual(heads.candidate, heads.other);
	mkdirSync(bin);
	const registry = join(base, "registry.json");
	const calls = join(base, "calls.log");
	writeFileSync(
		join(bin, "portless"),
		`#!/bin/sh\necho "$@" >> "${calls}"\ncase "$2" in status) cat "${registry}";; *) echo '{}';; esac\n`,
	);
	chmodSync(join(bin, "portless"), 0o755);
	const env = { ...gitEnv, PATH: `${bin}:${process.env.PATH}` };
	let hits = 0;
	const server = createServer((_request, response) => {
		hits++;
		response.end("preview");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => server.close());
	const { port } = server.address() as AddressInfo;
	const record = {
		id: "preview-1",
		project: candidate,
		head: heads.candidate,
		branch: "main",
		mode: "production",
		state: "ready",
		url: `http://localhost:${port}/`,
	};
	const stack = (rows: object[]) => {
		writeFileSync(registry, JSON.stringify(rows));
		return node([at("scripts/stack.mjs"), "check", "--project", candidate], env);
	};

	await t.test("the preview's source, checkout and URL must be the candidate's own", async () => {
		const allowed: boolean[] = [];
		for (const [name, row, message] of [
			["another commit", { ...record, head: heads.other }, "Preview commit differs from HEAD"],
			["another checkout", { ...record, project: other }, "This worktree has no ready preview"],
			["a failed preview", { ...record, state: "failed" }, "This worktree has no ready preview"],
			[
				"an unrelated local server",
				{ ...record, url: `http://127.0.0.1:${port}/` },
				"Preview must use a local Portless URL",
			],
			[
				"credentials in the URL",
				{ ...record, url: `http://u:pw@localhost:${port}/` },
				"Preview must use a local Portless URL",
			],
			["a public host", { ...record, url: "https://preview.example.test/" }, "Preview must use a local Portless URL"],
		] as const) {
			const checked = await stack([row]);
			assert.ok(checked.stderr.includes(message), `${name}: ${checked.stderr}`);
			allowed.push(checked.code === 0);
		}
		assert.equal(allowed.some(Boolean), result.preview_allowed);
		assert.equal(hits, 0);
		const own = await stack([record]);
		assert.equal(own.code, 0, own.stderr);
		assert.deepEqual([JSON.parse(own.stdout).head, JSON.parse(own.stdout).httpStatus, hits], [heads.candidate, 200, 1]);
	});

	await t.test("a copied production secret refuses the preview before anything is started", async () => {
		const secret = "postgres://neondb_owner:PRODUCTION-SECRET@ep-gentle-dust-1.aws.neon.test/neondb";
		mkdirSync(join(candidate, "apps/web"), { recursive: true });
		const settings = join(candidate, "apps/web/.env.local");
		writeFileSync(settings, `DATABASE_URL=${secret}\n`);
		writeFileSync(registry, "[]");
		rmSync(calls, { force: true });
		const preview = () =>
			node(
				[at(".agents/skills/verify-preview/scripts/preview.mjs"), candidate, "--mode", "development"],
				env,
				candidate,
			);
		const refusedPreview = await preview();
		assert.equal(refusedPreview.code === 0, result.preview_allowed);
		assert.match(
			refusedPreview.stderr,
			/Refused: the composed preview env DATABASE_URL is not the shared development database/,
		);
		assert.doesNotMatch(refusedPreview.stdout + refusedPreview.stderr, /PRODUCTION-SECRET|ep-gentle-dust/);
		assert.equal(existsSync(calls), false, "no preview was started");
		const storageKeys = {
			AWS_ACCESS_KEY_ID: "k",
			AWS_SECRET_ACCESS_KEY: "s",
			AWS_ENDPOINT_URL_S3: "https://storage.example.test",
		};
		for (const VERCEL_ENV of [undefined, "preview"])
			assert.throws(
				() => privateStorageFrom({ ...storageKeys, AWS_BUCKET_NAME: "everyfield", VERCEL_ENV }),
				/production only/,
			);
	});

	await t.test("with a provider key present, a preview hands the provider no mail", async () => {
		const resend = resendRecorder();
		const ready = {
			keys: {
				encryptionKey: Buffer.alloc(32, 1),
				addressKey: Buffer.alloc(32, 2),
				from: "church@everyfield.app",
				origin: "https://preview.localhost",
				optOutKeys: null,
			},
			apiKey: "re_real_sender",
		};
		const outbox = process.env.EVERYFIELD_DEV_OUTBOX;
		process.env.EVERYFIELD_DEV_OUTBOX = join(base, "outbox");
		const payload = { from: ready.keys.from, to: A.email, subject: "Hello", html: "<p>Hello</p>", text: "Hello" };
		const send = (environment: Record<string, string>) =>
			queuedMailTransport(ready, resend.fetch, environment).send(
				payload as never,
				randomUUID() as never,
				AbortSignal.any([]),
			);
		try {
			for (const environment of [
				{},
				{ VERCEL_ENV: "preview" },
				{ VERCEL_ENV: "development" },
				{ VERCEL_ENV: "preview", EMAIL_TEST_RECIPIENTS: "someone@example.test" },
			]) {
				const sent = await send(environment as Record<string, string>);
				assert.match(str((sent as { id?: string }).id), /^capture-/);
			}
			assert.equal(resend.requests.length, result.real_sends);
			await send({ VERCEL_ENV: "production" });
			assert.equal(resend.requests.length, 1);
		} finally {
			if (outbox === undefined) delete process.env.EVERYFIELD_DEV_OUTBOX;
			else process.env.EVERYFIELD_DEV_OUTBOX = outbox;
		}
	});
	assert.equal(c.expected.event, null);
});

test("AC:CASE-OPS-010 listing the operator's commands runs none of them, a destructive seed refuses an unknown target, and a test file with no real run is no acceptance", async () => {
	const c = caseOf("CASE-OPS-010");
	const { result } = c.expected;
	assert.deepEqual(given(c, "behavior-inputs"), {
		fixture_type: "test_setup",
		script: "destructive_seed",
		target: "unknown",
		test_file_exists: true,
	});
	const before = connections;
	const environment = {
		DATABASE_URL: unknownUrl,
		DATABASE_URL_UNPOOLED: unknownUrl,
		EVERYFIELD_DISPOSABLE_DATABASE: undefined,
	};
	const ran: boolean[] = [];
	const { listed, scripts } = await untouched(admin, async () => {
		const help = await runBackupCli(["--help"], environment);
		assert.deepEqual([help.code, help.stderr], [0, ""]);
		const [, names] = /Commands: ([a-z, -]+)\./.exec(help.stdout) ?? assert.fail(help.stdout);
		const listed = str(names).split(", ");
		const scripts = JSON.parse(readFileSync(at("ops/maintenance/runbook.json"), "utf8")).commands as Record<
			string,
			string
		>;
		for (const command of listed) {
			const tried = await runBackupCli([command], environment);
			assert.deepEqual([tried.stdout, tried.stderr], ["", GENERIC], command);
			ran.push(tried.code === 0);
		}
		for (const script of [
			[at("packages/db/scripts/reset-dev.ts")],
			[at("packages/reference/src/starter/verify/cli.ts")],
		]) {
			const tried = await node(script, environment, at("packages/reference"));
			assert.notEqual(tried.code, 0, script.at(-1));
			assert.match(tried.stderr, /[Rr]efused/, script.at(-1));
			assert.equal((tried.stdout + tried.stderr).includes("target-secret"), false);
			ran.push(tried.code === 0);
		}
		return { listed, scripts };
	});
	assert.ok(listed.includes("readiness") && listed.includes("migration-apply"));
	for (const command of listed)
		assert.ok(
			Object.values(scripts).some((line) => line.includes(` ${command} `)),
			command,
		);
	assert.equal(ran.some(Boolean), result.execution_allowed);
	assert.equal(connections, before);
	assert.equal((await proofOf(c.id)).accepted, result.application_acceptance);
	assert.equal(c.expected.event, null);
});

test("AC:CASE-OPS-011 an old schema is read without a write, its retired tables and grants are not in the live schema, and a retired operation or table cannot come back unseen", async () => {
	const c = caseOf("CASE-OPS-011");
	const { result } = c.expected;
	const { retired_table_in_historical_evidence, retired_helper_in_live_catalog } = given(c, "case-input");
	const history = await database.createSchema(`${schema.slice(0, 50)}_old`);
	const directory = join(dir, "history");
	mkdirSync(directory);
	for (const name of ["0001_early_access.sql", "0002_baseline.sql"])
		await cp(at(`packages/db/migrations/${name}`), join(directory, name));
	await migrate(admin, history, pathToFileURL(directory + "/"));
	const tablesIn = async (name: string) =>
		(await rowsOf(sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema=${name}`)).map((r) =>
			str(r.name),
		);
	const helpersIn = async (name: string) =>
		(
			await rowsOf(
				sql`SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${name}`,
			)
		).map((r) => str(r.name));
	const marked = async () =>
		rowsOf(sql`SELECT c.relname,c.relkind::text,c.relacl::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
			WHERE n.nspname=${history} ORDER BY 1`);
	const evidence = await marked();
	const inspected = await admin.transaction(async (tx) => {
		await tx.execute(sql`SET TRANSACTION READ ONLY`);
		return inspectMigrationProvenance(tx as never, history);
	});
	assert.equal(inspected.state, "pending");
	assert.deepEqual(
		inspected.applied.map((m) => m.name),
		["0001_early_access.sql", "0002_baseline.sql"],
	);
	assert.equal(JSON.stringify(await marked()) === JSON.stringify(evidence), result.historical_evidence_readonly);

	const liveTables = new Set(await tablesIn(schema));
	const retired = (await tablesIn(history)).filter((name) => !liveTables.has(name));
	assert.equal(retired.length > 0, retired_table_in_historical_evidence);
	assert.ok(retired.includes("conversation_entry") && retired.includes("effect"), retired.join());
	const liveHelpers = new Set(await helpersIn(schema));
	const past = await helpersIn(history);
	const helpers = retired.map((name) => `${name}_bind_record`).filter((name) => past.includes(name));
	assert.ok(helpers.length > 0, past.join());
	assert.equal(
		helpers.some((name) => liveHelpers.has(name)),
		retired_helper_in_live_catalog,
	);
	for (const statement of retired.map((name) => `SELECT 1 FROM "${name}"`))
		await assert.rejects(
			db.execute(sql.raw(statement)),
			(e) => (e as { cause: { code: string } }).cause.code === "42P01",
		);

	const target = JSON.parse(readFileSync(at("docs/schema/target.json"), "utf8"));
	assert.deepEqual(
		Object.keys(target.retired_tables).filter((name) => liveTables.has(name)),
		[],
	);
	await assertCurrentCatalog(admin, schema, target);
	await admin.execute(sql`CREATE TABLE conversation_entry(id uuid PRIMARY KEY)`);
	await assert.rejects(assertCurrentCatalog(admin, schema, target), /differ from target.json/);
	const granted =
		await rowsOf(sql`SELECT role,priv FROM unnest(ARRAY['everyfield_runtime','everyfield_auth','everyfield_cleanup']) role
		CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) priv
		WHERE has_table_privilege(role::name,'conversation_entry'::regclass,priv)`);
	const opened = await db.execute(sql`SELECT 1 FROM conversation_entry`).then(
		() => true,
		(e) => ((e as { cause: { code: string } }).cause.code === "42501" ? false : assert.fail(String(e))),
	);
	assert.equal(granted.length > 0 || opened, result.retired_permissions_restored, JSON.stringify(granted));
	await admin.execute(sql`DROP TABLE conversation_entry`);
	await assertCurrentCatalog(admin, schema, target);

	const { operations } = JSON.parse(readFileSync(at("docs/catalog/operations.json"), "utf8")) as {
		operations: { id: string }[];
	};
	const inventory = new Set(operations.map((o) => o.id));
	const served = JSON.parse(readFileSync(at("docs/catalog/evry-tools.json"), "utf8")).operation_ids as string[];
	assert.deepEqual(
		served.filter((id) => !inventory.has(id)),
		result.retired_live_operations,
	);
	const offered = Object.values(READ_DOMAINS).flatMap((adapters) => adapters.map((a) => a.operation as string));
	assert.ok(offered.length > 0);
	assert.deepEqual(
		offered.filter((id) => !inventory.has(id)),
		result.retired_live_operations,
	);
	const catalog = join(dir, "retired-operation");
	mkdirSync(join(catalog, "docs/catalog"), { recursive: true });
	writeFileSync(
		join(catalog, "docs/catalog/operations.json"),
		JSON.stringify({ operations: operations.map(({ id }) => ({ id })) }),
	);
	const check = () =>
		new Promise<{ code: number; stdout: string }>((resolve) =>
			execFile("python3", [at("docs/catalog/check-operation-references.py"), "--root", catalog], (error, stdout) =>
				resolve({ code: error ? Number(error.code) : 0, stdout }),
			),
		);
	const tools = (ids: string[]) =>
		writeFileSync(join(catalog, "docs/catalog/evry-tools.json"), JSON.stringify({ operation_ids: ids }));
	tools(served);
	assert.equal((await check()).code, 0);
	tools([...served, "effect.executeReviewed"]);
	const planted = await check();
	assert.deepEqual([planted.code, /unknown operation effect\.executeReviewed/.test(planted.stdout)], [1, true]);
	assert.equal(c.expected.event, null);
});

const scoped = {
	authority: "explicit_scoped_operator",
	verified: true,
	operation_ids: ["ops.readiness"],
	environment: "isolated-test",
} as const;
const ITEMS = ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"];

async function proposal(c: Case, monthly: number, approved: unknown) {
	const name = `cost-${c.id}-${randomUUID().slice(0, 8)}`;
	const evidence = join(dir, `${name}.evidence.json`);
	const offered = {
		cost_approval: {
			approved,
			approved_at: c.clock.now,
			monthly_usd: { low: monthly, expected: monthly, high: monthly },
		},
	};
	writeFileSync(evidence, JSON.stringify(offered), { mode: 0o600 });
	const file = control(name, ["readiness"], new URL(unknownUrl));
	const reports = [];
	const before = { bytes: readFileSync(evidence, "utf8"), connections };
	for (let n = 0; n < Number(given(c, "execution").repeat ?? 2); n++) {
		const { code, stdout, stderr } = await runBackupCli(
			["readiness", "--control", file, "--evidence", evidence],
			{ DATABASE_URL_UNPOOLED: unknownUrl },
			["--import", clockAt(c.clock.now)],
		);
		assert.deepEqual([code, stderr], [0, ""]);
		reports.push(JSON.parse(stdout) as Exclude<ReturnType<typeof readiness>, { refusal: "operator_unavailable" }>);
	}
	assert.deepEqual(reports.at(-1), reports[0]);
	assert.deepEqual({ bytes: readFileSync(evidence, "utf8"), connections }, before);
	const report = reports[0] ?? assert.fail("no report");
	assert.equal(report.checked_at, c.clock.now);
	const kept = JSON.parse(readFileSync(evidence, "utf8")).cost_approval as {
		approved: unknown;
		monthly_usd: { expected: number };
	};
	return {
		report,
		purchase: !report.missing.includes("cost_approval"),
		monthly: kept.monthly_usd.expected,
		approved: kept.approved,
	};
}

for (const { id, marker, price, approval, amount } of [
	{
		id: "COST-GATE-001",
		marker: "AC:COST-GATE-001 ",
		price: "monthly_estimate_usd",
		approval: "paid_approval",
		amount: "proposal_monthly_usd",
	},
	{
		id: "OPS54-001",
		marker: "AC:OPS54-001 ",
		price: "new_service_cost_usd_month",
		approval: "owner_approval",
		amount: "proposal_monthly_cost",
	},
])
	test(`${marker}a priced monthly proposal without the owner's approval allows no purchase, stays the proposal it was and keeps the customer-data gate blocked`, async () => {
		const c = caseOf(id);
		const { result } = c.expected;
		const inputs = given(c, "execution");
		const offered = await proposal(c, Number(inputs[price]), inputs[approval]);
		assert.equal(offered.purchase, result.purchase_allowed);
		assert.equal(offered.monthly, result[amount]);
		assert.equal(offered.approved, false);
		assert.deepEqual(offered.report.missing, ITEMS);
		assert.equal(offered.report.customer_data_gate, result.customer_data_gate ?? "blocked");
		assert.equal(offered.report.live_evidence_verified, inputs.restore_proof ?? false);
		for (const approved of [null, "true", 1, "unlimited free allowance"])
			assert.equal(
				(await proposal(c, Number(inputs[price]), approved)).purchase,
				result.purchase_allowed,
				String(approved),
			);
		const approvedByOwner = await proposal(c, Number(inputs[price]), true);
		assert.equal(approvedByOwner.purchase, true);
		assert.deepEqual(approvedByOwner.report.missing, ITEMS.slice(1));
		assert.equal(approvedByOwner.report.customer_data_gate, "blocked");
		const unpriced = readiness({
			capability: scoped,
			evidence: { cost_approval: { approved: true, approved_at: c.clock.now } },
			now: new Date(c.clock.now),
		});
		assert.deepEqual(unpriced.refusal === null && unpriced.missing, ITEMS);
		assert.deepEqual(
			readiness({ capability: { ...scoped, operation_ids: ["engineering.other"] }, evidence: {}, now: NOW }),
			{ refusal: "operator_unavailable" },
		);
		assert.equal(c.expected.event, null);
	});

test("AC:PROVIDER48-004 vendor names with no tier, schedule, key, preview or restore evidence leave the gate blocked and permit no configuration", async () => {
	const c = caseOf("PROVIDER48-004");
	const { result } = c.expected;
	const { preview_isolated, paid_approval, restore_proven } = given(c, "input");
	const vendors = { next: "Vercel", database: "Neon", auth: "Better Auth", files: "Tigris", mail: "Resend" };
	const named = { ...vendors, preview_isolated, paid_approval, restore_proven };
	for (const evidence of [
		{},
		named,
		{
			cost_approval: { ...named, approved: paid_approval },
			host_schedule: { ...named, host: "", schedule: "" },
			key_exclusion: {
				...named,
				denied: { app: true, build: true, preview: preview_isolated },
				verified_at: c.clock.now,
			},
			coherent_restore: { ...named, live_recovery_proven: restore_proven, verified_at: c.clock.now },
		},
	]) {
		const report = readiness({ capability: scoped, evidence, now: new Date(c.clock.now) });
		if (report.refusal !== null) assert.fail(report.refusal);
		assert.equal(report.customer_data_gate, result.release_gate);
		assert.deepEqual(report.missing, ITEMS);
		assert.deepEqual([report.live_evidence_verified, report.build_gate_from_backup], [false, false]);
		assert.doesNotMatch(JSON.stringify(report), /Vercel|Neon|Tigris|Resend/);
	}
	const production = new URL("postgres://app:pw@ep-gentle-dust-1.aws.neon.tech/neondb");
	const none = () => ({ endpoints: [], branches: [] });
	const permitted = [
		["everyfield", undefined],
		["drill-files", undefined],
		["everyfield", { host: "other.example.test", bucket: "everyfield", approvedBy: "owner", approvedAt: c.clock.now }],
		["everyfield", { host: production.hostname, bucket: "other", approvedBy: "owner", approvedAt: c.clock.now }],
	].map(([bucket, approval]) => {
		try {
			allowSource(production, bucket as string, approval as never, none);
			return true;
		} catch (error) {
			assert.equal((error as { code: string }).code, "production_source_refused");
			return false;
		}
	});
	const bucket = await fakeBucket();
	try {
		const config = backupConfig(join(dir, "unapproved"), {
			context: "restricted-backup",
			operations: ["backup-capture"],
			url: production,
			files: { endpoint: bucket.endpoint, bucket: "everyfield" },
			backups: bucket.endpoint,
		});
		const captured = await runBackupCli(["backup-capture", "--config", config, "--out", join(dir, "captured")], {
			EVERYFIELD_BACKUP_KEY: randomBytes(32).toString("hex"),
			DATABASE_URL_UNPOOLED: production.href,
		});
		assert.deepEqual([captured.code, captured.stdout], [1, '{"refused":"production_source_refused"}\n']);
		assert.equal(bucket.objects.size, 0);
	} finally {
		await bucket.close();
	}
	assert.equal(permitted.some(Boolean), result.configuration_permission);
	assert.equal(c.expected.event, null);
});

test("AC:OPS-BACKUP-001 an offline backup candidate is valid with its exact checksums and its subject's original expiry, its key opens it outside the app, and nothing certifies live recovery", async (t) => {
	const c = caseOf("OPS-BACKUP-001");
	const { result } = c.expected;
	const candidate = given(c, "candidate");
	const now = new Date(c.clock.now);
	const subject = randomUUID();
	const manifest = {
		version: 1,
		source: "d".repeat(40),
		schema: str(candidate.artifact_sha256),
		createdAt: str(candidate.created_at),
		expiresAt: str(candidate.expires_at),
		database: { id: randomUUID(), sha256: str(candidate.database_sha256), bytes: 10, version: "image" },
		objects: [{ id: randomUUID(), sha256: str(candidate.object_sha256), bytes: 10, version: "v1" }],
		keyVersion: randomUUID(),
		witnessCheckpoint: "0",
		subjects: [{ id: subject, expiresAt: str(candidate.subject_expires_at) }],
	};

	await t.test("the candidate is valid to the earliest expiry, on the operator's own command", async () => {
		const checked = validateCandidate(manifest, now, new Map([[subject, str(candidate.subject_expires_at)]]));
		assert.equal(checked.effectiveExpiresAt.replace(".000Z", "Z"), result.effective_subject_expiry);
		assert.equal(checked.liveRecoveryProven, result.live_recovery_proven);
		assert.deepEqual(checked.manifest, manifest);
		const file = join(dir, "manifest.json");
		const check = async (value: object) => {
			writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
			return runBackupCli(
				[
					"backup-check",
					"--control",
					control("backup", ["backup-check"], new URL(unknownUrl), "restricted-backup"),
					"--manifest",
					file,
				],
				{},
				["--import", clockAt(c.clock.now)],
			);
		};
		const told = await check(manifest);
		assert.equal(told.code, 0, told.stderr);
		assert.deepEqual(JSON.parse(told.stdout), {
			candidate_manifest_valid: result.candidate_valid,
			bytes_verified: false,
			live_recovery_proven: result.live_recovery_proven,
			key_custody_proven: false,
			restore_executed: false,
		});
		const broken: [string, object][] = [
			["a short database checksum", { ...manifest, database: { ...manifest.database, sha256: "b".repeat(63) } }],
			["no file checksum", { ...manifest, objects: [{ ...manifest.objects[0], sha256: "" }] }],
			["a short artifact checksum", { ...manifest, schema: "a" }],
			["an expiry past seven days", { ...manifest, expiresAt: "2026-10-24T12:00:01Z" }],
			["an expired copy", { ...manifest, createdAt: "2026-10-11T12:00:00Z", expiresAt: c.clock.now }],
			["a copy from the future", { ...manifest, createdAt: "2026-10-18T12:00:01Z" }],
			["an expired subject", { ...manifest, subjects: [{ id: subject, expiresAt: c.clock.now }] }],
		];
		for (const [name, value] of broken) {
			assert.throws(() => validateCandidate(value, now), name);
			const refused = await check(value);
			assert.deepEqual([refused.code, refused.stdout, refused.stderr], [1, "", GENERIC], name);
		}
		assert.throws(
			() =>
				validateCandidate(
					{ ...manifest, subjects: [{ id: subject, expiresAt: str(candidate.expires_at) }] },
					now,
					new Map([[subject, str(candidate.subject_expires_at)]]),
				),
			{ code: "subject_expired_or_reset" },
		);
	});

	await t.test("the exact database and file bytes must match their checksums", async () => {
		const held = await readyFile(admin, live, P.id, Buffer.from("%PDF-1.7 backup D"));
		const createdAt = new Date(str(candidate.created_at));
		const subjects = [{ id: randomUUID(), expiresAt: str(candidate.subject_expires_at) }];
		const copy = await snapshot(admin, live, { createdAt, expiresAt: new Date(str(candidate.expires_at)), subjects });
		assert.equal(copy.manifest.schema, await schemaVersion());
		const image = Buffer.from(copy.image);
		image.write(" ", image.length - 1);
		const changedImage = await rehearse({ ...copy, image }, undefined, now);
		assert.deepEqual([changedImage.result.restore_success, changedImage.result.refusal], [false, "database_mismatch"]);
		const objects = new Map(copy.objects).set(held.id, Buffer.from("%PDF-1.7 backup E"));
		const changedFile = await rehearse({ ...copy, objects }, undefined, now);
		assert.deepEqual([changedFile.result.refusal, changedFile.result.file], ["file_mismatch", held.id]);
		const whole = await rehearse(copy, undefined, now);
		assert.equal(whole.result.restore_success, true, JSON.stringify(whole.result));
		const report = readiness({
			capability: scoped,
			evidence: { coherent_restore: { ...whole.result, verified_at: c.clock.now } },
			now,
		});
		assert.equal(report.refusal === null && !report.missing.includes("coherent_restore"), result.live_recovery_proven);
		assert.equal(report.refusal === null && report.live_evidence_verified, result.live_recovery_proven);
	});

	await t.test("the restricted key alone opens the copy, and neither the store nor an app login holds it", async () => {
		const { key_recovery_verified, ordinary_runtime_has_key } = given(c, "execution");
		const bucket = await fakeBucket();
		try {
			bucket.settings.now = now;
			const copy = await snapshot(admin, live, {
				createdAt: new Date(str(candidate.created_at)),
				expiresAt: new Date(str(candidate.expires_at)),
			});
			const hex = randomBytes(32).toString("hex");
			const key = createSecretKey(Buffer.from(hex, "hex"));
			const taken = await runBackup({ bucket: bucket.bucket, key, capture: async () => copy, clock: () => now });
			if (!taken.copy_complete) assert.fail(taken.refusal);
			const opened = await openEncryptedCopy(bucket.bucket, taken.location, key);
			assert.equal(Buffer.from(opened.image).equals(copy.image), key_recovery_verified);
			await assert.rejects(openEncryptedCopy(bucket.bucket, taken.location, createSecretKey(randomBytes(32))));
			for (const [path, { bytes }] of bucket.objects) {
				assert.equal(holdsKey(bytes, hex), ordinary_runtime_has_key, path);
				assert.equal(Buffer.from(bytes).includes("%PDF-1.7 backup D"), false, path);
			}
			const stored = bucket.objects.size;
			const config = backupConfig(join(dir, "keyless"), {
				context: "restricted-backup",
				operations: ["backup-daily"],
				url: new URL(unknownUrl),
				files: { endpoint: bucket.endpoint, bucket: "drill-files" },
				backups: bucket.endpoint,
			});
			const keyless = await runBackupCli(["backup-daily", "--config", config], { DATABASE_URL_UNPOOLED: unknownUrl });
			assert.notEqual(keyless.code, 0);
			assert.match(keyless.stderr, /EVERYFIELD_BACKUP_KEY is missing/);
			assert.equal(bucket.objects.size, stored);
			assert.equal(holdsKey(JSON.stringify(process.env), hex), ordinary_runtime_has_key);
		} finally {
			await bucket.close();
		}
	});
	assert.equal(c.expected.event, null);
});

test("AC:OPS-EVAL-PROOF-001 a declared evaluation with no recorded run is not run, calls no model, opens no rollout and proves no live account", async (t) => {
	const c = caseOf("OPS-EVAL-PROOF-001");
	const { result } = c.expected;
	const evaluation = given(c, "evaluation");
	assert.equal(evaluation.execution, null);
	const proof = await proofOf(c.id);
	assert.equal(proof.status, result.status);
	assert.equal(proof.accepted, result.rollout_allowed);

	const fetches = t.mock.method(globalThis, "fetch", async () => assert.fail("no model is called"));
	const selected: unknown[] = [];
	const { model, file, save } = recorder(str(evaluation.fixture_release), ((env: unknown) => {
		selected.push(env);
		return assert.fail("no model is selected");
	}) as never);
	assert.equal(file(), null);
	for (const gold of evaluation.gold_cases as string[]) {
		const options = { prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: gold }] }] };
		await assert.rejects(Promise.resolve(model().doGenerate(options)), MissingRecording);
		await assert.rejects(Promise.resolve(model().doStream(options)), MissingRecording);
	}
	save();
	assert.equal(file(), null);
	assert.deepEqual([selected, fetches.mock.callCount()], [[], 0]);

	for (const evidence of [{ coherent_restore: evaluation }, { ...evaluation, live_recovery_proven: true }]) {
		const report = readiness({ capability: scoped, evidence, now: new Date(c.clock.now) });
		if (report.refusal !== null) assert.fail(report.refusal);
		assert.equal(report.live_evidence_verified, result.live_account_proven);
		assert.equal(report.customer_data_gate !== "blocked", result.rollout_allowed);
		assert.deepEqual(report.missing, ITEMS);
	}
	assert.equal(c.expected.event, null);
});
