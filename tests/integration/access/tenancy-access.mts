import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { liveAccess, organizationSeatContext } from "../../../packages/domain/src/access/index.ts";
import { tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

type SeatRow = { id: string; account_id: string; plant_id: string };
const seats = new Map<string, SeatRow>();
export async function seedAccess(t: Tenancy) {
	for (const seat of await t.rows<SeatRow>(sql`SELECT id::text, account_id::text, plant_id::text FROM seat`))
		seats.set(seat.account_id, seat);
}

export function accessCases(t: Tenancy, who: TenancyOwner) {
	const own = (owner: TenancyOwner) => {
		const seat = seats.get(owner.id)!;
		return { session: owner.session, owner: { kind: "plant", id: seat.plant_id }, seatId: seat.id };
	};
	return [
		tenancyCase("access:liveAccess", async () => ({ status: "ok", value: liveAccess(who.actor) }), {
			value: own(who),
			control: (value) => assert.deepEqual(value, own(t.ownerA)),
		}),
		tenancyCase(
			"access:organizationSeatContext",
			async () => ({ status: "ok", value: organizationSeatContext(who.actor) }),
			{ value: null, control: null },
		),
	];
}
