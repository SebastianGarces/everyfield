// T-396: the production identity setup (tools/prod-identity/setup.ts), run as Sebastian runs it, against a migrated
// throwaway Postgres in Docker with a stub `vercel` first on PATH. No test touches Neon or Vercel.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { source, startQuietDatabase, stopQuietDatabase, tsxRun, type QuietDatabase } from "./fixtures.ts";
import { LOGINS } from "../../prod-identity/setup.ts";

const SCRIPT = join(source, "tools/prod-identity/setup.ts");
const ORIGIN = "https://everyfield.example";
const pg = createRequire(join(source, "packages/db/package.json"))("pg");

let db: QuietDatabase;
let dir: string;
/** Every line any run printed: no generated value or admin password may appear in it. */
const printed: string[] = [];

before(() => {
	db = startQuietDatabase(source, "prod-identity");
	dir = realpathSync(mkdtempSync(join(tmpdir(), "prod-identity-")));
	mkdirSync(join(dir, "bin"));
	// The stub keeps each environment's names in a JSON file and logs every call's argv and stdin apart.
	writeFileSync(
		join(dir, "bin/vercel"),
		`#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), S = ${JSON.stringify(dir)};
const a = process.argv.slice(2), env = a[a.indexOf("--environment") + 1];
const file = path.join(S, env + ".json"), names = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
fs.appendFileSync(path.join(S, "argv.log"), JSON.stringify(a) + "\\n");
if (a[0] === "env" && a[1] === "ls") {
  console.error("> Environment Variables found for x/everyfield");
  console.log(" name               value               environments        created");
  for (const n of names) console.log(" " + n + "    Encrypted    " + env + "    1d ago");
  process.exit(0);
}
if (a[0] === "env" && a[1] === "add") {
  const value = fs.readFileSync(0, "utf8");
  if (names.includes(a[2]) && !a.includes("--force")) { console.error("already exists"); process.exit(1); }
  fs.writeFileSync(file, JSON.stringify([...new Set([...names, a[2]])]));
  fs.appendFileSync(path.join(S, "values.jsonl"), JSON.stringify({ name: a[2], value }) + "\\n");
  process.exit(0);
}
process.exit(2);
`,
	);
	chmodSync(join(dir, "bin/vercel"), 0o755);
	writeFileSync(join(dir, "production.json"), JSON.stringify(["DATABASE_URL", "DATABASE_URL_UNPOOLED"]));
	writeFileSync(
		join(dir, "preview.json"),
		JSON.stringify(["DATABASE_URL", "RESEND_API_KEY", "SOME_PREVIEW_ONLY_FLAG"]),
	);
});
after(() => {
	if (db) stopQuietDatabase(db);
	if (dir) rmSync(dir, { recursive: true, force: true });
});

const OUT = () => join(dir, "out/vercel-production.sh");
const PATH = () => `${join(dir, "bin")}${delimiter}${process.env.PATH ?? ""}`;

function run(args: string[], admin = db.adminUrl) {
	const r = spawnSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", SCRIPT, "--origin", ORIGIN, ...args],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PATH: PATH(), PROD_IDENTITY_ADMIN_URL: admin },
		},
	);
	printed.push(r.stdout, r.stderr);
	return { code: r.status, out: r.stdout + r.stderr };
}

async function query(url: string, text: string, options?: string) {
	const client = new pg.Client({ connectionString: url, options });
	await client.connect();
	try {
		return (await client.query(text)).rows as Record<string, unknown>[];
	} finally {
		await client.end();
	}
}
const roles = () =>
	query(
		db.adminUrl,
		`SELECT r.rolname, r.oid::text, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls, r.rolinherit,
		        array(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid WHERE m.member=r.oid) AS groups
		   FROM pg_roles r WHERE r.rolname LIKE 'everyfield_prod_%' ORDER BY 1`,
	);
const vercelCalls = () =>
	existsSync(join(dir, "argv.log"))
		? readFileSync(join(dir, "argv.log"), "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l) as string[])
		: [];
/** The values the commands file handed the stub on stdin, by setting name (the last one wins). */
const handed = () =>
	Object.fromEntries(
		readFileSync(join(dir, "values.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { name: string; value: string })
			.map((e) => [e.name, e.value]),
	) as Record<string, string>;
const runCommands = () => {
	const r = spawnSync("sh", [OUT()], { encoding: "utf8", env: { ...process.env, PATH: PATH() } });
	assert.equal(r.status, 0, r.stderr);
};

test("--help names the flags, the admin variable and that it is a dry run unless --apply", () => {
	const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", SCRIPT, "--help"], {
		encoding: "utf8",
	});
	assert.equal(r.status, 0);
	for (const word of [
		"--origin",
		"--apply",
		"--confirm",
		"--rotate-passwords",
		"--out",
		"PROD_IDENTITY_ADMIN_URL",
		"dry run",
	])
		assert.ok(r.stdout.includes(word), word);
});

test("each generated value passes the app's own parser", () => {
	const r = tsxRun(["tools/qa/tests/prod-identity-probe.ts"], {});
	assert.equal(r.status, 0, r.stderr);
	assert.deepEqual(JSON.parse(r.stdout), {
		IDENTITY_SECRET: true,
		IDENTITY_MAIL_KEY: true,
		IDENTITY_ADDRESS_KEY: true,
		NOTIFICATION_OPT_OUT_KEYS: true,
		CRON_SECRET: true,
		fresh: true,
	});
});

test("a dry run prints the plan and every setting by name, and changes no role and no Vercel setting", async () => {
	const r = run(["--out", OUT()]);
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(await roles(), []);
	assert.ok(vercelCalls().every((a) => a[0] === "env" && a[1] === "ls"));
	assert.ok(!existsSync(OUT()));
	for (const login of LOGINS) assert.match(r.out, new RegExp(`${login.name}: create`));
	assert.match(r.out, /GRANT everyfield_auth TO everyfield_prod_auth \(to grant\)/);
	assert.match(r.out, /IDENTITY_MAIL_KEY: \*{8} \(64 hex\)/);
	assert.match(r.out, /DATABASE_URL\s+already present/);
	assert.match(r.out, /RESEND_WEBHOOK_SECRET\s+set by hand/);
	assert.match(r.out, /SOME_PREVIEW_ONLY_FLAG\s+set by hand: Preview has it/);
	assert.match(r.out, /Dry run: nothing changed/);
});

test("--apply without the confirmed endpoint refuses and changes nothing", async () => {
	for (const args of [["--apply"], ["--apply", "--confirm", "ep-some-other-endpoint"]]) {
		const r = run([...args, "--out", OUT()]);
		assert.equal(r.code, 1, r.out);
		assert.match(r.out, /Refused: --apply writes only to the endpoint you confirm/);
	}
	assert.deepEqual(await roles(), []);
	assert.ok(!existsSync(OUT()));
	assert.ok(vercelCalls().every((a) => a[1] === "ls"));
});

test("apply creates the three logins, writes the commands file, and a second apply keeps them; rotate replaces passwords", async () => {
	const r = run(["--apply", "--confirm", "127.0.0.1", "--out", OUT()]);
	assert.equal(r.code, 0, r.out);
	const made = await roles();
	assert.deepEqual(
		made.map((x) => [
			x.rolname,
			x.groups,
			x.rolcanlogin,
			x.rolinherit,
			x.rolsuper,
			x.rolcreatedb,
			x.rolcreaterole,
			x.rolbypassrls,
		]),
		LOGINS.map((l) => [l.name, [l.group], true, true, false, false, false, false]).sort(),
	);
	assert.equal(statSync(OUT()).mode & 0o777, 0o600);
	const file = readFileSync(OUT(), "utf8");
	const adds = file.split("\n").filter((l) => l.includes("vercel env add"));
	assert.equal(adds.length, 9);
	for (const line of adds) {
		assert.match(
			line,
			/^printf '%s' '[^']+' \| vercel env add [A-Z_]+ --environment production --project everyfield --scope sebastian-garces-projects-335a0259 /,
		);
		assert.ok(!line.includes("--force"));
	}
	assert.match(
		r.out,
		/Vercel commands for: IDENTITY_DATABASE_URL, IDENTITY_AUTH_DATABASE_URL, LIFECYCLE_CLEANUP_DATABASE_URL, IDENTITY_ORIGIN, IDENTITY_SECRET/,
	);

	runCommands();
	const values = handed();
	assert.equal(values.IDENTITY_ORIGIN, ORIGIN);
	// No value travelled in an argv.
	for (const [name, value] of Object.entries(values))
		if (name !== "IDENTITY_ORIGIN")
			assert.ok(
				vercelCalls().every((a) => !a.some((x) => x.includes(value))),
				name,
			);
	// Each URL connects as the app connects and reads a table its group is granted.
	const asApp = async () => {
		assert.deepEqual(
			await query(
				values.IDENTITY_DATABASE_URL!,
				"SELECT current_user AS u, current_setting('statement_timeout') AS t FROM tenant RIGHT JOIN (SELECT 1) x ON true LIMIT 1",
				"-c statement_timeout=5s",
			),
			[{ u: "everyfield_prod_runtime", t: "5s" }],
		);
		assert.deepEqual(
			await query(
				values.IDENTITY_AUTH_DATABASE_URL!,
				"SELECT current_user AS u FROM auth_user RIGHT JOIN (SELECT 1) x ON true LIMIT 1",
			),
			[{ u: "everyfield_prod_auth" }],
		);
		assert.deepEqual(
			await query(
				values.LIFECYCLE_CLEANUP_DATABASE_URL!,
				"SELECT current_user AS u FROM tenant RIGHT JOIN (SELECT 1) x ON true LIMIT 1",
				"-c statement_timeout=60s",
			),
			[{ u: "everyfield_prod_cleanup" }],
		);
	};
	await asApp();

	// A waiting commands file blocks a rerun.
	const blocked = run(["--apply", "--confirm", "127.0.0.1", "--out", OUT()]);
	assert.equal(blocked.code, 1);
	assert.match(blocked.out, /A commands file from an earlier run is waiting/);

	// Once run and deleted, a second apply re-asserts the grants and changes no password or key.
	rmSync(OUT());
	const again = run(["--apply", "--confirm", "127.0.0.1", "--out", OUT()]);
	assert.equal(again.code, 0, again.out);
	assert.match(again.out, /everyfield_prod_runtime: keep/);
	assert.match(again.out, /already granted; re-asserted/);
	assert.match(again.out, /No commands file written/);
	assert.ok(!existsSync(OUT()));
	assert.deepEqual(
		(await roles()).map((x) => x.oid),
		made.map((x) => x.oid),
	);
	await asApp();

	// A login whose URL Vercel lacks cannot be kept: its password is gone, so only --rotate-passwords proceeds.
	writeFileSync(
		join(dir, "production.json"),
		JSON.stringify(
			JSON.parse(readFileSync(join(dir, "production.json"), "utf8")).filter(
				(n: string) => n !== "IDENTITY_AUTH_DATABASE_URL",
			),
		),
	);
	const stuck = run(["--apply", "--confirm", "127.0.0.1", "--out", OUT()]);
	assert.equal(stuck.code, 1);
	assert.match(
		stuck.out,
		/everyfield_prod_auth exists but Vercel Production has no IDENTITY_AUTH_DATABASE_URL.*--rotate-passwords/,
	);
	const rotated = run(["--apply", "--confirm", "127.0.0.1", "--rotate-passwords", "--out", OUT()]);
	assert.equal(rotated.code, 0, rotated.out);
	const lines = readFileSync(OUT(), "utf8")
		.split("\n")
		.filter((l) => l.includes("vercel env add"));
	assert.deepEqual(
		lines.map((l) => / env add ([A-Z_]+) /.exec(l)![1]),
		LOGINS.map((l) => l.setting),
	);
	assert.ok(lines.filter((l) => !l.includes("IDENTITY_AUTH_DATABASE_URL")).every((l) => l.endsWith("--force")));
	runCommands();
	await assert.rejects(query(values.IDENTITY_DATABASE_URL!, "SELECT 1"), /password authentication failed/);
	const fresh = handed();
	assert.deepEqual(await query(fresh.IDENTITY_DATABASE_URL!, "SELECT current_user AS u"), [
		{ u: "everyfield_prod_runtime" },
	]);
	assert.equal(fresh.IDENTITY_SECRET, values.IDENTITY_SECRET);
	rmSync(OUT());

	// No value or password reached any terminal output, here or in the tests above.
	const secrets = [...new Set([...Object.values(values), ...Object.values(fresh)])].filter((v) => v !== ORIGIN);
	secrets.push(new URL(db.adminUrl).password);
	for (const s of secrets) for (const out of printed) assert.ok(!out.includes(s), "a value reached the terminal");
});

test("a failing connection's error names no password or URL", () => {
	const wrong = Object.assign(new URL(db.adminUrl), { password: "wrong-sentinel-password-77" }).href;
	const r = run([], wrong);
	assert.equal(r.code, 1);
	assert.match(r.out, /prod-identity: /);
	assert.ok(!r.out.includes("wrong-sentinel-password-77"));
});
