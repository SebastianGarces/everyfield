import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fixture, source } from "./fixtures.ts";
import { openWorkDb } from "../db.ts";
import { evfDataDir } from "../lib.ts";

// OPS-72: previews wait for a free slot. A fake `portless` keeps its previews in a JSON file.
const { ensurePreviewSlot } = (await import(
	join(source, ".agents/skills/verify-preview/scripts/preview-slots.mjs")
)) as {
	ensurePreviewSlot: (o: Record<string, unknown>) => Promise<{ reused: boolean }>;
};

type Preview = { id: string; project: string; state: string; mode?: string; head?: string };
function slotFixture() {
	const f = fixture();
	const db = openWorkDb(f.root);
	const state = join(f.root, "portless-state.json");
	const fake = join(f.root, "fake-bin/portless");
	writeFileSync(
		fake,
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);const p=${JSON.stringify(state)};\n` +
			`const s=JSON.parse(fs.readFileSync(p,"utf8"));s.calls.push(a);const save=()=>fs.writeFileSync(p,JSON.stringify(s));\n` +
			`const mark=(f,to)=>{s.previews=s.previews.map(x=>f(x)?{...x,state:to}:x)};let out="";\n` +
			`if(a[1]==="status"){s.statusCalls++;if(s.dropAfter&&s.statusCalls>=s.dropAfter.calls)mark(x=>x.id===s.dropAfter.id,"removed");out=JSON.stringify(s.previews)}\n` +
			`else if(a[1]==="gc"&&a.includes("--apply"))mark(x=>x.state==="failed"||x.state==="expired","removed");\n` +
			`else if(a[1]==="down")mark(x=>x.id===a[2],"removed");\n` +
			`else if(a[1]==="up"){const project=a[a.indexOf("--project")+1];const up={id:"new-"+project.split("/").pop(),project,head:"abc",mode:"development",state:"ready",url:"http://x.localhost:1355",branch:"b"};s.previews.push(up);out=JSON.stringify(up)}\n` +
			`save();process.stdout.write(out);\n`,
	);
	chmodSync(fake, 0o755);
	const set = (previews: Preview[], extra: object = {}) =>
		writeFileSync(state, JSON.stringify({ previews, calls: [], statusCalls: 0, ...extra }));
	const read = () => JSON.parse(readFileSync(state, "utf8")) as { previews: Preview[]; calls: string[][] };
	/** A task worktree directory with a task row of `status` and, with `run`, a started run. */
	const worktree = (slug: string, status: string, run = false) => {
		const dir = join(f.root, ".worktrees", slug);
		mkdirSync(dir, { recursive: true });
		const ts = new Date().toISOString();
		const id = Number(
			db
				.prepare(
					"INSERT INTO tasks (slug, mode, ref, title, status, created_at, updated_at) VALUES (?, 'implement', ?, ?, ?, ?, ?)",
				)
				.run(slug, slug.toUpperCase(), slug, status, ts, ts).lastInsertRowid,
		);
		const runId = run
			? Number(
					db
						.prepare(
							"INSERT INTO runs (task_id, stage, role, round, status, started_at) VALUES (?, 'implement', 'implementer', 0, 'started', ?)",
						)
						.run(id, ts).lastInsertRowid,
				)
			: 0;
		return { dir, taskId: id, runId };
	};
	const preview = (project: string, id = `p-${project.split("/").pop()}`): Preview => ({ id, project, state: "ready" });
	const common = join(f.root, ".git");
	const logs: string[] = [];
	const slot = (project: string, opts: Record<string, unknown> = {}) =>
		ensurePreviewSlot({
			project,
			root: f.root,
			common,
			limit: 4,
			waitMs: 3000,
			pollMs: 20,
			announceMs: 60_000,
			log: (l: string) => logs.push(l),
			...opts,
		});
	return { ...f, db, set, read, worktree, preview, common, logs, slot };
}

test("OPS-72-slots: a full pool releases only the orphan, then waits for a slot and succeeds; the wait is a run event", async () => {
	const f = slotFixture();
	try {
		const live1 = f.worktree("wp-001", "active", true),
			orphan = f.worktree("wp-002", "merged"),
			drive = f.worktree("wp-003", "merged"),
			live4 = f.worktree("wp-004", "active", true);
		// A live drive keeps its task's preview although its row is merged and no run is open.
		const holder = spawn("sleep", ["30"]);
		mkdirSync(join(evfDataDir(f.root), "drive"), { recursive: true });
		writeFileSync(join(evfDataDir(f.root), "drive", "wp-003.pid"), `${holder.pid}\n`);
		try {
			f.set(
				[
					f.preview(f.root, "p-main"),
					f.preview(live1.dir),
					f.preview(orphan.dir),
					f.preview(drive.dir),
					f.preview(live4.dir),
				],
				{ dropAfter: { id: "p-wp-004", calls: 6 } },
			);
			const env = { ...process.env, EVF_RUN: String(live1.runId) };
			const result = await f.slot(join(f.root, ".worktrees/wp-005"), { env });
			assert.equal(result.reused, false);
			const downs = f.read().calls.filter((c) => c[1] === "down");
			assert.deepEqual(downs, [["preview", "down", "p-wp-002"]], "only the orphan is released");
			const live = f
				.read()
				.previews.filter((p) => p.state === "ready")
				.map((p) => p.id);
			assert.deepEqual(
				live.sort(),
				["p-main", "p-wp-001", "p-wp-003"],
				"the main checkout, a live task and a live drive stay",
			);
			assert.ok(
				f.logs.some((l) => /released previews nobody needs: .*wp-002.*merged with no open run/.test(l)),
				f.logs.join("\n"),
			);
			assert.deepEqual(
				f.logs.filter((l) => /waiting for a preview slot/.test(l)),
				["waiting for a preview slot (4/4 in use)"],
				"announced once",
			);
			const event = f.db
				.prepare("SELECT payload FROM events WHERE run_id = ? AND type = 'preview_wait'")
				.all(live1.runId) as Array<{ payload: string }>;
			assert.equal(event.length, 1);
			assert.match(event[0]!.payload, /waiting for a preview slot \(4\/4 in use\)/);
		} finally {
			holder.kill();
		}
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-slots: a project that has a preview reuses it without waiting; a free pool starts at once", async () => {
	const f = slotFixture();
	try {
		const dirs = ["wp-001", "wp-002", "wp-003", "wp-004"].map((s) => f.worktree(s, "active", true).dir);
		f.set(dirs.map((d) => f.preview(d)));
		const reuse = await f.slot(dirs[0]!);
		assert.equal(reuse.reused, true);
		assert.deepEqual(
			f.read().calls.map((c) => c[1]),
			["status"],
			"one status read, no gc, no down, no wait",
		);
		f.set(dirs.slice(0, 3).map((d) => f.preview(d)));
		assert.equal((await f.slot(join(f.root, ".worktrees/wp-005"))).reused, false);
		assert.deepEqual(f.logs, []);
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-slots: a pool that stays full fails after the bound with the wait, the limit and the projects that hold the slots", async () => {
	const f = slotFixture();
	try {
		const dirs = ["wp-001", "wp-002", "wp-003", "wp-004"].map((s) => f.worktree(s, "active", true).dir);
		f.set(dirs.map((d) => f.preview(d)));
		await assert.rejects(
			f.slot(join(f.root, ".worktrees/wp-005"), { waitMs: 250 }),
			(e: Error) =>
				/No free preview slot after waiting \d+ s: 4\/4 previews in use \(PORTLESS_PREVIEW_LIMIT 4\)\. Held by: /.test(
					e.message,
				) && dirs.every((d) => e.message.includes(d)),
		);
		assert.equal(f.read().calls.filter((c) => c[1] === "down").length, 0, "nothing live was stopped to make room");
		assert.ok(f.logs.some((l) => l === "waiting for a preview slot (4/4 in use)"));
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-slots: expired and failed previews go through gc, and a preview whose project is gone is released", async () => {
	const f = slotFixture();
	try {
		const dirs = ["wp-001", "wp-002", "wp-003"].map((s) => f.worktree(s, "active", true).dir);
		const gone = join(f.root, ".worktrees/wp-gone");
		f.set([
			...dirs.map((d) => f.preview(d)),
			f.preview(gone),
			{ id: "p-failed", project: join(f.root, ".worktrees/wp-failed"), state: "failed" },
		]);
		assert.equal((await f.slot(join(f.root, ".worktrees/wp-005"))).reused, false);
		const calls = f.read().calls.filter((c) => c[1] === "gc" || c[1] === "down");
		assert.deepEqual(calls, [
			["preview", "gc", "--apply"],
			["preview", "down", "p-wp-gone"],
		]);
		assert.equal(f.read().previews.find((p) => p.id === "p-failed")!.state, "removed");
		assert.ok(f.logs.some((l) => /wp-gone no longer exists|project .*wp-gone no longer exists/.test(l)));
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-slots: evf stack up waits for a slot before the portless stack command, and a stub stack command never asks portless", () => {
	const f = slotFixture();
	try {
		f.authorize("WP-001");
		const wt = f.task("wp-001");
		const others = ["wp-002", "wp-003", "wp-004", "wp-005"].map((s) => f.worktree(s, "active", true).dir);
		// The real stack command is scripts/stack.mjs; here it is a script of the fixture that only writes a marker.
		mkdirSync(join(f.root, "scripts"), { recursive: true });
		writeFileSync(join(f.root, "scripts/stack.mjs"), 'console.log("stack started")');
		f.cfg.stack = { usesPaidProviders: false, up: ["node", "scripts/stack.mjs", "up"] };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.git("add", "evf.config.json", "scripts");
		f.git("commit", "-qm", "stack");
		mkdirSync(join(wt, "scripts"), { recursive: true });
		writeFileSync(join(wt, "scripts/stack.mjs"), 'console.log("stack started")');
		// evf runs the check from the driving checkout, so the fixture carries a copy of the skill scripts.
		mkdirSync(join(f.root, ".agents/skills/verify-preview/scripts"), { recursive: true });
		cpSync(
			join(source, ".agents/skills/verify-preview/scripts/preview-slots.mjs"),
			join(f.root, ".agents/skills/verify-preview/scripts/preview-slots.mjs"),
		);
		const env = {
			...process.env,
			EVF_PREVIEW_WAIT_MS: "1500",
			EVF_PREVIEW_POLL_MS: "50",
			PORTLESS_PREVIEW_LIMIT: "4",
			EVF_RUN: "",
			EVF_MONITOR: "test-runner",
		};
		const up = () =>
			spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), "stack", "up", "WP-001"], {
				cwd: f.root,
				encoding: "utf8",
				env,
			});
		f.set(others.map((d) => f.preview(d)));
		const full = up();
		assert.equal(full.status, 1);
		assert.match(full.stderr, /waiting for a preview slot \(4\/4 in use\)/);
		assert.match(full.stderr, /No free preview slot after waiting/);
		assert.doesNotMatch(full.stdout, /stack started/, "the stack does not start while the pool is full");
		f.set(others.slice(0, 2).map((d) => f.preview(d)));
		const free = up();
		assert.equal(free.status, 0, free.stderr);
		assert.match(free.stdout, /stack started/);

		// A stack command that does not start a portless preview never reaches portless.
		f.cfg.stack = { usesPaidProviders: false, up: [process.execPath, "-e", 'console.log("stub stack")'] };
		writeFileSync(join(f.root, "evf.config.json"), JSON.stringify(f.cfg));
		f.set(others.map((d) => f.preview(d)));
		const asked = f.read().calls.length;
		const stub = up();
		assert.equal(stub.status, 0, stub.stderr);
		assert.match(stub.stdout, /stub stack/);
		assert.equal(f.read().calls.length, asked, "portless was not asked");
	} finally {
		f.db.close();
		f.close();
	}
});

test("OPS-72-slots: the verify-preview script asks the same check before it runs portless preview up", () => {
	const text = readFileSync(join(source, ".agents/skills/verify-preview/scripts/preview.mjs"), "utf8");
	assert.match(text, /import \{ ensurePreviewSlot \} from "\.\/preview-slots\.mjs"/);
	assert.ok(
		text.indexOf("await ensurePreviewSlot") > 0 &&
			text.indexOf("await ensurePreviewSlot") < text.indexOf('"preview", "up"'),
	);
});
