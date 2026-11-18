import assert from "node:assert/strict";
import { test } from "node:test";
import * as settings from "../../../packages/contracts/src/settings/index.ts";
import * as native from "../../../packages/contracts/src/settings/native.ts";

test("INV-native: the model-safe settings entry exports none of the native-only settings contracts", () => {
	const shared = new Set<unknown>(Object.values(settings));
	assert.ok(Object.keys(native).length > 0);
	assert.deepEqual(
		Object.entries(native)
			.filter(([name, value]) => name in settings || shared.has(value))
			.map(([name]) => name),
		[],
	);
});
