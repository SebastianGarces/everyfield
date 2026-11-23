import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { emailProblems, emailScoped } from "../../scripts/lint/test-emails.mjs";

const CHECK = fileURLToPath(new URL("../../scripts/lint/check-repo-files.mjs", import.meta.url));
const at = (local, domain) => [local, domain].join("@");
const GMAIL = at("someone", "gmail.com");
const found = (source) => emailProblems("tests/x.test.mts", source).map((line) => line.split(": ")[1].split(" ")[0]);

function repoWith(files) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "test-emails-")));
	const put = (path, text) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	};
	put("evf.toml", '[[policy.class]]\nname = "document-templates"\npaths = []\noutcome = "owner"\n');
	put("packages/domain/src/documents/templates/.keep", "");
	for (const [path, text] of Object.entries(files)) put(path, text);
	execFileSync("git", ["init", "-q"], { cwd: dir });
	const ran = spawnSync(process.execPath, [CHECK], {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, EVERYFIELD_ROOT: dir },
	});
	rmSync(dir, { recursive: true, force: true });
	return { status: ran.status, stderr: ran.stderr };
}

test("the repo check fails a real email address in an integration test and passes a reserved one", () => {
	const real = repoWith({ "tests/integration/access/x.test.mts": `const a = 1;\nconst who = "${GMAIL}";\n` });
	assert.equal(real.status, 1);
	assert.match(
		real.stderr,
		new RegExp(`tests/integration/access/x\\.test\\.mts:2: ${GMAIL.replaceAll(".", "\\.")} is a real address`),
	);
	const reserved = repoWith({ "tests/integration/access/x.test.mts": 'const who = "someone@example.test";\n' });
	assert.equal(reserved.status, 0, reserved.stderr);
});

test("reserved placeholder domains and Resend test addresses pass", () => {
	const source = [
		"a@example.com b@example.org c@example.net d@app.example.com",
		"e@harvest.example f@church.test g@EXAMPLE.TEST h@everyfield.invalid",
		"delivered+a@resend.dev bounced@Resend.dev x@sub.resend.dev",
	].join("\n");
	assert.deepEqual(found(source), []);
});

test("addresses on real domains fail, including mailto links and look-alike domains", () => {
	const real = [
		GMAIL,
		at("a", "b.co"),
		at("x", "notexample.com"),
		at("y", "example.com.evil.io"),
		at("z", "resend.dev.co"),
		at("news", "unverified-church.org"),
	];
	const source = [`"${real[0]}"`, `[mail](mailto:${real[1]})`, real.slice(2, 5).join(" "), real[5]].join("\n");
	assert.deepEqual(found(source), real);
	assert.deepEqual(
		emailProblems("tests/unit/a.test.mjs", `\n\nconst to = '${at("pat", "outlook.com")}';`).map(
			(p) => p.split(": ")[0],
		),
		["tests/unit/a.test.mjs:3"],
	);
});

test("connection-string credentials, package versions and IP hosts are not addresses", () => {
	const source = [
		"postgres://u:p@ep-gentle-dust-123456.us-east-1.aws.neon.tech/neondb",
		"https://user-r1:pass-r2@us.cloud.langfuse.com/?token=tok-r3",
		"postgres://ci:${password}@127.0.0.1:55432/everyfield_ci",
		"pnpm@10.34.6 from the corepack cache",
	].join("\n");
	assert.deepEqual(found(source), []);
});

test("the check covers the tests, tools tests and ops tests, minus the recorded eval cases", () => {
	for (const path of [
		"tests/integration/access/privileges.test.mts",
		"tests/unit/tasks/description.test.mjs",
		"tests/evry/evals/classify.test.mts",
		"tools/qa/tests/qa.test.ts",
		"ops/actionable-watch/test/provision.test.mts",
	])
		assert.equal(emailScoped(path), true, path);
	for (const path of [
		"tests/evry/evals/adapters.cases.json",
		"apps/web/src/server/mail/transport.ts",
		"tools/qa/qa.ts",
	])
		assert.equal(emailScoped(path), false, path);
});
