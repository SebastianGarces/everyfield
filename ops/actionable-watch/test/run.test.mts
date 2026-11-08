import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, type CommandName, type ExecResult, type Payload, type Transport } from "../io.mts";
import { pollOnce, type Deps } from "../run.mts";
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
		send: async (p) => {
			if (failuresLeft-- > 0) throw new Error("down");
			sent.push(p);
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
		[ok({ tasks: [] }), "evf_bad_shape"],
		[ok([1, 2]), "evf_bad_shape"],
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
	assert.deepEqual(h.lines.filter((l) => l.startsWith("wake_failed")), ["wake_failed tries=3 pending=1 keys=decision:D-6", "wake_failed tries=3 pending=1 keys=decision:D-6"]);
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
		raw.agents[0].wait = secret;
		return raw;
	};
	const h = await harness({ evf: ok(leaky(1)), gh: green });
	await pollOnce(h.deps);
	h.world.evf = ok(leaky(2));
	assert.equal(await pollOnce(h.deps), "woke");
	const everything = JSON.stringify(h.sent) + h.lines.join("\n") + (await readFile(join(h.stateDir, "state.json"), "utf8"));
	for (const bit of ["example", "pw@", "LIVEKEY", "transcript", "nora"]) assert.ok(!everything.includes(bit), `leaks ${bit}`);
});
