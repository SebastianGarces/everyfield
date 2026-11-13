import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePreviewSlot } from "../../.agents/skills/verify-preview/scripts/preview-slots.mjs";

// OPS-72: previews wait for a free slot. A fake `portless` keeps its previews in a JSON file.
function slotFixture(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "preview-slots-")));
	const state = join(root, "portless-state.json");
	mkdirSync(join(root, "bin"));
	const fake = join(root, "bin/portless");
	writeFileSync(
		fake,
		`#!${process.execPath}\nconst fs=require("node:fs");const a=process.argv.slice(2);const p=${JSON.stringify(state)};\n` +
			`const s=JSON.parse(fs.readFileSync(p,"utf8"));s.calls.push(a);\n` +
			`const mark=(f,to)=>{s.previews=s.previews.map(x=>f(x)?{...x,state:to}:x)};let out="";\n` +
			`if(a[1]==="status"){s.statusCalls++;if(s.dropAfter&&s.statusCalls>=s.dropAfter.calls)mark(x=>x.id===s.dropAfter.id,"removed");out=JSON.stringify(s.previews)}\n` +
			`else if(a[1]==="gc"&&a.includes("--apply"))mark(x=>x.state==="failed"||x.state==="expired","removed");\n` +
			`else if(a[1]==="down")mark(x=>x.id===a[2],"removed");\n` +
			`fs.writeFileSync(p,JSON.stringify(s));process.stdout.write(out);\n`,
	);
	chmodSync(fake, 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${join(root, "bin")}:${path}`;
	t.after(() => {
		process.env.PATH = path;
		rmSync(root, { recursive: true, force: true });
	});
	const set = (previews, extra = {}) =>
		writeFileSync(state, JSON.stringify({ previews, calls: [], statusCalls: 0, ...extra }));
	const read = () => JSON.parse(readFileSync(state, "utf8"));
	const worktree = (slug) => {
		const dir = join(root, ".worktrees", slug);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	const preview = (project, id = `p-${project.split("/").pop()}`) => ({ id, project, state: "ready" });
	const logs = [];
	const slot = (project, opts = {}) =>
		ensurePreviewSlot({
			project,
			limit: 4,
			waitMs: 3000,
			pollMs: 20,
			announceMs: 60_000,
			env: {},
			log: (line) => logs.push(line),
			...opts,
		});
	return { root, set, read, worktree, preview, logs, slot };
}

const downs = (f) => f.read().calls.filter((call) => call[1] === "down");

test("OPS-72-slots: a full pool of live projects stops nothing, waits for a slot and succeeds", async (t) => {
	const f = slotFixture(t);
	const dirs = ["wp-001", "wp-002", "wp-003", "wp-004"].map(f.worktree);
	f.set(
		dirs.map((dir) => f.preview(dir)),
		{ dropAfter: { id: "p-wp-004", calls: 6 } },
	);
	const result = await f.slot(join(f.root, ".worktrees/wp-005"));
	assert.equal(result.reused, false);
	assert.deepEqual(downs(f), [], "a preview whose project exists is never stopped");
	assert.deepEqual(
		f.logs.filter((line) => /waiting for a preview slot/.test(line)),
		["waiting for a preview slot (4/4 in use)"],
		"announced once",
	);
});

test("OPS-72-slots: a project that has a preview reuses it; a free pool starts at once", async (t) => {
	const f = slotFixture(t);
	const dirs = ["wp-001", "wp-002", "wp-003", "wp-004"].map(f.worktree);
	f.set(dirs.map((dir) => f.preview(dir)));
	assert.equal((await f.slot(dirs[0])).reused, true);
	assert.deepEqual(
		f.read().calls.map((call) => call[1]),
		["status"],
		"one status read, no gc, no down, no wait",
	);
	f.set(dirs.slice(0, 3).map((dir) => f.preview(dir)));
	assert.equal((await f.slot(join(f.root, ".worktrees/wp-005"))).reused, false);
	assert.deepEqual(f.logs, []);
});

test("OPS-72-slots: a pool that stays full fails at the bound and names the projects that hold the slots", async (t) => {
	const f = slotFixture(t);
	const dirs = ["wp-001", "wp-002", "wp-003", "wp-004"].map(f.worktree);
	f.set(dirs.map((dir) => f.preview(dir)));
	await assert.rejects(
		f.slot(join(f.root, ".worktrees/wp-005"), { waitMs: 100 }),
		(error) =>
			/No free preview slot after waiting \d+ s: 4\/4 previews in use \(PORTLESS_PREVIEW_LIMIT 4\)\. Held by: /.test(
				error.message,
			) && dirs.every((dir) => error.message.includes(dir)),
	);
	assert.deepEqual(downs(f), [], "nothing live was stopped to make room");
});

test("OPS-72-slots: expired and failed previews go through gc, and a preview whose project is gone is released", async (t) => {
	const f = slotFixture(t);
	const dirs = ["wp-001", "wp-002", "wp-003"].map(f.worktree);
	const gone = join(f.root, ".worktrees/wp-gone");
	f.set([
		...dirs.map((dir) => f.preview(dir)),
		f.preview(gone),
		{ id: "p-failed", project: join(f.root, ".worktrees/wp-failed"), state: "failed" },
	]);
	assert.equal((await f.slot(join(f.root, ".worktrees/wp-005"))).reused, false);
	assert.deepEqual(
		f.read().calls.filter((call) => call[1] === "gc" || call[1] === "down"),
		[
			["preview", "gc", "--apply"],
			["preview", "down", "p-wp-gone"],
		],
	);
	assert.equal(f.read().previews.find((p) => p.id === "p-failed").state, "removed");
	assert.ok(f.logs.some((line) => line.includes("wp-gone: its project no longer exists")));
});

test("OPS-72-slots: the slot check reads no v1 store, because an evf2 run id could name another task's v1 row", () => {
	const text = readFileSync(
		new URL("../../.agents/skills/verify-preview/scripts/preview-slots.mjs", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(text, /node:sqlite|work\.sqlite|EVF_RUN\b/);
});

test("OPS-72-slots: the verify-preview script asks the same check before it runs portless preview up", () => {
	const text = readFileSync(
		new URL("../../.agents/skills/verify-preview/scripts/preview.mjs", import.meta.url),
		"utf8",
	);
	assert.match(text, /import \{ ensurePreviewSlot \} from "\.\/preview-slots\.mjs"/);
	assert.ok(
		text.indexOf("await ensurePreviewSlot") > 0 &&
			text.indexOf("await ensurePreviewSlot") < text.indexOf('"preview", "up"'),
	);
});
