import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, createTransport, WEBHOOK_SENDS_PER_HOUR, type CommandName, type ExecResult, type Payload, type Transport } from "../io.mts";
import { pollOnce, type Deps } from "../run.mts";
import { fakeRoutine, writeConfig } from "./fake-routine.mts";
import { ciRuns, NOW, running } from "./fixtures.mts";

type World = { evf: ExecResult; gh: ExecResult };
const ok = (v: unknown): ExecResult => ({ ok: true, stdout: JSON.stringify(v) });

async function harness(world: World, failSends = 0) {
	const stateDir = await mkdtemp(join(tmpdir(), "actionable-watch-run-"));
	const lines: string[] = [];
	const sent: Payload[] = [];
	let failuresLeft = failSends;
	const transport: Transport = {
		mode: "dry-run",
		capped: false,
		send: async (p) => {
			if (failuresLeft-- > 0) return { ok: false, result: "connect_error", retry: true };
			sent.push(p);
			return { ok: true, result: "logged" };
		},
	};
	const deps: Deps = {
		now: () => NOW,
		exec: async (name: CommandName) => (name === "evf-status" ? world.evf : world.gh),
		transport,
		log: async (l) => void lines.push(l),
		stateDir,
		sleep: async () => {},
	};
	return { deps, lines, sent, stateDir, world, fail: (n: number) => (failuresLeft = n) };
}

const green = ok(ciRuns("1".repeat(40), "success"));

test("N identical polls call the transport zero times", async () => {
	const h = await harness({ evf: ok(running()), gh: green });
	assert.equal(await pollOnce(h.deps), "baseline");
	for (let i = 0; i < 20; i++) {
		h.world.evf = ok(running({ noise: i % 2 ? "a" : "b", now: NOW + i * 90_000, heartbeat: NOW + i * 90_000 - 1000 }));
		assert.equal(await pollOnce(h.deps), "no_change");
	}
	assert.equal(h.sent.length, 0);
});

test("a restart over the same state file and identical status does not wake", async () => {
	const h = await harness({ evf: ok(running()), gh: green });
	await pollOnce(h.deps);
	h.world.evf = ok(running({ decisions: [{ id: 4 }] }));
	assert.equal(await pollOnce(h.deps), "woke");
	// a fresh process: new deps object, same state dir
	const restarted = { ...h.deps, exec: h.deps.exec };
	assert.equal(await pollOnce(restarted), "no_change");
	assert.equal(h.sent.length, 1);
	assert.deepEqual(h.sent[0].events.map((e) => e.key), ["decision:D-4"]);
});

test("missing or corrupt state re-baselines without a wake storm", async () => {
	const busy = running({ decisions: [{ id: 1 }, { id: 2 }], tickError: "x" });
	const h = await harness({ evf: ok(busy), gh: ok(ciRuns("2".repeat(40), "failure")) });
	assert.equal(await pollOnce(h.deps), "baseline");
	await writeFile(join(h.stateDir, "state.json"), "{not json");
	assert.equal(await pollOnce(h.deps), "baseline");
	await writeFile(join(h.stateDir, "state.json"), JSON.stringify({ version: 1, snapshot: null }));
	assert.equal(await pollOnce(h.deps), "baseline");
	assert.equal(await pollOnce(h.deps), "no_change");
	assert.equal(h.sent.length, 0);
	assert.match(h.lines.join("\n"), /baseline reason=state_corrupt/);
});

test("evf failures and odd output log one line and leave state untouched", async () => {
	const h = await harness({ evf: ok(running({ decisions: [{ id: 1 }] })), gh: green });
	await pollOnce(h.deps);
	h.world.evf = ok(running());
	const before = await readFile(join(h.stateDir, "state.json"), "utf8");
	const cases: [ExecResult, string][] = [
		[{ ok: false, code: "evf_missing" }, "evf_missing"],
		[{ ok: false, code: "evf_not_executable" }, "evf_not_executable"],
		[{ ok: false, code: "evf_exit_2" }, "evf_exit_2"],
		[{ ok: false, code: "evf_timeout" }, "evf_timeout"],
		[{ ok: true, stdout: "panicked at stdio.rs" }, "evf_invalid_json"],
		[ok({ tasks: [] }), "evf_bad_shape list=top fields=now:undefined,heartbeat:undefined,budget.seats:undefined"],
		[ok([1, 2]), "evf_bad_shape list=top fields=status:array"],
	];
	for (const [result, code] of cases) {
		h.lines.length = 0;
		h.world.evf = result;
		assert.equal(await pollOnce(h.deps), "poll_failed");
		assert.deepEqual(h.lines, [`poll_failed code=${code}`]);
	}
	assert.equal(await readFile(join(h.stateDir, "state.json"), "utf8"), before, "sent keys and snapshot survive");
	h.world.evf = ok(running({ decisions: [{ id: 1 }] }));
	assert.equal(await pollOnce(h.deps), "no_change", "no false wake after recovery");
	assert.equal(h.sent.length, 0);
});

test("gh unavailable turns only the CI check off and keeps the last CI", async () => {
	const red = ok(ciRuns("3".repeat(40), "failure"));
	const h = await harness({ evf: ok(running()), gh: green });
	await pollOnce(h.deps);
	h.world.gh = red;
	assert.equal(await pollOnce(h.deps), "woke");
	for (const gh of [{ ok: false, code: "gh_missing" }, { ok: false, code: "gh_exit_4" }, { ok: true, stdout: "nope" }, ok({})] as ExecResult[]) {
		h.world.gh = gh;
		assert.equal(await pollOnce(h.deps), "no_change");
	}
	h.world.gh = red;
	assert.equal(await pollOnce(h.deps), "no_change", "the failed sha does not re-fire when gh returns");
	h.world.gh = { ok: false, code: "gh_missing" };
	h.world.evf = ok(running({ decisions: [{ id: 8 }] }));
	assert.equal(await pollOnce(h.deps), "woke", "evf events still flow without gh");
	assert.deepEqual(h.sent.map((p) => p.events.map((e) => e.key)), [[`ci-failed:${"3".repeat(40)}`], ["decision:D-8"]]);
});

test("a failed send stays pending, retries once per poll, and is sent once on success", async () => {
	const h = await harness({ evf: ok(running()), gh: green });
	await pollOnce(h.deps);
	h.world.evf = ok(running({ decisions: [{ id: 6 }] }));
	h.fail(3);
	assert.equal(await pollOnce(h.deps), "wake_failed");
	h.fail(3);
	assert.equal(await pollOnce(h.deps), "wake_failed");
	assert.deepEqual(h.lines.filter((l) => l.startsWith("wake_failed")), [
		"wake_failed transport=dry-run tries=3 result=connect_error pending=1 keys=decision:D-6",
		"wake_failed transport=dry-run tries=3 result=connect_error pending=1 keys=decision:D-6",
	]);
	assert.equal(await pollOnce(h.deps), "woke");
	assert.equal(await pollOnce(h.deps), "no_change");
	assert.deepEqual(h.sent.map((p) => p.events.map((e) => e.key)), [["decision:D-6"]]);
});

test("a second concurrent instance exits without polling", async () => {
	const h = await harness({ evf: ok(running()), gh: green });
	let polled = 0;
	const lock = await acquireLock(join(h.stateDir, "watch.lock"), NOW);
	assert.ok(lock);
	const second = { ...h.deps, exec: async (n: CommandName) => (polled++, h.deps.exec(n)) };
	assert.equal(await pollOnce(second), "locked");
	assert.equal(polled, 0);
	await lock.release();
	assert.equal(await pollOnce(second), "baseline");
});

test("sensitive status text never reaches the payload, log or state", async () => {
	const secret = "nora@example.com https://u:pw@hook.example/abc sk-LIVEKEY raw transcript";
	const leaky = (id: number) => {
		const raw = running({ decisions: [{ id, task: 1, question: secret, context: secret }] });
		raw.tasks[0].title = secret;
		raw.tasks[0].label = secret;
		raw.seats[0].activity = secret;
		raw.seats[0].doing = secret;
		for (const a of raw.agents) Object.assign(a, { wait: secret, title: secret });
		return raw;
	};
	const h = await harness({ evf: ok(leaky(1)), gh: green });
	await pollOnce(h.deps);
	h.world.evf = ok(leaky(2));
	assert.equal(await pollOnce(h.deps), "woke");
	const everything = JSON.stringify(h.sent) + h.lines.join("\n") + (await readFile(join(h.stateDir, "state.json"), "utf8"));
	for (const bit of ["example", "pw@", "LIVEKEY", "transcript", "nora"]) assert.ok(!everything.includes(bit), `leaks ${bit}`);
});

test("the hourly send cap holds a pending event across a restart and lets it through an hour later", async () => {
	const h = await harness({ evf: ok(running()), gh: green });
	let posts = 0;
	let answer = 503;
	h.deps.transport = { mode: "webhook", capped: true, send: async () => (posts++, answer === 200 ? { ok: true, result: "http_200" } : { ok: false, result: `http_${answer}`, retry: true }) };
	await pollOnce(h.deps);
	h.world.evf = ok(running({ decisions: [{ id: 11 }] }));
	let t = NOW;
	h.deps.now = () => t;
	const outcomes: string[] = [];
	for (let i = 0; i < 7; i++) outcomes.push(await pollOnce(h.deps), String((t += 90_000, posts)));
	assert.deepEqual(outcomes, ["wake_failed", "3", "wake_failed", "6", "wake_failed", "9", "wake_failed", "12", "wake_failed", "15", "wake_failed", "18", "wake_capped", "20"]);
	assert.deepEqual(h.lines.filter((l) => l.startsWith("wake_capped")), [`wake_capped transport=webhook sends_last_hour=20 cap=${WEBHOOK_SENDS_PER_HOUR} pending=1 keys=decision:D-11`]);
	const saved = JSON.parse(await readFile(join(h.stateDir, "state.json"), "utf8"));
	assert.equal(saved.sends.length, 20, "the send log is persisted");
	assert.deepEqual(saved.pending.map((e: { key: string }) => e.key), ["decision:D-11"], "the event is kept, not dropped");

	// A restart: a fresh process over the same state dir is still capped, and sends nothing.
	answer = 200;
	const restarted: Deps = { ...h.deps, transport: { ...h.deps.transport } };
	assert.equal(await pollOnce(restarted), "wake_capped");
	assert.equal(posts, 20);
	// Once the oldest sends leave the rolling hour, the pending event goes out once.
	t += 60 * 60_000;
	assert.equal(await pollOnce(restarted), "woke");
	assert.equal(await pollOnce(restarted), "no_change");
	assert.equal(posts, 21);
});

test("the webhook URL and key never reach the log or the state file, on success or failure", async () => {
	const urlToken = "SENTINELURLTOKEN0d6f";
	const key = "SENTINELKEY9a1c";
	const routine = await fakeRoutine([200]);
	try {
		const h = await harness({ evf: ok(running()), gh: green });
		const configPath = await writeConfig(h.stateDir, { url: `${routine.origin}/hooks/${urlToken}?token=${urlToken}`, key });
		const t = createTransport("webhook", h.deps.log, { configPath, ca: routine.ca });
		assert.ok(t.ok);
		h.deps.transport = t.transport;
		await pollOnce(h.deps);
		let id = 20;
		const replies = [[200], [500], [401], [429], ["reset"]] as const;
		for (const r of replies) {
			routine.replies = [...r];
			h.world.evf = ok(running({ decisions: [{ id: id++ }] }));
			await pollOnce(h.deps);
		}
		// failure paths before any request: a world-readable file, then a non-https URL holding the token
		await writeConfig(h.stateDir, { url: `${routine.origin}/hooks/${urlToken}`, key }, 0o644);
		h.world.evf = ok(running({ decisions: [{ id: id++ }] }));
		await pollOnce(h.deps);
		await writeConfig(h.stateDir, { url: `http://127.0.0.1:1/hooks/${urlToken}`, key });
		h.world.evf = ok(running({ decisions: [{ id: id++ }] }));
		await pollOnce(h.deps);
		await writeConfig(h.stateDir, `{"url": "${urlToken}", "key": "${key}"`);
		await pollOnce(h.deps);

		assert.ok(routine.seen.length >= 5, "the fake routine was really called");
		assert.ok(routine.seen.every((r) => r.headers.authorization === `Bearer ${key}`));
		const log = h.lines.join("\n");
		const state = await readFile(join(h.stateDir, "state.json"), "utf8");
		for (const sentinel of [urlToken, key, "Bearer", "127.0.0.1", "hooks/"]) {
			assert.ok(!log.includes(sentinel), `log leaks ${sentinel}`);
			assert.ok(!state.includes(sentinel), `state leaks ${sentinel}`);
		}
		for (const code of ["result=http_200", "result=http_500", "result=http_401", "result=http_429", "result=network_error", "result=webhook_config_mode", "result=webhook_url_not_https", "result=webhook_config_invalid_json"]) {
			assert.ok(log.includes(code), `log names ${code}`);
		}
	} finally {
		await routine.close();
	}
});

const runMts = new URL("../run.mts", import.meta.url).pathname;
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(process.execPath, [runMts, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
			resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
		);
	});
}

test("--test-wake sends one test payload and neither reads nor changes the dedup state", async () => {
	const routine = await fakeRoutine([200]);
	try {
		const dir = await mkdtemp(join(tmpdir(), "actionable-watch-testwake-"));
		const statePath = join(dir, "state.json");
		await writeFile(statePath, "{deliberately not valid state", { mode: 0o600 });
		const before = await stat(statePath);
		const key = "SENTINELKEYcli";
		await writeConfig(dir, { url: `${routine.origin}/hooks/SENTINELURLcli`, key });

		const sent = await cli(["--test-wake", "--transport", "webhook", "--state-dir", dir, "--log-dir", dir], { NODE_EXTRA_CA_CERTS: routine.caPath });
		assert.deepEqual(sent, { code: 0, stdout: "test-wake transport=webhook result=http_200\n", stderr: "" });
		assert.equal(routine.seen.length, 1);
		const body = JSON.parse(routine.seen[0].body);
		assert.equal(body.kind, "test");
		assert.deepEqual(body.events, []);

		routine.replies = [503];
		const refused = await cli(["--test-wake", "--transport", "webhook", "--state-dir", dir, "--log-dir", dir], { NODE_EXTRA_CA_CERTS: routine.caPath });
		assert.deepEqual(refused, { code: 1, stdout: "test-wake transport=webhook result=http_503\n", stderr: "" });
		assert.equal(routine.seen.length, 2, "one try only, even for a 5xx");

		const dry = await cli(["--test-wake", "--transport", "dry-run", "--state-dir", dir, "--log-dir", dir]);
		assert.deepEqual(dry, { code: 0, stdout: "test-wake transport=dry-run result=logged\n", stderr: "" });

		const after = await stat(statePath);
		assert.equal(await readFile(statePath, "utf8"), "{deliberately not valid state", "state.json is untouched");
		assert.equal(after.mtimeMs, before.mtimeMs);
		const log = await readFile(join(dir, "watch.log"), "utf8");
		assert.match(log, /test-wake transport=webhook result=http_200\n/);
		assert.match(log, /dry-run wake payload=\{"source":"everyfield-actionable-watch","version":1,"kind":"test",/);
		assert.ok(!log.includes("SENTINEL"), "no URL or key in the log");
		assert.ok(!log.includes("poll") && !log.includes("baseline"), "no poll ran");
	} finally {
		await routine.close();
	}
});
