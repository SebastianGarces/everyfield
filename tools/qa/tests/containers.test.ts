// T-356: every qa-test-* container a QA test starts goes when its run ends, and `bin/dev check`'s sweep removes the
// orphans of runs that died, never a live run's database or another container.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGE_ENV, LABELS, processStart, sweep, sweepCommand } from "../containers.ts";

const MINUTE = 60_000;
/** A pid no process holds any more. */
const deadPid = spawnSync("true").pid;

/** A `docker` on PATH that answers ps, inspect and rm from a JSON state file, as Docker's CLI does. */
function fakeDocker(containers: { name: string; ageMinutes: number; owner?: [number, string] | null }[], down = false) {
	const dir = mkdtempSync(join(tmpdir(), "qa-fake-docker-"));
	const state = join(dir, "state.json");
	const created = (age: number) => new Date(Date.now() - age * MINUTE).toISOString();
	writeFileSync(
		state,
		JSON.stringify({
			down,
			removed: [],
			containers: containers.map((c, i) => ({
				Id: `id${i}`,
				Name: `/${c.name}`,
				Created: created(c.ageMinutes),
				Config: {
					Labels: c.owner
						? { [LABELS.pid]: String(c.owner[0]), [LABELS.start]: c.owner[1], [LABELS.started]: created(c.ageMinutes) }
						: null,
				},
			})),
		}),
	);
	writeFileSync(
		join(dir, "docker"),
		`#!${process.execPath}
const fs = require("node:fs"), file = ${JSON.stringify(state)}, s = JSON.parse(fs.readFileSync(file, "utf8"));
const [cmd, ...args] = process.argv.slice(2);
if (s.down) { console.error("Cannot connect to the Docker daemon. Is the docker daemon running?"); process.exit(1); }
const filter = args.find((a) => a.startsWith("name="))?.slice(5);
if (cmd === "ps") console.log(s.containers.filter((c) => c.Name.includes(filter)).map((c) => c.Id).join("\\n"));
else if (cmd === "inspect") console.log(JSON.stringify(s.containers.filter((c) => args.includes(c.Id))));
else if (cmd === "rm") {
	s.removed.push(...s.containers.filter((c) => args.includes(c.Id)).map((c) => c.Name.slice(1)));
	s.containers = s.containers.filter((c) => !args.includes(c.Id));
	fs.writeFileSync(file, JSON.stringify(s));
} else process.exit(2);
`,
	);
	chmodSync(join(dir, "docker"), 0o755);
	return {
		env: { PATH: `${dir}:/usr/bin:/bin` },
		removed: () => (JSON.parse(readFileSync(state, "utf8")) as { removed: string[] }).removed.sort(),
		[Symbol.dispose]: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("INV-qa-containers: the sweep removes old orphans only, and never a live run's or another container", () => {
	const me: [number, string] = [process.pid, processStart(process.pid)!];
	using docker = fakeDocker([
		{ name: "qa-test-live-owner", ageMinutes: 600, owner: me },
		{ name: "qa-test-dead-owner", ageMinutes: 180, owner: [deadPid, me[1]] },
		{ name: "qa-test-reused-pid", ageMinutes: 180, owner: [process.pid, "Thu Jan  1 00:00:00 2026"] },
		{ name: "qa-test-young-dead-owner", ageMinutes: 30, owner: [deadPid, me[1]] },
		{ name: "qa-test-old-unlabelled", ageMinutes: 125 },
		{ name: "qa-test-young-unlabelled", ageMinutes: 10 },
		{ name: "local-qa-test-db", ageMinutes: 3000 },
		{ name: "t350pg", ageMinutes: 3000 },
	]);
	const lines: string[] = [];
	sweepCommand((line) => lines.push(line), docker.env);
	assert.deepEqual(docker.removed(), ["qa-test-dead-owner", "qa-test-old-unlabelled", "qa-test-reused-pid"]);
	assert.deepEqual(lines.sort(), [
		`qa-test sweep removed qa-test-dead-owner, 180 min old: its owning run (pid ${deadPid}, started ${me[1]}) is gone`,
		"qa-test sweep removed qa-test-old-unlabelled, 125 min old: it names no owning run",
		`qa-test sweep removed qa-test-reused-pid, 180 min old: its owning run (pid ${process.pid}, started Thu Jan  1 00:00:00 2026) is gone`,
	]);

	// The threshold comes from the environment.
	assert.deepEqual(sweep({ ...docker.env, [AGE_ENV]: "20" }), {
		removed: [
			{
				name: "qa-test-young-dead-owner",
				ageMinutes: 30,
				reason: `its owning run (pid ${deadPid}, started ${me[1]}) is gone`,
			},
		],
	});
});

test("INV-qa-containers: without Docker or its daemon the sweep says it skipped, in one line", () => {
	const empty = mkdtempSync(join(tmpdir(), "qa-no-docker-"));
	try {
		const lines: string[] = [];
		sweepCommand((line) => lines.push(line), { PATH: empty });
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /^qa-test sweep skipped: docker is not available: /);
	} finally {
		rmSync(empty, { recursive: true, force: true });
	}
	using docker = fakeDocker([{ name: "qa-test-old-unlabelled", ageMinutes: 500 }], true);
	const lines: string[] = [];
	sweepCommand((line) => lines.push(line), docker.env);
	assert.deepEqual(lines, [
		"qa-test sweep skipped: docker ps failed: Cannot connect to the Docker daemon. Is the docker daemon running?",
	]);
});

const exists = (name: string) =>
	spawnSync("docker", ["ps", "-a", "-q", "--filter", `name=^/${name}$`], { encoding: "utf8" }).stdout.trim() !== "";

/** Runs the child QA test process and resolves with it once its database is up and named. */
function child(mode: "fail" | "wait") {
	const p = spawn(process.execPath, [join(import.meta.dirname, "fixtures/quiet-database-child.ts"), mode], {
		stdio: ["ignore", "pipe", "pipe"],
		env: (({ NODE_TEST_CONTEXT: _, ...env }) => env)(process.env),
	});
	let out = "",
		err = "";
	p.stderr.on("data", (d) => (err += d));
	const exited = new Promise<number | string>((done) => p.on("exit", (code, signal) => done(code ?? signal!)));
	const container = new Promise<string>((done, fail) => {
		p.stdout.on("data", (d) => {
			out += d;
			const name = /qa-test-cleanup-[0-9a-f]+/.exec(out)?.[0];
			if (name) done(name);
		});
		void exited.then(() => fail(new Error(`the child exited before its database was up:\n${out}${err}`)));
	});
	return { p, container, exited };
}

/** Whether the container still exists once removal had time to finish: after a signal, removal starts at death. */
async function remains(name: string) {
	for (let waited = 0; exists(name) && waited < 15_000; waited += 250) await new Promise((r) => setTimeout(r, 250));
	return exists(name);
}

test("INV-qa-containers: a QA database goes when its test process fails, is interrupted or is killed", async (t) => {
	await t.test("a failing test", async () => {
		const run = child("fail");
		const name = await run.container;
		assert.equal(await run.exited, 1);
		// Removed before the process was gone, not after.
		assert.equal(exists(name), false);
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const)
		await t.test(signal, async () => {
			const run = child("wait");
			const name = await run.container;
			const labels = JSON.parse(
				spawnSync("docker", ["inspect", "--format", "{{json .Config.Labels}}", name], { encoding: "utf8" }).stdout,
			) as Record<string, string>;
			assert.equal(labels[LABELS.pid], String(run.p.pid));
			assert.equal(labels[LABELS.start], processStart(run.p.pid!));
			assert.ok(Date.now() - Date.parse(labels[LABELS.started]!) < 10 * MINUTE);
			run.p.kill(signal);
			assert.equal(await run.exited, signal);
			assert.equal(await remains(name), false);
		});
});
