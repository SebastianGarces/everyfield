import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readWebhookConfig } from "../io.mts";
import { osascriptPrompt, promptScript, provision, PROMPT_GIVE_UP_S, type Field, type Prompt, type PromptResult } from "../provision.mts";

const here = new URL("..", import.meta.url).pathname;
const provisionMts = join(here, "provision.mts");
const URL_TOKEN = "SENTINELURLTOKEN7f3e";
const KEY = "SENTINELKEY4b2d";
const GOOD_URL = `https://routines.example/hooks/${URL_TOKEN}?t=${URL_TOKEN}`;
const SENTINELS = [URL_TOKEN, KEY, "routines.example"];

const tmp = () => mkdtemp(join(tmpdir(), "actionable-watch-provision-"));
const answers = (a: Partial<Record<Field, PromptResult>>): Prompt => async (f) => a[f] ?? { ok: false, reason: "prompt_failed" };
const value = (v: string): PromptResult => ({ ok: true, value: v });
const statusLine = async (dir: string) => (await readFile(join(dir, "provision.status"), "utf8")).trim();

/** Every byte the helper left anywhere except webhook.json itself. */
async function everythingButConfig(dir: string, extra: string[] = []): Promise<string> {
	let all = extra.join("\n");
	for (const f of await readdir(dir)) if (f !== "webhook.json") all += `\n${f}\n${await readFile(join(dir, f), "utf8")}`;
	return all;
}
const assertNoLeak = (text: string, where: string) => {
	for (const s of SENTINELS) assert.ok(!text.includes(s), `${where} leaks ${s}`);
};

describe("provision with an injected prompt", () => {
	test("valid input writes an owner-only webhook.json the transport's loader accepts", async () => {
		const dir = join(await tmp(), "state");
		const asked: Field[] = [];
		const r = await provision({
			stateDir: dir,
			prompt: async (f) => (asked.push(f), value(f === "url" ? `  ${GOOD_URL}\n` : `\t${KEY} `)),
		});
		assert.deepEqual(r, { state: "ok", code: "webhook_config_ok" });
		assert.deepEqual(asked, ["url", "key"], "URL first, then the key");
		const cfg = join(dir, "webhook.json");
		const st = await stat(cfg);
		assert.equal(st.mode & 0o777, 0o600);
		assert.equal(st.uid, process.getuid!());
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
		assert.deepEqual(JSON.parse(await readFile(cfg, "utf8")), { url: GOOD_URL, key: KEY }, "trimmed, exact");
		const read = await readWebhookConfig(cfg);
		assert.ok(read.ok);
		assert.equal(read.config.url.href, GOOD_URL);
		assert.match(await statusLine(dir), /^state=ok code=webhook_config_ok at=\d{4}-\d\d-\d\dT[\d:.]+Z$/);
		assert.equal((await stat(join(dir, "provision.status"))).mode & 0o777, 0o600);
		assert.deepEqual((await readdir(dir)).sort(), ["provision.status", "webhook.json"], "no temp file left behind");
	});

	test("an existing directory with a wider mode is tightened to 0700", async () => {
		const dir = await tmp();
		await chmod(dir, 0o755);
		await provision({ stateDir: dir, prompt: answers({ url: value(GOOD_URL), key: value(KEY) }) });
		assert.equal((await stat(dir)).mode & 0o777, 0o700);
	});

	const refusals: [string, Partial<Record<Field, PromptResult>>, string, string][] = [
		["cancel at the URL", { url: { ok: false, reason: "cancelled" } }, "cancelled", "cancelled"],
		["cancel at the key", { url: value(GOOD_URL), key: { ok: false, reason: "cancelled" } }, "cancelled", "cancelled"],
		["timeout", { url: value(GOOD_URL), key: { ok: false, reason: "timed_out" } }, "timed_out", "timed_out"],
		["prompt failure", { url: { ok: false, reason: "prompt_failed" } }, "invalid", "prompt_failed"],
		["invalid URL", { url: value(`not a url ${URL_TOKEN}`), key: value(KEY) }, "invalid", "webhook_config_invalid_url"],
		["non-https URL", { url: value(`http://routines.example/hooks/${URL_TOKEN}`), key: value(KEY) }, "invalid", "webhook_url_not_https"],
		["key with a space", { url: value(GOOD_URL), key: value(`${KEY} more`) }, "invalid", "webhook_config_invalid"],
		["empty key", { url: value(GOOD_URL), key: value("   ") }, "invalid", "webhook_config_invalid"],
	];
	for (const [name, a, state, code] of refusals) {
		test(`${name} writes nothing, keeps an existing config and reports ${code}`, async () => {
			const fresh = await tmp();
			assert.deepEqual(await provision({ stateDir: fresh, prompt: answers(a) }), { state, code });
			assert.deepEqual(await readdir(fresh), ["provision.status"], "no webhook.json written");
			assert.match(await statusLine(fresh), new RegExp(`^state=${state} code=${code} at=`));

			const kept = await tmp();
			const old = JSON.stringify({ url: "https://old.example/x", key: "OLDKEY" });
			await writeFile(join(kept, "webhook.json"), old, { mode: 0o600 });
			const before = await stat(join(kept, "webhook.json"));
			await provision({ stateDir: kept, prompt: answers(a) });
			const after = await stat(join(kept, "webhook.json"));
			assert.equal(await readFile(join(kept, "webhook.json"), "utf8"), old);
			assert.equal(after.ino, before.ino, "the same file, not a rewrite");
			assert.equal(after.mtimeMs, before.mtimeMs);
		});
	}

	test("replacing an existing config goes through the same 0600 temp-and-rename path", async () => {
		const dir = await tmp();
		await writeFile(join(dir, "webhook.json"), JSON.stringify({ url: "https://old.example/x", key: "OLDKEY" }), { mode: 0o600 });
		const before = await stat(join(dir, "webhook.json"));
		assert.equal((await provision({ stateDir: dir, prompt: answers({ url: value(GOOD_URL), key: value(KEY) }) })).state, "ok");
		const after = await stat(join(dir, "webhook.json"));
		assert.notEqual(after.ino, before.ino, "renamed into place, not edited in place");
		assert.equal(after.mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(await readFile(join(dir, "webhook.json"), "utf8")), { url: GOOD_URL, key: KEY });
		assert.deepEqual((await readdir(dir)).sort(), ["provision.status", "webhook.json"]);
	});

	test("sentinel values appear nowhere but webhook.json, on success and on every failure path", async () => {
		const paths: Partial<Record<Field, PromptResult>>[] = [
			{ url: value(GOOD_URL), key: value(KEY) },
			...refusals.map(([, a]) => a),
			{ url: value(`https://routines.example/${URL_TOKEN} ${KEY}`), key: value(KEY) },
			{ url: value(`${GOOD_URL}%%%`), key: value(`${KEY}\n${URL_TOKEN}`) },
		];
		for (const a of paths) {
			const dir = await tmp();
			const r = await provision({ stateDir: dir, prompt: answers(a) });
			assertNoLeak(await everythingButConfig(dir, [JSON.stringify(r)]), `result ${r.code}`);
		}
	});
});

describe("the real prompt", () => {
	test("is a hidden-input dialog built from fixed text only", () => {
		for (const f of ["url", "key"] as const) {
			const s = promptScript(f);
			assert.match(s, /display dialog "[^"]/);
			assert.match(s, /default answer "" with hidden answer/);
			assert.match(s, /buttons \{"Cancel", "Save"\}.*cancel button "Cancel"/);
			assert.match(s, new RegExp(`giving up after ${PROMPT_GIVE_UP_S}$`, "m"));
			assert.equal(promptScript(f), s, "deterministic: nothing variable goes in");
		}
		assert.ok(PROMPT_GIVE_UP_S > 0 && PROMPT_GIVE_UP_S <= 30 * 60);
		assert.match(promptScript("url"), /\\"POST to\\" URL/);
		assert.match(promptScript("key"), /sender key/);
	});

	test("maps osascript's answer and exit to a result", async () => {
		const dir = await tmp();
		const cases: [string, PromptResult][] = [
			["printf 'C\\n'", { ok: false, reason: "cancelled" }],
			["printf 'T\\n'", { ok: false, reason: "timed_out" }],
			["printf 'Vabc def\\n'", { ok: true, value: "abc def" }],
			["printf 'V\\n'", { ok: true, value: "" }],
			["printf 'junk\\n'", { ok: false, reason: "prompt_failed" }],
			["echo boom >&2; exit 1", { ok: false, reason: "prompt_failed" }],
		];
		for (const [body, want] of cases) {
			const bin = join(dir, `osa-${cases.findIndex((c) => c[0] === body)}`);
			await writeFile(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
			assert.deepEqual(await osascriptPrompt(bin)("url"), want, body);
		}
		assert.deepEqual(await osascriptPrompt(join(dir, "missing"))("key"), { ok: false, reason: "prompt_failed" });
	});

	test("the helper reads no clipboard, keychain, environment or other secret source", async () => {
		// Code only: comments may name what the helper does not do.
		const src = (await readFile(provisionMts, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
		for (const banned of [/pbpaste/, /NSPasteboard/, /clipboard/i, /\bsecurity\b/, /keychain/i, /process\.argv/, /console\./, /node:https?"/, /node:net/, /fetch\(/, /readFile\(/]) {
			assert.doesNotMatch(src, banned, String(banned));
		}
		assert.equal(src.match(/process\.env/g)?.length, 1, "only HOME is passed on, to the detached child");
		assert.match(src, /env: \{ HOME: process\.env\.HOME \?\? "", PATH: "\/usr\/bin:\/bin" \}/);
		assert.equal(src.match(/execFile\(/g)?.length, 1, "one prompt spawn site");
		assert.equal(src.match(/spawn\(/g)?.length, 1, "one detach spawn site");
		assert.match(src, /spawn\(process\.execPath, \[import\.meta\.filename, "--state-dir", stateDir, "--osascript", values\.osascript\]/);
		assert.match(src, /\["-e", promptScript\(field\)\]/, "osascript gets only the fixed script");
	});
});

/** A stand-in for osascript: it records its argv, env and its parent's argv, then answers from files. */
async function fakeOsascript(dir: string, url: string, key: string): Promise<string> {
	await writeFile(join(dir, "url.in"), url);
	await writeFile(join(dir, "key.in"), key);
	const bin = join(dir, "osascript");
	await writeFile(
		bin,
		`#!/bin/sh
D='${dir}'
{ printf 'argv:'; printf ' %s' "$@"; printf '\\nparent:'; ps -o args= -p $PPID; printf 'env:'; env; } >> "$D/seen.out"
i=0; while [ ! -f "$D/go" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done
case "$2" in *"1 of 2"*) f=url.in ;; *) f=key.in ;; esac
printf 'V'; cat "$D/$f"; printf '\\n'
`,
		{ mode: 0o755 },
	);
	return bin;
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [provisionMts, ...args], (err, stdout, stderr) =>
			resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
		);
	});
}

async function until(check: () => Promise<boolean>, ms = 10_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 50));
	}
	assert.fail("timed out waiting");
}

describe("the provision CLI", () => {
	test("reports only a code and leaks no value through any argv, env, output or file", async () => {
		const work = await tmp();
		const state = join(work, "state");
		const bin = await fakeOsascript(work, ` ${GOOD_URL} `, KEY);
		await writeFile(join(work, "go"), "");
		const ok = await cli(["--state-dir", state, "--osascript", bin]);
		assert.deepEqual(ok, { code: 0, stdout: "webhook_config ok\n", stderr: "" });
		assert.deepEqual(JSON.parse(await readFile(join(state, "webhook.json"), "utf8")), { url: GOOD_URL, key: KEY });
		const seen = await readFile(join(work, "seen.out"), "utf8");
		assert.equal(seen.match(/^argv: -e try/gm)?.length, 2, "two prompts, each given only the fixed script");
		assert.match(seen, /with hidden answer/);
		assertNoLeak(seen, "a child's argv or env, or the helper's own argv");
		assertNoLeak(ok.stdout + ok.stderr + (await everythingButConfig(state)), "output or state dir");

		await writeFile(join(work, "url.in"), `http://routines.example/${URL_TOKEN}`);
		const bad = await cli(["--state-dir", state, "--osascript", bin]);
		assert.deepEqual(bad, { code: 1, stdout: "webhook_url_not_https\n", stderr: "" });
		assert.deepEqual(JSON.parse(await readFile(join(state, "webhook.json"), "utf8")), { url: GOOD_URL, key: KEY }, "the good config stays");
		assertNoLeak(bad.stdout + (await everythingButConfig(state)), "failure output");
	});

	test("--detach prints only its pid and status path, shows waiting, and outlives the launcher", async () => {
		const work = await tmp();
		const state = join(work, "state");
		const bin = await fakeOsascript(work, GOOD_URL, KEY);
		const launched = await cli(["--detach", "--state-dir", state, "--osascript", bin]);
		assert.equal(launched.code, 0);
		assert.equal(launched.stderr, "");
		const m = launched.stdout.match(/^pid=(\d+) status=(.+)\n$/);
		assert.ok(m, launched.stdout);
		assert.equal(m[2], join(state, "provision.status"));
		// The launcher has exited; the detached helper is still alive and waiting on the prompt.
		await until(async () => (await readFile(join(work, "seen.out"), "utf8").catch(() => "")).includes("argv:"));
		assert.match(await statusLine(state), /^state=waiting code=none at=/);
		process.kill(Number(m[1]), 0);
		await writeFile(join(work, "go"), "");
		await until(async () => (await statusLine(state)).startsWith("state=ok"));
		assert.match(await statusLine(state), /^state=ok code=webhook_config_ok at=/);
		const seen = await readFile(join(work, "seen.out"), "utf8");
		assert.match(seen, /parent:.*provision\.mts --state-dir .* --osascript /);
		assertNoLeak(seen + launched.stdout + (await everythingButConfig(state)), "detached run");
	});
});
