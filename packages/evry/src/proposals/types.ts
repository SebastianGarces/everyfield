import type { Database, Transaction } from "@everyfield/db/client";
import type { SQL } from "@everyfield/db/query";
import type { RequestActor } from "@everyfield/domain/access";
import type { createInvitationService } from "@everyfield/domain/identity";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import type { DeletionProducer, NativeAccountProducer, SettingsProducer } from "@everyfield/contracts/settings/server";
import type { DeliveryKeys, DeliveryTransport } from "@everyfield/domain/communication";
import type { MailReport } from "@everyfield/contracts/communication";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { TaskReminders } from "@everyfield/domain/tasks";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";

/**
 * The email service and the keys that seal and hash its addresses. Only a reviewed write that reaches the email
 * service uses it; the deployment passes null when it has no mail keys.
 */
export type MailPort = { transport: DeliveryTransport; keys: DeliveryKeys };

/**
 * The native services a Settings, seat or connection tool calls, built by the deployment with its own mail, job and
 * replan effects, so Evry calls exactly what the Settings screens call. `invitations` builds the invitation service on
 * the connection it is given: the executor passes its own transaction, so the change commits with the proposal outcome.
 */
export type NativePorts = {
	invitations(
		db: Database | Transaction,
	): Pick<ReturnType<typeof createInvitationService>, "invite" | "resend" | "revoke" | "list">;
	organizations: OrganizationAdapter<Transaction>;
	settings: Pick<SettingsProducer<Transaction>, "updatePlantProfile" | "previewPlantTimezone" | "setPlantTimezone">;
	account: Pick<NativeAccountProducer<Transaction>, "finalizeAvatar"> &
		Pick<DeletionProducer<Transaction>, "requestAccountDeletion">;
};

/** What a review may read besides the proposal statement itself. */
export type ReviewContext = { db: Database; mail: MailPort | null; native: NativePorts | null };

/** What a native command needs besides the proposal: the approving session's authority and the native services. */
export type NativeContext = { authority: RequestActor; ports: NativePorts | null };

/**
 * The owning domain write's saved receipt, or the domain's refusal code. `report` is what the email service confirmed;
 * only a write that reaches the email service has one.
 */
type EffectDone = { receiptId?: string; revision: string; report?: MailReport };
export type EffectResult = EffectDone | { refused: string };

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
	 * exact arguments, including the target's current revision), or no row when the target is not available. A review
	 * that must hash addresses first reads them through `context.db`.
	 */
	review(actor: EvryActor, input: I, context: ReviewContext): SQL | Promise<SQL | null>;
	/**
	 * The native command inside the executor's transaction, for the approving session in the proposal's exact context,
	 * with the effect key as its request key. The command checks that session's live seat and role itself. A command that
	 * hands tasks to someone else replans their reminders through `reminders`.
	 */
	execute(
		tx: Transaction,
		context: PeopleContext,
		args: unknown,
		effectKey: string,
		reminders: TaskReminders,
		native: NativeContext,
	): Promise<EffectResult>;
	/**
	 * A fact the review froze that the proposal cannot compare in SQL. The executor runs it inside its transaction on an
	 * effect's first run only, never on a retry of an effect that already started. Returns a refusal code, or null.
	 */
	recheck?(tx: Transaction, context: PeopleContext, args: unknown): Promise<string | null>;
	/**
	 * The second kind of effect: a step that calls the email service. The executor runs it after `execute` committed
	 * and before it saves the outcome, never inside a transaction. It runs again, with the same keys, after a crash, so
	 * each domain command it calls must replay (request key, stored provider key or confirmed answers).
	 */
	reach?(
		db: Database,
		authority: RequestActor,
		args: unknown,
		effectKey: string,
		first: EffectDone,
		mail: MailPort,
	): Promise<EffectResult>;
	/**
	 * Check again after a result the email service has not confirmed: asks it again with a fresh check key and returns
	 * the new report. Only a write whose report can be unconfirmed has it.
	 */
	check?(
		db: Database,
		authority: RequestActor,
		args: unknown,
		keys: { effectKey: string; checkKey: string; revision: string },
		mail: MailPort,
	): Promise<EffectResult>;
};
