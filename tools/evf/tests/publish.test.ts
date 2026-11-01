import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	appendFileSync,
	readFileSync,
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
	const types: Record<string, string | undefined> = {};
	const server = createServer((req, res) => {
		const virtual = req.headers.host?.startsWith("everyfield-evidence.");
		requests.push(`${req.method} ${virtual ? "virtual" : ""}${req.url}`);
		if (req.method === "PUT")
			types[decodeURIComponent(req.url!.replace(/^.*\/[0-9a-f]{32}\//, ""))] = req.headers["content-type"];
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
		types,
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

// The WP-036 evidence shape: two image folders plus top-level text, JSON and JSONL files.
function wp036Fixture(evidence: string) {
	mkdirSync(join(evidence, "actions"));
	mkdirSync(join(evidence, "shots"));
	mkdirSync(join(evidence, ".cache"));
	writeFileSync(join(evidence, "actions/01-type-text.png"), "png");
	writeFileSync(join(evidence, "actions/02-trace.jsonl"), "{}\n");
	writeFileSync(join(evidence, "shots/1440-light-text-style-menu.webp"), "webp");
	writeFileSync(join(evidence, "shots/390-light-text-style-menu.png"), "png");
	writeFileSync(join(evidence, "checks.txt"), "ok\n");
	writeFileSync(join(evidence, "results.json"), "{}\n");
	writeFileSync(join(evidence, "console.jsonl"), "{}\n");
	writeFileSync(join(evidence, "photo.jpeg"), "jpeg");
	writeFileSync(join(evidence, ".hidden.png"), "png");
	writeFileSync(join(evidence, ".cache/skip.png"), "png");
	writeFileSync(join(evidence, "published.json"), "{}\n");
}

const figure = (f: string) =>
	`<figure><a href="${f}" target="_blank" rel="noopener"><img src="${f}" alt="${f}" loading="lazy" decoding="async"></a><figcaption>${f}</figcaption></figure>`;

test("OPS-110 publish: the index shows one section per folder with images inline and other files as links", async () => {
	const t = await setup(evidenceOnly);
	try {
		wp036Fixture(t.evidence);
		const r = await t.publish();
		assert.equal(r.code, 0, r.err);
		const html = readFileSync(join(t.evidence, "index.html"), "utf8");
		const files = html.slice(html.indexOf("<h2>Files</h2>"));
		assert.equal(
			files,
			"<h2>Files</h2>\n" +
				[
					"<section><h3>(top level)</h3>" +
						`<div class="gallery">${figure("photo.jpeg")}</div>` +
						'<ul class="files"><li><a href="checks.txt">checks.txt</a></li><li><a href="console.jsonl">console.jsonl</a></li><li><a href="probe.log">probe.log</a></li><li><a href="results.json">results.json</a></li></ul></section>',
					"<section><h3>actions</h3>" +
						`<div class="gallery">${figure("actions/01-type-text.png")}</div>` +
						'<ul class="files"><li><a href="actions/02-trace.jsonl">actions/02-trace.jsonl</a></li></ul></section>',
					"<section><h3>shots</h3>" +
						`<div class="gallery">${figure("shots/1440-light-text-style-menu.webp")}${figure("shots/390-light-text-style-menu.png")}</div></section>`,
				].join("\n"),
		);
		// Uncropped images capped at the page width, a responsive grid at desktop width, readable captions.
		assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
		assert.match(
			html,
			/\.gallery\{display:grid;grid-template-columns:repeat\(auto-fill,minmax\(min\(360px,100%\),1fr\)\)/,
		);
		assert.match(html, /\.gallery img\{display:block;max-width:100%;height:auto;/);
		assert.match(html, /figcaption\{font-size:13px;/);
		assert.match(html, /td img\{[^}]*object-fit:cover/);
		assert.doesNotMatch(html.replace(/td img\{[^}]*\}/, ""), /object-fit/);
		assert.doesNotMatch(html, /\.hidden|\.cache|published\.json|href="index\.html"/);
		// Eight fixture files, probe.log and the index; dot-files and published.json are not uploaded.
		assert.equal(JSON.parse(r.out).files, 10);
		assert.equal(t.types["shots/1440-light-text-style-menu.webp"], "image/webp");
		assert.equal(t.types["photo.jpeg"], "image/jpeg");
	} finally {
		t.close();
	}
});

test("OPS-110 publish: names with <, & and quotes render escaped in headings, captions, href and src", async () => {
	const t = await setup(evidenceOnly);
	try {
		mkdirSync(join(t.evidence, 'q"&<d>'));
		writeFileSync(join(t.evidence, "a&b <x>.png"), "png");
		writeFileSync(join(t.evidence, 'q"&<d>/n&"<y>.gif'), "gif");
		writeFileSync(join(t.evidence, 'q"&<d>/l&<z>.txt'), "text\n");
		const r = await t.publish();
		assert.equal(r.code, 0, r.err);
		const html = readFileSync(join(t.evidence, "index.html"), "utf8");
		assert.ok(
			html.includes(
				'<figure><a href="a%26b%20%3Cx%3E.png" target="_blank" rel="noopener"><img src="a%26b%20%3Cx%3E.png" alt="a&amp;b &lt;x&gt;.png" loading="lazy" decoding="async"></a><figcaption>a&amp;b &lt;x&gt;.png</figcaption></figure>',
			),
		);
		assert.ok(html.includes("<h3>q&quot;&amp;&lt;d&gt;</h3>"));
		assert.ok(
			html.includes(
				'<img src="q%22%26%3Cd%3E/n%26%22%3Cy%3E.gif" alt="q&quot;&amp;&lt;d&gt;/n&amp;&quot;&lt;y&gt;.gif"',
			),
		);
		assert.ok(
			html.includes('<li><a href="q%22%26%3Cd%3E/l%26%3Cz%3E.txt">q&quot;&amp;&lt;d&gt;/l&amp;&lt;z&gt;.txt</a></li>'),
		);
		assert.doesNotMatch(html, /<x>|<y>|<z>|<d>/);
		assert.equal(t.types['q"&<d>/n&"<y>.gif'], "image/gif");
	} finally {
		t.close();
	}
});
