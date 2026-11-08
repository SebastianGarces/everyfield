import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	acquireLock, COMMANDS, createLog, createTransport, deliver, runAllowed, saveState, WEBHOOK_CONTRACT_NEEDED,
	type Transport,
} from "../io.mts";

const here = new URL("..", import.meta.url).pathname;
const tmp = () => mkdtemp(join(tmpdir(), "actionable-watch-"));

async function fake(dir: string, body: string, mode = 0o755) {
	const path = join(dir, "fake");
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, mode);
	return path;
}

describe("command allowlist", () => {
	test("only evf status --json and gh run list on main are allowed", () => {
		assert.deepEqual(Object.keys(COMMANDS), ["evf-status", "gh-main-ci"]);
		assert.match(COMMANDS["evf-status"].bin, /\/\.cargo\/bin\/evf$/);
		assert.deepEqual(COMMANDS["evf-status"].args, ["status", "--json"]);
		assert.equal(COMMANDS["gh-main-ci"].bin, "/opt/homebrew/bin/gh");
		assert.deepEqual(COMMANDS["gh-main-ci"].args.slice(0, 2), ["run", "list"]);
		assert.ok(COMMANDS["gh-main-ci"].args.includes("main"));
	});

	test("an unlisted command name is refused", async () => {
		assert.deepEqual(await runAllowed("evf-decide" as never), { ok: false, code: "command_not_allowed" });
	});

	test("no source spawns, fetches or reads anything outside io.mts", async () => {
		const sources = (await readdir(here)).filter((f) => f.endsWith(".mts"));
		for (const f of sources) {
			const text = await readFile(join(here, f), "utf8");
			if (f !== "io.mts") assert.doesNotMatch(text, /child_process|node:fs|node:http|node:net|fetch\(/, f);
			assert.doesNotMatch(text, /fetch\(|node:https?|node:net|XMLHttpRequest/, `${f} makes no network call`);
		}
		const io = await readFile(join(here, "io.mts"), "utf8");
		assert.equal(io.match(/execFile\(/g)?.length, 1, "one spawn site");
		assert.match(io, /\[\.\.\.command\.args\]/, "args come only from COMMANDS");
		assert.doesNotMatch(io, /https?:\/\//, "no hard-coded endpoint");
	});
});

describe("command failures are classified, never thrown", () => {
	test("missing, not executable, non-zero, timeout and success", async () => {
		const dir = await tmp();
		assert.deepEqual(await runAllowed("evf-status", { bin: join(dir, "nope"), cwd: dir }), { ok: false, code: "evf_missing" });
		assert.deepEqual(await runAllowed("evf-status", { bin: await fake(dir, "echo {}", 0o644), cwd: dir }), { ok: false, code: "evf_not_executable" });
		assert.deepEqual(await runAllowed("evf-status", { bin: await fake(dir, "echo secret-detail >&2; exit 3"), cwd: dir }), { ok: false, code: "evf_exit_3" });
		const start = Date.now();
		assert.deepEqual(await runAllowed("gh-main-ci", { bin: await fake(dir, "sleep 30"), cwd: dir, timeoutMs: 300 }), { ok: false, code: "gh_timeout" });
		assert.ok(Date.now() - start < 5000);
		assert.deepEqual(await runAllowed("evf-status", { bin: await fake(dir, 'echo "$1 $2"'), cwd: dir }), { ok: true, stdout: "status --json\n" });
	});

	test("the timeout cannot be raised past 20 s", async () => {
		const io = await readFile(join(here, "io.mts"), "utf8");
		assert.match(io, /COMMAND_TIMEOUT_MS = 20_000/);
		assert.match(io, /Math\.min\(opts\.timeoutMs \?\? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS\)/);
	});
});

describe("files", () => {
	test("state is written atomically and privately", async () => {
		const dir = await tmp();
		const path = join(dir, "s", "state.json");
		const state = { version: 1 as const, snapshot: {} as never, sent: ["a"], pending: [] };
		await saveState(path, state);
		await saveState(path, { ...state, sent: ["b"] });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")).sent, ["b"]);
		assert.deepEqual(await readdir(join(dir, "s")), ["state.json"], "no temp file left");
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	});

	test("one instance: a live lock blocks, a stale or dead one is taken over", async () => {
		const dir = await tmp();
		const path = join(dir, "watch.lock");
		const first = await acquireLock(path, 1000);
		assert.ok(first);
		assert.equal(await acquireLock(path, 2000), null, "second concurrent run is refused");
		await first.release();
		const again = await acquireLock(path, 3000);
		assert.ok(again);
		await again.release();

		await writeFile(path, "999999 1000\n"); // dead pid
		const overDead = await acquireLock(path, 2000);
		assert.ok(overDead);
		await overDead.release();
		await writeFile(path, `${process.pid} 0\n`); // live pid, far too old
		const overStale = await acquireLock(path, 11 * 60_000);
		assert.ok(overStale);
		await overStale.release();
	});

	test("the log rolls past its cap", async () => {
		const dir = await tmp();
		const log = createLog(join(dir, "watch.log"), () => 0, 100);
		for (let i = 0; i < 20; i++) await log(`line ${i} ${"x".repeat(20)}`);
		assert.ok((await stat(join(dir, "watch.log"))).size <= 100 + 60);
		assert.ok((await stat(join(dir, "watch.log.1"))).size <= 100 + 60);
		assert.deepEqual((await readdir(dir)).sort(), ["watch.log", "watch.log.1"]);
	});
});

describe("transport", () => {
	const payload = { source: "s", version: 1, at: "t", events: [{ kind: "tick-error", key: "tick-error" }] };

	test("webhook mode refuses and names the missing contract", () => {
		const t = createTransport("webhook", async () => {});
		assert.deepEqual(t, { ok: false, code: WEBHOOK_CONTRACT_NEEDED });
		assert.match(WEBHOOK_CONTRACT_NEEDED, /URL shape.*auth header name.*payload schema/);
		assert.deepEqual(createTransport("http", async () => {}), { ok: false, code: "transport_unknown" });
	});

	test("dry-run logs the payload and counts as delivered", async () => {
		const lines: string[] = [];
		const t = createTransport("dry-run", async (l) => void lines.push(l));
		assert.ok(t.ok);
		assert.deepEqual(await deliver(t.transport, payload), { ok: true, tries: 1 });
		assert.deepEqual(lines, [`dry-run wake payload=${JSON.stringify(payload)}`]);
	});

	test("retries stop at 3 with exponential backoff", async () => {
		const sleeps: number[] = [];
		let calls = 0;
		const failing: Transport = {
			mode: "webhook",
			send: async () => {
				calls++;
				throw new Error("down");
			},
		};
		assert.deepEqual(await deliver(failing, payload, { sleep: async (ms) => void sleeps.push(ms) }), { ok: false, tries: 3 });
		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [1000, 2000]);
	});

	test("a hung send times out per try", async () => {
		let aborted = 0;
		const hung: Transport = {
			mode: "webhook",
			send: (_p, signal) => new Promise(() => signal.addEventListener("abort", () => aborted++)),
		};
		assert.deepEqual(await deliver(hung, payload, { sleep: async () => {}, timeoutMs: 20 }), { ok: false, tries: 3 });
		assert.equal(aborted, 3);
	});
});

describe("install docs", () => {
	test("README rollback, plist and code agree on label and paths", async () => {
		const { LOG_DIR, STATE_DIR } = await import("../io.mts");
		const readme = await readFile(join(here, "README.md"), "utf8");
		const plist = await readFile(join(here, "com.everyfield.actionable-watch.plist"), "utf8");
		const label = "com.everyfield.actionable-watch";
		assert.match(plist, new RegExp(`<key>Label</key>\\s*<string>${label}</string>`));
		assert.match(plist, /<key>StartInterval<\/key>\s*<integer>90<\/integer>/);
		assert.ok(readme.includes(`launchctl bootout gui/$UID/${label}`));
		assert.ok(readme.includes(`rm -f "$HOME/Library/LaunchAgents/${label}.plist"`));
		for (const dir of [STATE_DIR, LOG_DIR]) {
			const rel = dir.replace(/^.*?\/Library\//, "Library/");
			assert.ok(readme.includes(`rm -rf "$HOME/${rel}"`), `README removes ${rel}`);
			assert.ok(plist.includes(`__HOME__/${rel}`), `plist uses ${rel}`);
		}
	});
});
