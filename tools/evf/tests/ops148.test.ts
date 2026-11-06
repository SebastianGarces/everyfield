import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTask, setTasks, source, writeTask } from "./fixtures.ts";
import { approvedExperience, approvedQuality, mergeFixture, VERIFIER } from "./reconciliation-helpers.ts";
import { ship } from "../ship.ts";

const fastShip = { queue: { waitMs: 10_000, pollMs: 10 }, ciWaitMs: 10_000, ciPollMs: 1 };

/** Main's last commit with the shared `maintenanceTasks` object in evf.config.json. */
const BEFORE_THE_MOVE = "0efdd7bec2070bf538fa7711853ba39b3e727283";

test("AC:OPS-148-1 evf.config.json holds no entries, and each old entry is a file with the same values", () => {
	const repo = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8" });
	const config = JSON.parse(readFileSync(join(source, "evf.config.json"), "utf8"));
	assert.equal("maintenanceTasks" in config, false);
	const old = JSON.parse(repo("show", `${BEFORE_THE_MOVE}:evf.config.json`)).maintenanceTasks;
	assert.equal(Object.keys(old).length, 107);
	// A later task may change its own entry, so only a file with one commit, the move, still has the old values.
	const commits = repo("log", "--format=", "--name-only", "--", "tools/evf/tasks/").split("\n").filter(Boolean);
	const moved = (id: string) => commits.filter((path) => path === `tools/evf/tasks/${id}.json`).length <= 1;
	for (const id of Object.keys(old)) {
		const entry = readTask(source, id);
		if (moved(id)) assert.deepEqual(entry, old[id], id);
	}
});

test("AC:OPS-148-6 two OPS PRs that each add their own entry have no path overlap at ship", () => {
	const f = mergeFixture(),
		log = console.log;
	console.log = () => {};
	try {
		const inWt = (...args: string[]) => execFileSync("git", ["-C", f.wt, ...args], { encoding: "utf8" }).trim();
		const landOnMain = (message: string) => {
			f.git("add", "-A", "tools/evf/tasks");
			f.git("commit", "-qm", message);
			f.git("push", "-q", "origin", "main");
		};
		// Neither task is registered on main when the two branches start.
		const entry = readTask(f.root, "OPS-1");
		setTasks(f.root, {});
		landOnMain("No entries");
		inWt("fetch", "-q", "origin", "main");
		inWt("merge", "-q", "--ff-only", "origin/main");
		writeTask(f.wt, "OPS-1", entry);
		inWt("add", "tools/evf/tasks");
		inWt("commit", "-qm", "OPS-1: register");
		const approved = inWt("rev-parse", "HEAD");
		inWt("push", "-q", "origin", `HEAD:refs/heads/${f.taskRef.branch}`);

		// The other PR lands first, with its own entry.
		writeTask(f.root, "OPS-2", { ...entry, title: "The other task" });
		landOnMain("OPS-2: register");

		const pass = {
			name: "CI",
			state: "SUCCESS",
			bucket: "pass",
			link: "https://github.com/test/private/actions/runs/2",
		};
		const state = f.getState();
		state.pr.headRefOid = approved;
		state.comments["77"] = [
			{
				body: `EVF-Review: ${JSON.stringify({ head: approved, verifier: VERIFIER, verdict: "approved", quality: approvedQuality, experience: approvedExperience })}`,
				html_url: "https://github.com/test/private/pull/77#issuecomment-3",
			},
		];
		state.requiredChecks = [pass];
		state.checksQueue = [[pass], [pass]];
		state.calls = [];
		f.setState(state);

		// The fixture's merge barrier is past the Fresh gate: ship updated the branch and asked GitHub to merge.
		assert.throws(() => ship(f.root, f.taskRef, fastShip), /fixture merge barrier/);
		const calls = (sub: string) =>
			f.getState().calls.filter((c: { args: string[] }) => c.args[0] === "pr" && c.args[1] === sub);
		assert.equal(calls("update-branch").length, 1);
		assert.equal(calls("merge").length, 1);
		const head = inWt("rev-parse", "HEAD");
		assert.deepEqual(inWt("diff", "--name-only", approved, head).split("\n"), ["tools/evf/tasks/OPS-2.json"]);
		assert.equal(readTask(f.wt, "OPS-1").title, entry.title);
	} finally {
		console.log = log;
		f.close();
	}
});
