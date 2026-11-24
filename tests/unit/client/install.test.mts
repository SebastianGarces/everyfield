import "../runs-in/react-server.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(globalThis, { window: {} });
const { reinstall } = await import("../../../apps/web/src/components/install.ts");

test("INV-install: a second install under a key gets the first install's value, and keys never share a value", () => {
	const first = { remove: () => "first" };
	const second = { remove: () => "second" };
	const other = { remove: () => "other" };
	const key = Symbol.for("everyfield.test.install");
	const otherKey = Symbol.for("everyfield.test.other-install");

	assert.equal(reinstall(key, first), undefined);
	assert.equal(reinstall(otherKey, other), undefined, "a different key gets nothing");
	assert.equal(reinstall(key, second), first);
	assert.equal(reinstall(otherKey, other), other, "the other key still holds only its own value");
	assert.equal(reinstall(key, first), second);
});
