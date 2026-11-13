import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	acquireLock,
	classifySendError,
	COMMANDS,
	createLog,
	createTransport,
	deliver,
	readWebhookConfig,
	runAllowed,
	saveState,
	WEBHOOK_SENDS_PER_HOUR,
	webhookRequest,
	type SendResult,
	type Transport,
} from "../io.mts";
import { fakeRoutine, writeConfig } from "./fake-routine.mts";

const here = new URL("..", import.meta.url).pathname;
const tmp = () => mkdtemp(join(tmpdir(), "actionable-watch-"));

async function fake(dir: string, body: string, mode = 0o755) {
	const path = join(dir, "fake");
	await writeFile(path, `#!/bin/sh\n${body}\n`);
	await chmod(path, mode);
	return path;
}

describe("INV-watch-io: command allowlist", () => {
	test("INV-watch-io: only evf status --json and gh run list on main are allowed", () => {
		assert.deepEqual(Object.keys(COMMANDS), ["evf-status", "gh-main-ci"]);
		assert.match(COMMANDS["evf-status"].bin, /\/\.cargo\/bin\/evf$/);
		assert.deepEqual(COMMANDS["evf-status"].args, ["status", "--json"]);
		assert.equal(COMMANDS["gh-main-ci"].bin, "/opt/homebrew/bin/gh");
		// D-588: main's push runs and its nightly schedule runs; --branch main alone keeps PR runs out.
		assert.deepEqual(COMMANDS["gh-main-ci"].args, [
			"run",
			"list",
			"--repo",
			"SebastianGarces/everyfield",
			"--branch",
			"main",
			"--workflow",
			"CI",
			"--limit",
			"10",
			"--json",
			"headSha,status,conclusion,createdAt",
		]);
	});

	test("INV-watch-io: an unlisted command name is refused", async () => {
		assert.deepEqual(await runAllowed("evf-decide" as never), { ok: false, code: "command_not_allowed" });
	});

	test("INV-watch-io: no source spawns, fetches or reads anything outside io.mts (provision.mts has its own test)", async () => {
		const sources = (await readdir(here)).filter((f) => f.endsWith(".mts"));
		for (const f of sources) {
			const text = await readFile(join(here, f), "utf8");
			if (f !== "io.mts" && f !== "provision.mts")
				assert.doesNotMatch(text, /child_process|node:fs|node:http|node:net|fetch\(/, f);
			assert.doesNotMatch(text, /fetch\(|node:http"|node:net|XMLHttpRequest/, `${f} makes no other network call`);
			if (f !== "io.mts") assert.doesNotMatch(text, /node:https/, `${f} makes no network call`);
		}
		const io = await readFile(join(here, "io.mts"), "utf8");
		assert.equal(io.match(/execFile\(/g)?.length, 1, "one spawn site");
		assert.equal(io.match(/httpsRequest\(/g)?.length, 1, "one request site, the webhook POST");
		assert.match(io, /\[\.\.\.command\.args\]/, "args come only from COMMANDS");
		assert.doesNotMatch(io, /https?:\/\//, "no hard-coded endpoint");
	});
});

describe("INV-watch-io: command failures are classified, never thrown", () => {
	test("INV-watch-io: missing, not executable, non-zero, timeout and success", async () => {
		const dir = await tmp();
		assert.deepEqual(await runAllowed("evf-status", { bin: join(dir, "nope"), cwd: dir }), {
			ok: false,
			code: "evf_missing",
		});
		assert.deepEqual(await runAllowed("evf-status", { bin: await fake(dir, "echo {}", 0o644), cwd: dir }), {
			ok: false,
			code: "evf_not_executable",
		});
		assert.deepEqual(
			await runAllowed("evf-status", { bin: await fake(dir, "echo secret-detail >&2; exit 3"), cwd: dir }),
			{ ok: false, code: "evf_exit_3" },
		);
		const start = Date.now();
		assert.deepEqual(await runAllowed("gh-main-ci", { bin: await fake(dir, "sleep 30"), cwd: dir, timeoutMs: 300 }), {
			ok: false,
			code: "gh_timeout",
		});
		assert.ok(Date.now() - start < 5000);
		assert.deepEqual(await runAllowed("evf-status", { bin: await fake(dir, 'echo "$1 $2"'), cwd: dir }), {
			ok: true,
			stdout: "status --json\n",
		});
	});

	test("INV-watch-io: the timeout cannot be raised past 20 s", async () => {
		const io = await readFile(join(here, "io.mts"), "utf8");
		assert.match(io, /COMMAND_TIMEOUT_MS = 20_000/);
		assert.match(io, /Math\.min\(opts\.timeoutMs \?\? COMMAND_TIMEOUT_MS, COMMAND_TIMEOUT_MS\)/);
	});
});

describe("INV-watch-io: files", () => {
	test("INV-watch-io: state is written atomically and privately", async () => {
		const dir = await tmp();
		const path = join(dir, "s", "state.json");
		const state = { version: 1 as const, snapshot: {} as never, sent: ["a"], pending: [], sends: [] };
		await saveState(path, state);
		await saveState(path, { ...state, sent: ["b"] });
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")).sent, ["b"]);
		assert.deepEqual(await readdir(join(dir, "s")), ["state.json"], "no temp file left");
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	});

	test("INV-watch-io: one instance: a live lock blocks, a stale or dead one is taken over", async () => {
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

	test("INV-watch-io: the log rolls past its cap", async () => {
		const dir = await tmp();
		const log = createLog(join(dir, "watch.log"), () => 0, 100);
		for (let i = 0; i < 20; i++) await log(`line ${i} ${"x".repeat(20)}`);
		assert.ok((await stat(join(dir, "watch.log"))).size <= 100 + 60);
		assert.ok((await stat(join(dir, "watch.log.1"))).size <= 100 + 60);
		assert.deepEqual((await readdir(dir)).sort(), ["watch.log", "watch.log.1"]);
	});
});

describe("INV-watch-io: transport", () => {
	const payload = { source: "s", version: 1, at: "t", events: [{ kind: "tick-error", key: "tick-error" }] };
	const fail = (result: string, retry: boolean): SendResult => ({ ok: false, result, retry });

	test("INV-watch-io: unknown modes are refused", () => {
		assert.deepEqual(
			createTransport("http", async () => {}),
			{ ok: false, code: "transport_unknown" },
		);
	});

	test("INV-watch-io: dry-run logs the payload and counts as delivered", async () => {
		const lines: string[] = [];
		const t = createTransport("dry-run", async (l) => void lines.push(l));
		assert.ok(t.ok);
		assert.deepEqual(await deliver(t.transport, payload), {
			ok: true,
			tries: 1,
			result: "logged",
			capped: false,
			sends: [],
		});
		assert.deepEqual(lines, [`dry-run wake payload=${JSON.stringify(payload)}`]);
	});

	test("INV-watch-io: only retryable results try again, up to 3 with exponential backoff", async () => {
		for (const [result, retry, tries] of [
			["connect_error", true, 3],
			["dns_error", true, 3],
			["http_503", true, 3],
			["http_429", false, 1],
			["http_401", false, 1],
			["timeout", false, 1],
			["network_error", false, 1],
		] as const) {
			const sleeps: number[] = [];
			let calls = 0;
			const t: Transport = { mode: "webhook", capped: false, send: async () => (calls++, fail(result, retry)) };
			const d = await deliver(t, payload, { sleep: async (ms) => void sleeps.push(ms) });
			assert.deepEqual({ ok: d.ok, tries: d.tries, result: d.result }, { ok: false, tries, result }, result);
			assert.equal(calls, tries, result);
			assert.deepEqual(sleeps, tries === 3 ? [1000, 2000] : [], result);
		}
	});

	test("INV-watch-io: a hung send times out once and is not retried in the poll", async () => {
		let aborted = 0;
		const hung: Transport = {
			mode: "webhook",
			capped: false,
			send: (_p, signal) => new Promise(() => signal.addEventListener("abort", () => aborted++)),
		};
		const d = await deliver(hung, payload, { sleep: async () => {}, timeoutMs: 20 });
		assert.deepEqual({ ok: d.ok, tries: d.tries, result: d.result }, { ok: false, tries: 1, result: "timeout" });
		assert.equal(aborted, 1);
	});

	test("INV-watch-io: the hourly cap counts every POST and stops before sending", async () => {
		const now = 10 * 3_600_000;
		let calls = 0;
		const t: Transport = { mode: "webhook", capped: true, send: async () => (calls++, fail("http_500", true)) };
		const old = Array.from({ length: 30 }, (_, i) => now - 3_600_000 - i); // outside the rolling hour
		const recent = Array.from({ length: WEBHOOK_SENDS_PER_HOUR - 1 }, (_, i) => now - 1000 - i);
		const d = await deliver(t, payload, { sleep: async () => {}, cap: { sends: [...old, ...recent], now: () => now } });
		assert.equal(calls, 1, "one POST fits under the cap, the retry does not");
		assert.deepEqual(
			{ ok: d.ok, capped: d.capped, result: d.result, n: d.sends.length },
			{ ok: false, capped: true, result: "capped", n: WEBHOOK_SENDS_PER_HOUR },
		);
	});
});

describe("INV-watch-io: webhook config", () => {
	const good = { url: "https://example.invalid/hook", key: "k" };

	test("INV-watch-io: a private, owned, valid config is read", async () => {
		const path = await writeConfig(await tmp(), good);
		const r = await readWebhookConfig(path);
		assert.ok(r.ok);
		assert.equal(r.config.url.href, good.url);
	});

	test("INV-watch-io: each refusal has its own code", async () => {
		const dir = await tmp();
		const cases: [string, string][] = [
			[join(dir, "absent.json"), "webhook_config_missing"],
			[await writeConfig(await tmp(), good, 0o000), "webhook_config_unreadable"],
			[await writeConfig(await tmp(), good, 0o640), "webhook_config_mode"],
			[await writeConfig(await tmp(), good, 0o604), "webhook_config_mode"],
			[await writeConfig(await tmp(), "{not json"), "webhook_config_invalid_json"],
			[await writeConfig(await tmp(), { url: good.url }), "webhook_config_invalid"],
			[await writeConfig(await tmp(), { ...good, key: "two words" }), "webhook_config_invalid"],
			[await writeConfig(await tmp(), { ...good, url: "not a url" }), "webhook_config_invalid_url"],
			[await writeConfig(await tmp(), { ...good, url: "http://example.invalid/hook" }), "webhook_url_not_https"],
			[dir, "webhook_config_unreadable"],
		];
		const link = join(await tmp(), "link.json");
		await symlink(await writeConfig(await tmp(), good), link);
		cases.push([link, "webhook_config_unreadable"]);
		// A file owned by someone else: root's /etc/hosts. Running as root makes it ours, so skip then.
		if (process.getuid?.() !== 0) cases.push(["/etc/hosts", "webhook_config_not_owner"]);
		for (const [path, code] of cases) assert.deepEqual(await readWebhookConfig(path), { ok: false, code }, code);
	});

	test("INV-watch-io: a refused config sends nothing", async () => {
		const routine = await fakeRoutine();
		try {
			for (const [config, mode] of [
				[{ url: `${routine.origin}/hook`, key: "k" }, 0o644],
				[{ url: `${routine.origin.replace("https:", "http:")}/hook`, key: "k" }, 0o600],
				["{", 0o600],
			] as const) {
				const path = await writeConfig(await tmp(), config, mode);
				const t = createTransport("webhook", async () => {}, { configPath: path, ca: routine.ca });
				assert.ok(t.ok);
				const d = await deliver(t.transport, wakePayload(), { sleep: async () => {} });
				assert.equal(d.ok, false);
				assert.equal(d.tries, 1, "a refusal is not retried");
			}
			assert.equal(routine.seen.length, 0);
		} finally {
			await routine.close();
		}
	});

	test("INV-watch-io: the config is read at send time, not at start", async () => {
		const dir = await tmp();
		const routine = await fakeRoutine([200]);
		try {
			const t = createTransport("webhook", async () => {}, { configPath: join(dir, "webhook.json"), ca: routine.ca });
			assert.ok(t.ok, "a missing config does not stop the transport from being built");
			assert.equal((await deliver(t.transport, wakePayload())).result, "webhook_config_missing");
			await writeConfig(dir, { url: `${routine.origin}/hook`, key: "k" });
			assert.equal((await deliver(t.transport, wakePayload())).result, "http_200");
		} finally {
			await routine.close();
		}
	});
});

const wakePayload = () => ({
	source: "everyfield-actionable-watch",
	version: 1,
	at: "2026-11-08T00:00:00.000Z",
	events: [{ kind: "tick-error", key: "tick-error" }],
});

describe("INV-watch-io: webhook send", () => {
	test("INV-watch-io: the request builder sets exactly the two headers and the payload body", () => {
		const r = webhookRequest({ url: new URL("https://example.invalid/p"), key: "abc" }, wakePayload());
		assert.deepEqual(r, {
			url: new URL("https://example.invalid/p"),
			method: "POST",
			headers: { Authorization: "Bearer abc", "Content-Type": "application/json" },
			body: JSON.stringify(wakePayload()),
		});
	});

	test("INV-watch-io: one POST to the configured URL with exactly those headers; only 200 delivers", async () => {
		const routine = await fakeRoutine([200]);
		try {
			const path = await writeConfig(await tmp(), {
				url: `${routine.origin}/routines/abc/trigger?x=1`,
				key: "the-key",
			});
			const t = createTransport("webhook", async () => {}, { configPath: path, ca: routine.ca });
			assert.ok(t.ok);
			const d = await deliver(t.transport, wakePayload());
			assert.deepEqual({ ok: d.ok, tries: d.tries, result: d.result }, { ok: true, tries: 1, result: "http_200" });
			assert.equal(routine.seen.length, 1);
			const req = routine.seen[0]!;
			assert.equal(req.method, "POST");
			assert.equal(req.path, "/routines/abc/trigger?x=1");
			assert.equal(req.headers.authorization, "Bearer the-key");
			assert.equal(req.headers["content-type"], "application/json");
			// Node adds only the protocol headers; the watcher adds nothing else (no user agent, no cookies).
			assert.deepEqual(Object.keys(req.headers).sort(), [
				"authorization",
				"connection",
				"content-length",
				"content-type",
				"host",
			]);
			assert.deepEqual(JSON.parse(req.body), wakePayload());

			for (const [status, tries] of [
				[201, 1],
				[202, 1],
				[204, 1],
				[302, 1],
				[400, 1],
				[401, 1],
				[404, 1],
				[429, 1],
				[500, 3],
				[503, 3],
			] as const) {
				routine.seen.length = 0;
				routine.replies = [status];
				const r = await deliver(t.transport, wakePayload(), { sleep: async () => {} });
				assert.deepEqual(
					{ ok: r.ok, tries: r.tries, result: r.result },
					{ ok: false, tries, result: `http_${status}` },
					String(status),
				);
				assert.equal(routine.seen.length, tries, `${status} reached the server ${tries} times`);
			}
		} finally {
			await routine.close();
		}
	});

	test("INV-watch-io: a timeout and a dropped connection are not delivered and not retried", async () => {
		const routine = await fakeRoutine(["hang"]);
		try {
			const path = await writeConfig(await tmp(), { url: `${routine.origin}/hook`, key: "k" });
			const t = createTransport("webhook", async () => {}, { configPath: path, ca: routine.ca });
			assert.ok(t.ok);
			const hung = await deliver(t.transport, wakePayload(), { sleep: async () => {}, timeoutMs: 300 });
			assert.deepEqual(
				{ ok: hung.ok, tries: hung.tries, result: hung.result },
				{ ok: false, tries: 1, result: "timeout" },
			);
			routine.replies = ["reset"];
			routine.seen.length = 0;
			const reset = await deliver(t.transport, wakePayload(), { sleep: async () => {} });
			assert.deepEqual(
				{ ok: reset.ok, tries: reset.tries, result: reset.result },
				{ ok: false, tries: 1, result: "network_error" },
			);
			assert.equal(routine.seen.length, 1);
		} finally {
			await routine.close();
		}
	});

	test("INV-watch-io: a connect error is retried in the poll; a bad certificate is not", async () => {
		const routine = await fakeRoutine([200]);
		const origin = routine.origin;
		await routine.close(); // nothing listens on that port now
		const path = await writeConfig(await tmp(), { url: `${origin}/hook`, key: "k" });
		const t = createTransport("webhook", async () => {}, { configPath: path });
		assert.ok(t.ok);
		const refused = await deliver(t.transport, wakePayload(), { sleep: async () => {} });
		assert.deepEqual(
			{ ok: refused.ok, tries: refused.tries, result: refused.result },
			{ ok: false, tries: 3, result: "connect_error" },
		);

		const live = await fakeRoutine([200]);
		try {
			const untrusted = createTransport("webhook", async () => {}, {
				configPath: await writeConfig(await tmp(), { url: `${live.origin}/hook`, key: "k" }),
			});
			assert.ok(untrusted.ok);
			const tls = await deliver(untrusted.transport, wakePayload(), { sleep: async () => {} });
			assert.deepEqual(
				{ ok: tls.ok, tries: tls.tries, result: tls.result },
				{ ok: false, tries: 1, result: "tls_error" },
			);
			assert.equal(live.seen.length, 0);
		} finally {
			await live.close();
		}
	});

	test("INV-watch-io: errors are classed by code only", () => {
		const err = (code: string) => Object.assign(new Error(`getaddrinfo ${code} secret-host.example`), { code });
		assert.deepEqual(classifySendError(err("ENOTFOUND")), { ok: false, result: "dns_error", retry: true });
		assert.deepEqual(classifySendError(err("EAI_AGAIN")), { ok: false, result: "dns_error", retry: true });
		assert.deepEqual(classifySendError(err("ECONNREFUSED")), { ok: false, result: "connect_error", retry: true });
		assert.deepEqual(classifySendError(err("ECONNRESET")), { ok: false, result: "network_error", retry: false });
		assert.deepEqual(classifySendError(err("DEPTH_ZERO_SELF_SIGNED_CERT")), {
			ok: false,
			result: "tls_error",
			retry: false,
		});
		assert.deepEqual(classifySendError(err("ABORT_ERR")), { ok: false, result: "timeout", retry: false });
	});
});

/** The README's `plutil` lines that switch ProgramArguments.3: to webhook, then back to dry-run. */
const readmeSwitches = (readme: string) =>
	readme
		.split("\n")
		.filter((l) => /^\s*plutil -remove ProgramArguments\.3 /.test(l))
		.map((l) => l.trim());

describe("INV-watch-io: install docs", () => {
	test("INV-watch-io: README rollback, plist and code agree on label and paths", async () => {
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

	test("INV-watch-io: README hookup steps match the plist, the flags and the config path", async () => {
		const { WEBHOOK_CONFIG } = await import("../io.mts");
		const readme = await readFile(join(here, "README.md"), "utf8");
		const plist = await readFile(join(here, "com.everyfield.actionable-watch.plist"), "utf8");
		const run = await readFile(join(here, "run.mts"), "utf8");
		const args = [
			...plist
				.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)![1]!
				.matchAll(/<string>(.*?)<\/string>/g),
		].map((m) => m[1]);
		assert.deepEqual(args.slice(2), ["--transport", "dry-run"], "ProgramArguments.3 is the transport");
		assert.equal(readmeSwitches(readme).length, 2, "one switch to webhook, one rollback to dry-run");
		assert.ok(readme.includes("plutil -extract ProgramArguments.0 raw"));
		const rel = WEBHOOK_CONFIG.replace(/^.*?\/Library\//, "Library/");
		assert.ok(readme.includes(`install -m 600 /dev/null "$HOME/${rel}"`));
		assert.ok(readme.includes(`rm -f "$HOME/${rel}"`));
		assert.ok(readme.includes("--test-wake --transport webhook"));
		assert.match(run, /"test-wake": \{ type: "boolean"/);
		assert.match(readme, /BUILT\/TESTED, AWAITING LIVE RECEPTION/);
		assert.doesNotMatch(readme, /pending the contract/);
	});

	// plutil ships with macOS only; CI runs on Linux, where this one test is skipped and every other runs.
	test(
		"INV-watch-io: README switch and rollback lines flip the transport on a copy of the plist",
		{
			skip: process.platform !== "darwin" && "plutil exists only on macOS",
		},
		async () => {
			const readme = await readFile(join(here, "README.md"), "utf8");
			const plist = await readFile(join(here, "com.everyfield.actionable-watch.plist"), "utf8");
			const [toWebhook, toDryRun] = readmeSwitches(readme);
			const copy = join(await mkdtemp(join(tmpdir(), "actionable-watch-plist-")), "p.plist");
			await writeFile(copy, plist);
			for (const [line, want] of [
				[toWebhook!, "webhook"],
				[toDryRun!, "dry-run"],
			] as const) {
				await new Promise<void>((resolve, reject) =>
					execFile("/bin/sh", ["-c", line], { env: { PATH: "/usr/bin:/bin", PLIST: copy } }, (e) =>
						e ? reject(e) : resolve(),
					),
				);
				const now = await readFile(copy, "utf8");
				const got = [
					...now
						.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)![1]!
						.matchAll(/<string>(.*?)<\/string>/g),
				].map((m) => m[1]);
				assert.deepEqual(got.slice(2), ["--transport", want], line);
			}
		},
	);
});
