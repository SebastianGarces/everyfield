import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnRunner, type Runner } from "../../scripts/check.ts";
import {
	type Deps,
	LABELS,
	OLD_APP_LABEL,
	ownerLabels,
	realDeps,
	reportSweep,
	sweepQuietly,
} from "../../scripts/containers.ts";
import { status } from "../../scripts/containers-command.ts";
import { down, environment, PgError, scratches, status as pgStatus, up } from "../../scripts/scratch-postgres.ts";
import { DatabaseError, IMAGE, sleepSync, startPostgres, watchProcess } from "../../scripts/throwaway-postgres.ts";
import { dockerRun } from "../../tools/formal/formal.ts";

const source = fileURLToPath(new URL("../../", import.meta.url));
const OPEN = 990000001,
	LANDED = 990000002,
	ABANDONED = 990000003,
	UNKNOWN = 990000009;
const TASKS = JSON.stringify([
	{ id: OPEN, lifecycle: "open" },
	{ id: LANDED, lifecycle: "landed" },
	{ id: ABANDONED, lifecycle: "abandoned" },
]);
const tag = randomBytes(4).toString("hex");
const NO_SEAT = { EVF_TASK: undefined, EVF_HOME: undefined };
for (const key of ["EVF_TASK", "EVF_HOME"]) delete process.env[key];

const sh = (command: string, ...args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();
const git = (cwd: string, ...args: string[]) =>
	sh("git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args);
const has = (kind: "container" | "volume", id: string) =>
	spawnSync("docker", [kind, "inspect", id], { stdio: "ignore" }).status === 0;

const temp: string[] = [],
	started = new Map<string, () => void>();
after(() => {
	for (const [id, unwatch] of started) {
		spawnSync("docker", ["rm", "-f", "-v", id], { stdio: "ignore" });
		unwatch();
	}
	for (const dir of temp) rmSync(dir, { recursive: true, force: true });
});

function repository() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evf-containers-")));
	temp.push(dir);
	const root = join(dir, "main");
	mkdirSync(root);
	git(root, "init", "-q", "-b", "main");
	git(root, "commit", "-q", "--allow-empty", "-m", "main");
	const worktree = (name: string) => {
		const path = join(root, ".worktrees", name);
		git(root, "worktree", "add", "-q", "--detach", path);
		return path;
	};
	return { root, worktree, drop: (path: string) => git(root, "worktree", "remove", "--force", path) };
}

let made = 0;
type Started = { id: string; name: string; volume: string };

function adopt(id: string): Started {
	if (!started.has(id)) started.set(id, watchProcess(id));
	const [found] = JSON.parse(sh("docker", "inspect", id)) as [{ Name: string; Mounts: { Name: string }[] }];
	return { id, name: found.Name.slice(1), volume: found.Mounts[0]!.Name };
}

function start(labels: string[], name = `evf-sweep-test-${tag}-${made++}`, stopped = false): Started {
	const id = sh("docker", "run", "-d", "--name", name, ...labels, "--entrypoint", "sleep", IMAGE, "900")
		.split("\n")
		.at(-1)!;
	const container = adopt(id);
	if (stopped) sh("docker", "stop", "-t", "0", id);
	return container;
}

function deps(root: string, over: Partial<Deps> = {}): Deps {
	const real = realDeps(root);
	return {
		...real,
		docker: (args) =>
			args[0] === "ps" ? { status: 0, stdout: [...started.keys()].join("\n"), stderr: "" } : real.docker(args),
		evf: () => ({ status: 0, stdout: TASKS, stderr: "" }),
		...over,
	};
}

function swept(root: string, over: Partial<Deps> = {}) {
	const lines: string[] = [];
	const code = reportSweep(deps(root, over), (line) => lines.push(line.replace(/^\S+ /, "")));
	return { code, lines };
}

const gone = (...all: Started[]) => {
	for (const { id, name, volume } of all) {
		assert.equal(has("container", id), false, `${name} is gone`);
		assert.equal(has("volume", volume), false, `${name}'s volume is gone`);
		started.get(id)!();
		started.delete(id);
	}
};
const alive = (...all: Started[]) => {
	for (const { id, name } of all) assert.equal(has("container", id), true, `${name} stays`);
};
const migrates =
	(ok = true): Runner =>
	(command, args, options) =>
		command === "corepack" ? { status: ok ? 0 : 1, stdout: "", output: "" } : spawnRunner(command, args, options);
const labelsOf = (id: string) =>
	JSON.parse(sh("docker", "inspect", "--format", "{{json .Config.Labels}}", id)) as Record<string, string>;

function shim(body: Record<string, string>) {
	const bin = mkdtempSync(join(tmpdir(), "evf-containers-bin-"));
	temp.push(bin);
	for (const [name, script] of Object.entries(body)) {
		writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`);
		chmodSync(join(bin, name), 0o755);
	}
	return {
		bin,
		env: { ...process.env, ...NO_SEAT, PATH: `${bin}${delimiter}${process.env.PATH}` } as NodeJS.ProcessEnv,
	};
}

test("INV-containers: the owner labels name the repository, the worktree and the seat's task, else the worktree's", () => {
	const { root, worktree } = repository();
	const common = join(root, ".git"),
		task = worktree(`t${OPEN}-x`),
		plain = worktree("plain");
	const of = (path: string, env = {}) => ownerLabels(path, env).filter((arg) => arg !== "--label");
	const base = (path: string) => [`${LABELS.repository}=${common}`, `${LABELS.worktree}=${path}`];
	assert.deepEqual(of(task), [...base(task), `${LABELS.task}=${OPEN}`]);
	assert.deepEqual(of(plain), base(plain));
	assert.deepEqual(of(plain, { EVF_TASK: "T-7" }), [...base(plain), `${LABELS.task}=7`]);
	assert.deepEqual(of(plain, { EVF_TASK: "7", EVF_HOME: join(common, "evf2") }), [...base(plain), `${LABELS.task}=7`]);
	assert.deepEqual(of(plain, { EVF_TASK: "7", EVF_HOME: "/another/.git/evf2" }), base(plain));
});

test("INV-containers: each start path labels its container", (t) => {
	const { root, worktree } = repository();
	const path = worktree(`t${OPEN}-labels`);
	const want = { [LABELS.repository]: join(root, ".git"), [LABELS.worktree]: path, [LABELS.task]: String(OPEN) };
	const owned = (labels: Record<string, string>) => Object.fromEntries(Object.keys(want).map((k) => [k, labels[k]]));
	const base = { root: path, env: {}, run: migrates(), readyTimeoutMs: 60_000, sleep: sleepSync, watch: watchProcess };
	for (const scope of [undefined, "census"]) {
		const db = startPostgres({ ...base, scope });
		t.after(db.stop);
		assert.deepEqual(owned(labelsOf(db.container)), want, scope ?? "check");
		db.stop();
	}
	up({ root: path, run: migrates() }, "default");
	const [scratch] = scratches({ root: path, run: spawnRunner });
	adopt(scratch!.id);
	assert.deepEqual(owned(labelsOf(scratch!.id)), want, "pg");
	down({ root: path, run: spawnRunner });

	const formal = dockerRun("n", "/work", "/jar", []);
	assert.deepEqual(
		formal.filter((arg) => arg.startsWith("everyfield.")),
		ownerLabels(source).filter((a) => a !== "--label"),
	);

	const next = join(path, "apps/web/node_modules/next/dist/bin/next");
	mkdirSync(dirname(next), { recursive: true });
	writeFileSync(next, "");
	const log = join(root, "docker.log");
	const { env } = shim({ docker: `echo "$@" >> ${log}; exit 1` });
	const app = spawnSync(join(source, "bin/app"), ["up"], { cwd: path, encoding: "utf8", env });
	assert.notEqual(app.status, 0);
	assert.match(app.stdout + app.stderr, /up failed at database: docker run/);
	const run = readFileSync(log, "utf8")
		.split("\n")
		.find((line) => line.startsWith("run "))!;
	for (const [key, value] of Object.entries(want)) assert.ok(run.includes(`--label ${key}=${value} `), run);
});

test("INV-containers: a landed or abandoned task's containers go with their volumes, an open task's and a live plain worktree's stay", () => {
	const { root, worktree } = repository();
	const at = (path: string) => ownerLabels(path);
	const landed = worktree(`t${LANDED}-a`),
		abandoned = worktree(`t${ABANDONED}-a`),
		open = worktree(`t${OPEN}-a`),
		lost = worktree(`t${OPEN}-lost`),
		plain = worktree("plain");
	up({ root: landed, run: migrates() }, "default");
	const scratch = adopt(scratches({ root: landed, run: spawnRunner })[0]!.id);
	const closed = [
		scratch,
		start(at(landed)),
		start(at(landed), undefined, true),
		start(at(abandoned)),
		start(at(abandoned), undefined, true),
		start(ownerLabels(plain, { EVF_TASK: String(LANDED) })),
	];
	const keep = [
		start(at(open)),
		start(at(open), undefined, true),
		start(at(lost)),
		start(at(plain)),
		start(ownerLabels(landed, { EVF_TASK: String(OPEN) })),
		start(ownerLabels(open, { EVF_TASK: String(LANDED) })),
	];
	rmSync(lost, { recursive: true });
	const { code, lines } = swept(root);
	assert.equal(code, 0);
	assert.equal(lines.length, closed.length, lines.join("\n"));
	assert.ok(lines.includes(`containers sweep removed ${scratch.name}: T-${LANDED} landed`), lines.join("\n"));
	assert.ok(lines.some((line) => line.endsWith(`T-${ABANDONED} abandoned`)));
	gone(...closed);
	alive(...keep);
	assert.deepEqual(swept(root), { code: 0, lines: [] });
});

test("INV-containers: a container whose worktree is gone goes unless an open task owns it", () => {
	const { root, worktree, drop } = repository();
	const paths = {
		task: worktree(`t${LANDED}-gone`),
		plain: worktree("plain-gone"),
		review: worktree(`t${OPEN}-review-1795000000001`),
		liveReview: worktree(`t${OPEN}-review-1795000000002`),
		closedReview: worktree(`t${LANDED}-review-1795000000003`),
		open: worktree(`t${OPEN}-gone`),
		ownReview: worktree(`t${OPEN}-review-the-words`),
	};
	const at = Object.fromEntries(Object.entries(paths).map(([k, path]) => [k, start(ownerLabels(path))])) as Record<
		keyof typeof paths,
		Started
	>;
	const scratchOfOpen = start(ownerLabels(paths.plain, { EVF_TASK: String(OPEN) }));
	for (const key of ["task", "plain", "review", "open", "ownReview"] as const) drop(paths[key]);
	assert.equal(swept(root).code, 0);
	gone(at.task, at.plain, at.review, at.closedReview);
	alive(at.liveReview, at.open, at.ownReview, scratchOfOpen);
});

test("INV-containers: what evf, git or Docker cannot answer stays, with the reason", () => {
	const { root, worktree, drop } = repository();
	const landed = start(ownerLabels(worktree(`t${LANDED}-a`))),
		unknown = start(ownerLabels(worktree(`t${UNKNOWN}-a`))),
		plainPath = worktree("plain"),
		plain = start(ownerLabels(plainPath)),
		reviewPath = worktree(`t${OPEN}-review-1795000000004`),
		review = start(ownerLabels(reviewPath));
	drop(plainPath);
	drop(reviewPath);
	const answer =
		(status: number, stdout: string, stderr = "") =>
		() => ({ status, stdout, stderr });
	const broken: [string, Partial<Deps>, RegExp][] = [
		["evf fails", { evf: answer(1, "", "no store") }, /evf cannot be read: no store/],
		["evf is not JSON", { evf: answer(0, "nope") }, /evf task list is not JSON/],
		["evf is not a list", { evf: answer(0, "{}") }, /evf task list is not a list/],
		["evf has a bad row", { evf: answer(0, '[{"id":1}]') }, /a row with no id or lifecycle/],
		["evf knows no task", { evf: answer(0, "[]") }, new RegExp(`evf does not know T-${LANDED}`)],
	];
	const badGit: Partial<Deps> = { git: answer(128, "", "not a repository") };
	for (const [name, over, reason] of broken) {
		const { lines } = swept(root, { ...over, ...badGit });
		assert.match(lines.join("\n"), reason, name);
		assert.ok(!lines.some((line) => line.includes("removed")), name);
		alive(landed, unknown, plain, review);
	}
	for (const git of [badGit.git!, answer(0, ""), answer(0, "junk"), answer(0, "worktree /elsewhere\0\0")]) {
		const landedOpen = JSON.stringify([LANDED, OPEN].map((id) => ({ id, lifecycle: "open" })));
		const { lines } = swept(root, { git, evf: answer(0, landedOpen) });
		assert.ok(!lines.some((line) => line.includes("removed")), lines.join("\n"));
		assert.match(lines.join("\n"), /git (?:cannot be read|worktree list)/);
		alive(landed, unknown, plain, review);
	}
	const noDocker = swept(root, { docker: answer(1, "", "Cannot connect to the Docker daemon") });
	assert.deepEqual(noDocker, {
		code: 1,
		lines: ["containers sweep: Docker cannot be reached: Cannot connect to the Docker daemon"],
	});

	const { lines } = swept(root);
	assert.ok(lines.includes(`containers sweep kept ${unknown.name}: evf does not know T-${UNKNOWN}`));
	gone(landed, plain, review);
	alive(unknown);
});

test("INV-containers: the owner is read again just before the removal", () => {
	const { root, worktree } = repository();
	const landed = start(ownerLabels(worktree(`t${LANDED}-a`)));
	let reads = 0;
	const evf = () => ({
		status: 0,
		stdout: reads++ ? JSON.stringify([{ id: LANDED, lifecycle: "open" }]) : TASKS,
		stderr: "",
	});
	assert.deepEqual(swept(root, { evf }), { code: 0, lines: [] });
	assert.equal(reads, 2);
	alive(landed);
});

test("INV-containers: an old app container and an unlabeled t<id> Postgres follow their task; nothing else is touched", () => {
	const { root, worktree, drop } = repository();
	const old = (name: string, path = join(root, ".worktrees", name)) => {
		const hash = createHash("sha256").update(path).digest("hex").slice(0, 12);
		return start(["--label", `${OLD_APP_LABEL}=${name}`], `evf-app-${hash}`);
	};
	const plain = worktree(`old-${tag}`);
	const goes = [
		old(`t${LANDED}-${tag}`),
		old(`old-${tag}`),
		start([], `t${LANDED}-pg-${tag}`),
		start([], `t${ABANDONED}-pg-${tag}`, true),
	];
	const { common } = deps(root);
	const landedPath = worktree(`t${LANDED}-a`);
	const landed = ownerLabels(landedPath);
	const stays = [
		old(`t${OPEN}-${tag}`),
		old(`elsewhere-${tag}`, "/another/clone"),
		start([], `t${OPEN}-pg-${tag}`),
		start([], `t${UNKNOWN}-pg-${tag}`),
		start([], `unrelated-${tag}`),
		start(["--label", "com.docker.compose.project=x"], `t${LANDED}-compose-${tag}`),
		start([...landed, "--label", "dev.evf.slot=0"]),
		start(landed, `qa-test-sweep-${tag}`),
		start(["--label", `${LABELS.repository}=/another/.git`, ...landed.slice(2)]),
	];
	assert.ok(common);
	drop(plain);
	const image = `evf-sweep-test:${tag}`;
	sh("docker", "tag", IMAGE, image);
	try {
		const other = sh("docker", "run", "-d", "--name", `t${LANDED}-app-${tag}`, "--entrypoint", "sleep", image, "900");
		stays.push(adopt(other));
		swept(root);
	} finally {
		sh("docker", "rmi", "--no-prune", "-f", image);
	}
	gone(...goes);
	alive(...stays);
});

test("INV-containers: status lists owner, age and verdict, removes nothing and fails while an orphan exists", () => {
	const { root, worktree } = repository();
	const orphan = start(ownerLabels(worktree(`t${LANDED}-a`))),
		kept = start(ownerLabels(worktree(`t${OPEN}-a`)));
	const own = (over: Partial<Deps> = {}) => {
		const lines: string[] = [];
		return { code: status(deps(root, over), "not installed", (line) => lines.push(line)), lines };
	};
	const { code, lines } = own();
	assert.equal(code, 1);
	const line = (name: string) => lines.find((l) => l.includes(name))!;
	assert.match(line(orphan.name), new RegExp(`^remove .* T-${LANDED} .*/t${LANDED}-a  0m old: T-${LANDED} landed$`));
	assert.match(line(kept.name), new RegExp(`^keep .* T-${OPEN} .* 0m old: T-${OPEN} is open$`));
	assert.equal(lines.at(-1), "LaunchAgent com.everyfield.containers: not installed");
	alive(orphan, kept);
	swept(root);
	gone(orphan);
	assert.equal(own().code, 0);
});

test("INV-containers: a failing sweep changes no command's result", () => {
	const lines: string[] = [];
	sweepQuietly(tmpdir(), (line) => lines.push(line));
	assert.match(lines.join("\n"), /^containers sweep skipped: .* is not a git worktree/);

	const { root } = repository();
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs/check-all.py"), "print('ok')\n");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
	writeFileSync(join(root, "docs/a.md"), "a\n");
	const home = mkdtempSync(join(tmpdir(), "evf-containers-home-"));
	temp.push(home);
	const map = { head: "x".repeat(12), createdAt: new Date().toISOString(), tests: {} };
	writeFileSync(join(home, "coverage-map.json"), JSON.stringify(map));
	const script = `import { checkCommand } from ${JSON.stringify(pathToFileURL(join(source, "scripts/check.ts")).href)};
process.exitCode = checkCommand([], ${JSON.stringify(root)});`;
	const runs = ["exit 0", "echo broken >&2; exit 1"].map((docker) => {
		const { env } = shim({ docker, gh: "exit 1" });
		return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			env: { ...env, EVERYFIELD_CI_HOME: home, NODE_TEST_CONTEXT: undefined } as unknown as NodeJS.ProcessEnv,
		});
	});
	const [working, failing] = runs as [(typeof runs)[0], (typeof runs)[0]];
	assert.equal(working.status, 0, working.stdout + working.stderr);
	assert.equal(failing.status, 0, failing.stdout + failing.stderr);
	assert.equal(failing.stdout, working.stdout);
	assert.match(failing.stderr, /containers sweep: Docker cannot be reached: broken/);

	const web = join(root, "apps/web");
	assert.equal(existsSync(web), false);
	const apps = ["exit 0", "exit 1"].map((docker) => {
		const { env } = shim({ docker });
		return spawnSync(join(source, "bin/app"), ["up"], { cwd: root, encoding: "utf8", env });
	});
	assert.equal(apps[0]!.status, 4, apps[0]!.stderr);
	assert.equal(apps[1]!.status, apps[0]!.status);
	assert.match(apps[1]!.stderr, /containers sweep: Docker cannot be reached/);
	assert.match(apps[1]!.stdout + apps[1]!.stderr, /apps\/web has no node_modules/);
});

test("INV-containers: bin/dev pg reuses a running database, keeps to its worktree and leaves nothing after a failed up", () => {
	const { worktree } = repository();
	const here = { root: worktree(`t${OPEN}-a`), run: migrates() },
		there = { root: worktree("other"), run: migrates() };
	assert.match(up(here, "one"), /^pg up one: evf-pg-one-db-/);
	const [first] = scratches(here);
	const container = adopt(first!.id);
	assert.match(up(here, "one"), /^pg already up one: /);
	assert.deepEqual(
		scratches(here).map(({ id }) => id),
		[container.id],
	);
	assert.deepEqual(scratches(there), []);
	assert.throws(() => environment(there, "one"), PgError);
	assert.deepEqual(down(there), ["no scratch Postgres of this worktree to remove"]);
	alive(container);
	assert.match(pgStatus(here).join("\n"), /^one: evf-pg-one-db-\S+ running on 127\.0\.0\.1:\d+$/);
	const url = new URL(environment(here, "one").DATABASE_URL!);
	assert.equal(url.hostname, "127.0.0.1");
	assert.throws(() => up({ ...here, run: migrates(false) }, "two"), DatabaseError);
	assert.deepEqual(
		scratches(here).map(({ name }) => name),
		["one"],
	);
	assert.match(down(here).join("\n"), /^pg down one: removed/);
	gone(container);
	assert.equal(basename(here.root), `t${OPEN}-a`);
});
