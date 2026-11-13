import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { RequestActor } from "@everyfield/domain/access";
import {
	audiencePeople,
	communicationWriter,
	mailAddressHash,
	recipientsDigest,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import {
	escapeHtml,
	recipientOutcome,
	renderBody,
	sanitizeHtml,
	systemTemplate,
	templateCategories,
	usesRsvpLink,
	type MailReport,
} from "@everyfield/contracts/communication";
import { meetingOpenSql } from "@everyfield/domain/meetings";
import { z } from "zod";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, MailPort, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";
import { held, resendCandidates, unanswered, untouchedMail } from "../reads/index.ts";
import {
	audienceInput,
	audienceRefusal,
	classifiedPeople,
	leftOutIds,
	leftOutPeople,
	recipientNames,
	type AudienceValue,
} from "../audience.ts";

// The Communication reviewed writes (MAIL51-009). Each review reads the message live in the actor's church and saves the
// native command's exact arguments, including the revision the review showed. Messages and Evry call the same native
// operations: a draft is saved in one transaction; a schedule saves in one transaction and then hands off to the email
// service; a time change, a cancel and a replacement call the email service outside any transaction. Anything that
// changed since the review refuses (revision_conflict) before the email service hears of it. Each review saves the
// `untouched` mail count beside the revision, and a review with an audience saves who it showed: staleMessage and the
// native schedule compare those facts.

const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

/** The church's own time zone, as `c`'s plant. */
const zone = sql`(SELECT pl.timezone FROM plant pl WHERE pl.id=c.plant_id)`;
const iso = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const message = sql`jsonb_build_object('kind','message','id',c.id,'label',coalesce(nullif(c.subject,''),'Untitled draft'))`;
const change = (field: string, before: SQL | null, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before ?? sql`NULL::jsonb`},'after',${after})`;
const instantAt = (at: SQL) => sql`jsonb_build_object('at',${iso(at)},'zone',${zone})`;
/** An audience with the counts a send would use, from the shared resolver the Messages composer uses. */
const audienceShape = (plantId: string, audience: AudienceValue) =>
	sql`(SELECT jsonb_build_object('groups',${JSON.stringify(audience.groups)}::jsonb,'teamIds',${JSON.stringify(audience.teamIds)}::jsonb,
		'personIds',${JSON.stringify(audience.personIds)}::jsonb,
		'recipients',count(*) FILTER (WHERE btrim(coalesce(x.email,''))<>''),
		'noAddress',count(*) FILTER (WHERE btrim(coalesce(x.email,''))=''))
		FROM jsonb_to_recordset(${audiencePeople(plantId, audience)}) x(email text))`;

const localTime = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
	.describe("The church's local date and time, like 2026-11-06T09:00, never a zone or offset");
const messageId = z.uuid().describe("A message id from communication.list");

/** An email body as the reader sees it: paragraphs and line breaks kept, markup and entities gone. */
const readable = (html: string) =>
	sanitizeHtml(html)
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
		.replace(/<[^>]+>/g, "")
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&#39;", "'")
		.replaceAll("&amp;", "&")
		.trim();

/** Plain paragraphs become safe email markup; the domain sanitizes it again when it saves. */
const paragraphs = (text: string) =>
	text
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
		.join("");

/** The window Everyfield holds an email for: not in the past, at most 30 days ahead (scheduleAccepted). */
const acceptedWindow = (at: SQL): SQL =>
	sql`CASE WHEN ${at} < clock_timestamp() THEN 'That time has already passed. Pick a time from now on.'
		WHEN ${at} > clock_timestamp() + interval '30 days' THEN 'Everyfield can hold an email for up to 30 days. Pick a time within the next 30 days.' END`;
const withRefusal = (refusal: SQL, review: SQL): SQL =>
	sql`${review} || CASE WHEN ${refusal} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal',${refusal}) END`;

/** The args a review of a saved message stored: the revision it showed and the native input, without a request key. */
const savedArgs = z.object({ expectedRevision: z.string(), input: z.object({ communicationId: z.uuid() }) });
const savedTime = savedArgs.extend({ input: z.object({ communicationId: z.uuid(), scheduledAt: z.string() }) });
const savedSchedule = savedArgs.extend({
	leftOut: z.array(z.uuid()),
	input: z.object({ communicationId: z.uuid(), scheduledAt: z.string(), recipientsDigest: z.string() }),
});
const untouched = sql.raw(untouchedMail("c"));

const done = (reply: CommunicationReply<{ communicationId: string; revision: string }>): EffectResult =>
	reply.status === "ok"
		? { receiptId: reply.value.communicationId, revision: reply.value.revision }
		: { refused: reply.error.code };

/** What became of each recipient the email service held for a message. A recipient it never took is not affected. */
async function recipientOutcomes(db: Database, authority: RequestActor, communicationId: string) {
	const plantId = authority.actor.context.owner.id;
	const r = await db.execute(
		sql`SELECT coalesce(p.display_name,'Unknown') AS name,
				CASE m.state WHEN 'cancelled' THEN 'cancelled' WHEN 'sent' THEN 'sent' ELSE 'open' END AS outcome
			FROM mail m LEFT JOIN person p ON p.id=m.recipient_person_id
			WHERE m.tenant_id=${plantId}::uuid AND m.logical_key LIKE ${"communication/" + communicationId + "/%"}
				AND m.state NOT IN ('refused','failed')
			ORDER BY p.display_name`,
	);
	return z.array(z.object({ name: z.string(), outcome: recipientOutcome })).parse(r.rows);
}

// --- 1. communication.saveDraft -----------------------------------------------------------------------------

const draftInput = z.strictObject({
	subject: z.string().trim().min(1).max(200),
	body: z.string().trim().min(1).max(20_000).describe("Plain text. A blank line starts a new paragraph."),
	audience: audienceInput,
});
export const saveDraft: ReviewedWrite<z.infer<typeof draftInput>> = {
	operation: "communication.saveDraft",
	description:
		"Propose saving a new email draft with its subject, audience and body. The draft is saved in Messages and nothing is sent. Nothing changes until the user approves the exact review.",
	input: draftInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		const html = paragraphs(value.body);
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
				${change("subject", null, sql`${JSON.stringify(value.subject)}::jsonb`)},
				${change("audience", null, audienceShape(actor.owner.id, value.audience))},
				${change("body", null, sql`${JSON.stringify(readable(html))}::jsonb`)})) AS review,
			jsonb_build_object('input',jsonb_build_object('subject',${value.subject}::text,'bodyHtml',${html}::text,'audience',${JSON.stringify(value.audience)}::jsonb)) AS args`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const { input } = z.object({ input: z.unknown() }).parse(args);
		return done(await communicationWriter.saveDraft(tx, context, { requestKey: `${effectKey}:draft`, input }));
	},
};

// --- 2. communication.scheduleReviewed ----------------------------------------------------------------------

const scheduleInput = z.strictObject({ communicationId: messageId, sendAt: localTime });
/** Stands in for the first recipient's name until the review statement knows who that is. */
const SAMPLE_NAME = "RECIPIENT_NAME_TOKEN_7F3A";

/**
 * One audience as the handoff will resolve it. The address hashes are read first because the keys that hash an address
 * are not in the database: the review statement then compares them to the active blocks. Null with no mail keys.
 */
async function audienceFacts(context: ReviewContext, plantId: string, audience: AudienceValue) {
	const { mail } = context;
	if (!mail) return null;
	const raw = (await context.db.execute(sql`SELECT ${audiencePeople(plantId, audience)} AS people`)).rows[0]!.people;
	const hashes = Object.fromEntries(
		z
			.array(z.object({ email: z.string().nullable() }))
			.parse(raw)
			.flatMap((p) => {
				const address = p.email?.trim().toLowerCase();
				return address ? [[address, mailAddressHash(mail.keys.addressKey, address)]] : [];
			}),
	);
	return { audience, hashes, digest: recipientsDigest(raw) };
}

type Handoff = Awaited<ReturnType<typeof communicationWriter.handOffScheduled>>;
/**
 * The message is saved as scheduled. Only an accepted recipient is called scheduled; unknown ones are counted, never called
 * delivered. A handoff (`leftOut` given) makes no email service call (D-927): every recipient it accepts waits in
 * Everyfield until the send time. A later check may find mail the email service already took.
 */
function scheduleReport(sent: Handoff, scheduledAt: string, leftOut?: number): MailReport {
	if (sent.status !== "ok")
		return {
			kind: "schedule",
			confirmation: "refused",
			scheduledAt,
			accepted: 0,
			refused: 0,
			unknown: 0,
			code: sent.error.code,
		};
	const v = sent.value;
	return {
		kind: "schedule",
		confirmation: v.acceptedCount > 0 ? "confirmed" : v.unknownCount > 0 ? "not_confirmed" : "refused",
		scheduledAt,
		accepted: v.acceptedCount,
		refused: v.rejectedCount,
		unknown: v.unknownCount,
		...(leftOut === undefined ? {} : { waiting: v.acceptedCount, leftOut }),
	};
}

export const schedule: ReviewedWrite<z.infer<typeof scheduleInput>> = {
	operation: "communication.scheduleReviewed",
	description:
		"Propose scheduling a saved draft for a send time in the church's time zone, within the next 30 days. The review lists who gets it, who is left out and why, and the exact content. Nothing is sent until the user approves.",
	input: scheduleInput,
	allowed: ownerOrAdmin,
	async review(actor, value, context): Promise<SQL | null> {
		const found = await context.db.execute(
			sql`SELECT c.audience,c.body_html,c.revision::text AS revision FROM communication c
				WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND c.state IN ('draft','reviewed')`,
		);
		if (!found.rows.length) return null;
		const draft = z
			.object({ audience: z.unknown(), body_html: z.string().nullable(), revision: z.string() })
			.parse(found.rows[0]);
		const facts = await audienceFacts(context, actor.owner.id, audienceInput.parse(draft.audience ?? {}));
		if (!facts) return null;
		// The first person who will get it is named in the content; the review statement puts the name in.
		const content = draft.body_html ? readable(renderBody(draft.body_html, { name: SAMPLE_NAME, rsvp_link: "" })) : "";
		const at = sql`(${value.sendAt}::timestamp AT TIME ZONE ${zone})`;
		const refusal = sql`coalesce(${acceptedWindow(at)},
			CASE WHEN coalesce(c.subject,'')='' OR coalesce(c.body_html,'')='' THEN 'The draft needs a subject and a body before it can be scheduled.' END,
			${audienceRefusal})`;
		return sql`WITH c AS (
				SELECT * FROM communication WHERE id=${value.communicationId}::uuid AND plant_id=${actor.owner.id}::uuid
					AND state IN ('draft','reviewed') AND revision=${draft.revision}::bigint
			), ${classifiedPeople(actor.owner.id, facts.audience, facts.hashes)}
			SELECT ${withRefusal(
				refusal,
				sql`jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("recipients", null, recipientNames)},
					${change("leftOut", null, leftOutPeople)},
					${change("content", null, sql`to_jsonb(replace(${content}::text, ${SAMPLE_NAME}::text, coalesce((SELECT name FROM classified WHERE reason IS NULL ORDER BY name, id LIMIT 1), '')))`)},
					${change("sendAt", null, instantAt(at))}))`,
			)} AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'untouched',${untouched},'leftOut',${leftOutIds},
				'input',jsonb_build_object('communicationId',c.id,'scheduledAt',${iso(at)},'recipientsDigest',${facts.digest}::text)) AS args
			FROM c`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const saved = savedSchedule.parse(args);
		return done(
			await communicationWriter.scheduleReviewed(tx, context, {
				requestKey: `${effectKey}:schedule`,
				expectedRevision: saved.expectedRevision,
				input: saved.input,
			}),
		);
	},
	async reach(db, authority, args, effectKey, first, mail): Promise<EffectResult> {
		const saved = savedSchedule.parse(args);
		const { communicationId, scheduledAt } = saved.input;
		const sent = await communicationWriter.handOffScheduled(
			db,
			authority,
			{
				requestKey: `${effectKey}:send`,
				expectedRevision: first.revision,
				input: { communicationId, leftOut: saved.leftOut },
			},
			mail.transport,
			mail.keys,
		);
		return { ...first, report: scheduleReport(sent, scheduledAt, saved.leftOut.length) };
	},
	async check(db, authority, args, keys, mail): Promise<EffectResult> {
		const saved = savedSchedule.parse(args);
		const { communicationId, scheduledAt } = saved.input;
		const asked = await communicationWriter.reconcileProviderOutcome(
			db,
			authority,
			{ requestKey: `${keys.checkKey}:send`, expectedRevision: keys.revision, input: { communicationId } },
			mail.transport,
			mail.keys,
		);
		if (asked.status !== "ok") return { refused: asked.error.code };
		return { receiptId: communicationId, revision: keys.revision, report: scheduleReport(asked, scheduledAt) };
	},
};

// --- 3. communication.rescheduleReviewed (time change) ---------------------------------------------------------

/** Moves the time. Safe to repeat: a message already at the new time moves only the recipients that still hold the old one. */
async function moveTime(
	db: Database,
	authority: RequestActor,
	args: unknown,
	requestKey: string,
	mail: MailPort,
): Promise<EffectResult> {
	const saved = savedTime.parse(args);
	const { communicationId, scheduledAt } = saved.input;
	// A message already at the new time is this effect's own earlier success, at the revision that success saved.
	const found = await db.execute(
		sql`SELECT c.revision::text AS revision,${iso(sql`c.scheduled_at`)} AS scheduled_at FROM communication c
			WHERE c.id=${communicationId}::uuid AND c.plant_id=${authority.actor.context.owner.id}::uuid`,
	);
	const now = z.object({ revision: z.string(), scheduled_at: z.string().nullable() }).optional().parse(found.rows[0]);
	const expectedRevision = now?.scheduled_at === scheduledAt ? now.revision : saved.expectedRevision;
	const moved = await communicationWriter.rescheduleDispatched(
		db,
		authority,
		{ requestKey, expectedRevision, input: { communicationId, scheduledAt } },
		mail.transport,
	);
	if (moved.status !== "ok") return { refused: moved.error.code };
	const v = moved.value;
	return {
		receiptId: communicationId,
		revision: expectedRevision,
		report: {
			kind: "reschedule",
			confirmation: v.rescheduleStatus !== "accepted" ? "not_confirmed" : v.confirmedCount > 0 ? "confirmed" : "none",
			scheduledAt: v.scheduledAt,
			open: v.openCount,
			sent: v.sentCount,
		},
	};
}
/** Holds a review's native work in the executor's transaction without changing anything: the email service step does it. */
const checkedOnly = async (_tx: Transaction, _context: unknown, args: unknown): Promise<EffectResult> => {
	const saved = savedArgs.parse(args);
	return { receiptId: saved.input.communicationId, revision: saved.expectedRevision };
};

export const reschedule: ReviewedWrite<z.infer<typeof scheduleInput>> = {
	operation: "communication.rescheduleReviewed",
	description:
		"Propose moving a scheduled email to a new send time in the church's time zone, within the next 30 days. Recipients and content stay the same. The new time is shown only after the email service confirms it. Nothing changes until the user approves.",
	input: scheduleInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		const at = sql`(${value.sendAt}::timestamp AT TIME ZONE ${zone})`;
		// A time moves by the email service's id for each recipient. One it never answered about may hold the old time for good.
		const refusal = sql`coalesce(CASE WHEN ${unanswered}>0 THEN 'The email service has not answered about every recipient of this message, so the send time can''t change.' END,
			${acceptedWindow(at)})`;
		return sql`SELECT ${withRefusal(
			refusal,
			sql`jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("recipientCount", null, sql`to_jsonb(${held})`)},
					${change("sendAt", instantAt(sql`c.scheduled_at`), instantAt(at))}))`,
		)} AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'untouched',${untouched},'input',jsonb_build_object('communicationId',c.id,'scheduledAt',${iso(at)})) AS args
			FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid
				AND c.state='scheduled' AND ${held}>0`;
	},
	execute: checkedOnly,
	reach: (db, authority, args, effectKey, _first, mail) => moveTime(db, authority, args, `${effectKey}:move`, mail),
	check: (db, authority, args, keys, mail) => moveTime(db, authority, args, `${keys.checkKey}:move`, mail),
};

// --- 4. communication.cancelScheduledReviewed ---------------------------------------------------------------

const cancelInput = z.strictObject({ communicationId: messageId });
async function cancelStep(
	db: Database,
	authority: RequestActor,
	args: unknown,
	requestKey: string,
	mail: MailPort,
): Promise<EffectResult> {
	const saved = savedArgs.parse(args);
	const { communicationId } = saved.input;
	const cancelled = await communicationWriter.cancelScheduledReviewed(
		db,
		authority,
		{ requestKey, expectedRevision: saved.expectedRevision, input: { communicationId } },
		mail.transport,
	);
	if (cancelled.status !== "ok") return { refused: cancelled.error.code };
	const v = cancelled.value;
	const open = v.scheduledCancel === "reconcile";
	return {
		receiptId: communicationId,
		revision: saved.expectedRevision,
		report: {
			kind: "cancel",
			// Cancelled only once the email service confirmed every recipient it held.
			confirmation: v.scheduledCancel === "confirmed" ? "confirmed" : open ? "not_confirmed" : "none",
			cancelled: v.confirmedCount,
			sent: v.sentCount,
			open: v.openCount,
			// A cancel that is not confirmed lists who may still get the email.
			...(open ? { people: await recipientOutcomes(db, authority, communicationId) } : {}),
		},
	};
}

export const cancel: ReviewedWrite<z.infer<typeof cancelInput>> = {
	operation: "communication.cancelScheduledReviewed",
	description:
		"Propose cancelling a scheduled email with the email service. The result says Cancelled only after the email service confirms. Nothing changes until the user approves.",
	input: cancelInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("sendAt", instantAt(sql`c.scheduled_at`), sql`NULL::jsonb`)},
					${change("recipientCount", null, sql`to_jsonb(${held})`)})) AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'untouched',${untouched},'input',jsonb_build_object('communicationId',c.id)) AS args
			FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid
				AND c.state='scheduled' AND ${held}>0`;
	},
	execute: checkedOnly,
	reach: (db, authority, args, effectKey, _first, mail) => cancelStep(db, authority, args, `${effectKey}:cancel`, mail),
	check: (db, authority, args, keys, mail) => cancelStep(db, authority, args, `${keys.checkKey}:cancel`, mail),
};

// --- 5. communication.replaceScheduledReviewed --------------------------------------------------------------

const replaceInput = z.strictObject({
	communicationId: messageId,
	body: z
		.string()
		.trim()
		.min(1)
		.max(20_000)
		.optional()
		.describe("The new body as plain text, when the content changes"),
	audience: audienceInput.optional().describe("The new audience, when the recipients change"),
});

const savedReplace = savedArgs.extend({
	leftOut: z.array(z.uuid()),
	recipientsDigest: z.string(),
	input: z.object({
		communicationId: z.uuid(),
		subject: z.string(),
		bodyHtml: z.string(),
		audience: audienceInput,
		meetingId: z.uuid().nullable(),
		scheduledAt: z.string(),
	}),
});

/**
 * Cancel the old send first. Only when every recipient is confirmed cancelled does it save and hand off the new one,
 * at the same time. Each step replays: the cancel asks only open recipients, and the new message's keys are fixed.
 * Once the cancel ran, a refusal is a report that says what did happen, never a refusal that says nothing was done.
 */
async function replaceStep(
	db: Database,
	authority: RequestActor,
	args: unknown,
	keys: { cancelKey: string; buildKey: string },
	mail: MailPort,
): Promise<EffectResult> {
	const saved = savedReplace.parse(args);
	const { input } = saved;
	const old = await communicationWriter.cancelScheduledReviewed(
		db,
		authority,
		{
			requestKey: keys.cancelKey,
			expectedRevision: saved.expectedRevision,
			input: { communicationId: input.communicationId },
		},
		mail.transport,
	);
	if (old.status !== "ok") return { refused: old.error.code };
	const counts = { cancelled: old.value.confirmedCount, sent: old.value.sentCount, open: old.value.openCount };
	/** No replacement exists. Everyone the old send reached is listed with what happened to them. */
	const stopped = async (
		confirmation: "not_confirmed" | "blocked" | "refused",
		code?: string,
	): Promise<EffectResult> => ({
		receiptId: input.communicationId,
		revision: saved.expectedRevision,
		report: {
			kind: "replace_stopped",
			confirmation,
			...counts,
			people: await recipientOutcomes(db, authority, input.communicationId),
			...(code ? { code } : {}),
		},
	});
	const gate = await communicationWriter.replaceScheduledReviewed(db, authority, {
		requestKey: `${keys.cancelKey}:gate`,
		expectedRevision: saved.expectedRevision,
		input: { communicationId: input.communicationId },
	});
	if (gate.status !== "ok") return stopped("refused", gate.error.code);
	if (!gate.value.replacementAllowed) return stopped(counts.open > 0 ? "not_confirmed" : "blocked");
	const session = authority.session;
	const owner = authority.actor.context.owner;
	const scheduled = await db.transaction(async (tx) => {
		if (!(await RequestActor.claimWrite(tx, session, owner))) return null;
		const context: CommunicationContext = { session, selected: owner };
		const draft = await communicationWriter.saveDraft(tx, context, {
			requestKey: `${keys.buildKey}:draft`,
			input: {
				subject: input.subject,
				bodyHtml: input.bodyHtml,
				audience: input.audience,
				...(input.meetingId ? { meetingId: input.meetingId } : {}),
			},
		});
		if (draft.status !== "ok") return draft;
		return communicationWriter.scheduleReviewed(tx, context, {
			requestKey: `${keys.buildKey}:schedule`,
			expectedRevision: draft.value.revision,
			input: {
				communicationId: draft.value.communicationId,
				scheduledAt: input.scheduledAt,
				recipientsDigest: saved.recipientsDigest,
			},
		});
	});
	if (!scheduled) return stopped("refused", "access_denied");
	if (scheduled.status !== "ok") return stopped("refused", scheduled.error.code);
	const replacement = scheduled.value;
	const sent = await communicationWriter.handOffScheduled(
		db,
		authority,
		{
			requestKey: `${keys.buildKey}:send`,
			expectedRevision: replacement.revision,
			input: { communicationId: replacement.communicationId, leftOut: saved.leftOut },
		},
		mail.transport,
		mail.keys,
	);
	if (sent.status !== "ok") return stopped("refused", sent.error.code);
	const v = sent.value;
	if (v.acceptedCount === 0 && v.unknownCount === 0) return stopped("refused", "provider_refused");
	return {
		receiptId: replacement.communicationId,
		revision: replacement.revision,
		report: {
			kind: "replace",
			confirmation: v.acceptedCount > 0 ? "confirmed" : "not_confirmed",
			scheduledAt: input.scheduledAt,
			accepted: v.acceptedCount,
			refused: v.rejectedCount,
			unknown: v.unknownCount,
			waiting: v.acceptedCount,
			leftOut: saved.leftOut.length,
		},
	};
}

export const replace: ReviewedWrite<z.infer<typeof replaceInput>> = {
	operation: "communication.replaceScheduledReviewed",
	description:
		"Propose replacing the body or the audience of a scheduled email. The old send is cancelled first; the new one is scheduled at the same time only after the email service confirms every cancel. Nothing changes until the user approves.",
	input: replaceInput.refine(
		(v) => v.body !== undefined || v.audience !== undefined,
		"Change the body or the audience",
	),
	allowed: ownerOrAdmin,
	async review(actor, value, context): Promise<SQL | null> {
		const found = await context.db.execute(
			sql`SELECT c.body_html,c.audience FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND c.state='scheduled'`,
		);
		if (!found.rows.length) return null;
		const before = z.object({ body_html: z.string().nullable(), audience: z.unknown() }).parse(found.rows[0]);
		const html = value.body === undefined ? null : paragraphs(value.body);
		const oldAudience = audienceInput.parse(before.audience ?? {});
		const facts = await audienceFacts(context, actor.owner.id, value.audience ?? oldAudience);
		if (!facts) return null;
		const changes: SQL[] = [
			change("subject", null, sql`to_jsonb(c.subject)`),
			change("sendAt", null, instantAt(sql`c.scheduled_at`)),
			change("recipientCount", null, sql`to_jsonb(${held})`),
			change("leftOut", null, leftOutPeople),
		];
		if (html !== null)
			changes.push(
				change(
					"body",
					sql`${JSON.stringify(readable(before.body_html ?? ""))}::jsonb`,
					sql`${JSON.stringify(readable(html))}::jsonb`,
				),
			);
		if (value.audience)
			changes.push(
				change("audience", audienceShape(actor.owner.id, oldAudience), audienceShape(actor.owner.id, value.audience)),
			);
		// What the new send would be refused for is refused here, before the old send is cancelled.
		const needsMeeting = usesRsvpLink(html ?? before.body_html);
		const refusal = sql`coalesce(${acceptedWindow(sql`c.scheduled_at`)},
			CASE WHEN ${needsMeeting}::boolean AND NOT coalesce((SELECT ${meetingOpenSql("mt")} FROM meeting mt WHERE mt.id=c.meeting_id AND mt.plant_id=c.plant_id),false)
				THEN 'This email has an RSVP link, and its meeting is no longer open.' END,
			${audienceRefusal})`;
		return sql`WITH c AS (
				SELECT c.* FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid
					AND c.state='scheduled' AND ${held}>0
			), ${classifiedPeople(actor.owner.id, facts.audience, facts.hashes)}
			SELECT ${withRefusal(
				refusal,
				sql`jsonb_build_object('target',${message},'changes',jsonb_build_array(${sql.join(changes, sql`,`)}))`,
			)} AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'untouched',${untouched},'leftOut',${leftOutIds},'recipientsDigest',${facts.digest}::text,
				'input',jsonb_build_object('communicationId',c.id,'subject',coalesce(c.subject,''),
				'bodyHtml',${html === null ? sql`coalesce(c.body_html,'')` : sql`${html}::text`},
				'audience',${value.audience ? sql`${JSON.stringify(value.audience)}::jsonb` : sql`coalesce(c.audience,'{}'::jsonb)`},
				'meetingId',c.meeting_id,'scheduledAt',${iso(sql`c.scheduled_at`)})) AS args
			FROM c`;
	},
	// The new audience is compared before the old send is cancelled, so a changed audience costs nobody their email.
	async recheck(tx, context, args) {
		const saved = savedReplace.parse(args);
		const now = await tx.execute(sql`SELECT ${audiencePeople(context.selected.id, saved.input.audience)} AS people`);
		return recipientsDigest(now.rows[0]!.people) === saved.recipientsDigest ? null : "stale_review";
	},
	execute: checkedOnly,
	reach: (db, authority, args, effectKey, _first, mail) =>
		replaceStep(db, authority, args, { cancelKey: `${effectKey}:cancel`, buildKey: effectKey }, mail),
	check: (db, authority, args, keys, mail) =>
		replaceStep(db, authority, args, { cancelKey: `${keys.checkKey}:cancel`, buildKey: keys.effectKey }, mail),
};

// --- 6. communication.sendReviewed (send now) ---------------------------------------------------------------
// The review shows exactly who gets the email, who is left out and why, and the exact content. On approval one
// transaction saves the draft (or takes the saved one) and schedules it for the earliest accepted minute, as Messages'
// Send now does; then the email service is handed every recipient at once. The people the review left out are passed
// as left out, so a duplicate address gets one email and nobody the review did not show gets one.

/** The earliest send time the scheduling window accepts: the next whole minute at least one minute away (sendNowChain). */
const earliestSendAt = (now = Date.now()) => new Date(Math.ceil((now + 60_000) / 60_000) * 60_000).toISOString();

/**
 * Schedules a saved message for send now, unless an earlier run of this effect already did: a retry after the email
 * service step replays every command by its request key and finds the message scheduled.
 */
async function scheduleNow(
	tx: Transaction,
	context: PeopleContext,
	communicationId: string,
	revision: string,
	requestKey: string,
	recipients?: string,
): Promise<EffectResult> {
	const now = await tx.execute(
		sql`SELECT state,revision::text AS revision FROM communication WHERE id=${communicationId}::uuid AND plant_id=${context.selected.id}::uuid`,
	);
	const found = z.object({ state: z.string(), revision: z.string() }).optional().parse(now.rows[0]);
	if (found?.state === "scheduled") return { receiptId: communicationId, revision: found.revision };
	return done(
		await communicationWriter.scheduleReviewed(tx, context, {
			requestKey,
			expectedRevision: revision,
			input: {
				communicationId,
				scheduledAt: earliestSendAt(),
				...(recipients ? { recipientsDigest: recipients } : {}),
			},
		}),
	);
}

/** Hands a scheduled message to the email service at once and says what it answered. Replays by its request key. */
async function sendNow(
	db: Database,
	authority: RequestActor,
	first: { receiptId: string; revision: string },
	requestKey: string,
	leftOut: string[],
	held: number,
	mail: MailPort,
): Promise<EffectResult> {
	const sent = await communicationWriter.sendReviewed(
		db,
		authority,
		{ requestKey, expectedRevision: first.revision, input: { communicationId: first.receiptId, leftOut } },
		mail.transport,
		mail.keys,
	);
	return { ...first, report: sendReport(sent, leftOut.length, held) };
}
/**
 * What the email service answered. The handoff also refuses, without asking it, each person the review left out who has
 * an address (`held` of them): those are counted as left out, never as refused by the email service.
 */
function sendReport(sent: Handoff, leftOut: number, held: number): MailReport {
	if (sent.status !== "ok")
		return {
			kind: "send",
			confirmation: "refused",
			accepted: 0,
			refused: 0,
			unknown: 0,
			leftOut,
			code: sent.error.code,
		};
	const v = sent.value;
	return {
		kind: "send",
		confirmation: v.acceptedCount > 0 ? "confirmed" : v.unknownCount > 0 ? "not_confirmed" : "refused",
		accepted: v.acceptedCount,
		refused: Math.max(0, v.rejectedCount + v.unsubscribedCount - held),
		unknown: v.unknownCount,
		leftOut,
	};
}
/** Asks the email service again about a send it has not answered. */
async function checkSend(
	db: Database,
	authority: RequestActor,
	communicationId: string,
	keys: { checkKey: string; revision: string },
	leftOut: number,
	held: number,
	mail: MailPort,
): Promise<EffectResult> {
	const asked = await communicationWriter.reconcileProviderOutcome(
		db,
		authority,
		{ requestKey: `${keys.checkKey}:send`, expectedRevision: keys.revision, input: { communicationId } },
		mail.transport,
		mail.keys,
	);
	if (asked.status !== "ok") return { refused: asked.error.code };
	return { receiptId: communicationId, revision: keys.revision, report: sendReport(asked, leftOut, held) };
}

const sendInput = z.strictObject({
	communicationId: messageId.optional().describe("A saved draft to send. Leave it out to send a new email."),
	subject: z.string().trim().min(1).max(200).optional(),
	body: z.string().trim().min(1).max(20_000).optional().describe("Plain text. A blank line starts a new paragraph."),
	audience: audienceInput.optional(),
	meetingId: z.uuid().optional().describe("The meeting the email is about, from communication.preview"),
});
const savedSend = z.object({
	expectedRevision: z.string().nullable(),
	leftOut: z.array(z.uuid()),
	/** Of those, the people with an address: the handoff refuses them without asking the email service. */
	held: z.number().int(),
	recipientsDigest: z.string(),
	input: z.union([
		z.object({ communicationId: z.uuid() }),
		z.object({ subject: z.string(), bodyHtml: z.string(), audience: audienceInput, meetingId: z.uuid().nullable() }),
	]),
});
/** The content one recipient will read, with the first recipient's name in place of the merge field. */
const contentFor = (html: string) => readable(renderBody(html, { name: SAMPLE_NAME, rsvp_link: "" }));
const firstName = sql`coalesce((SELECT name FROM classified WHERE reason IS NULL ORDER BY name,id LIMIT 1),'')`;
const meetingFact = (meetingId: SQL) =>
	sql`(SELECT jsonb_build_object('title',mt.title,'at',${iso(sql`mt.starts_at`)},'zone',mt.timezone) FROM meeting mt
		WHERE mt.id=${meetingId} AND mt.plant_id=c.plant_id)`;

export const send: ReviewedWrite<z.infer<typeof sendInput>> = {
	operation: "communication.sendReviewed",
	description:
		"Propose sending an email now: a new one (subject, body, audience and the meeting it is about) or a saved draft by id. The review lists exactly who gets it, who is left out and why, and the exact content. A chat yes is never approval: nothing is sent until the user approves the review.",
	input: sendInput.refine(
		(v) =>
			v.communicationId !== undefined || (v.subject !== undefined && v.body !== undefined && v.audience !== undefined),
		"Give a saved draft id, or a subject, body and audience",
	),
	allowed: ownerOrAdmin,
	async review(actor, value, context): Promise<SQL | null> {
		const plant = actor.owner.id;
		let draft: {
			subject: string;
			html: string;
			audience: AudienceValue;
			meetingId: string | null;
			revision: string | null;
		};
		if (value.communicationId) {
			const found = await context.db.execute(
				sql`SELECT c.subject,c.body_html,c.audience,c.meeting_id,c.revision::text AS revision FROM communication c
					WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${plant}::uuid AND c.state='draft'`,
			);
			if (!found.rows.length) return null;
			const row = z
				.object({
					subject: z.string().nullable(),
					body_html: z.string().nullable(),
					audience: z.unknown(),
					meeting_id: z.uuid().nullable(),
					revision: z.string(),
				})
				.parse(found.rows[0]);
			draft = {
				subject: row.subject ?? "",
				html: row.body_html ?? "",
				audience: audienceInput.parse(row.audience ?? {}),
				meetingId: row.meeting_id,
				revision: row.revision,
			};
		} else
			draft = {
				subject: value.subject!,
				html: paragraphs(value.body!),
				audience: value.audience!,
				meetingId: value.meetingId ?? null,
				revision: null,
			};
		const facts = await audienceFacts(context, plant, draft.audience);
		if (!facts) return null;
		const target = draft.revision
			? sql`(SELECT ${message} FROM communication c WHERE c.id=${value.communicationId!}::uuid)`
			: sql`'null'::jsonb`;
		const meeting = draft.meetingId ? meetingFact(sql`${draft.meetingId}::uuid`) : sql`NULL::jsonb`;
		const refusal = sql`coalesce(CASE WHEN ${draft.subject}::text='' OR ${draft.html}::text='' THEN 'The email needs a subject and a body before it can be sent.' END,
			CASE WHEN ${draft.meetingId}::uuid IS NOT NULL AND ${meeting} IS NULL THEN 'That meeting is not in this church.' END,
			CASE WHEN ${usesRsvpLink(draft.html)}::boolean AND NOT coalesce((SELECT ${meetingOpenSql("mt")} FROM meeting mt WHERE mt.id=${draft.meetingId}::uuid AND mt.plant_id=c.plant_id),false)
				THEN 'This email has an RSVP link, and its meeting is no longer open.' END,
			${audienceRefusal})`;
		const input = draft.revision
			? sql`jsonb_build_object('communicationId',${value.communicationId!}::uuid)`
			: sql`jsonb_build_object('subject',${draft.subject}::text,'bodyHtml',${draft.html}::text,'audience',${JSON.stringify(draft.audience)}::jsonb,'meetingId',${draft.meetingId}::uuid)`;
		return sql`WITH c AS (SELECT ${plant}::uuid AS plant_id), ${classifiedPeople(plant, facts.audience, facts.hashes)}
			SELECT ${withRefusal(
				refusal,
				sql`jsonb_build_object('target',${target},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(${draft.subject}::text)`)},
					${change("meeting", null, sql`coalesce(${meeting},'null'::jsonb)`)},
					${change("recipients", null, recipientNames)},
					${change("leftOut", null, leftOutPeople)},
					${change("content", null, sql`to_jsonb(replace(${contentFor(draft.html)}::text,${SAMPLE_NAME}::text,${firstName}))`)}))`,
			)} AS review,
			jsonb_build_object('expectedRevision',${draft.revision}::text,'leftOut',${leftOutIds},'recipientsDigest',${facts.digest}::text,
				'held',(SELECT count(*)::int FROM classified WHERE reason IS NOT NULL AND reason<>'no_address'),
				${draft.revision ? sql`'untouched',0,` : sql``}'input',${input}) AS args
			FROM c`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const saved = savedSend.parse(args);
		let id: string;
		let revision: string;
		if ("communicationId" in saved.input) {
			id = saved.input.communicationId;
			revision = saved.expectedRevision!;
		} else {
			const { meetingId, ...rest } = saved.input;
			const draft = await communicationWriter.saveDraft(tx, context, {
				requestKey: `${effectKey}:draft`,
				input: { ...rest, ...(meetingId ? { meetingId } : {}) },
			});
			if (draft.status !== "ok") return { refused: draft.error.code };
			id = draft.value.communicationId;
			revision = draft.value.revision;
		}
		return scheduleNow(tx, context, id, revision, `${effectKey}:schedule`, saved.recipientsDigest);
	},
	reach: (db, authority, args, effectKey, first, mail) => {
		const saved = savedSend.parse(args);
		return sendNow(db, authority, first, `${effectKey}:send`, saved.leftOut, saved.held, mail);
	},
	check: async (db, authority, args, keys, mail) => {
		const saved = savedSend.parse(args);
		const id = "communicationId" in saved.input ? saved.input.communicationId : await readReceipt(db, authority, keys);
		return id ? checkSend(db, authority, id, keys, saved.leftOut.length, saved.held, mail) : { refused: "not_found" };
	},
};

/** The message an effect created, from its saved receipt: a check about a new send asks about that message. */
async function readReceipt(db: Database, authority: RequestActor, keys: { effectKey: string }) {
	const [, proposalId] = keys.effectKey.split(":");
	const r = await db.execute(
		sql`SELECT receipt->>'receiptId' AS id FROM proposal WHERE id=${proposalId}::uuid AND tenant_id=${authority.actor.context.owner.id}::uuid`,
	);
	return z.uuid().nullable().optional().parse(r.rows[0]?.id) ?? null;
}

// --- 7. communication.executeResend and communication.retryProvenFailed ------------------------------------
// A resend goes only to the people Messages' own rule picks (COM-009): delivered non-openers 24 hours after a confirmed
// delivery, or recipients the email service refused or bounced. A recipient it never answered is still being checked
// and is never resent. The native command saves the follow-up with exactly those people; it is then scheduled and handed
// off as a send now. The review shows who gets it and who is left out; an approval whose people changed is refused.

const resendInput = z.strictObject({ communicationId: messageId.describe("A sent message id from communication.get") });
const savedResend = z.object({
	eligible: z.array(z.uuid()),
	/** The people the review left out: the handoff leaves them out too, though Messages' rule may still pick them. */
	excluded: z.array(z.uuid()),
	input: z.object({ communicationId: z.uuid(), selection: z.string() }),
});
type Selection = "delivered_nonopeners" | "proven_failed";

function resendWrite({
	selection,
	operation,
	description,
}: {
	selection: Selection;
	operation: string;
	description: string;
}): ReviewedWrite<z.infer<typeof resendInput>> {
	return {
		operation,
		description,
		input: resendInput,
		allowed: ownerOrAdmin,
		async review(actor, value, context) {
			// The same facts the resendCandidates read gives the model: Messages' own rule decides who is in.
			const read = await context.db.transaction((tx) =>
				resendCandidates.invoke(tx, actor, { communicationId: value.communicationId, selection }),
			);
			const people = read.rows.filter((r) => r.kind === "person");
			const eligible = people.filter((r) => r.fields.leftOut === null);
			// Nobody can get it yet (too soon, no confirmed delivery, or nothing failed for certain): no review.
			if (!eligible.length) return null;
			const found = await context.db.execute(
				sql`SELECT c.body_html FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid`,
			);
			const html = z.object({ body_html: z.string().nullable() }).optional().parse(found.rows[0])?.body_html ?? "";
			const content = contentFor(html).replaceAll(SAMPLE_NAME, eligible[0]!.label);
			const names = (rows: typeof people, reason: boolean) =>
				sql`${JSON.stringify(rows.map((r) => (reason ? { name: r.label, reason: r.fields.leftOut } : { name: r.label })))}::jsonb`;
			return sql`SELECT jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("recipients", null, names(eligible, false))},
					${change(
						"leftOut",
						null,
						names(
							people.filter((r) => r.fields.leftOut !== null),
							true,
						),
					)},
					${change("content", null, sql`to_jsonb(${content}::text)`)})) AS review,
				jsonb_build_object('expectedRevision',c.revision::text,'untouched',${untouched},
					'eligible',${JSON.stringify(eligible.map((r) => r.id).sort())}::jsonb,
					'excluded',${JSON.stringify(people.filter((r) => r.fields.leftOut !== null).map((r) => r.id))}::jsonb,
					'input',jsonb_build_object('communicationId',c.id,'selection',${selection}::text)) AS args
				FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid`;
		},
		async execute(tx, context, args, effectKey): Promise<EffectResult> {
			const saved = savedResend.parse(args);
			const made = await communicationWriter.executeResend(tx, context, {
				requestKey: `${effectKey}:resend`,
				input: { communicationId: saved.input.communicationId, selection },
			});
			if (made.status !== "ok")
				return { refused: made.error.code === "invalid_subject" ? "stale_review" : made.error.code };
			// Everyone the review showed is still picked, and nobody it did not show is: else nobody is sent anything.
			const picked = new Set<string>(made.value.eligibleIds);
			const shown = new Set([...saved.eligible, ...saved.excluded]);
			if (saved.eligible.some((id) => !picked.has(id)) || [...picked].some((id) => !shown.has(id)))
				return { refused: "stale_review" };
			return scheduleNow(tx, context, made.value.communicationId, "1", `${effectKey}:schedule`);
		},
		reach: (db, authority, args, effectKey, first, mail) =>
			sendNow(db, authority, first, `${effectKey}:send`, savedResend.parse(args).excluded, 0, mail),
		check: async (db, authority, _args, keys, mail) => {
			const id = await readReceipt(db, authority, keys);
			return id ? checkSend(db, authority, id, keys, 0, 0, mail) : { refused: "not_found" };
		},
	};
}

export const resend = resendWrite({
	selection: "delivered_nonopeners",
	operation: "communication.executeResend",
	description:
		"Propose resending a sent email to the people it was delivered to who have no open recorded, once 24 hours have passed since it was sent and a delivery is confirmed. Open tracking is not reliable. Nothing is sent until the user approves the review.",
});
export const retryFailed = resendWrite({
	selection: "proven_failed",
	operation: "communication.retryProvenFailed",
	description:
		"Propose sending a sent email again to only the recipients the email service refused or bounced. A recipient whose result is still being checked is never sent again. Nothing is sent until the user approves the review.",
});

// --- 8. communication.deleteDraft -----------------------------------------------------------------------------

const draftId = z.strictObject({ communicationId: messageId.describe("A draft id from communication.list") });
export const deleteDraft: ReviewedWrite<z.infer<typeof draftId>> = {
	operation: "communication.deleteDraft",
	description:
		"Propose deleting a saved email draft. Nothing is sent. The draft stays until the user approves the review.",
	input: draftId,
	allowed: ownerOrAdmin,
	async review(actor, value, context) {
		const found = await context.db.execute(
			sql`SELECT c.audience FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND c.state='draft'`,
		);
		if (!found.rows.length) return null;
		const audience = audienceInput.parse(z.object({ audience: z.unknown() }).parse(found.rows[0]).audience ?? {});
		// The draft is the review's own change, not its target: once deleted, the card still names what it removed.
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
				${change("draft", sql`to_jsonb(coalesce(nullif(c.subject,''),'Untitled draft'))`, sql`NULL::jsonb`)},
				${change("audience", null, audienceShape(actor.owner.id, audience))})) AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'input',jsonb_build_object('communicationId',c.id)) AS args
			FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND c.state='draft'`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const saved = savedArgs.parse(args);
		return done(
			await communicationWriter.deleteDraft(tx, context, {
				requestKey: `${effectKey}:delete`,
				expectedRevision: saved.expectedRevision,
				input: saved.input,
			}),
		);
	},
};

// --- 9. communication.templates.create, .fork and .update ------------------------------------------------------
// A system template is Everyfield's own and is never edited: it is copied (forked) into a church template first.

const category = z.enum(templateCategories);
const createInput = z.strictObject({
	name: z.string().trim().min(1).max(255),
	category,
	subject: z.string().trim().min(1).max(500),
	body: z
		.string()
		.trim()
		.min(1)
		.max(20_000)
		.describe("Plain text, like a draft's body. {{name}} is the recipient's name."),
});
const templateDone = (reply: CommunicationReply<{ templateId: string; revision: string }>): EffectResult =>
	reply.status === "ok"
		? { receiptId: reply.value.templateId, revision: reply.value.revision }
		: { refused: reply.error.code };

export const createTemplate: ReviewedWrite<z.infer<typeof createInput>> = {
	operation: "communication.templates.create",
	description:
		"Propose saving a new church email template, for example from a draft: its name, kind, subject and body. Nothing is sent. Nothing is saved until the user approves the review.",
	input: createInput,
	allowed: ownerOrAdmin,
	review(_actor, value) {
		const html = paragraphs(value.body);
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
				${change("name", null, sql`to_jsonb(${value.name}::text)`)},
				${change("category", null, sql`to_jsonb(${value.category}::text)`)},
				${change("subject", null, sql`to_jsonb(${value.subject}::text)`)},
				${change("body", null, sql`to_jsonb(${readable(html)}::text)`)})) AS review,
			jsonb_build_object('input',jsonb_build_object('name',${value.name}::text,'category',${value.category}::text,
				'subject',${value.subject}::text,'bodyHtml',${html}::text)) AS args`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const { input } = z.object({ input: z.unknown() }).parse(args);
		return templateDone(
			await communicationWriter.createTemplate(tx, context, { requestKey: `${effectKey}:template`, input }),
		);
	},
};

const forkInput = z.strictObject({
	sourceKey: z.string().trim().min(1).max(80).describe("A system template's sourceKey"),
});
export const forkTemplate: ReviewedWrite<z.infer<typeof forkInput>> = {
	operation: "communication.templates.fork",
	description:
		"Propose copying a system template into a church template the church can edit. The system template stays as it is. Nothing changes until the user approves the review.",
	input: forkInput,
	allowed: ownerOrAdmin,
	async review(_actor, value) {
		const source = systemTemplate(value.sourceKey);
		if (!source) return null;
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
				${change("copyOf", null, sql`to_jsonb(${source.name}::text)`)},
				${change("name", null, sql`to_jsonb(${source.name}::text)`)},
				${change("subject", null, sql`to_jsonb(${source.subject}::text)`)})) AS review,
			jsonb_build_object('input',jsonb_build_object('sourceKey',${source.sourceKey}::text)) AS args`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const { input } = z.object({ input: z.unknown() }).parse(args);
		return templateDone(
			await communicationWriter.forkTemplate(tx, context, { requestKey: `${effectKey}:fork`, input }),
		);
	},
};

const updateInput = z.strictObject({
	templateId: z.uuid().describe("A template id from communication.templates.list"),
	name: z.string().trim().min(1).max(255).optional(),
	subject: z.string().trim().min(1).max(500).optional(),
	body: z.string().trim().min(1).max(20_000).optional().describe("The new body as plain text"),
});
const templateRow = z.object({
	revision: z.string(),
	name: z.string(),
	description: z.string().nullable(),
	category: category,
	meeting_type: z.string().nullable(),
	subject: z.string(),
	body_html: z.string(),
});
export const updateTemplate: ReviewedWrite<z.infer<typeof updateInput>> = {
	operation: "communication.templates.update",
	description:
		"Propose changing a church template's name, subject or body. A system template can't be edited: the review refuses and offers to copy it first. Nothing changes until the user approves the review.",
	input: updateInput.refine(
		(v) => v.name !== undefined || v.subject !== undefined || v.body !== undefined,
		"Change the name, subject or body",
	),
	allowed: ownerOrAdmin,
	async review(actor, value, context) {
		const listed = await context.db.transaction((tx) => communicationWriter.listTemplates(tx, actor.authority));
		if (listed.status !== "ok") return null;
		const found = listed.value.templates.find((t) => t.templateId === value.templateId && !t.archived);
		if (!found) return null;
		if (found.origin === "system")
			return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
					${change("name", null, sql`to_jsonb(${found.name}::text)`)}),
				'refusal','System templates can''t be edited. Copy it into a church template first, then edit the copy.') AS review,
				'{}'::jsonb AS args`;
		const r = await context.db.execute(
			sql`SELECT revision::text AS revision,name,description,category,meeting_type,subject,body_html FROM message_template
				WHERE id=${value.templateId}::uuid AND plant_id=${actor.owner.id}::uuid AND archived_at IS NULL`,
		);
		if (!r.rows.length) return null;
		const t = templateRow.parse(r.rows[0]);
		const html = value.body === undefined ? t.body_html : paragraphs(value.body);
		const patch = {
			name: value.name ?? t.name,
			description: t.description,
			category: t.category,
			meetingType: t.meeting_type,
			subject: value.subject ?? t.subject,
			bodyHtml: html,
		};
		const changes = [
			change("name", sql`to_jsonb(${t.name}::text)`, sql`to_jsonb(${patch.name}::text)`),
			change("subject", sql`to_jsonb(${t.subject}::text)`, sql`to_jsonb(${patch.subject}::text)`),
			...(value.body === undefined
				? []
				: [change("body", sql`to_jsonb(${readable(t.body_html)}::text)`, sql`to_jsonb(${readable(html)}::text)`)]),
		];
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(${sql.join(changes, sql`,`)})) AS review,
			jsonb_build_object('expectedRevision',${t.revision}::text,'input',jsonb_build_object('templateId',${value.templateId}::uuid,'patch',${JSON.stringify(patch)}::jsonb)) AS args`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const saved = z.object({ expectedRevision: z.string(), input: z.unknown() }).parse(args);
		return templateDone(
			await communicationWriter.updateTemplate(tx, context, {
				requestKey: `${effectKey}:template`,
				expectedRevision: saved.expectedRevision,
				input: saved.input,
			}),
		);
	},
};

/** The installed Communication reviewed writes, keyed by operation. */
export const COMMUNICATION_COMMANDS = {
	"communication.saveDraft": saveDraft,
	"communication.scheduleReviewed": schedule,
	"communication.rescheduleReviewed": reschedule,
	"communication.cancelScheduledReviewed": cancel,
	"communication.replaceScheduledReviewed": replace,
	"communication.sendReviewed": send,
	"communication.executeResend": resend,
	"communication.retryProvenFailed": retryFailed,
	"communication.deleteDraft": deleteDraft,
	"communication.templates.create": createTemplate,
	"communication.templates.fork": forkTemplate,
	"communication.templates.update": updateTemplate,
} as const;
