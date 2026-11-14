import { sql } from "@everyfield/db/query";
import { owner } from "@everyfield/contracts/common";
import type { PeopleContext } from "@everyfield/contracts/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { nativeWrite, notes, plantSeat, settled } from "../../native.ts";

// The signed-in person's own account: their photo and a request to delete their login. Each runs the account command
// the Settings > Account section runs, for the approving session's own account. Sign-in, password and email changes
// are never Evry tools; Evry points to Settings for them.

// Anyone with a seat in a church may change their own account. An organization login gets only its own profile tool
// for now (T-327), so these stay with church seats.
/** The approving session's own account, the owner every account command takes. */
const own = (context: PeopleContext, accountId: string) => ({
	session: context.session,
	selected: owner.parse({ kind: "account", id: accountId }),
});
const account = (actor: EvryActor) =>
	sql`FROM account a CROSS JOIN LATERAL seat_identity(a.id) n WHERE a.id=${actor.accountId}::uuid`;
const you = sql`jsonb_build_object('kind','account','id',a.id,'label',n.display_name)`;

/**
 * Making a photo the person attached in Evry their own account photo. The upload is their own staged, verified photo
 * that no account uses yet; the card shows its bytes and approval needs them shown (proposals/store.ts).
 */
export const finalizeAvatar = nativeWrite({
	operation: "account.finalizeAvatar",
	description:
		"Propose making a photo the user attached (a photo reference's id) their own account photo. Nothing changes until the user approves the exact review.",
	input: z.strictObject({ uploadId: z.uuid() }),
	allowed: plantSeat,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${you},'changes',jsonb_build_array(jsonb_build_object('field','photo','before',to_jsonb(a.avatar_object_id),'after',${value.uploadId}::text))) AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input',jsonb_build_object('uploadId',${value.uploadId}::uuid)) AS args
			${account(actor)} AND EXISTS(SELECT FROM file_object f WHERE f.id=${value.uploadId}::uuid AND f.tenant_id=a.id AND f.purpose='avatar'
				AND f.state='ready' AND f.expires_at>clock_timestamp() AND NOT EXISTS(SELECT FROM account o WHERE o.avatar_object_id=f.id))`;
	},
	async run(tx, context, request, { authority, ports }) {
		settled(await ports.account.finalizeAvatar(tx, own(context, authority.actor.accountId), request as never));
	},
});

/**
 * Asking to delete the person's own login. It waits 30 days, during which signing in again offers to cancel it. An
 * Owner's account keeps the church running, so its review says what has to happen first and offers no approval, as
 * Settings does.
 */
export const requestDeletion = nativeWrite({
	operation: "account.requestDeletion",
	description:
		"Propose deleting the user's own login (not the church). It is deleted 30 days after approval and can be cancelled until then. Nothing changes until the user approves the exact review.",
	input: z.strictObject({}),
	allowed: plantSeat,
	review(actor) {
		const lines = [
			"Your login is deleted 30 days after you approve. Your church and its records stay.",
			"You are signed out everywhere right away. To cancel within the 30 days, sign in again with your password and choose Cancel deletion.",
		];
		const refusal =
			actor.role === "owner"
				? "You are an Owner, so your church needs another Owner first. Write to Everyfield support to arrange it."
				: null;
		return sql`SELECT jsonb_build_object('target',${you},'changes',jsonb_build_array(jsonb_build_object('field','account','before','active','after','deletion_requested')),
				'notes',${notes(lines)})||CASE WHEN ${refusal}::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal',${refusal}::text) END AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input',jsonb_build_object('confirmed',true)) AS args
			${account(actor)}`;
	},
	async run(tx, context, request, { authority, ports }) {
		settled(await ports.account.requestAccountDeletion(tx, own(context, authority.actor.accountId), request as never));
	},
});

/** The installed account reviewed writes, keyed by operation. */
export const ACCOUNT_COMMANDS = {
	"account.finalizeAvatar": finalizeAvatar,
	"account.requestDeletion": requestDeletion,
} as const;
