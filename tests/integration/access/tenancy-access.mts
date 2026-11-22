import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { liveAccess, organizationSeatContext } from "../../../packages/domain/src/access/index.ts";

const seats = new Map();
export async function seedAccess(t) {
	for (const seat of await t.rows(sql`SELECT id::text, account_id::text, plant_id::text FROM seat`))
		seats.set(seat.account_id, seat);
}

export function accessCases(t, who) {
	const own = (owner) => {
		const seat = seats.get(owner.id);
		return { session: owner.session, owner: { kind: "plant", id: seat.plant_id }, seatId: seat.id };
	};
	return [
		[
			"access:liveAccess",
			{
				run: async () => ({ status: "ok", value: liveAccess(who.actor) }),
				expected: {
					value: own(who),
					control: (value) => assert.deepEqual(value, own(t.ownerA)),
				},
			},
		],
		[
			"access:organizationSeatContext",
			{
				run: async () => ({ status: "ok", value: organizationSeatContext(who.actor) }),
				expected: { value: null, control: null },
			},
		],
	];
}
