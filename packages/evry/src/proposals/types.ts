import type { Transaction } from "@everyfield/db/client";
import type { SQL } from "@everyfield/db/query";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";

/** The owning domain write's saved receipt, or the domain's refusal code. */
export type EffectResult = { receiptId: string; revision: string } | { refused: string };

/**
 * A reviewed adapter from one durable operation flagged evry_review to its native domain command. The model may only
 * propose it; a person approves the exact review; the executor runs the native command once under live authority.
 */
export type ReviewedWrite<I> = {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	/** Current authority decides availability, the same as the native command's role floor. */
	allowed(actor: EvryActor): boolean;
	/**
	 * One SELECT returning `review` (the target and every change, before and after) and `args` (the native command's
	 * exact arguments, including the target's current revision), or no row when the target is not available.
	 */
	review(actor: EvryActor, input: I): SQL;
	/**
	 * The native command inside the executor's transaction, for the approving session in the proposal's exact context,
	 * with the effect key as its request key. The command checks that session's live seat and role itself.
	 */
	execute(tx: Transaction, context: PeopleContext, args: unknown, effectKey: string): Promise<EffectResult>;
};
