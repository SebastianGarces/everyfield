import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SELF = ".agents/skills/verify-preview/scripts/publish.mjs";
const source = join(resolve(import.meta.dirname, "../../.."), SELF);
const PROD_SECRET = "prod-secret-value-never-read";
const DEV_SECRET = "dev-database-password-1234";

// A scratch checkout with the committed script, an unreadable .env.prod and a dev env file,
// plus a fake S3 endpoint that answers protected-bucket listings with the given statuses.
async function setup(listing: Record<string, number>) {
	const dir = mkdtempSync(join(tmpdir(), "evf-publish-test-")),
		repo = join(dir, "repo"),
		script = join(repo, SELF);
	mkdirSync(join(script, ".."), { recursive: true });
	copyFileSync(source, script);
	const g = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
	g("init", "-q");
	g("add", ".");
	g("commit", "-q", "-m", "scratch");
	writeFileSync(join(repo, ".env.prod"), `AWS_ACCESS_KEY_ID=prod-key-id\nAWS_SECRET_ACCESS_KEY=${PROD_SECRET}\n`);
	chmodSync(join(repo, ".env.prod"), 0); // any read throws EACCES
	writeFileSync(join(repo, ".env.local"), `DATABASE_PASSWORD=${DEV_SECRET}\n`);

	const requests: string[] = [];
	const server = createServer((req, res) => {
		const virtual = req.headers.host?.startsWith("everyfield-evidence.");
		requests.push(`${req.method} ${virtual ? "virtual" : ""}${req.url}`);
		const bucket = req.url!.split(/[/?]/)[1];
		const status = virtual
			? req.url!.startsWith("/?")
				? 403
				: 200
			: req.method === "GET" && bucket in listing
				? listing[bucket]
				: 200;
		req.resume().on("end", () => res.writeHead(status).end(""));
	});
	await new Promise<void>((r) => server.listen(0, r));
	const keyFile = join(dir, "evidence.env");
	writeFileSync(
		keyFile,
		`AWS_ACCESS_KEY_ID=evidence-key\nAWS_SECRET_ACCESS_KEY=evidence-secret-value\nAWS_ENDPOINT_URL_S3=http://localhost:${(server.address() as AddressInfo).port}\nAWS_REGION=auto\n`,
	);
	const evidence = join(dir, "evidence");
	mkdirSync(evidence);
	writeFileSync(join(evidence, "probe.log"), "all checks passed\n");

	const run = (scriptPath: string, args: string[]) =>
		new Promise<{ code: number | null; out: string; err: string }>((done) => {
			const child = spawn(process.execPath, [scriptPath, ...args], {
				cwd: dir,
				env: { PATH: process.env.PATH, HOME: dir, EVF_EVIDENCE_ENV: keyFile },
			});
			let out = "",
				err = "";
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("close", (code) => done({ code, out, err }));
		});
	return {
		dir,
		repo,
		script,
		evidence,
		requests,
		keyFile,
		publish: (scriptPath = script) => run(scriptPath, [evidence, "--task", "OPS-33"]),
		remove: () => run(script, ["--delete", "OPS-33"]),
		close: () => {
			server.close();
			chmodSync(join(repo, ".env.prod"), 0o600);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const evidenceOnly = { everyfield: 403, "everyfield-dev": 403 };

test("OPS-33 publish: an evidence-only key uploads and the script never opens .env.prod", async () => {
	const t = await setup(evidenceOnly);
	try {
		// A value from .env.prod in the evidence: reading .env.prod as a secret source would also refuse this.
		writeFileSync(join(t.evidence, "notes.txt"), `mentions ${PROD_SECRET}\n`);
		const r = await t.publish();
		assert.equal(r.code, 0, r.err);
		assert.match(r.err, new RegExp(`key file ${join(t.dir, "evidence.env")}\\.`));
		assert.doesNotMatch(r.err + r.out, /EACCES|\.env\.prod/);
		assert.deepEqual(JSON.parse(r.out).files, 3);
		assert.deepEqual(t.requests.filter((q) => !q.startsWith("PUT")).slice(0, 2), [
			"GET /everyfield?list-type=2&max-keys=1",
			"GET /everyfield-dev?list-type=2&max-keys=1",
		]);
		assert.equal(t.requests.filter((q) => q.startsWith("PUT /everyfield-evidence/evf-evidence/OPS-33/")).length, 3);
	} finally {
		t.close();
	}
});

test("OPS-33 publish: a key that can list everyfield-dev is refused before any upload or delete", async () => {
	const t = await setup({ everyfield: 403, "everyfield-dev": 200 });
	try {
		for (const r of [await t.publish(), await t.remove()]) {
			assert.notEqual(r.code, 0);
			assert.match(r.err, /Refused: listing everyfield-dev with the key in .* returned HTTP 200, not 403/);
		}
		assert.deepEqual(
			t.requests.filter((q) => !q.startsWith("GET /everyfield")),
			[],
		);
	} finally {
		t.close();
	}
});

test("OPS-33 publish: a copied or edited script refuses to run", async () => {
	const t = await setup(evidenceOnly);
	try {
		const copy = join(t.dir, "publish.mjs");
		copyFileSync(t.script, copy);
		const copied = await t.publish(copy);
		appendFileSync(t.script, "// local edit\n");
		const edited = await t.publish();
		for (const r of [copied, edited]) {
			assert.equal(r.code, 2);
			assert.match(r.err, /Refused: run \.agents\/skills\/verify-preview\/scripts\/publish\.mjs unchanged/);
		}
		assert.deepEqual(t.requests, []);
	} finally {
		t.close();
	}
});

test("OPS-33 publish: an evidence file with a development env value is blocked", async () => {
	const t = await setup(evidenceOnly);
	try {
		writeFileSync(join(t.evidence, "server.log"), `connected with ${DEV_SECRET}\n`);
		const r = await t.publish();
		assert.notEqual(r.code, 0);
		assert.match(r.err, /Refused: server\.log contain a credential/);
		assert.doesNotMatch(r.err, new RegExp(DEV_SECRET));
		assert.deepEqual(
			t.requests.filter((q) => q.startsWith("PUT")),
			[],
		);
	} finally {
		t.close();
	}
});

test("OPS-33 publish: an evidence or dev env file that resolves to .env.prod is refused unopened", async () => {
	const t = await setup(evidenceOnly);
	try {
		rmSync(join(t.repo, ".env.local"));
		symlinkSync(join(t.repo, ".env.prod"), join(t.repo, ".env.local"));
		const dev = await t.publish();
		assert.notEqual(dev.code, 0);
		assert.match(dev.err, /Refused: .*\.env\.local resolves to a production env file/);
		rmSync(t.keyFile);
		symlinkSync(join(t.repo, ".env.prod"), t.keyFile);
		const key = await t.publish();
		assert.notEqual(key.code, 0);
		assert.match(key.err, /Refused: .*evidence\.env resolves to a production env file/);
		for (const r of [dev, key]) assert.doesNotMatch(r.err, /EACCES/);
		assert.deepEqual(
			t.requests.filter((q) => q.startsWith("PUT")),
			[],
		);
	} finally {
		t.close();
	}
});

test("OPS-33 publish: an evidence file that links to .env.prod or out of the folder is refused unopened", async () => {
	const t = await setup(evidenceOnly);
	try {
		const outside = join(t.dir, "outside.txt");
		writeFileSync(outside, "outside the evidence folder\n");
		for (const [name, targetPath] of [
			["notes.txt", join(t.repo, ".env.prod")],
			["other.txt", outside],
			["index.html", join(t.repo, ".env.prod")],
		]) {
			symlinkSync(targetPath, join(t.evidence, name));
			const r = await t.publish();
			rmSync(join(t.evidence, name));
			assert.notEqual(r.code, 0);
			assert.match(
				r.err,
				new RegExp(
					`Refused: ${name.replace(".", "\\.")} (resolves outside the evidence folder|in the evidence folder is a symlink)`,
				),
			);
			assert.doesNotMatch(r.err, /EACCES/);
		}
		assert.deepEqual(
			t.requests.filter((q) => q.startsWith("PUT")),
			[],
		);
	} finally {
		t.close();
	}
});
