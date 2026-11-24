import assert from "node:assert/strict";
import { readFlags, setFlag } from "../../../packages/domain/src/flags/index.ts";
import { tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

export async function seedFlags(t: Tenancy) {
	await setFlag(t.f.db, {
		flag: "overview-role-subtitle",
		scope: { kind: "workspace", id: t.plantA.id },
		value: true,
		operator: t.ownerA.id,
	});
}

export function flagsCases(t: Tenancy, who: TenancyOwner) {
	return [
		tenancyCase(
			"flags:readFlags",
			async () => ({
				status: "ok",
				value: (await readFlags(t.f.db, who.actor)).value("overview-role-subtitle"),
			}),
			{ value: false, control: (value) => assert.equal(value, true) },
		),
	];
}
