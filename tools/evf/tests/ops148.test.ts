import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTask, setTasks, source, writeTask } from "./fixtures.ts";
import { approvedExperience, approvedQuality, mergeFixture, VERIFIER } from "./reconciliation-helpers.ts";
import { ship } from "../ship.ts";

const fastShip = { queue: { waitMs: 10_000, pollMs: 10 }, ciWaitMs: 10_000, ciPollMs: 1 };

/** The 107 task IDs in evf.config.json before the move. The PR body records the check that compared their values. */
const MOVED =
	"OPS-1 OPS-2 OPS-3 OPS-4 OPS-5 OPS-6 OPS-7 OPS-8 OPS-9 OPS-10 OPS-11 OPS-12 OPS-13 OPS-14 OPS-15 OPS-16 OPS-17 OPS-18 OPS-19 OPS-20 OPS-21 OPS-22 OPS-23 OPS-24 OPS-25 OPS-30 OPS-31 OPS-32 OPS-33 OPS-34 OPS-40 OPS-41 OPS-43 OPS-44 OPS-45 OPS-46 OPS-52 OPS-53 OPS-54 OPS-55 OPS-56 OPS-57 OPS-58 OPS-59 OPS-60 OPS-61 OPS-62 OPS-63 OPS-64 OPS-65 OPS-66 OPS-67 OPS-68 OPS-69 OPS-70 OPS-71 OPS-72 OPS-73 OPS-74 OPS-75 OPS-76 OPS-77 OPS-78 OPS-79 OPS-80 OPS-81 OPS-82 OPS-83 OPS-84 OPS-86 OPS-93 OPS-99 OPS-100 OPS-101 OPS-102 OPS-103 OPS-106 OPS-107 OPS-109 OPS-110 OPS-111 OPS-112 OPS-113 OPS-114 OPS-115 OPS-116 OPS-117 OPS-121 OPS-122 OPS-123 OPS-125 OPS-126 OPS-127 OPS-128 OPS-129 OPS-130 OPS-131 OPS-132 OPS-133 OPS-134 OPS-135 OPS-136 OPS-137 OPS-138 OPS-139 OPS-140 OPS-151".split(
		" ",
	);

test("AC:OPS-148-1 evf.config.json holds no entries, and each old entry is a complete file", () => {
	const config = JSON.parse(readFileSync(join(source, "evf.config.json"), "utf8"));
	assert.equal("maintenanceTasks" in config, false);
	assert.equal(MOVED.length, 107);
	for (const id of MOVED) {
		const entry = readTask(source, id);
		assert.ok(entry.title && entry.owningPaths.length && entry.checks.length && entry.risk, id);
	}
	const approvals = MOVED.filter((id) => readTask(source, id).prototypeApproval);
	assert.deepEqual(approvals, ["OPS-84", "OPS-101"]);
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
