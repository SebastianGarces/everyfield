import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { source } from "./fixtures.ts";
import { DEV_ENDPOINT, PROD_ENDPOINT, seedRefusal } from "../qa-guard.ts";
import { startQuietDatabase, stopQuietDatabase } from "../timing-stack.ts";

// Sentinels the stubbed CLIs emit or receive. None may reach evf's output, its store or any file it leaves behind.
const NEON_PASSWORD = "npg_SentinelNeonPassword01";
const BYPASS = "sentinel-bypass-secret-0f1e2d3c";
const API_KEY = "re_sentinel_resend_key_99";

const DEV = { id: `${DEV_ENDPOINT}-b8ltidky`, branch_id: "br-dev" };
const PROD = { id: `${PROD_ENDPOINT}-b8tvq4ha`, branch_id: "br-main" };
const BRANCHES = [
	{ id: "br-dev", name: "development" },
	{ id: "br-main", name: "main" },
];

/** A git repo with one feature branch, stub neonctl, vercel and corepack first on PATH, and a private TMPDIR. */
function setup(endpoints = [DEV, PROD]) {
	const dir = mkdtempSync(join(tmpdir(), "evf-qa-")),
		root = join(dir, "repo"),
		bin = join(dir, "bin"),
		state = join(dir, "stub-state"),
		temp = join(dir, "tmp");
	for (const d of [root, bin, state, temp]) mkdirSync(d);
	const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	git("init", "--quiet", "-b", "main");
	mkdirSync(join(root, "tools/evf"), { recursive: true });
	writeFileSync(join(root, "tools/evf/qa-seed.ts"), "// placeholder\n");
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
	console.log(JSON.stringify({ branch, connection_uris: [{ connection_uri: ${JSON.stringify(cs)} }] }));
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
console.log("seeded with " + process.env.QA_ROLE_PASSWORD);`,
	);
	stub(
		"vercel",
		`if (a[0] === "deploy") {
	const env = {};
	for (let i = 0; i < a.length; i++) if (a[i] === "-e") { const [k, ...v] = a[i + 1].split("="); env[k] = v.join("="); }
	write("deploy-env.json", env);
	write("deploy-link.json", JSON.parse(fs.readFileSync(".vercel/project.json", "utf8")));
	console.error("Inspect: https://vercel.com/x  bypass ${BYPASS}");
	console.log("https://everyfield-abc123-team.vercel.app");
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
	const evf = (...args: string[]) =>
		spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "qa", ...args], {
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
	return { dir, root, temp, state, evf, calls, stubState, done: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Every file under `dir`, with its bytes as text. */
function files(dir: string): Array<[string, string]> {
	return readdirSync(dir, { recursive: true, withFileTypes: false })
		.map((rel) => join(dir, String(rel)))
		.filter((p) => statSync(p).isFile())
		.map((p) => [p, readFileSync(p).toString("latin1")]);
}

test("OPS-106: evf qa up refuses before it creates anything when the parent is missing or production", () => {
	for (const [endpoints, reason] of [
		[[PROD], /No single ep-autumn-dew endpoint/],
		[[DEV, { ...PROD, branch_id: "br-dev" }], /production database/],
	] as const) {
		const s = setup([...endpoints]);
		try {
			const r = s.evf("up", "feature/nora-qa");
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
			assert.equal(s.evf("list").stdout.trim(), "No open QA previews.");
		} finally {
			s.done();
		}
	}
});

test("OPS-106: qa up, list and down keep every secret out of output, the store and files; down twice is a no-op", () => {
	const s = setup();
	try {
		const up = s.evf("up", "feature/nora-qa");
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
			"DATABASE_URL",
			"DATABASE_URL_UNPOOLED",
			"IDENTITY_ADDRESS_KEY",
			"IDENTITY_AUTH_DATABASE_URL",
			"IDENTITY_DATABASE_URL",
			"IDENTITY_MAIL_KEY",
			"IDENTITY_ORIGIN",
			"IDENTITY_SECRET",
			"NOTIFICATION_OPT_OUT_KEYS",
		]);
		assert.equal(env.IDENTITY_ORIGIN, url);
		assert.equal(new URL(env.IDENTITY_DATABASE_URL!).username, "evf_qa_runtime");
		assert.match(new URL(env.DATABASE_URL!).hostname, /^ep-qa-branch-a1-pooler\./);
		assert.ok(s.calls("vercel").some((c) => c.includes("--target") && c.includes("preview")));
		assert.ok(!s.calls("vercel").some((c) => c.includes("--prod") || c.includes("production")));
		assert.deepEqual(s.stubState("alias.json"), {
			[`everyfield-${id}.vercel.app`]: "https://everyfield-abc123-team.vercel.app",
		});

		const list = s.evf("list");
		assert.equal(list.status, 0, list.stderr);
		assert.match(list.stdout.trim(), new RegExp(`^${id}  feature/nora-qa  ${url}  neon:${id}  age 0m  [0-9a-f]{12}$`));

		const down = s.evf("down", id);
		assert.equal(down.status, 0, down.stderr);
		assert.equal(down.stdout.trim(), `Removed QA preview ${id}: alias, deployment, Neon branch ${id}.`);
		assert.deepEqual(s.stubState("branches.json"), BRANCHES);
		assert.deepEqual(s.stubState("alias.json"), {});
		const again = s.evf("down", id);
		assert.equal(again.status, 0, again.stderr);
		assert.equal(again.stdout.trim(), `No QA preview ${id}. Nothing to remove.`);
		assert.equal(s.calls("neonctl").filter((c) => c[1] === "delete").length, 1);
		assert.equal(s.evf("list").stdout.trim(), "No open QA previews.");

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
			seen.some(([p]) => p.endsWith("work.sqlite")),
			"the store was scanned",
		);
		for (const [where, text] of seen)
			for (const secret of secrets) assert.ok(!text.includes(secret), `a secret reached ${where}`);
		assert.deepEqual(readdirSync(s.temp), [], "the deploy checkout is removed");
	} finally {
		s.done();
	}
});

test("OPS-106: a failed qa up shows redacted output and removes the Neon branch it made", () => {
	const s = setup();
	try {
		writeFileSync(join(s.state, "FAIL_MIGRATE"), "");
		const r = s.evf("up", "feature/nora-qa");
		assert.equal(r.status, 1);
		assert.match(r.stderr, /corepack pnpm failed \(exit 1\):\nusing <redacted>\n/);
		assert.ok(!(r.stdout + r.stderr).includes(NEON_PASSWORD));
		assert.deepEqual(s.stubState("branches.json"), BRANCHES);
		assert.equal(s.evf("list").stdout.trim(), "No open QA previews.");
	} finally {
		s.done();
	}
});

const seedArgs = ["--conditions=react-server", "tools/evf/qa-seed.ts"];
const tsx = join(source, "packages/domain/node_modules/.bin/tsx");
const runSeed = (env: Record<string, string | undefined>) => {
	const clean: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: undefined, DATABASE_URL: undefined };
	for (const [k, v] of Object.entries(env)) clean[k] = v;
	for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
	return spawnSync(tsx, seedArgs, { cwd: source, encoding: "utf8", env: clean });
};

test("OPS-106: the QA seed refuses production, the shared development branch, NODE_ENV=production and no URL", () => {
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

test("OPS-106: the QA seed fills a fresh database, and a second run changes no table's row count", async () => {
	const db = startQuietDatabase(source, "qa-seed");
	try {
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
		const before = await counts();
		// The refusal leaves the database as it was.
		assert.equal(
			runSeed({ DATABASE_URL: db.adminUrl, NODE_ENV: "production", QA_ROLE_PASSWORD: "x".repeat(20) }).status,
			2,
		);
		assert.deepEqual(await counts(), before);

		const env = { DATABASE_URL: db.adminUrl, QA_ROLE_PASSWORD: "qa-role-password-0123" };
		const first = runSeed(env);
		assert.equal(first.status, 0, first.stderr);
		assert.match(first.stdout, /QA seed wrote: .*church.*wiki\./);
		const seeded = await counts();
		const second = runSeed(env);
		assert.equal(second.status, 0, second.stderr);
		assert.equal(second.stdout.trim(), "QA seed: the branch is already complete.");
		assert.deepEqual(await counts(), seeded);

		// The test church and its data, from the requirement: each role, and rows in every planter area.
		assert.deepEqual(
			await query(`SELECT u.email, s.role FROM seat s JOIN account a ON a.id = s.account_id
				JOIN auth_user u ON u.id = a.auth_user_id JOIN plant p ON p.id = s.plant_id
				WHERE p.name = 'Harvest Point (QA)' ORDER BY s.role DESC`),
			[
				{ email: "delivered+qa-owner@resend.dev", role: "owner" },
				{ email: "delivered+qa-member@resend.dev", role: "member" },
				{ email: "delivered+qa-admin@resend.dev", role: "admin" },
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
	} finally {
		stopQuietDatabase(db);
	}
});
