import type * as c from "@everyfield/contracts/people";
import type { PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { Transaction } from "@everyfield/db/client";
import { personFields as f } from "@everyfield/domain/people";
import type { z } from "zod";

type Leave = z.input<typeof c.removeFromHouseholdRequest>;
type Answer = z.infer<typeof c.householdMutationResult>;

/**
 * Takes a person out of their household and, when `deleteEmpty` asks for it, deletes the household in the same
 * transaction. The leave answer holds the household as it is after the person left, so its id and revision are the ones
 * to delete at. A replay with the same key returns the same leave answer, and the delete under its derived key replays
 * too, so both answers stay ok. A refused delete is the answer, and the caller's transaction rolls the leave back.
 */
export async function leave(
	tx: Transaction,
	ctx: PeopleWriteContext,
	request: Leave,
	deleteEmpty: boolean,
): Promise<PeopleReply<Answer>> {
	const left = await f.removeFromHousehold(tx, ctx, request);
	if (left.status !== "ok" || !deleteEmpty || left.value.result.status !== "available") return left;
	const { id, revision } = left.value.result.household;
	const gone = await f.deleteHousehold(tx, ctx, {
		requestKey: `${request.requestKey}:delete`,
		expectedRevision: revision,
		input: { householdId: id },
	});
	return gone.status === "ok" ? left : gone;
}
