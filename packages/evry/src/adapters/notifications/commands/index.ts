import type { Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { digestCadence, notificationCategory, type NotificationReply } from "@everyfield/contracts/notifications";
import {
	defaultChannelEnabled,
	defaultDigestCadence,
	notificationChannels,
	residencyCategories,
} from "@everyfield/contracts/settings";
import { OVERSIGHT_SLOT, lockedNotificationWrites, noticeVisible, selfSql } from "@everyfield/domain/notifications";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, ReviewedWrite } from "../../../proposals/types.ts";
import { ownerOrAdmin } from "../../people/commands/index.ts";
import { inPlant, organizationOwnerOrAdmin } from "../reads/index.ts";

// The Notifications reviewed writes (WP-082). Each one changes only the signed-in account's own bell or settings: no
// input names an account, and the native command runs for the approving session's own account. Each review is one
// SELECT under the proposal's statement that reads the account's current state through the bell's own visibility rule
// and saves the native command's exact arguments with the account revision it saw. On approval the executor runs the
// native command once inside its transaction, with the effect key as its request key, so a second approval or a
// retry replays the first answer instead of writing again. Marking read never completes or changes a task (NTF-003).

/** One reviewed write: `review` selects the review and `args`; `run` is the native command on the executor's gate. */
function reviewed<I>(spec: {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	review(actor: EvryActor, input: I): SQL;
	run(tx: Transaction, raw: unknown): Promise<NotificationReply<unknown>>;
}): ReviewedWrite<I> {
	return {
		operation: spec.operation,
		description: spec.description,
		input: spec.input,
		allowed: spec.allowed,
		review: spec.review,
		async execute(tx, _context, args, effectKey): Promise<EffectResult> {
			const reply = await spec.run(tx, { ...z.object({}).loose().parse(args), requestKey: effectKey });
			return reply.status === "ok" ? { own: true } : { refused: reply.error.code };
		},
	};
}

/** The signed-in account (`me`, the bell's own rule) and its current revision, which every native write checks. */
const me = (actor: EvryActor) => selfSql(actor.session, actor.accountId);
const revision = sql`(SELECT a.revision::text FROM account a WHERE a.id=(SELECT account_id FROM me))`;
/** The account's unread notices, as the bell shows them, as `n`; the church's zone names their local time. */
const unread = (ids: string[] | null) =>
	sql`SELECT n.id,n.title,split_part(n.logical_key,'/',2) AS category,n.eligible_at,
			to_char(n.eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
		FROM notice n WHERE ${noticeVisible()} AND n.read_at IS NULL
			${ids ? sql`AND n.id=ANY(${sql.param(ids)}::uuid[])` : sql``}`;
const zone = (actor: EvryActor) => sql`(SELECT timezone FROM plant WHERE id=${actor.owner.id}::uuid)`;

/**
 * The categories Settings > Notifications offers in a church. Launch milestones send nothing yet (D-762), the
 * oversight digest belongs to organization Evry, and the residency categories reach only a linked resident, who holds
 * no seat in a church (T-365).
 */
const settable = notificationCategory.exclude(["launch_milestone", "oversight_digest", ...residencyCategories]);
const choice = z
	.strictObject({ category: settable, channel: z.enum(["email", "in_app"]), enabled: z.boolean() })
	.refine((c) => notificationChannels(c.category).includes(c.channel), "This category has no email channel.");

/** The installed Notifications reviewed writes, keyed by operation. */
export const NOTIFICATION_COMMANDS = {
	"notifications.markSelectedRead": reviewed({
		operation: "notifications.markSelectedRead",
		description:
			"Propose marking some of the user's own notifications read, by the notice ids a notifications read returned. The review lists each one. Nothing is marked until the user approves the exact review.",
		input: z.strictObject({ noticeIds: z.array(z.uuid()).min(1).max(50) }),
		allowed: inPlant,
		review(actor, value) {
			// Only the account's own unread notices among the ids: another account's id, or one already read, drops out.
			return sql`WITH ${me(actor)}, n AS (${unread(value.noticeIds)})
			SELECT jsonb_build_object('target','null'::jsonb,'changes',(SELECT jsonb_agg(jsonb_build_object('field','notice',
					'before',jsonb_build_object('id',n.id,'title',n.title,'category',n.category,'at',n.at,'zone',${zone(actor)}),
					'after','read') ORDER BY n.eligible_at DESC,n.id) FROM n)) AS review,
				jsonb_build_object('expectedRevision',${revision},'input',jsonb_build_object('noticeIds',
					(SELECT jsonb_agg(n.id ORDER BY n.eligible_at DESC,n.id) FROM n))) AS args
			WHERE EXISTS(SELECT FROM n)`;
		},
		run: lockedNotificationWrites.markSelectedRead,
	}),
	"notifications.markAllVisibleRead": reviewed({
		operation: "notifications.markAllVisibleRead",
		description:
			"Propose marking every unread notification the user's bell shows now as read. The review states how many. One that arrives after the review stays unread. Nothing is marked until the user approves the exact review.",
		input: z.strictObject({}),
		allowed: inPlant,
		review(actor) {
			// The cutoff is the newest unread notice the review counted, so the approval marks exactly what it showed.
			return sql`WITH ${me(actor)}, n AS (${unread(null)})
			SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
					jsonb_build_object('field','unread','before',x.count,'after',0))) AS review,
				jsonb_build_object('expectedRevision',${revision},'input',jsonb_build_object('cutoff',
					to_char(x.newest AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) AS args
			FROM (SELECT count(*)::int AS count,max(n.eligible_at) AS newest FROM n) x WHERE x.count>0`;
		},
		run: lockedNotificationWrites.markAllVisibleRead,
	}),
	"notifications.setPreferences": reviewed({
		operation: "notifications.setPreferences",
		description:
			"Propose turning the user's own email or in-app notifications on or off for one or more categories, as Settings > Notifications does. Task reminders are task_due and task_overdue. Each person sets only their own. Nothing changes until the user approves the exact review.",
		input: z.strictObject({
			choices: z
				.array(choice)
				.min(1)
				.max(20)
				.refine((v) => new Set(v.map((c) => `${c.category}:${c.channel}`)).size === v.length, "Each choice once."),
		}),
		allowed: inPlant,
		review(actor, value) {
			// Every channel of each category asked about, so the review also says which ones stay as they are.
			const asked = new Map(value.choices.map((c) => [`${c.category}:${c.channel}`, c.enabled]));
			const rows = [...new Set(value.choices.map((c) => c.category))].flatMap((category) =>
				notificationChannels(category).map((channel) => ({
					category,
					channel,
					after: asked.get(`${category}:${channel}`) ?? null,
					fallback: defaultChannelEnabled(category, channel),
				})),
			);
			return sql`WITH ${me(actor)}, k AS (
				SELECT k.n,k.category,k.channel,coalesce(p.enabled,k.fallback) AS before,
					coalesce(k.after,p.enabled,k.fallback) AS after
				FROM jsonb_to_recordset(${JSON.stringify(rows.map((r, n) => ({ n, ...r })))}::jsonb)
					AS k(n int,category text,channel text,after boolean,fallback boolean)
				LEFT JOIN notification_preference p ON p.account_id=(SELECT account_id FROM me)
					AND p.category=k.category AND p.channel=k.channel)
			SELECT jsonb_build_object('target','null'::jsonb,
					'changes',(SELECT jsonb_agg(jsonb_build_object('field',k.category||'.'||k.channel,'before',k.before,'after',k.after) ORDER BY k.n) FROM k))
				|| CASE WHEN EXISTS(SELECT FROM k WHERE k.before<>k.after) THEN '{}'::jsonb
					ELSE jsonb_build_object('refusal','These notifications are already set that way, so nothing would change.') END AS review,
				jsonb_build_object('expectedRevision',${revision},'input',jsonb_build_object('choices',coalesce(
					(SELECT jsonb_agg(jsonb_build_object('category',k.category,'channel',k.channel,'enabled',k.after) ORDER BY k.n)
						FROM k WHERE k.before<>k.after),'[]'::jsonb))) AS args
			WHERE EXISTS(SELECT FROM me)`;
		},
		run: lockedNotificationWrites.setPreferences,
	}),
	"notifications.digestCadence.set": reviewed({
		operation: "notifications.digestCadence.set",
		description:
			"Propose how often the user's own church digest comes: daily or weekly, the only choices Settings offers. It keeps the church's send day and hour. Owner or Admin. Nothing changes until the user approves the exact review.",
		input: z.strictObject({ cadence: digestCadence.describe("daily or weekly; there is no other choice") }),
		allowed: ownerOrAdmin,
		review(actor, value) {
			const slot = (cadence: SQL) =>
				sql`jsonb_build_object('cadence',${cadence},'weekday',pl.digest_weekday,'hour',pl.digest_hour)`;
			return sql`WITH ${me(actor)}, x AS (
				SELECT coalesce((SELECT p.cadence FROM notification_preference p WHERE p.account_id=(SELECT account_id FROM me)
					AND p.category='planter_digest' AND p.cadence IS NOT NULL LIMIT 1),'weekly') AS before)
			SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(jsonb_build_object('field','planter_digest.cadence',
					'before',${slot(sql`x.before`)},'after',${slot(sql`${value.cadence}::text`)})))
				|| CASE WHEN x.before<>${value.cadence}::text THEN '{}'::jsonb
					ELSE jsonb_build_object('refusal','Your church digest already comes this often, so nothing would change.') END AS review,
				jsonb_build_object('expectedRevision',${revision},'input',jsonb_build_object('plantId',pl.id,'cadence',${value.cadence}::text)) AS args
			FROM x CROSS JOIN plant pl WHERE pl.id=${actor.owner.id}::uuid AND EXISTS(SELECT FROM me)`;
		},
		run: lockedNotificationWrites.setDigestCadence,
	}),
	"notifications.oversightDigestCadence.set": reviewed({
		operation: "notifications.oversightDigestCadence.set",
		description:
			"Propose how often the user's own oversight digest comes: daily or weekly, the only choices Settings offers. It always goes out at 07:00 in the organization's zone, on Mondays when weekly. Owner or Admin. Each person sets only their own. Nothing changes until the user approves the exact review.",
		input: z.strictObject({ cadence: digestCadence.describe("daily or weekly; there is no other choice") }),
		allowed: organizationOwnerOrAdmin,
		review(actor, value) {
			const slot = (cadence: SQL) =>
				sql`jsonb_build_object('cadence',${cadence},'weekday',${OVERSIGHT_SLOT.weekday}::int,'hour',${OVERSIGHT_SLOT.hour}::int)`;
			return sql`WITH ${me(actor)}, x AS (
				SELECT coalesce((SELECT p.cadence FROM notification_preference p WHERE p.account_id=(SELECT account_id FROM me)
					AND p.category='oversight_digest' AND p.cadence IS NOT NULL LIMIT 1),${defaultDigestCadence.oversight_digest}::text) AS before)
			SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(jsonb_build_object('field','oversight_digest.cadence',
					'before',${slot(sql`x.before`)},'after',${slot(sql`${value.cadence}::text`)})))
				|| CASE WHEN x.before<>${value.cadence}::text THEN '{}'::jsonb
					ELSE jsonb_build_object('refusal','Your oversight digest already comes this often, so nothing would change.') END AS review,
				jsonb_build_object('expectedRevision',${revision},'input',jsonb_build_object('organizationId',o.id,
					'organizationKind',o.kind,'cadence',${value.cadence}::text)) AS args
			FROM x CROSS JOIN organization o WHERE o.id=${actor.owner.id}::uuid AND EXISTS(SELECT FROM me)`;
		},
		run: lockedNotificationWrites.setOversightDigestCadence,
	}),
} as const;
