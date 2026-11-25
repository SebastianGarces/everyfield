import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../identity/invitations-support.mts";
import { readSwitches, setFlag, switchedOff, type FlagScope } from "../../../packages/domain/src/flags/index.ts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
let f: Fixture;
let plant: Awaited<ReturnType<Fixture["workspace"]>>;
let operator: Awaited<ReturnType<Fixture["account"]>>;

before(async () => {
	f = await fixture();
	plant = await f.workspace();
	operator = await f.account();
	await f.seat(operator, plant, "owner");
});
after(() => f?.close());

test("with no stored value every switch reads on, in one statement", async () => {
	let statements = 0;
	const execute: Fixture["db"]["execute"] = (query) => {
		statements++;
		return f.db.execute(query);
	};
	const counting = { execute };
	assert.deepEqual(await readSwitches(counting), {
		"evry-model-calls": true,
		"outbound-mail": true,
		"document-exports": true,
	});
	assert.equal(statements, 1);
});

test("a switch reads only its global value: workspace and account overrides of a kill flag are ignored", async () => {
	const set = (scope: FlagScope, value: boolean | null) =>
		setFlag(f.db, { flag: "outbound-mail", scope, value, operator: operator.id });
	await set({ kind: "workspace", id: plant.id }, false);
	await set({ kind: "account", id: operator.id }, false);
	assert.equal((await readSwitches(f.db))["outbound-mail"], true);
	await withSwitchOff(f.db, { flag: "outbound-mail", operator: operator.id }, async () => {
		await set({ kind: "workspace", id: plant.id }, true);
		await set({ kind: "account", id: operator.id }, true);
		assert.deepEqual(await readSwitches(f.db), {
			"evry-model-calls": true,
			"outbound-mail": false,
			"document-exports": true,
		});
	});
	await set({ kind: "workspace", id: plant.id }, null);
	await set({ kind: "account", id: operator.id }, null);
	assert.equal((await readSwitches(f.db))["outbound-mail"], true);
});

test("a refused action logs one line naming the switch and the action; an allowed one logs nothing", async () => {
	const { value, lines } = await capturedLines(() =>
		withSwitchOff(f.db, { flag: "document-exports", operator: operator.id }, async () => {
			const switches = await readSwitches(f.db);
			return [
				switchedOff(switches, "document-exports", "documents.exportNative"),
				switchedOff(switches, "outbound-mail", "communication.handOff"),
			];
		}),
	);
	assert.deepEqual(value, [true, false]);
	assert.deepEqual(lines, [
		{ component: "kill-switch", switch: "document-exports", action: "documents.exportNative", outcome: "refused" },
	]);
});
