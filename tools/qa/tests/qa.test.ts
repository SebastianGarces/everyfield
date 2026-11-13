import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
	MAIL_KEYS,
	runSeed,
	source,
	startQuietDatabase,
	stopQuietDatabase,
	tsxRun,
	type QuietDatabase,
} from "./fixtures.ts";
import { DEV_ENDPOINT, PROD_ENDPOINT, QA_LOGINS, QA_PASSWORD, seedRefusal } from "../qa-guard.ts";

// Sentinels the stubbed CLIs emit or receive. None may reach qa's output, its store or any file it leaves behind.
const NEON_PASSWORD = "npg_SentinelNeonPassword01";
const BYPASS = "sentinel-bypass-secret-0f1e2d3c";
const API_KEY = "re_sentinel_resend_key_99";

const DEV = { id: DEV_ENDPOINT, branch_id: "br-dev" };
const PROD = { id: `${PROD_ENDPOINT}-b8tvq4ha`, branch_id: "br-main" };
const BRANCHES = [
	{ id: "br-dev", name: "development" },
	{ id: "br-main", name: "main" },
];

/** A git repo with one feature branch, stub neonctl, vercel and corepack first on PATH, and a private TMPDIR. */
function setup(endpoints = [DEV, PROD], seedPath = "tools/qa/qa-seed.ts") {
	const dir = mkdtempSync(join(tmpdir(), "qa-test-")),
		root = join(dir, "repo"),
		bin = join(dir, "bin"),
		state = join(dir, "stub-state"),
		temp = join(dir, "tmp");
	for (const d of [root, bin, state, temp]) mkdirSync(d);
	const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "--quiet", "-b", "main");
	mkdirSync(dirname(join(root, seedPath)), { recursive: true });
	writeFileSync(join(root, seedPath), "// placeholder\n");
	git("add", ".");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "init");
	git("branch", "feature/nora-qa");
	writeFileSync(join(state, "endpoints.json"), JSON.stringify({ endpoints }));
	writeFileSync(join(state, "branches.json"), JSON.stringify(BRANCHES));
	const stub = (name: string, body: string) => {
		writeFileSync(
			join(bin, name),
			`#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const a = process.argv.slice(2), S = ${JSON.stringify(state)};
fs.appendFileSync(path.join(S, ${JSON.stringify(name + ".log")}), JSON.stringify(a) + "\\n");
const read = (f) => JSON.parse(fs.readFileSync(path.join(S, f), "utf8"));
const write = (f, v) => fs.writeFileSync(path.join(S, f), JSON.stringify(v));
${body}
`,
		);
		chmodSync(join(bin, name), 0o755);
	};
	const cs = `postgres://neondb_owner:${NEON_PASSWORD}@ep-qa-branch-a1.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require`;
	stub(
		"neonctl",
		`if (a[0] === "api") console.log(JSON.stringify(read("endpoints.json")));
else if (a[0] === "branches" && a[1] === "list") console.log(JSON.stringify(read("branches.json")));
else if (a[0] === "branches" && a[1] === "create") {
	const name = a[a.indexOf("--name") + 1], branch = { id: "br-" + name, name };
	write("branches.json", [...read("branches.json"), branch]);
	console.log(JSON.stringify({ branch }));
} else if (a[0] === "branches" && a[1] === "delete") write("branches.json", read("branches.json").filter((b) => b.id !== a[2]));
else if (a[0] === "connection-string") console.log(a.includes("--pooled") ? ${JSON.stringify(cs.replace("-a1.", "-a1-pooler."))} : ${JSON.stringify(cs)});
else process.exit(9);`,
	);
	// corepack prints the database URL it got, as a leaky migration would; a FAIL_MIGRATE file makes it fail.
	stub(
		"corepack",
		`if (a.includes("--frozen-lockfile")) process.exit(0);
if (a.includes("db:migrate")) {
	console.log("migrating " + process.env.DATABASE_URL);
	console.error("using " + process.env.DATABASE_URL_UNPOOLED);
	process.exit(fs.existsSync(path.join(S, "FAIL_MIGRATE")) ? 1 : 0);
}
fs.writeFileSync(path.join(S, "role-password"), process.env.QA_ROLE_PASSWORD || "");
write("seed-keys.json", { IDENTITY_MAIL_KEY: process.env.IDENTITY_MAIL_KEY, IDENTITY_ADDRESS_KEY: process.env.IDENTITY_ADDRESS_KEY });
write("seed-recipients.json", { QA_TEST_RECIPIENTS: process.env.QA_TEST_RECIPIENTS ?? null });
console.log("seeded with " + process.env.QA_ROLE_PASSWORD);
// A FAIL_SEED file makes the seed fail and print the keys it got, as a leaky seed would.
if (fs.existsSync(path.join(S, "FAIL_SEED"))) {
	console.error("seed failed with " + process.env.IDENTITY_MAIL_KEY + " and " + process.env.IDENTITY_ADDRESS_KEY);
	process.exit(1);
}`,
	);
	stub(
		"vercel",
		`if (a[0] === "deploy") {
	const env = {};
	for (let i = 0; i < a.length; i++) if (a[i] === "-e") { const [k, ...v] = a[i + 1].split("="); env[k] = v.join("="); }
	write("deploy-env.json", env);
	write("deploy-link.json", JSON.parse(fs.readFileSync(".vercel/project.json", "utf8")));
	console.error("Inspect: https://vercel.com/x  bypass ${BYPASS}");
	// A DEPLOY_JSON file prints what Vercel CLI 65 prints off a terminal: one JSON object, the URL at deployment.url.
	if (fs.existsSync(path.join(S, "DEPLOY_JSON"))) {
		console.error("  Preview         https://everyfield-json456-team.vercel.app");
		console.log(JSON.stringify({
			status: "ok",
			deployment: { id: "dpl_json456", url: "https://everyfield-json456-team.vercel.app", readyState: "READY" },
			message: "Deployment everyfield-json456-team.vercel.app ready.",
			next: [{ command: "vercel curl https://everyfield-json456-team.vercel.app", when: "Verify deployment" }],
		}, null, 2));
	} else console.log("https://everyfield-abc123-team.vercel.app");
} else if (a[0] === "curl") {
	// T-255: the scheduled-send driver. Record the target, the linked project and the Authorization header curl got.
	const file = a[a.indexOf("--header") + 1].slice(1);
	fs.appendFileSync(path.join(S, "cron-calls.log"), JSON.stringify({
		path: a[1],
		deployment: a[a.indexOf("--deployment") + 1],
		linked: JSON.parse(fs.readFileSync(".vercel/project.json", "utf8")),
		authorization: fs.readFileSync(file, "utf8"),
		mode: fs.statSync(file).mode & 0o777,
	}) + "\\n");
	if (fs.existsSync(path.join(S, "FAIL_CRON"))) { process.stdout.write("Unauthorized\\nqa-cron-http:401\\n"); process.exit(0); }
	process.stdout.write('{"status":"ok","messages":1}\\nqa-cron-http:200\\n');
} else if (a[0] === "alias" && a[1] === "set") write("alias.json", { [a[3]]: a[2] });
else if (a[0] === "alias" && a[1] === "rm") {
	const aliases = fs.existsSync(path.join(S, "alias.json")) ? read("alias.json") : {};
	if (!aliases[a[2]]) { console.error("Error: The alias " + a[2] + " was not found"); process.exit(1); }
	write("alias.json", {});
} else if (a[0] === "remove") {
	if (fs.existsSync(path.join(S, "removed"))) { console.error("Error: Deployment not found"); process.exit(1); }
	fs.writeFileSync(path.join(S, "removed"), a[1]);
}`,
	);
	const qa = (...args: string[]) =>
		spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", join(source, "tools/qa/main.ts"), ...args], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH}`,
				TMPDIR: temp,
				VERCEL_AUTOMATION_BYPASS_SECRET: BYPASS,
				RESEND_API_KEY: API_KEY,
			},
		});
	const calls = (name: string): string[][] => {
		try {
			return readFileSync(join(state, `${name}.log`), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	};
	const stubState = <T>(f: string): T => JSON.parse(readFileSync(join(state, f), "utf8"));
	// T-255: qa up leaves a detached scheduled-send driver running; stop any a test did not take down.
	const done = () => {
		try {
			const { previews } = JSON.parse(readFileSync(join(root, ".git/qa/previews.json"), "utf8"));
			for (const p of previews) if (p.driver_pid) process.kill(p.driver_pid, "SIGKILL");
		} catch {
			// No record, or the driver already ended.
		}
		rmSync(dir, { recursive: true, force: true });
	};
	return { dir, root, temp, state, qa, calls, stubState, done };
}

/** Every file under `dir`, with its bytes as text. */
function files(dir: string): Array<[string, string]> {
	return readdirSync(dir, { recursive: true, withFileTypes: false })
		.map((rel) => join(dir, String(rel)))
		.filter((p) => statSync(p).isFile())
		.map((p) => [p, readFileSync(p).toString("latin1")]);
}

test("INV-qa-preview: qa up refuses before it creates anything when the parent is missing or production", () => {
	for (const [endpoints, reason] of [
		[[PROD], new RegExp(`No single ${DEV_ENDPOINT} endpoint`)],
		[[DEV, { ...PROD, branch_id: "br-dev" }], /production database/],
	] as const) {
		const s = setup([...endpoints]);
		try {
			const r = s.qa("up", "feature/nora-qa");
			assert.equal(r.status, 1, r.stdout);
			assert.match(r.stderr, /refused before creating anything/);
			assert.match(r.stderr, reason);
			// Reads only: no branch create, no install, no deploy, no record.
			assert.deepEqual(
				s.calls("neonctl").map((c) => c.slice(0, 2)),
				[
					["api", "/projects/cool-math-76767811/endpoints"],
					["branches", "list"],
				],
			);
			assert.deepEqual(s.calls("corepack"), []);
			assert.deepEqual(s.calls("vercel"), []);
			assert.equal(s.qa("list").stdout.trim(), "No open QA previews.");
		} finally {
			s.done();
		}
	}
});

test("INV-qa-secrets: qa up, list and down keep every secret out of output, the store and files; down twice is a no-op", () => {
	const s = setup();
	try {
		const up = s.qa("up", "feature/nora-qa");
		assert.equal(up.status, 0, up.stderr);
		const [idLine, url] = up.stdout.trim().split("\n");
		const id = /^QA preview (qa-feature-nora-qa-[0-9a-f]{4})$/.exec(idLine!)?.[1];
		assert.ok(id, up.stdout);
		assert.equal(url, `https://everyfield-${id}.vercel.app`);

		// Neon branch off development, the branch's own migrate and seed, then a preview deploy aliased to the URL.
		assert.ok(s.calls("neonctl").some((c) => c.join(" ").startsWith(`branches create --name ${id} --parent br-dev`)));
		assert.deepEqual(
			s.calls("corepack").map((c) => c.slice(0, 2)),
			[
				["pnpm", "install"],
				["pnpm", "db:migrate"],
				["pnpm", "--filter"],
			],
		);
		const env = s.stubState<Record<string, string>>("deploy-env.json");
		assert.deepEqual(Object.keys(env).sort(), [
			"CRON_SECRET",
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"IDENTITY_ADDRESS_KEY",
			"IDENTITY_AUTH_DATABASE_URL",
			"IDENTITY_DATABASE_URL",
			"IDENTITY_MAIL_KEY",
			"IDENTITY_ORIGIN",
			"IDENTITY_SECRET",
			"LIFECYCLE_CLEANUP_DATABASE_URL",
			"NOTIFICATION_OPT_OUT_KEYS",
		]);
		assert.equal(env.IDENTITY_ORIGIN, url);
		assert.equal(new URL(env.IDENTITY_DATABASE_URL!).username, "evf_qa_runtime");
		// The cron's job pool sends a startup option that Neon's pooler refuses, so the runtime login is direct.
		assert.match(new URL(env.IDENTITY_DATABASE_URL!).hostname, /^ep-qa-branch-a1\./);
		// T-51: the seed ran with the preview's own mail keys, so its suppression and mail rows match on the preview.
		const seedKeys = s.stubState<Record<string, string>>("seed-keys.json");
		assert.deepEqual(seedKeys, {
			IDENTITY_MAIL_KEY: env.IDENTITY_MAIL_KEY,
			IDENTITY_ADDRESS_KEY: env.IDENTITY_ADDRESS_KEY,
		});
		for (const k of Object.values(seedKeys)) assert.match(k!, /^[a-f0-9]{64}$/);
		assert.notEqual(seedKeys.IDENTITY_MAIL_KEY, seedKeys.IDENTITY_ADDRESS_KEY);
		assert.match(new URL(env.DATABASE_URL!).hostname, /^ep-qa-branch-a1-pooler\./);
		assert.ok(s.calls("vercel").some((c) => c.includes("--target") && c.includes("preview")));
		assert.ok(!s.calls("vercel").some((c) => c.includes("--prod") || c.includes("production")));
		// T-255: without --test-recipients nothing extra is approved, and the shared environments are never touched.
		assert.ok(!s.calls("vercel").some((c) => c[0] === "env"));
		assert.deepEqual(s.stubState("seed-recipients.json"), { QA_TEST_RECIPIENTS: null });
		assert.match(up.stderr, /Real mail on this preview reaches no extra address: only delivered\+\.\.\.@resend\.dev\./);
		assert.deepEqual(s.stubState("alias.json"), {
			[`everyfield-${id}.vercel.app`]: "https://everyfield-abc123-team.vercel.app",
		});

		const list = s.qa("list");
		assert.equal(list.status, 0, list.stderr);
		assert.match(list.stdout.trim(), new RegExp(`^${id}  feature/nora-qa  ${url}  neon:${id}  age 0m  [0-9a-f]{12}$`));

		const down = s.qa("down", id);
		assert.equal(down.status, 0, down.stderr);
		assert.equal(
			down.stdout.trim(),
			`Removed QA preview ${id}: scheduled-send driver, alias, deployment, Neon branch ${id}.`,
		);
		assert.deepEqual(s.stubState("branches.json"), BRANCHES);
		assert.deepEqual(s.stubState("alias.json"), {});
		const again = s.qa("down", id);
		assert.equal(again.status, 0, again.stderr);
		assert.equal(again.stdout.trim(), `No QA preview ${id}. Nothing to remove.`);
		assert.equal(s.calls("neonctl").filter((c) => c[1] === "delete").length, 1);
		assert.equal(s.qa("list").stdout.trim(), "No open QA previews.");

		// Every secret that passed through: Neon, the generated role password and identity keys, bypass, API key.
		const secrets = [
			NEON_PASSWORD,
			BYPASS,
			API_KEY,
			readFileSync(join(s.state, "role-password"), "utf8"),
			...Object.entries(env)
				.filter(([k]) => k !== "IDENTITY_ORIGIN")
				.map(([, v]) => v),
		];
		assert.ok(secrets.every((v) => v.length >= 16));
		const seen = [
			...[up, list, down, again].map((r, i): [string, string] => [`output ${i}`, r.stdout + r.stderr]),
			...files(s.root),
			...files(s.temp),
		];
		assert.ok(
			seen.some(([p]) => p.endsWith(join(".git", "qa", "previews.json"))),
			"the store was scanned",
		);
		assert.ok(!existsSync(join(s.root, ".git/evf/work.sqlite")), "qa makes no v1 store");
		for (const [where, text] of seen)
			for (const secret of secrets) assert.ok(!text.includes(secret), `a secret reached ${where}`);
		assert.deepEqual(readdirSync(s.temp), [], "the deploy checkout is removed");
	} finally {
		s.done();
	}
});

test("INV-qa-preview: a failed qa up shows redacted output and removes the Neon branch it made", () => {
	const s = setup();
	try {
		writeFileSync(join(s.state, "FAIL_MIGRATE"), "");
		const r = s.qa("up", "feature/nora-qa");
		assert.equal(r.status, 1);
		assert.match(r.stderr, /corepack pnpm failed \(exit 1\):\nusing <redacted>\n/);
		assert.ok(!(r.stdout + r.stderr).includes(NEON_PASSWORD));
		assert.deepEqual(s.stubState("branches.json"), BRANCHES);
		assert.equal(s.qa("list").stdout.trim(), "No open QA previews.");
	} finally {
		s.done();
	}
	// T-51: a seed that fails and prints the mail keys it got shows them masked, and nothing is deployed.
	const seeded = setup();
	try {
		writeFileSync(join(seeded.state, "FAIL_SEED"), "");
		const r = seeded.qa("up", "feature/nora-qa");
		assert.equal(r.status, 1);
		assert.match(r.stderr, /seed failed with <redacted> and <redacted>/);
		for (const k of Object.values(seeded.stubState<Record<string, string>>("seed-keys.json")))
			assert.ok(!(r.stdout + r.stderr).includes(k), "a mail key reached the output");
		assert.ok(!seeded.calls("vercel").some((c) => c[0] === "deploy"));
		assert.deepEqual(seeded.stubState("branches.json"), BRANCHES);
	} finally {
		seeded.done();
	}
});

test("INV-qa-preview: qa up reads the deployment URL from the JSON Vercel CLI 65 prints off a terminal", () => {
	const s = setup();
	try {
		writeFileSync(join(s.state, "DEPLOY_JSON"), "");
		const up = s.qa("up", "feature/nora-qa");
		assert.equal(up.status, 0, up.stderr);
		const id = up.stdout.trim().split("\n")[0]!.replace("QA preview ", "");
		assert.deepEqual(s.stubState("alias.json"), {
			[`everyfield-${id}.vercel.app`]: "https://everyfield-json456-team.vercel.app",
		});
		const { previews } = JSON.parse(readFileSync(join(s.root, ".git/qa/previews.json"), "utf8"));
		assert.equal(previews[0].deployment, "https://everyfield-json456-team.vercel.app");
	} finally {
		s.done();
	}
});

test("INV-qa-preview: a branch with no tools/qa/qa-seed.ts refuses", () => {
	const none = setup([DEV, PROD], "docs/no-seed.txt");
	try {
		const up = none.qa("up", "feature/nora-qa");
		assert.equal(up.status, 1);
		assert.match(up.stderr, /This branch has no QA seed \(tools\/qa\/qa-seed\.ts\)/);
		assert.equal(none.qa("list").stdout.trim(), "No open QA previews.", "the failed run removed its record");
	} finally {
		none.done();
	}
});

test("INV-qa-preview: a previews file with a key an older qa wrote still loads, and the next write drops the key", () => {
	const s = setup();
	const preview = {
		id: "qa-main-b24e",
		branch: "task/qa-main-b24e",
		head: "a".repeat(40),
		neon_branch: "qa-main-b24e",
		url: "https://everyfield-qa-main-b24e.vercel.app",
		deployment: "https://d1.vercel.app",
		created_at: "2026-11-05T12:00:00.000Z",
	};
	const file = join(s.root, ".git/qa/previews.json");
	try {
		mkdirSync(join(s.root, ".git/qa"), { recursive: true });
		writeFileSync(file, JSON.stringify({ previews: [preview], retiredIds: [preview.id] }));
		const listed = s.qa("list");
		assert.equal(listed.status, 0, listed.stderr);
		assert.match(listed.stdout, /^qa-main-b24e {2}task\/qa-main-b24e/);
		const down = s.qa("down", preview.id);
		assert.equal(down.status, 0, down.stderr);
		assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { previews: [] });
	} finally {
		s.done();
	}
});

test("INV-qa-preview: every worktree of a repository shares one preview file, and bad usage exits 2", () => {
	const s = setup();
	const linked = join(s.dir, "linked");
	try {
		const up = s.qa("up", "feature/nora-qa");
		assert.equal(up.status, 0, up.stderr);
		const id = up.stdout.split("\n")[0]!.replace("QA preview ", "");
		assert.equal(spawnSync("git", ["-C", s.root, "worktree", "add", "-q", "--detach", linked]).status, 0);
		const seen = spawnSync(
			process.execPath,
			["--disable-warning=ExperimentalWarning", join(source, "tools/qa/main.ts"), "list"],
			{ cwd: linked, encoding: "utf8" },
		);
		assert.match(seen.stdout, new RegExp(`^${id}  `));
		assert.equal(s.qa("list", "extra").status, 2);
		assert.match(s.qa("down", "not-a-preview").stderr, /is not a QA preview id/);
	} finally {
		s.done();
	}
});

test("INV-qa-seed: the QA seed refuses production, the shared development branch, NODE_ENV=production and no URL", () => {
	const neon = (endpoint: string) =>
		`postgres://u:${NEON_PASSWORD}@${endpoint}-x1.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require`;
	assert.match(seedRefusal({ DATABASE_URL: neon(PROD_ENDPOINT).replace("-x1.", "-x1-pooler.") })!, /production/);
	for (const [env, reason] of [
		[{ DATABASE_URL: neon(PROD_ENDPOINT) }, /production database/],
		[{ DATABASE_URL: neon(DEV_ENDPOINT) }, /shared development branch/],
		[{ DATABASE_URL: "postgres://u:p@127.0.0.1:1/qa", NODE_ENV: "production" }, /NODE_ENV is production/],
		[{}, /DATABASE_URL is not set/],
	] as const) {
		// Each refusal comes before any connection: these hosts do not answer, and the run ends at once with exit 2.
		const r = runSeed({ ...env, QA_ROLE_PASSWORD: "x".repeat(20) });
		assert.equal(r.status, 2, r.stderr);
		assert.match(r.stderr, /QA seed refused: /);
		assert.match(r.stderr, reason);
		assert.ok(!r.stderr.includes(NEON_PASSWORD));
	}
});

const ROLE_PASSWORD = "qa-role-password-0123";
const started: QuietDatabase[] = [];
after(() => started.forEach(stopQuietDatabase));

/** A quiet database with one-statement query, per-table row counts and the seed run against it. */
function quiet(tag: string) {
	const db = startQuietDatabase(source, tag);
	started.push(db);
	const pg = createRequire(join(source, "packages/db/package.json"))("pg");
	const query = async (sql: string) => {
		const client = new pg.Client({ connectionString: db.adminUrl });
		await client.connect();
		try {
			return (await client.query(sql)).rows as Array<Record<string, unknown>>;
		} finally {
			await client.end();
		}
	};
	const counts = async () => {
		const tables = await query(
			"SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migration' ORDER BY 1",
		);
		const out: Record<string, number> = {};
		for (const { tablename } of tables)
			out[String(tablename)] = Number((await query(`SELECT count(*)::int AS n FROM "${tablename}"`))[0]!.n);
		return out;
	};
	const env = { DATABASE_URL: db.adminUrl, QA_ROLE_PASSWORD: ROLE_PASSWORD, ...MAIL_KEYS };
	const seed = () => {
		const r = runSeed(env);
		assert.equal(r.status, 0, r.stderr);
		return r.stdout.trim();
	};
	return { db, query, counts, env, seed };
}

/** What each QA login sees through the domain reads the screens use (fixtures/qa-probe.ts). */
function probe(env: Record<string, string>) {
	const r = tsxRun(["tools/qa/tests/fixtures/qa-probe.ts"], env);
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout) as Record<string, any>;
}

/** One fresh database for every seed test: the refusal, the first run, the second run and what the logins see. */
let freshRun: ReturnType<typeof seedFresh> | undefined;
const fresh = () => (freshRun ??= seedFresh());
async function seedFresh() {
	const q = quiet("qa-seed");
	const before = await q.counts();
	// The refusal leaves the database as it was.
	assert.equal(runSeed({ ...q.env, NODE_ENV: "production", QA_ROLE_PASSWORD: "x".repeat(20) }).status, 2);
	assert.deepEqual(await q.counts(), before);
	const first = q.seed();
	const seeded = await q.counts();
	const second = q.seed();
	return { ...q, before, first, seeded, second, after: await q.counts(), seen: probe(q.env) };
}

const ORGS = { network: "Harvest Network (QA)", sending: "Grace Church (QA)" };
/** The mail parts of the 2026-11-04 cases, in the order the seed names them. */
const NOV4_MAIL =
	"suppressed address of Leo Pratt, message QA delivery check, suppressed admin address, past restore of the admin address";

/**
 * A church's rows without what the 2026-11-04 parts add or change on an older branch: Owen Price's seat and Person, the
 * delivery message, and the church's material revision, which each new Person moves on. `before` names the old seats.
 */
function oldRows(rows: Array<Record<string, unknown>>, before: Array<Record<string, unknown>>) {
	const row = (r: Record<string, unknown>) => r.row as Record<string, unknown>;
	const seats = new Set(before.filter((r) => r.t === "seat").map((r) => row(r).account_id));
	return rows
		.filter(
			(r) =>
				!(r.t === "person" && row(r).display_name === "Owen Price") &&
				!(r.t === "communication" && row(r).subject === "QA delivery check") &&
				!(r.t === "seat" && !seats.has(row(r).account_id)),
		)
		.map((r) => (r.t === "plant" ? { ...r, row: { ...row(r), material_revision: null } } : r));
}
/** The owner's last seeded check-in week (OPS-125's history), and every note the history carries. */
const LAST_WEEK = {
	answers: { spiritual: "steady", family: "strained", financial: "steady", pace: "strained" },
	note: "Still busy. Took one evening off.",
};
const NOTES = [
	"First check-in after the core group meeting.",
	"Budget talk with the sending church went well.",
	"Launch planning took most evenings.",
	"Too many nights out. Sleep is short.",
	LAST_WEEK.note,
];

test("INV-qa-seed: the QA seed fills a fresh database, and a second run changes no table's row count", async () => {
	const { first, second, seeded, after, before, query } = await fresh();
	assert.match(first, /QA seed wrote: .*church.*wiki, owner timezone, 13 check-in weeks\./);
	assert.equal(second, "QA seed: the branch is already complete.");
	assert.deepEqual(after, seeded);

	// The test church and its data, from the requirement: each role, and rows in every planter area.
	assert.deepEqual(
		await query(`SELECT u.email, s.role FROM seat s JOIN account a ON a.id = s.account_id
			JOIN auth_user u ON u.id = a.auth_user_id JOIN plant p ON p.id = s.plant_id
			WHERE p.name = 'Harvest Point (QA)' ORDER BY s.role DESC, u.email`),
		[
			{ email: QA_LOGINS.owner, role: "owner" },
			{ email: QA_LOGINS.member2, role: "member" },
			{ email: QA_LOGINS.member, role: "member" },
			{ email: QA_LOGINS.admin, role: "admin" },
		],
	);
	for (const [table, least] of [
		["person", 10],
		["household", 1],
		["team", 3],
		["meeting", 2],
		["task", 5],
		["document", 1],
		["communication", 1],
		["reference_activation", 1],
	] as const)
		assert.ok(seeded[table]! - before[table]! >= least, `${table}: ${seeded[table]} after, ${before[table]} before`);
	assert.deepEqual(
		await query(
			"SELECT count(*)::int AS n FROM person WHERE email IS NOT NULL AND email NOT LIKE 'delivered+%@resend.dev'",
		),
		[{ n: 0 }],
	);
});

test("INV-qa-seed: eight QA logins; the seed makes both organization logins verified and active, and each signs in", async () => {
	assert.deepEqual(QA_LOGINS, {
		owner: "delivered+qa-owner@resend.dev",
		admin: "delivered+qa-admin@resend.dev",
		member: "delivered+qa-member@resend.dev",
		network: "delivered+qa-network-admin@resend.dev",
		sending: "delivered+qa-sending-director@resend.dev",
		member2: "delivered+qa-member-2@resend.dev",
		signup: "delivered+qa-signup@resend.dev",
		riverside: "delivered+qa-riverside-owner@resend.dev",
	});
	const { first, query, seen } = await fresh();
	for (const email of [QA_LOGINS.network, QA_LOGINS.sending]) assert.ok(first.includes(`login ${email},`), first);
	assert.deepEqual(
		await query(`SELECT u.email, u.email_verified, a.registration_state, a.registration_kind FROM auth_user u
			JOIN account a ON a.auth_user_id = u.id WHERE u.email IN ('${QA_LOGINS.network}', '${QA_LOGINS.sending}') ORDER BY 1`),
		[
			{ email: QA_LOGINS.network, email_verified: true, registration_state: "active", registration_kind: "network" },
			{
				email: QA_LOGINS.sending,
				email_verified: true,
				registration_state: "active",
				registration_kind: "sending_church",
			},
		],
	);
	// The probe signs in with QA_PASSWORD through the identity service, then reads the session its cookie names.
	for (const login of ["network", "sending"]) {
		assert.equal(seen[login].signedIn, "signed_in");
		assert.equal(seen[login].session, "active");
	}
	assert.equal(QA_PASSWORD, "Everyfield-QA-preview-1");
});

test("INV-qa-seed: the network login holds an admin seat and the sending-church login an owner seat, none on the church", async () => {
	const { query, seen } = await fresh();
	assert.deepEqual(
		await query(`SELECT u.email, o.name, o.kind, s.role, s.accepted_at IS NOT NULL AS accepted, s.ended_at IS NULL AS live,
			s.plant_id FROM seat s JOIN account a ON a.id = s.account_id JOIN auth_user u ON u.id = a.auth_user_id
			LEFT JOIN organization o ON o.id = s.organization_id
			WHERE u.email IN ('${QA_LOGINS.network}', '${QA_LOGINS.sending}') ORDER BY 1`),
		[
			{
				email: QA_LOGINS.network,
				name: ORGS.network,
				kind: "sending_network",
				role: "admin",
				accepted: true,
				live: true,
				plant_id: null,
			},
			{
				email: QA_LOGINS.sending,
				name: ORGS.sending,
				kind: "sending_church",
				role: "owner",
				accepted: true,
				live: true,
				plant_id: null,
			},
		],
	);
	// OPS-127's Grace Fellowship (QA) shares the wiki and has no login.
	assert.deepEqual(await query("SELECT name, kind FROM organization WHERE name LIKE '%(QA)' ORDER BY name"), [
		{ name: ORGS.sending, kind: "sending_church" },
		{ name: "Grace Fellowship (QA)", kind: "sending_church" },
		{ name: ORGS.network, kind: "sending_network" },
	]);
	// The session each login gets selects its organization seat.
	assert.deepEqual(seen.network.context, {
		kind: "seat",
		role: "admin",
		owner: { kind: "organization", id: seen.network.context.owner.id, organizationKind: "sending_network" },
	});
	assert.deepEqual(seen.sending.context, {
		kind: "seat",
		role: "owner",
		owner: { kind: "organization", id: seen.sending.context.owner.id, organizationKind: "sending_church" },
	});
});

test("INV-qa-seed: each organization has one active connection to the church, made by invitation and acceptance, with the build's defaults", async () => {
	const { query } = await fresh();
	// Each link names the invitation it came from. The request went to the organization login's own address and was
	// answered by that login. Acceptance wrote the approval event. The sharing choices are the ones acceptance applies
	// to a plant pair (packages/domain/src/organizations/relationships.ts), and nothing changed them since.
	assert.deepEqual(
		await query(`SELECT o.name, i.purpose, i.state, i.recipient_email, u.email AS accepted_by, f.revision::text,
			f.consent_revision::text, f.share_people, f.share_meetings, f.share_tasks, f.share_ministry_teams, f.share_wiki,
			f.share_activity, f.shared_findings,
			(SELECT array_agg(e.action ORDER BY e.id) FROM audit_event e WHERE e.subject_id = f.id) AS events
			FROM affiliation f JOIN plant p ON p.id = f.plant_id JOIN organization o ON o.id = f.organization_id
			JOIN invitation i ON i.id = f.invitation_id JOIN account a ON a.id = i.accepted_account_id
			JOIN auth_user u ON u.id = a.auth_user_id
			WHERE p.name = 'Harvest Point (QA)' AND f.ended_at IS NULL ORDER BY o.name`),
		[ORGS.sending, ORGS.network].map((name) => {
			const network = name === ORGS.network;
			return {
				name,
				purpose: network ? "plant_network" : "plant_church",
				state: "accepted",
				recipient_email: network ? QA_LOGINS.network : QA_LOGINS.sending,
				accepted_by: network ? QA_LOGINS.network : QA_LOGINS.sending,
				revision: "1",
				consent_revision: "1",
				share_people: true,
				share_meetings: true,
				share_tasks: true,
				share_ministry_teams: true,
				share_wiki: true,
				share_activity: true,
				shared_findings: true,
				events: ["affiliation.approved"],
			};
		}),
	);
	// The church Owner made each request through associations.invite.
	assert.deepEqual(
		await query(`SELECT u.email, count(*)::int AS n FROM audit_event e JOIN account a ON a.id = e.actor_id
			JOIN auth_user u ON u.id = a.auth_user_id JOIN invitation i ON i.id = e.subject_id
			WHERE i.purpose IN ('plant_network', 'plant_church') AND e.kind = 'create' GROUP BY 1`),
		[{ email: QA_LOGINS.owner, n: 2 }],
	);
});

test("INV-qa-seed: the sharing-page reads list Harvest Point (QA) for the network Admin and the sending-church director", async () => {
	const { seen } = await fresh();
	assert.deepEqual(seen.network.connections, [
		{ kind: "plant", subject: "Harvest Point (QA)", organization: ORGS.network },
	]);
	assert.deepEqual(seen.sending.connections, [
		{ kind: "plant", subject: "Harvest Point (QA)", organization: ORGS.sending },
	]);
});

test("INV-qa-seed: the seed writes the Owner's check-ins through the private-care writer, and he reads them back as his own", async () => {
	const { query, seen } = await fresh();
	// OPS-125's history is the Owner's check-in data: 13 answered past weeks, all his, all in the church.
	assert.deepEqual(
		await query(`SELECT u.email, p.name, count(*)::int AS weeks, max(w.ordinal) AS last FROM private_week w
			JOIN account a ON a.id = w.author_id JOIN auth_user u ON u.id = a.auth_user_id JOIN plant p ON p.id = w.plant_id
			WHERE w.answer_revision > 0 GROUP BY 1, 2`),
		[{ email: QA_LOGINS.owner, name: "Harvest Point (QA)", weeks: 13, last: 13 }],
	);
	assert.deepEqual(
		await query(`SELECT w.spiritual, w.family, w.financial, w.pace, w.note FROM private_week w WHERE w.ordinal = 13`),
		[{ ...LAST_WEEK.answers, note: LAST_WEEK.note }],
	);
	assert.equal(seen.owner.selected.kind, "plant");
	assert.equal(seen.owner.checkIn.status, "ok");
	assert.equal(seen.owner.checkIn.value.week.current, true);
	// Newest first: this week stays open (OPS-125), and last week is the Owner's own answer.
	const [open, last] = seen.owner.history.value.weeks;
	assert.deepEqual([open.ordinal, open.current, open.answer], [14, true, null]);
	assert.deepEqual([last.ordinal, last.answer.answers, last.answer.note], [13, LAST_WEEK.answers, LAST_WEEK.note]);
});

test("INV-privacy: the QA organization logins read no check-in and no person of the church", async () => {
	const { seen } = await fresh();
	const refused = (code: string) => ({
		status: "refused",
		error: { code, details: {}, correlationId: null, retry: "never" },
	});
	for (const login of ["network", "sending"]) {
		const care = refused("access_denied"),
			people = refused("unavailable");
		assert.deepEqual(seen[login].care, { current: care, history: care, trends: care });
		assert.deepEqual(seen[login].people, { list: people, person: people, page: people });
		const shown = JSON.stringify(seen[login]);
		for (const part of [...NOTES, "strained", "struggling", "Daniel Reyes"])
			assert.ok(!shown.includes(part), `${login}: ${part}`);
	}
});

test("INV-qa-seed: the seed stays idempotent, and a branch seeded before the organization logins gains only the new parts", async () => {
	const { second, seeded, after } = await fresh();
	assert.equal(second, "QA seed: the branch is already complete.");
	assert.deepEqual(after, seeded);

	// A branch seeded by the OPS-106 seed, the version before this task, then seeded again by this one.
	const old = quiet("qa-seed-old");
	const dir = mkdtempSync(join(tmpdir(), "qa-test-old-")),
		script = join(dir, "qa-seed.mts");
	try {
		// The OPS-106 seed as commit 1e5fa559 left it. A file, not `git show`: CI checks out one commit.
		const shown = readFileSync(join(source, "tools/qa/tests/fixtures/qa-seed-ops106.ts.txt"), "utf8");
		// It runs against today's domain, which takes a native body as the everyfield.doc/1 node (D-209), not text.
		const welcome = '"Welcome to Harvest Point. We meet Sundays at 10 AM at Travis Elementary."';
		assert.ok(shown.includes(`body: ${welcome}`), "the old seed's document body");
		writeFileSync(
			script,
			`import { nativeFromText } from "${source}/packages/contracts/src/documents/native.ts";\n` +
				shown
					.replaceAll('"../../', `"${source}/`)
					.replace('"./qa-guard.ts"', `"${source}/tools/qa/qa-guard.ts"`)
					.replace(`body: ${welcome}`, `body: nativeFromText(${welcome})`),
		);
		const r = tsxRun([script], old.env);
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /QA seed wrote: .*church.*wiki\./);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// Every row of the three current logins' church, as the old seed left it.
	const church = () =>
		old.query(`WITH p AS (SELECT id FROM plant WHERE name = 'Harvest Point (QA)')
			SELECT t, row FROM (SELECT 'plant' AS t, to_jsonb(x) AS row FROM plant x WHERE x.id IN (SELECT id FROM p)
			UNION ALL SELECT 'seat', to_jsonb(x) FROM seat x WHERE x.plant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'person', to_jsonb(x) FROM person x WHERE x.plant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'household', to_jsonb(x) FROM household x WHERE x.plant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'team', to_jsonb(x) FROM team x WHERE x.plant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'meeting', to_jsonb(x) FROM meeting x WHERE x.plant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'task', to_jsonb(x) FROM task x WHERE x.plant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'document', to_jsonb(x) FROM document x WHERE x.tenant_id IN (SELECT id FROM p)
			UNION ALL SELECT 'communication', to_jsonb(x) FROM communication x WHERE x.plant_id IN (SELECT id FROM p)) rows
			ORDER BY t, row::text`);
	const logins = () =>
		old.query(`SELECT u.email, u.email_verified, a.id, a.registration_state FROM auth_user u
			JOIN account a ON a.auth_user_id = u.id ORDER BY 1`);
	const beforeChurch = await church(),
		beforeLogins = await logins();
	assert.equal(beforeLogins.length, 3);

	// The OPS-127 wiki cases came after OPS-106 too. Their article titles depend on the database's wiki release.
	const upgrade = old
		.seed()
		.split(/wiki copies of [^,]+, wiki revision of [^,]+, wiki reading, wiki church versions of [^,]+/);
	assert.deepEqual(upgrade, [
		`QA seed wrote: login ${QA_LOGINS.network}, login ${QA_LOGINS.sending}, login ${QA_LOGINS.member2}, ` +
			`login ${QA_LOGINS.signup}, spare member seat Owen Price, ${NOV4_MAIL}, ` +
			`${ORGS.network}, ${ORGS.network} admin seat, ` +
			`connection ${ORGS.network}, ${ORGS.sending}, ${ORGS.sending} owner seat, connection ${ORGS.sending}, ` +
			`login ${QA_LOGINS.riverside}, church Riverside (QA), onboarding Riverside (QA), person Ana Lee in Riverside (QA), ` +
			"sending church Grace Fellowship (QA), affiliation with Grace Fellowship (QA), ",
		", owner timezone, 13 check-in weeks.",
	]);
	// The 2026-11-04 parts add Owen Price's seat and Person and the delivery message; every older row stays as it was.
	assert.deepEqual(oldRows(await church(), beforeChurch), oldRows(beforeChurch, beforeChurch));
	assert.deepEqual(
		(await logins()).filter(
			(l) =>
				!(
					[QA_LOGINS.network, QA_LOGINS.sending, QA_LOGINS.member2, QA_LOGINS.signup, QA_LOGINS.riverside] as string[]
				).includes(String(l.email)),
		),
		beforeLogins,
	);
	const upgraded = await old.counts();
	assert.equal(old.seed(), "QA seed: the branch is already complete.");
	assert.deepEqual(await old.counts(), upgraded);
	// The upgraded branch now looks as a fresh one does to both organization logins.
	const seen = probe(old.env);
	assert.deepEqual(seen.network.connections, [
		{ kind: "plant", subject: "Harvest Point (QA)", organization: ORGS.network },
	]);
	assert.deepEqual(seen.sending.connections, [
		{ kind: "plant", subject: "Harvest Point (QA)", organization: ORGS.sending },
	]);
});

test("INV-qa-runbook: the runbook's login table lists exactly the QA logins and says what the organization logins see", () => {
	const runbook = readFileSync(join(source, "docs/runbooks/qa-preview.md"), "utf8");
	const section = runbook.slice(
		runbook.indexOf("### Logins on every QA preview"),
		runbook.indexOf("### Email on a QA preview"),
	);
	const table = section
		.split("\n")
		.filter((line) => /^\|.*`delivered\+/.test(line))
		.map((line) => line.split("|").map((cell) => cell.trim().replaceAll("`", "")));
	assert.deepEqual(
		table.map((cells) => cells[2]),
		Object.values(QA_LOGINS),
	);
	assert.deepEqual(
		table.map((cells) => cells[3]),
		Object.values(QA_LOGINS).map(() => QA_PASSWORD),
	);
	assert.deepEqual(
		table.map((cells) => cells[1]),
		[
			"Owner",
			"Admin",
			"Member",
			"Network Admin",
			"Sending-church director",
			"Second Member",
			"Sign-up",
			"Riverside Owner",
		],
	);
	for (const words of [
		ORGS.network,
		ORGS.sending,
		"oversees Harvest Point (QA)",
		"/settings/sharing",
		"Connected churches",
		"This account is for an organization",
		"check-ins",
	])
		assert.ok(section.replace(/\s+/g, " ").includes(words), words);
});

// Nora QA 2026-11-04 (T-51): a removable Member seat, a sign-up login, a refused recipient, the Admin's suppressed
// address with a past restore. The wiki order case is in qa-wiki.test.ts.

test("INV-qa-seed: a second Member, Owen Price, holds a seat on the church and signs in to it; Ruth Allen's seat is unchanged", async () => {
	const { query, seen } = await fresh();
	assert.deepEqual(
		await query(`SELECT u.email, u.email_verified, a.registration_state, s.role, s.ended_at IS NULL AS live,
			s.accepted_at IS NOT NULL AS accepted, pe.display_name
			FROM seat s JOIN account a ON a.id = s.account_id JOIN auth_user u ON u.id = a.auth_user_id
			JOIN plant p ON p.id = s.plant_id
			LEFT JOIN person pe ON pe.linked_account_id = a.id AND pe.plant_id = p.id AND pe.state = 'live'
			WHERE p.name = 'Harvest Point (QA)' AND s.role = 'member' ORDER BY u.email`),
		[
			{
				email: QA_LOGINS.member2,
				email_verified: true,
				registration_state: "active",
				role: "member",
				live: true,
				accepted: true,
				display_name: "Owen Price",
			},
			{
				email: QA_LOGINS.member,
				email_verified: true,
				registration_state: "active",
				role: "member",
				live: true,
				accepted: true,
				display_name: "Ruth Allen",
			},
		],
	);
	assert.equal(seen.member2.signedIn, "signed_in");
	assert.equal(seen.member2.session, "active");
	assert.deepEqual([seen.member2.context.kind, seen.member2.context.role], ["seat", "member"]);
	assert.deepEqual(seen.member2.context.owner, seen.owner.selected);
});

test("INV-qa-seed: the sign-up login is verified, holds no seat or organization, and signs in with church setup still to do", async () => {
	const { query, seen } = await fresh();
	assert.deepEqual(
		await query(`SELECT u.email_verified, a.registration_state, a.registration_kind,
			(SELECT count(*)::int FROM seat s WHERE s.account_id = a.id) AS seats
			FROM auth_user u JOIN account a ON a.auth_user_id = u.id WHERE u.email = '${QA_LOGINS.signup}'`),
		[{ email_verified: true, registration_state: "pending_domain", registration_kind: "planter", seats: 0 }],
	);
	assert.equal(seen.signup.signedIn, "signed_in");
	assert.equal(seen.signup.session, "pending_domain");
	assert.equal(seen.signup.actor.status, "pending_domain");
});

test("INV-qa-seed: the sent delivery message has one refused recipient, counted as failed and not delivered", async () => {
	const { seen } = await fresh();
	assert.equal(seen.delivery.recipients.status, "ok");
	// The seed sealed each address under the keys the preview gets, so the Owner's read opens it.
	assert.deepEqual(
		seen.delivery.recipients.value.items
			.map((r: { name: string; deliveryStatus: string; deliveryAddress: string }) => [
				r.name,
				r.deliveryStatus,
				r.deliveryAddress,
			])
			.sort(),
		[
			["Leo Pratt", "refused", "delivered+qa-leo@resend.dev"],
			["Maria Santos", "delivered", "delivered+qa-maria@resend.dev"],
			["Sara Nunez", "delivered", "delivered+qa-sara@resend.dev"],
		],
	);
	const t = seen.delivery.totals.value;
	assert.deepEqual(
		[t.state, t.selected, t.attempted, t.accepted, t.delivered, t.failed, t.suppressed, t.unknown, t.bounced],
		["sent", 3, 3, 2, 2, 1, 1, 0, 0],
	);
});

test("INV-qa-seed: the Admin's own address is suppressed and has one past restore by Lena Park with a reason", async () => {
	const { seen } = await fresh();
	assert.equal(seen.address.status, "ok");
	const { address, active, restores } = seen.address.value;
	assert.deepEqual([address, active, restores.length], [QA_LOGINS.admin, true, 1]);
	assert.equal(restores[0].actorName, "Lena Park");
	assert.equal(restores[0].reason, "Lena confirmed her inbox works again after the first bounce.");
	const days = (Date.now() - Date.parse(restores[0].at)) / 86_400_000;
	assert.ok(days > 20 && days < 22, restores[0].at);
});

test("INV-qa-seed: the first run names each new part once; the second writes nothing", async () => {
	const { first, second, seeded, after } = await fresh();
	const parts = first
		.replace(/^QA seed wrote: /, "")
		.replace(/\.$/, "")
		.split(", ");
	for (const part of [
		`login ${QA_LOGINS.member2}`,
		`login ${QA_LOGINS.signup}`,
		"spare member seat Owen Price",
		...NOV4_MAIL.split(", "),
	])
		assert.equal(parts.filter((p) => p === part).length, 1, part);
	assert.equal(parts.filter((p) => p.startsWith("wiki church versions of ")).length, 1, first);
	assert.equal(second, "QA seed: the branch is already complete.");
	assert.deepEqual(after, seeded);
});

// T-255: real test inboxes on one deployment, and a second church that shares a person with the first.

/** Placeholder addresses only: the repository never holds a real inbox. */
const ANA = "ana.qa@example.com",
	OTHER = "second.qa@example.org";

test("INV-qa-preview: --test-recipients sets EMAIL_TEST_RECIPIENTS on that one deployment and the seed, and stores no address", () => {
	const s = setup();
	try {
		const up = s.qa("up", "feature/nora-qa", "--test-recipients", ` ${ANA}, ${OTHER}`);
		assert.equal(up.status, 0, up.stderr);
		const [idLine, url] = up.stdout.trim().split("\n");
		const id = idLine!.replace("QA preview ", "");
		// The per-deployment -e flag, next to the other per-deployment settings.
		const env = s.stubState<Record<string, string>>("deploy-env.json");
		assert.equal(env.EMAIL_TEST_RECIPIENTS, `${ANA},${OTHER}`);
		assert.equal(env.IDENTITY_ORIGIN, url);
		const deploy = s.calls("vercel").find((c) => c[0] === "deploy")!;
		assert.equal(deploy[deploy.indexOf(`EMAIL_TEST_RECIPIENTS=${ANA},${OTHER}`) - 1], "-e");
		// Nothing changes the shared Preview or Production environment.
		assert.deepEqual(
			s
				.calls("vercel")
				.map((c) => c[0])
				.filter((c) => c !== "curl"),
			["deploy", "alias"],
		);
		assert.deepEqual(s.stubState("seed-recipients.json"), { QA_TEST_RECIPIENTS: `${ANA},${OTHER}` });
		// The lead reads which extra addresses get real mail, after the URL. No secret is printed.
		const line = `Real mail on this preview also reaches: ${ANA}, ${OTHER}. Ana Lee uses ${ANA} in both churches.`;
		assert.ok(up.stderr.includes(line), up.stderr);
		for (const [k, v] of Object.entries(env))
			if (!["IDENTITY_ORIGIN", "EMAIL_TEST_RECIPIENTS"].includes(k)) assert.ok(!(up.stdout + up.stderr).includes(v), k);
		// The record and the list hold no address.
		const stored = readFileSync(join(s.root, ".git/qa/previews.json"), "utf8");
		assert.ok(!stored.includes("example."), stored);
		assert.match(
			s.qa("list").stdout.trim(),
			new RegExp(`^${id}  feature/nora-qa  ${url}  neon:${id}  age 0m  [0-9a-f]{12}$`),
		);
	} finally {
		s.done();
	}
});

/** The scheduled-send driver's calls of the stubbed `vercel curl`, in order. */
const cronCalls = (state: string) =>
	existsSync(join(state, "cron-calls.log"))
		? readFileSync(join(state, "cron-calls.log"), "utf8")
				.trim()
				.split("\n")
				.map(
					(l) =>
						JSON.parse(l) as {
							path: string;
							deployment: string;
							linked: unknown;
							authorization: string;
							mode: number;
						},
				)
		: [];

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("INV-qa-cron: qa up runs the preview's /api/cron/jobs with its own cron secret until qa down stops the driver", () => {
	const s = setup();
	try {
		const up = s.qa("up", "feature/nora-qa");
		assert.equal(up.status, 0, up.stderr);
		const id = up.stdout.split("\n")[0]!.replace("QA preview ", "");
		const env = s.stubState<Record<string, string>>("deploy-env.json");
		// A cron secret of this deployment only, set with -e like the other per-deployment settings; purges stay on
		// this preview's own Neon branch.
		assert.match(env.CRON_SECRET!, /^[a-f0-9]{64}$/);
		assert.equal(env.LIFECYCLE_CLEANUP_DATABASE_URL, env.DATABASE_URL_UNPOOLED);
		assert.ok(!s.calls("vercel").some((c) => c[0] === "env"));

		// The driver's first call reached the real route on this deployment before qa up returned, with the bearer the
		// route checks, through vercel curl (which adds the project's protection bypass) from a linked private folder.
		const [first] = cronCalls(s.state);
		assert.deepEqual(first, {
			path: "/api/cron/jobs",
			deployment: "https://everyfield-abc123-team.vercel.app",
			linked: { orgId: "team_JKEPRxDWACtp9hugEthW215I", projectId: "prj_N6MhFGqi0UW5Iaa6RBDpusMKxMwu" },
			authorization: `Authorization: Bearer ${env.CRON_SECRET}\n`,
			mode: 0o600,
		});
		assert.match(
			up.stderr,
			/Scheduled sends: on\. \/api\/cron\/jobs runs every minute from this Mac until bin\/qa down\./,
		);
		assert.ok(!(up.stdout + up.stderr).includes(env.CRON_SECRET!), "the cron secret was printed");

		// The driver outlives qa up, and its record and log hold no secret.
		const record = JSON.parse(readFileSync(join(s.root, ".git/qa/previews.json"), "utf8")).previews[0];
		assert.ok(alive(record.driver_pid), "the driver is running");
		const log = readFileSync(join(s.root, `.git/qa/${id}.cron.log`), "utf8");
		assert.match(log, /ok: HTTP 200 \{"status":"ok","messages":1\}/);
		for (const text of [log, JSON.stringify(record)]) assert.ok(!text.includes(env.CRON_SECRET!));

		const down = s.qa("down", id);
		assert.equal(down.status, 0, down.stderr);
		assert.match(down.stdout, /scheduled-send driver/);
		assert.ok(!alive(record.driver_pid), "qa down stopped the driver");
		assert.ok(!existsSync(join(s.root, `.git/qa/${id}.cron.log`)), "qa down removed the log");
		assert.deepEqual(readdirSync(s.temp), [], "the driver removed its header file");
	} finally {
		s.done();
	}
});

test("INV-qa-cron: a failed first cron run keeps the preview and says so; a driver whose record is gone stops itself", () => {
	const s = setup();
	try {
		writeFileSync(join(s.state, "FAIL_CRON"), "");
		const up = s.qa("up", "feature/nora-qa");
		assert.equal(up.status, 0, up.stderr);
		assert.match(
			up.stderr,
			/Scheduled sends: the first run FAILED \(HTTP 401 Unauthorized\)\. The driver keeps trying\./,
		);
		const file = join(s.root, ".git/qa/previews.json");
		const pid = JSON.parse(readFileSync(file, "utf8")).previews[0].driver_pid;
		assert.ok(alive(pid));
		// A record removed by anything but qa down still ends the driver within its next check.
		writeFileSync(file, JSON.stringify({ previews: [] }));
		for (let waited = 0; waited < 10_000 && alive(pid); waited += 200)
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
		assert.ok(!alive(pid), "the orphaned driver stopped");
		assert.deepEqual(readdirSync(s.temp), [], "the driver removed its header file");
	} finally {
		s.done();
	}
});

test("INV-qa-preview: a bad --test-recipients list exits 2 and says what to fix before anything is made; help lists the flag", () => {
	for (const value of [
		"",
		" , ",
		`${ANA},`,
		"example.com",
		`*@example.com`,
		"ana@*.example.com",
		"@example.com",
		"ana@",
		"ana@example",
		"ana @example.com",
	]) {
		const s = setup();
		try {
			const r = s.qa("up", "feature/nora-qa", `--test-recipients=${value}`);
			assert.equal(r.status, 2, `${JSON.stringify(value)}: ${r.stderr}`);
			assert.match(r.stderr, /qa up refused before creating anything\. --test-recipients (needs|takes) /, value);
			assert.deepEqual(s.calls("neonctl"), [], value);
			assert.deepEqual(s.calls("vercel"), [], value);
			assert.equal(s.qa("list").stdout.trim(), "No open QA previews.");
		} finally {
			s.done();
		}
	}
	const s = setup();
	try {
		for (const args of [
			["up", "feature/nora-qa", "--test-recipients"],
			["up", "feature/nora-qa", "--recipients", ANA],
			["up", "feature/nora-qa", "--test-recipients", ANA, "extra"],
			["up", "--test-recipients", ANA],
		]) {
			const r = s.qa(...args);
			assert.equal(r.status, 2, args.join(" "));
			assert.deepEqual(s.calls("neonctl"), [], args.join(" "));
		}
		assert.match(s.qa("help").stdout, /qa up <branch> \[--test-recipients a@x,b@x\]/);
	} finally {
		s.done();
	}
});

/** What the two church Owners see (fixtures/qa-churches-probe.ts). */
function churches(env: Record<string, string>) {
	const r = tsxRun(["tools/qa/tests/fixtures/qa-churches-probe.ts"], env);
	assert.equal(r.status, 0, r.stderr);
	return JSON.parse(r.stdout) as Record<string, any>;
}

let givenRun: Promise<{ first: string; seen: Record<string, any>; query: (sql: string) => Promise<any[]> }> | undefined;
/** A second fresh database, seeded with two test recipients as `bin/qa up --test-recipients` passes them. */
const given = () =>
	(givenRun ??= (async () => {
		const q = quiet("qa-seed-given");
		const r = runSeed({ ...q.env, QA_TEST_RECIPIENTS: `${ANA},${OTHER}` });
		assert.equal(r.status, 0, r.stderr);
		return { first: r.stdout.trim(), seen: churches(q.env), query: q.query };
	})());

test("INV-qa-seed: Riverside (QA) is a church plant with its own Owner login, whose session lands on it", async () => {
	const { query, first } = await fresh();
	assert.ok(first.includes(`login ${QA_LOGINS.riverside}, church Riverside (QA), onboarding Riverside (QA)`), first);
	assert.deepEqual(
		await query(`SELECT p.name, p.onboarding_completed_at IS NOT NULL AS onboarded, u.email, u.email_verified,
			a.registration_state, s.role, s.ended_at IS NULL AS live
			FROM plant p JOIN seat s ON s.plant_id = p.id JOIN account a ON a.id = s.account_id
			JOIN auth_user u ON u.id = a.auth_user_id WHERE p.name = 'Riverside (QA)'`),
		[
			{
				name: "Riverside (QA)",
				onboarded: true,
				email: QA_LOGINS.riverside,
				email_verified: true,
				registration_state: "active",
				role: "owner",
				live: true,
			},
		],
	);
	// A plant, not an organization: no sending church or network carries the name.
	assert.deepEqual(await query("SELECT count(*)::int AS n FROM organization WHERE name = 'Riverside (QA)'"), [
		{ n: 0 },
	]);
	const seen = churches((await fresh()).env);
	assert.deepEqual(seen.riverside.context, { kind: "seat", selected: "plant", church: "Riverside (QA)" });
	assert.deepEqual(seen.owner.context, { kind: "seat", selected: "plant", church: "Harvest Point (QA)" });
});

test("INV-qa-seed: with no test recipients, Ana Lee is in both churches at her resend.dev address, and each Owner sees only its church", async () => {
	const seen = churches((await fresh()).env);
	const ana = { name: "Ana Lee", email: "delivered+qa-ana@resend.dev" };
	assert.ok(
		seen.owner.people.some((p: any) => p.name === "Ana Lee" && p.email === ana.email),
		JSON.stringify(seen.owner),
	);
	assert.deepEqual(
		seen.riverside.people.filter((p: any) => p.name !== "Rachel Moss"),
		[ana],
	);
	// Neither Owner reads the other church's people: the read refuses, as for any church the login has no seat in.
	assert.deepEqual(seen.owner.other, { refused: "unavailable" });
	assert.deepEqual(seen.riverside.other, { refused: "unavailable" });
	assert.ok(!seen.owner.people.some((p: any) => p.name === "Rachel Moss"));
	assert.ok(!seen.riverside.people.some((p: any) => p.name === "Daniel Reyes" || p.name === "Maria Santos"));
});

test("INV-qa-seed: given test recipients, Ana Lee has the first address in both churches and no one else has a given address", async () => {
	const { seen, query, first } = await given();
	assert.ok(first.includes("person Ana Lee in Riverside (QA)"), first);
	const ana = { name: "Ana Lee", email: ANA };
	assert.deepEqual(
		seen.owner.people.filter((p: any) => p.name === "Ana Lee"),
		[ana],
	);
	assert.deepEqual(
		seen.riverside.people.filter((p: any) => p.name !== "Rachel Moss"),
		[ana],
	);
	// Every other seeded person keeps a resend.dev address, and the second given address is only an approved recipient.
	assert.deepEqual(
		await query(`SELECT p.display_name, pl.name AS church, p.email FROM person p JOIN plant pl ON pl.id = p.plant_id
			WHERE p.email NOT LIKE 'delivered+%@resend.dev' ORDER BY 2, 1`),
		[
			{ display_name: "Ana Lee", church: "Harvest Point (QA)", email: ANA },
			{ display_name: "Ana Lee", church: "Riverside (QA)", email: ANA },
		],
	);
	assert.deepEqual([seen.owner.other, seen.riverside.other], [{ refused: "unavailable" }, { refused: "unavailable" }]);
});
