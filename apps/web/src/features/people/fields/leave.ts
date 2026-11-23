import type * as c from "@everyfield/contracts/people";
import type { PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import { personFields as f } from "@everyfield/domain/people";
import type { z } from "zod";
import type { WriteTx } from "@everyfield/domain/access";

type Leave = z.input<typeof c.removeFromHouseholdRequest>;
type Answer = z.infer<typeof c.householdMutationResult>;

export async function leave(
	tx: WriteTx,
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
