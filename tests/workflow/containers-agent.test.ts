import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT, agentState, install, plist, uninstall } from "../../scripts/containers-command.ts";
import { jobPath, type ScheduleDeps } from "../../scripts/nightly-schedule.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));

function temp(t: { after(fn: () => void): void }) {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evf-containers-agent-")));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function fake(dir: string) {
	const calls: string[] = [],
		out: string[] = [];
	let on = false;
	const d: ScheduleDeps = {
		agentsDir: join(dir, "LaunchAgents"),
		uid: 501,
		home: join(dir, "ci"),
		checkout: "/repo/main",
		path: "/opt/node/bin:/cargo/bin:/usr/bin:/bin",
		launchctl: (args) => {
			calls.push(args.join(" "));
			if (args[0] === "print") return { status: on ? 0 : 113, output: "" };
			on = args[0] === "bootstrap";
			return { status: 0, output: "" };
		},
		log: (line) => out.push(line),
		sleep: () => {},
	};
	return { d, calls, out };
}

test("INV-containers: the plist runs the main checkout's sweep every 5 minutes with every tool on PATH", (t) => {
	const { d } = fake(temp(t));
	install(d);
	const text = readFileSync(join(d.agentsDir, `${AGENT}.plist`), "utf8");
	assert.equal(text, plist({ checkout: "/repo/main", path: d.path, log: join(d.home, "containers.log") }));
	assert.match(text, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
	assert.match(text, /<key>PATH<\/key>\s*<string>\/opt\/node\/bin:\/cargo\/bin:\/usr\/bin:\/bin<\/string>/);
	assert.match(text, /<string>sweep<\/string>\s*<string>\/repo\/main<\/string>/);
	assert.equal((text.match(/<string>\/dev\/null<\/string>/g) ?? []).length, 2);
	if (process.platform === "darwin")
		assert.equal(spawnSync("plutil", ["-lint", join(d.agentsDir, `${AGENT}.plist`)]).status, 0);
});

test("INV-containers: install and uninstall can be repeated", (t) => {
	const { d, calls, out } = fake(temp(t));
	assert.match(agentState(d), /^not installed/);
	install(d);
	install(d);
	assert.deepEqual(readdirSync(d.agentsDir), [`${AGENT}.plist`]);
	assert.equal(agentState(d), "installed, loaded");
	assert.ok(calls.includes(`bootout gui/501/${AGENT}`));
	uninstall(d);
	uninstall(d);
	assert.equal(existsSync(join(d.agentsDir, `${AGENT}.plist`)), false);
	assert.deepEqual(out.slice(-2), [`uninstalled ${AGENT}`, `nothing was installed: ${AGENT}`]);
});

test("INV-containers: the job PATH holds node, docker, git and evf, and a missing one fails", () => {
	const at: Record<string, string> = { node: "/n/node", docker: "/d/docker", git: "/g/git", evf: "/e/evf" };
	const path = (found: Record<string, string>) =>
		jobPath((tool) => found[tool] ?? null, "/n/node", ["docker", "git", "evf"], AGENT);
	assert.equal(path(at), "/n:/d:/g:/e:/usr/bin:/bin:/usr/sbin:/sbin");
	assert.throws(() => path(Object.fromEntries(Object.entries(at).filter(([tool]) => tool !== "evf"))), /evf is not on PATH/);
});

test("INV-containers: the job runs only landed code that has the command, and trims its log", (t) => {
	const dir = temp(t),
		checkout = join(dir, "main"),
		log = join(dir, "containers.log"),
		ran = join(dir, "ran");
	mkdirSync(checkout);
	const git = (...args: string[]) => {
		const r = spawnSync("git", ["-C", checkout, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], {
			encoding: "utf8",
		});
		assert.equal(r.status, 0, r.stderr);
	};
	const write = (path: string, text: string) => {
		mkdirSync(dirname(join(checkout, path)), { recursive: true });
		writeFileSync(join(checkout, path), text);
	};
	const text = plist({ checkout, path: "/usr/bin:/bin", log });
	const args = [.../<array>([\s\S]*?)<\/array>/.exec(text)![1]!.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
		([, arg]) =>
			arg!.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
	);
	const job = () => {
		rmSync(ran, { force: true });
		const r = spawnSync(args[0]!, args.slice(1), { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return existsSync(ran) ? readFileSync(ran, "utf8").trim() : null;
	};
	git("init", "-q", "-b", "main");
	write("bin/dev", `#!/bin/sh\necho "$@" > ${ran}\n`);
	chmodSync(join(checkout, "bin/dev"), 0o755);
	git("add", ".");
	git("commit", "-qm", "before the command");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	assert.equal(job(), null);
	write("scripts/containers-command.ts", "export {};\n");
	assert.equal(job(), null, "an uncommitted command does not run");
	git("add", ".");
	git("commit", "-qm", "unlanded");
	assert.equal(job(), null, "an unlanded commit does not run");
	assert.match(readFileSync(log, "utf8"), /holds code that has not landed/);
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	assert.equal(job(), "containers sweep");
	write("scripts/containers-command.ts", "export const edited = true;\n");
	assert.equal(job(), null, "an edited checkout does not run");
	git("checkout", "-q", "--", ".");
	writeFileSync(log, "x".repeat(300_000));
	assert.equal(job(), "containers sweep");
	assert.ok(statSync(log).size <= 65_536);
});

test("INV-containers: the commands show usage on a wrong call and help names them", () => {
	const dev = (...args: string[]) => spawnSync(join(source, "bin/dev"), args, { encoding: "utf8" });
	for (const args of [
		["containers"],
		["containers", "bogus"],
		["containers", "sweep", "x"],
		["pg"],
		["pg", "run"],
		["pg", "up", "--name"],
		["pg", "up", "--name", "Bad_Name"],
		["pg", "status", "--name", "a"],
	])
		assert.equal(dev(...args).status, 2, args.join(" "));
	const help = dev("help").stdout;
	for (const name of [
		"pg up",
		"pg run",
		"pg status",
		"containers sweep",
		"containers status",
		"containers install",
		"containers uninstall",
	])
		assert.ok(help.includes(`dev ${name}`), name);
});
