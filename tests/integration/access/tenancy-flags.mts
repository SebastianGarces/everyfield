import assert from "node:assert/strict";
import { readFlags, setFlag } from "../../../packages/domain/src/flags/index.ts";

export async function seedFlags(t) {
	await setFlag(t.f.db, {
		flag: "overview-role-subtitle",
		scope: { kind: "workspace", id: t.plantA.id },
		value: true,
		operator: t.ownerA.id,
	});
}

export function flagsCases(t, who) {
	return [
		[
			"flags:readFlags",
			{
				run: async () => ({
					status: "ok",
					value: (await readFlags(t.f.db, who.actor)).value("overview-role-subtitle"),
				}),
				expected: { value: false, control: (value) => assert.equal(value, true) },
			},
		],
	];
}
