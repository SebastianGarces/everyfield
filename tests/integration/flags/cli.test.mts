import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { GLOBAL_TENANT, setFlag } from "../../../packages/domain/src/flags/index.ts";
import { FlagError, removalAsk, runFlag } from "../../../tools/flag/flag.ts";

const flag = (kind, extra = {}) => ({
	owner: "Tests",
	task: "T-471",
	kind,
	default: kind === "kill",
	created: "2026-11-01",
	expires: "2027-03-01",
	...extra,
});
const declared = {
	"cli-list": flag("release"),
	"cli-kill": flag("kill"),
	"cli-show": flag("ops"),
	"cli-target": flag("release"),
	"cli-flip": flag("release"),
	"cli-flip-kill": flag("kill"),
	"cli-stale-13": flag("release"),
	"cli-stale-15": flag("release", { owner: "Nora" }),
	"cli-stale-ops": flag("ops"),
	"cli-stale-override": flag("release"),
};

let f, plant, account, operator;
before(async () => {
	f = await fixture();
	plant = await f.workspace();
	account = await f.account();
	operator = await f.account();
});
after(() => f?.close());

function stubEvf(answers = {}) {
	const calls = [];
	const evf = (args) => {
		calls.push([...args]);
		const answer = answers[args.slice(0, 2).join(" ")];
		if (typeof answer === "function") return answer(args);
		return answer ?? { status: 0, stdout: "", stderr: "" };
	};
	return { evf, calls };
}

async function cli(argv, { evf = stubEvf().evf, ci = false } = {}) {
	const out = [];
	const err = [];
	try {
		await runFlag(argv, {
			db: f.admin,
			target: "a throwaway test database",
			evf,
			out: (line) => out.push(line),
			err: (line) => err.push(line),
			ci,
			declared,
		});
		return { code: 0, out, err };
	} catch (error) {
		if (!(error instanceof FlagError)) throw error;
		return { code: error.code, out, err, message: error.message };
	}
}

const stored = async (name) =>
	(
		await f.admin.execute(sql`SELECT f.tenant_id::text AS tenant, f.value FROM feature_flag f WHERE f.name=${name}
 ORDER BY f.tenant_id`)
	).rows;
const audits = async (name) =>
	(
		await f.admin.execute(sql`SELECT a.tenant_id::text AS tenant, a.actor_id::text AS actor, a.system_cause AS cause,
 a.before_value->'value' AS before, a.after_value->'value' AS after, a.metadata
 FROM audit_event a JOIN feature_flag f ON f.id=a.subject_id
 WHERE a.action='flags.changed' AND f.name=${name} ORDER BY a.occurred_at, a.id`)
	).rows;

test("list prints every registry flag with its kind, default, owner, task, expiry and stored global value", async () => {
	await setFlag(f.admin, { flag: "cli-list", scope: { kind: "global" }, value: true, operator: operator.id }, declared);
	await setFlag(
		f.admin,
		{ flag: "cli-kill", scope: { kind: "global" }, value: false, operator: operator.id },
		declared,
	);
	const r = await cli(["list"]);
	assert.equal(r.code, 0);
	assert.deepEqual(r.err, ["bin/flag: target a throwaway test database"]);
	assert.deepEqual(r.out, [
		"NAME                KIND     DEFAULT  OWNER  TASK   EXPIRES     GLOBAL",
		"cli-list            release  off      Tests  T-471  2027-03-01  on",
		"cli-kill            kill     on       Tests  T-471  2027-03-01  off",
		"cli-show            ops      off      Tests  T-471  2027-03-01  unset",
		"cli-target          release  off      Tests  T-471  2027-03-01  unset",
		"cli-flip            release  off      Tests  T-471  2027-03-01  unset",
		"cli-flip-kill       kill     on       Tests  T-471  2027-03-01  unset",
		"cli-stale-13        release  off      Tests  T-471  2027-03-01  unset",
		"cli-stale-15        release  off      Nora   T-471  2027-03-01  unset",
		"cli-stale-ops       ops      off      Tests  T-471  2027-03-01  unset",
		"cli-stale-override  release  off      Tests  T-471  2027-03-01  unset",
	]);
});

test("show prints one flag's declaration, global value and every workspace and account override; an unknown name is refused", async () => {
	await setFlag(
		f.admin,
		{ flag: "cli-show", scope: { kind: "global" }, value: false, operator: operator.id },
		declared,
	);
	await setFlag(
		f.admin,
		{ flag: "cli-show", scope: { kind: "workspace", id: plant.id }, value: true, operator: operator.id },
		declared,
	);
	await setFlag(
		f.admin,
		{ flag: "cli-show", scope: { kind: "account", id: account.id }, value: false, operator: operator.id },
		declared,
	);
	const r = await cli(["show", "cli-show"]);
	assert.equal(r.code, 0);
	assert.deepEqual(r.out, [
		"cli-show",
		"  kind ops, default off, owner Tests, task T-471, created 2026-11-01, expires 2027-03-01",
		"  global: off",
		"  overrides:",
		`    account ${account.id}: off`,
		`    workspace (plant) ${plant.id}: on`,
	]);
	const quiet = await cli(["show", "cli-target"]);
	assert.deepEqual(quiet.out.slice(2), ["  global: unset", "  overrides: none"]);
	const unknown = await cli(["show", "no-such-flag"]);
	assert.equal(unknown.code, 1);
	assert.equal(unknown.message, "No flag no-such-flag in the registry (packages/domain/src/flags/registry.ts).");
});

test("set --workspace and --account (by id or sign-in email) store the override through setFlag with one flags.changed audit row, and show reflects it", async () => {
	const ws = await cli(["set", "cli-target", "on", "--workspace", plant.id]);
	assert.equal(ws.code, 0, ws.message);
	assert.deepEqual(ws.out, [`cli-target: on for workspace ${plant.id}.`]);
	const acc = await cli(["set", "cli-target", "off", "--account", account.id]);
	assert.deepEqual(acc.out, [`cli-target: off for account ${account.id}.`]);
	assert.deepEqual(
		(await stored("cli-target")).sort((a, b) => a.tenant.localeCompare(b.tenant)),
		[
			{ tenant: plant.id, value: true },
			{ tenant: account.id, value: false },
		].sort((a, b) => a.tenant.localeCompare(b.tenant)),
	);
	assert.deepEqual(await audits("cli-target"), [
		{
			tenant: plant.id,
			actor: null,
			cause: "bin/flag",
			before: null,
			after: true,
			metadata: { flag: "cli-target", scope: "workspace" },
		},
		{
			tenant: account.id,
			actor: null,
			cause: "bin/flag",
			before: null,
			after: false,
			metadata: { flag: "cli-target", scope: "account" },
		},
	]);
	const shown = await cli(["show", "cli-target"]);
	assert.ok(shown.out.includes(`    workspace (plant) ${plant.id}: on`), shown.out.join("\n"));
	assert.ok(shown.out.includes(`    account ${account.id}: off`), shown.out.join("\n"));
	const again = await cli(["set", "cli-target", "on", "--workspace", plant.id]);
	assert.equal(again.code, 0);
	assert.equal((await audits("cli-target")).length, 2, "setting the value a flag already holds writes no audit row");
	const cleared = await cli(["set", "cli-target", "clear", "--account", account.email.toUpperCase()]);
	assert.deepEqual(cleared.out, [`cli-target: cleared for account ${account.id}.`]);
	assert.equal((await audits("cli-target")).at(-1).after, null);
	assert.ok(!(await cli(["show", "cli-target"])).out.some((line) => line.includes(account.id)));
});

test("set refuses a wrong-kind, unknown or missing id and a missing scope, and writes nothing", async () => {
	const before = [await stored("cli-target"), await audits("cli-target")];
	const refusals = [
		[
			["set", "cli-target", "on", "--workspace", account.id],
			1,
			`No plant or organization ${account.id} in a throwaway test database. Nothing changed.`,
		],
		[
			["set", "cli-target", "on", "--account", plant.id],
			1,
			`No account ${plant.id} in a throwaway test database. Nothing changed.`,
		],
		[
			["set", "cli-target", "on", "--account", "00000000-0000-4000-8000-000000000001"],
			1,
			"No account 00000000-0000-4000-8000-000000000001 in a throwaway test database. Nothing changed.",
		],
		[
			["set", "cli-target", "on", "--account", "nora"],
			1,
			"--account nora is not an account id (a uuid) or a sign-in email.",
		],
		[
			["set", "cli-target", "on", "--account", "nobody@example.test"],
			1,
			"No single account signs in as nobody@example.test in a throwaway test database. Nothing changed.",
		],
		[["set", "cli-target", "on", "--workspace", "plant-a"], 1, "--workspace plant-a is not an id (a uuid)."],
		[["set", "cli-target", "on", "--workspace"], 2, "--workspace needs a value."],
		[["set", "cli-target", "on"], 2, "Give exactly one of --workspace <id>, --account <id> or --all."],
		[
			["set", "cli-target", "on", "--all", "--account", account.id],
			2,
			"Give exactly one of --workspace <id>, --account <id> or --all.",
		],
		[["set", "cli-target", "maybe", "--all"], 2, "Say on, off or clear."],
		[
			["set", "not-registered", "on", "--all"],
			1,
			"No flag not-registered in the registry (packages/domain/src/flags/registry.ts).",
		],
	];
	for (const [argv, code, message] of refusals) {
		const r = await cli(argv);
		assert.deepEqual([r.code, r.message], [code, message], argv.join(" "));
	}
	assert.deepEqual([await stored("cli-target"), await audits("cli-target")], before);
});

const flip = (state, decision = null) => ({
	"flip status": (args) => ({ status: 0, stdout: JSON.stringify({ flag: args[2], state, decision }), stderr: "" }),
});

test("set --all turns a release flag on for everyone only when evf flip status says approved", async () => {
	const ask = 'Ask with: evf flip request cli-flip --task T-471 --note "<why it may go on for everyone>"';
	const lead = "Refused: turning the release flag cli-flip on for everyone needs an approved flip.";
	const cases = [
		[flip("open", "D-9001"), `${lead} evf flip status says open (D-9001). ${ask}`],
		[flip("declined", "D-9002"), `${lead} evf flip status says declined (D-9002). ${ask}`],
		[flip("none"), `${lead} evf flip status says none. ${ask}`],
		[
			{ "flip status": () => ({ status: 2, stdout: "", stderr: "error: no such command\n" }) },
			`${lead} evf flip status failed (exit 2): error: no such command ${ask}`,
		],
		[
			{ "flip status": () => ({ status: null, stdout: "", stderr: "" }) },
			`${lead} evf is not reachable here, so the flip cannot be checked. ${ask}`,
		],
		[
			{ "flip status": () => ({ status: 0, stdout: "approved", stderr: "" }) },
			`${lead} evf flip status printed output bin/flag cannot read. ${ask}`,
		],
		[
			{
				"flip status": () => ({
					status: 0,
					stdout: JSON.stringify({ flag: "other", state: "approved", decision: "D-1" }),
					stderr: "",
				}),
			},
			`${lead} evf flip status answered for other, not cli-flip. ${ask}`,
		],
	];
	for (const [answers, message] of cases) {
		const { evf, calls } = stubEvf(answers);
		const r = await cli(["set", "cli-flip", "on", "--all"], { evf });
		assert.deepEqual([r.code, r.message], [1, message]);
		assert.deepEqual(calls, [["flip", "status", "cli-flip", "--json"]]);
	}
	assert.deepEqual(await stored("cli-flip"), [], "a refused flip writes nothing");

	const approved = stubEvf(flip("approved", "D-9003"));
	const on = await cli(["set", "cli-flip", "on", "--all"], { evf: approved.evf });
	assert.deepEqual([on.code, on.out], [0, ["cli-flip: on for everyone (flip D-9003 approved)."]]);
	assert.deepEqual(await stored("cli-flip"), [{ tenant: GLOBAL_TENANT, value: true }]);
	assert.deepEqual(
		(await audits("cli-flip")).map((a) => [a.tenant, a.cause, a.after, a.metadata.scope]),
		[[GLOBAL_TENANT, "bin/flag", true, "global"]],
	);
});

test("turning a flag off for everyone, clearing it, and a kill or ops flag need no flip approval", async () => {
	const { evf, calls } = stubEvf(flip("declined"));
	for (const argv of [
		["set", "cli-flip", "off", "--all"],
		["set", "cli-flip", "clear", "--all"],
		["set", "cli-flip-kill", "off", "--all"],
		["set", "cli-flip-kill", "on", "--all"],
		["set", "cli-stale-ops", "off", "--all"],
	]) {
		const r = await cli(argv, { evf });
		assert.equal(r.code, 0, `${argv.join(" ")}: ${r.message}`);
	}
	assert.deepEqual(calls, []);
	assert.deepEqual(await stored("cli-flip-kill"), [{ tenant: GLOBAL_TENANT, value: true }]);
});

async function onForEveryone(name, days, scope = { kind: "global" }) {
	await setFlag(f.admin, { flag: name, scope, value: true, operator: operator.id }, declared);
	await f.admin.execute(sql`UPDATE audit_event a SET occurred_at=clock_timestamp()-make_interval(days=>${days}::int)
 FROM feature_flag f WHERE f.id=a.subject_id AND f.name=${name} AND a.action='flags.changed'`);
}

test("stale lists release flags on for everyone and unchanged for 14 or more days, with the evf task new command for each", async () => {
	await onForEveryone("cli-stale-13", 13);
	await onForEveryone("cli-stale-15", 15);
	await onForEveryone("cli-stale-ops", 20);
	await onForEveryone("cli-stale-override", 20, { kind: "workspace", id: plant.id });
	const r = await cli(["stale"]);
	assert.equal(r.code, 0, r.message);
	const [row] = (
		await f.admin
			.execute(sql`SELECT max(a.occurred_at) AS at FROM audit_event a JOIN feature_flag f ON f.id=a.subject_id
 WHERE f.name='cli-stale-15'`)
	).rows;
	const since = new Date(row.at);
	const day = since.toISOString().slice(0, 10);
	const ask = removalAsk("cli-stale-15", declared["cli-stale-15"], since).replaceAll("'", "'\\''");
	assert.deepEqual(r.out, [
		"Release flags on for everyone for 14 or more days: 1",
		`cli-stale-15  on since ${day} (15 days), owner Nora, task T-471`,
		`  printf '%s\\n' '${ask}' | evf task new --title 'Remove the cli-stale-15 feature flag' --label 'flag:cli-stale-15' --author 'bin/flag stale' --ask-file /dev/stdin`,
	]);
	assert.equal(
		removalAsk("cli-stale-15", declared["cli-stale-15"], since),
		`Remove the release flag cli-stale-15 (owner Nora, from T-471). It has been on for everyone since ${day}. Delete its entry in packages/domain/src/flags/registry.ts, the off branch at every readFlag("cli-stale-15") and the tests of the off path; typecheck then names any read that is left (docs/architecture/patterns.md, Feature flags).`,
	);
});

test("stale --file files each removal once through evf and skips a flag whose removal task is already open", async () => {
	const open = [];
	let asked = null;
	const { evf, calls } = stubEvf({
		"task list": () => ({ status: 0, stdout: JSON.stringify(open), stderr: "" }),
		"task new": (args) => {
			asked = readFileSync(args[args.indexOf("--ask-file") + 1], "utf8");
			open.push({ id: 9100, label: args[args.indexOf("--label") + 1], lifecycle: "open", title: "x" });
			return { status: 0, stdout: "Filed T-9100.\n", stderr: "" };
		},
	});
	const first = await cli(["stale", "--file"], { evf });
	assert.equal(first.code, 0, first.message);
	assert.equal(first.out.at(-1), "filed cli-stale-15: Filed T-9100.");
	assert.deepEqual(
		calls.map((c) => c.slice(0, 2).join(" ")),
		["task list", "task new"],
	);
	const filed = calls[1];
	assert.deepEqual(filed.slice(0, 8), [
		"task",
		"new",
		"--title",
		"Remove the cli-stale-15 feature flag",
		"--label",
		"flag:cli-stale-15",
		"--author",
		"bin/flag stale",
	]);
	assert.match(asked, /^Remove the release flag cli-stale-15 \(owner Nora, from T-471\)\. /);
	const rerun = await cli(["stale", "--file"], { evf });
	assert.equal(rerun.out.at(-1), "skipped cli-stale-15: T-9100 is already open.");
	assert.equal(calls.filter((c) => c[1] === "new").length, 1, "the rerun files nothing");

	const unreachable = await cli(["stale", "--file"], {
		evf: stubEvf({ "task list": () => ({ status: null, stdout: "", stderr: "" }) }).evf,
	});
	assert.deepEqual(
		[unreachable.code, unreachable.message],
		[1, "evf is not reachable on this Mac (evf task list failed). Nothing filed."],
	);
	const ci = stubEvf();
	const fromCi = await cli(["stale", "--file"], { evf: ci.evf, ci: true });
	assert.deepEqual([fromCi.code, fromCi.message], [1, "bin/flag stale --file never files from CI. Nothing filed."]);
	assert.deepEqual(ci.calls, []);
	const printed = await cli(["stale"], { evf: ci.evf, ci: true });
	assert.equal(printed.out.length, 3, "under CI it still prints");
	assert.deepEqual(ci.calls, []);
});
