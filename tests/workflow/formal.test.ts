import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { mapProblems } from "../../tools/formal/formal.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const MAP = ".agents/skills/formal-permissions/map.json";
const cache = process.env.EVERYFIELD_FORMAL_CACHE ?? join(homedir(), ".cache", "everyfield", "formal");
mkdirSync(cache, { recursive: true });

function formal(...args: string[]) {
	const r = spawnSync(process.execPath, [join(root, "tools/formal/formal.ts"), ...args], {
		cwd: root,
		encoding: "utf8",
		timeout: 9 * 60 * 1000,
	});
	return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function mutant(from: string, to: string) {
	const dir = mkdtempSync(join(cache, "mutant-"));
	cpSync(join(root, "formal/permissions"), dir, { recursive: true });
	const file = join(dir, "Permissions.tla");
	const source = readFileSync(file, "utf8");
	assert.equal(source.split(from).length, 2, `the model no longer has: ${from}`);
	writeFileSync(file, source.replace(from, to));
	return dir;
}

test("INV-formal: the permissions model passes every property and its outcome table, traces and map are current", () => {
	const { status, output } = formal();
	assert.equal(status, 0, output);
	const config = readFileSync(join(root, "formal/permissions/MCPermissions.cfg"), "utf8");
	for (const name of [
		"OneLiveOwner",
		"OwnerSeatFixed",
		"NoInvitationGrantsOwner",
		"OnlyAdministratorsChangeSeats",
		"NoActionOnEndedSeat",
		"TenantAccessNeedsSeat",
		"StatementSeesLiveAccess",
		"NoChangeWithoutAccess",
		"InvitationAcceptedOnce",
		"AcceptOnlyPending",
		"OneSeatPerAcceptance",
	]) {
		assert.match(config, new RegExp(`^\\s+${name}$`, "m"), `${name} is not checked`);
		assert.match(output, new RegExp(`passed\\s+(?:invariant|property)\\s+${name}$`, "m"));
	}
	assert.match(output, /\d+ distinct states/);
	assert.match(output, /outcomes\.json matches the model/);
	assert.match(output, /TLC simulation: 40 traces, \d+ steps, depth 30, seed \d+/);
	assert.match(output, /the traces cover every action: .*Run write refused/);
	assert.match(output, /traces\.json matches the model \(40 traces\)/);
	assert.match(output, /map check passed/);
});

for (const [property, from, to] of [
	[
		"StatementSeesLiveAccess",
		"ReadAdmits(q, cur, session) == LiveCheck(q, cur, session)",
		"ReadAdmits(q, cur, session) == TRUE",
	],
	["OwnerSeatFixed", '    /\\ targetRole # "owner"\n', ""],
] as const)
	test(`INV-formal: TLC fails ${property} with a trace when the model drops its guard`, () => {
		const dir = mutant(from, to);
		try {
			const { status, output } = formal(dir);
			assert.equal(status, 1, output);
			assert.match(output, new RegExp(`FAILED\\s+${property}$`, "m"));
			assert.match(output, new RegExp(`Error: (?:Action property|Invariant) ${property} is violated`));
			assert.match(output, /State 1: <Initial predicate>/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

test("INV-formal: trace generation fails and names an action no generated behavior takes", () => {
	const dir = mutant('Expire(i) ==\n    /\\ invitations[i].state = "pending"\n', "Expire(i) ==\n    /\\ FALSE\n");
	try {
		const { status, output } = formal(dir);
		assert.equal(status, 1, output);
		assert.match(output, /the traces leave out: Expire\./);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("INV-formal: the map check fails when a mapped function no longer exists", () => {
	assert.deepEqual(mapProblems(root, MAP), []);
	const scratch = mkdtempSync(join(cache, "map-"));
	try {
		const map = JSON.parse(readFileSync(join(root, MAP), "utf8"));
		const files = new Set<string>([
			MAP,
			"docs/architecture/decisions.md",
			"docs/catalog/requirements/identity-access.json",
		]);
		for (const e of [...map.actions, ...map.rules, ...map.properties]) for (const c of e.code) files.add(c.file);
		for (const f of map.tests) files.add(f);
		for (const f of files) {
			mkdirSync(dirname(join(scratch, f)), { recursive: true });
			cpSync(join(root, f), join(scratch, f));
		}
		cpSync(join(root, "formal/permissions"), join(scratch, "formal/permissions"), { recursive: true });
		assert.deepEqual(mapProblems(scratch, MAP), []);
		const seats = join(scratch, "packages/domain/src/identity/seats.ts");
		writeFileSync(
			seats,
			readFileSync(seats, "utf8").replace("async function mutation(", "async function seatMutation("),
		);
		assert.ok(mapProblems(scratch, MAP).some((p) => p.includes("seats.ts no longer defines mutation")));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});
