import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// WP-028 slice 2 (MAIL51-009): criteria 12 and 13 have no browser. They run the Evry test files themselves, so the
// answer key proves the recorded evals replay and the statement budgets and transaction rule hold at this head.

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
	cwd: root,
	encoding: "utf8",
});
/** The home checkout's env file; node reads it, this test never does. */
const env = join(dirname(common.stdout.trim()), "apps/web/.env.local");

function node(args: string[], cwd: string) {
	return spawnSync(process.execPath, ["--conditions=react-server", `--env-file-if-exists=${env}`, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 420_000,
	});
}
const passed = (r: ReturnType<typeof node>) =>
	`${r.stdout}\n${r.stderr}`
		.split("\n")
		.filter((l) => /^(✖|ℹ fail)/.test(l))
		.join("\n");

test("AC:WP-028-12 the recorded email evals cover draft, schedule, time change, cancel, replace and send-now, and CI replays them", () => {
	const cases = JSON.parse(readFileSync(join(root, "tests/evry/evals/communication.cases.json"), "utf8")) as {
		operation: string;
		expect: string;
	}[];
	const operations = new Set(cases.map((c) => c.operation));
	for (const operation of [
		"communication.saveDraft",
		"communication.scheduleReviewed",
		"communication.rescheduleReviewed",
		"communication.cancelScheduledReviewed",
		"communication.replaceScheduledReviewed",
		"communication.list",
	])
		assert.ok(operations.has(operation), `a case for ${operation}`);
	assert.ok(
		cases.some((c) => c.expect === "draftFirst"),
		"a schedule request on an unsaved composition proposes the draft first",
	);
	assert.ok(
		cases.some((c) => c.expect === "none"),
		"send it now proposes no send",
	);
	const recorded = JSON.parse(readFileSync(join(root, "tests/evry/evals/communication.recorded.json"), "utf8"));
	assert.ok(Object.keys(recorded.streams).length >= cases.length, "every case has recorded calls");
	// The replay makes no paid call: it has no key, and a call without a recording fails.
	const replay = node(["--test", "../../tests/evry/evals/communication.test.mts"], join(root, "packages/evry"));
	assert.equal(replay.status, 0, passed(replay) || replay.stderr.slice(-800));
});

test("AC:WP-028-13 each Evry email review and effect stays within its statement budget and calls the email service outside any transaction", () => {
	const run = node(
		[
			"--test",
			"--test-concurrency=1",
			"--test-name-pattern=AC:WP-028-13",
			"../../tests/evry/adapters/communication/commands/email.test.mts",
		],
		join(root, "packages/evry"),
	);
	assert.equal(run.status, 0, passed(run) || run.stderr.slice(-800));
	assert.match(run.stdout, /✔ AC:WP-028-13 /);
});
