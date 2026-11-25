import { sql } from "@everyfield/db/query";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { anySeat, nativeWrite, notes, ownContext, plantSeat, settled } from "../../native.ts";

const account = (actor: EvryActor) =>
	sql`FROM account a CROSS JOIN LATERAL seat_identity(a.id) n WHERE a.id=${actor.accountId}::uuid`;
const you = sql`jsonb_build_object('kind','account','id',a.id,'label',n.display_name)`;

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
		settled(await ports.account.finalizeAvatar(tx, ownContext(context, authority.actor.accountId), request));
	},
});

export const removeAvatar = nativeWrite({
	operation: "account.removeAvatar",
	description:
		"Propose removing the user's own account photo; their initials show instead. Nothing changes until the user approves the exact review.",
	input: z.strictObject({}),
	allowed: anySeat,
	review(actor) {
		return sql`SELECT jsonb_build_object('target',${you},'changes',jsonb_build_array(jsonb_build_object('field','accountPhoto',
				'before',CASE WHEN a.avatar_object_id IS NULL THEN 'none' ELSE 'shown' END,'after','none')),
				'notes',${notes(["Your initials show instead. You can add a photo again at any time."])})
				||CASE WHEN a.avatar_object_id IS NULL THEN jsonb_build_object('refusal','You have no account photo, so there is nothing to remove.') ELSE '{}'::jsonb END AS review,
			jsonb_build_object('expectedRevision',a.revision::text,'input',jsonb_build_object()) AS args
			${account(actor)}`;
	},
	async run(tx, context, request, { authority, ports }) {
		settled(await ports.account.removeAvatar(tx, ownContext(context, authority.actor.accountId), request));
	},
});

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
		settled(await ports.account.requestAccountDeletion(tx, ownContext(context, authority.actor.accountId), request));
	},
});

export const ACCOUNT_COMMANDS = {
	"account.finalizeAvatar": finalizeAvatar,
	"account.removeAvatar": removeAvatar,
	"account.requestDeletion": requestDeletion,
} as const;
