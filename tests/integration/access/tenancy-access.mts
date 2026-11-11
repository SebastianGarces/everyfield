// The access read of INV-tenancy (tenancy.test.mts): liveAccess, which turns the caller's own request actor into the
// session, owner and seat a live-read condition checks. It returns a descriptor and runs no query.
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { liveAccess } from "../../../packages/domain/src/access/index.ts";

/** Each owner's seat as the seat table holds it, so a case names the seat without reading it off the actor. */
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
				// It takes no ids: only the caller's own request actor.
				run: async () => ({ status: "ok", value: liveAccess(who.actor) }),
				expected: {
					value: own(who),
					control: (value) => assert.deepEqual(value, own(t.ownerA)),
				},
			},
		],
	];
}
