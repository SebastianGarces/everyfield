import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { RequestActor } from "@everyfield/domain/access";
import {
	audiencePeople,
	BATCH_LIMIT,
	communicationWriter,
	mailAddressHash,
	recipientsDigest,
	updatesOff,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import {
	escapeHtml,
	recipientOutcome,
	renderBody,
	sanitizeHtml,
	usesRsvpLink,
	type MailReport,
} from "@everyfield/contracts/communication";
import { meetingOpenSql } from "@everyfield/domain/meetings";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, MailPort, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";
import { held, unanswered, untouchedMail } from "../reads/index.ts";

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

const GROUPS = ["all", "core_group", "launch_team", "leaders", "prospects"] as const;
const audienceInput = z.strictObject({
	groups: z.array(z.enum(GROUPS)).max(GROUPS.length).default([]).describe("Named groups of people"),
	teamIds: z.array(z.uuid()).max(50).default([]),
	personIds: z.array(z.uuid()).max(200).default([]).describe("People ids from an earlier result"),
});
type AudienceValue = z.infer<typeof audienceInput>;
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

/** The window the email service accepts: not in the past, at most 30 days ahead (scheduleAccepted). */
const acceptedWindow = (at: SQL): SQL =>
	sql`CASE WHEN ${at} < clock_timestamp() THEN 'That time has already passed. Pick a time from now on.'
		WHEN ${at} > clock_timestamp() + interval '30 days' THEN 'The email service holds an email for at most 30 days. Pick a time within the next 30 days.' END`;
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
const saveDraft: ReviewedWrite<z.infer<typeof draftInput>> = {
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
type AudienceFacts = NonNullable<Awaited<ReturnType<typeof audienceFacts>>>;

/** The statement's `classified` table: each person of the audience, with why they are left out or null. */
const classifiedPeople = (plantId: string, facts: AudienceFacts) =>
	sql`people AS (
		SELECT * FROM jsonb_to_recordset(${audiencePeople(plantId, facts.audience)}) x(id uuid,"displayName" text,email text)
	), hashes AS (SELECT key AS email,value AS hash FROM jsonb_each_text(${JSON.stringify(facts.hashes)}::jsonb)),
	classified AS (
		SELECT p.id,p."displayName" AS name,
			CASE WHEN btrim(coalesce(p.email,''))='' THEN 'no_address'
				WHEN EXISTS(SELECT 1 FROM suppression s JOIN hashes h ON h.hash=s.address_hash
					WHERE h.email=lower(btrim(p.email)) AND s.cleared_at IS NULL) THEN 'blocked'
				WHEN ${updatesOff(sql`p.id`)} THEN 'updates_off' END AS reason
		FROM people p
	)`;
/** What the handoff would refuse about the `classified` audience, said on the review so nothing is approved in vain. */
const audienceRefusal = sql`CASE WHEN (SELECT count(*) FROM classified WHERE reason IS NULL)=0 THEN 'Nobody in this audience can get this email.'
	WHEN (SELECT count(*) FROM classified WHERE reason IS DISTINCT FROM 'no_address')>${BATCH_LIMIT}::int
		THEN ${`The email service takes at most ${BATCH_LIMIT} people at a time. Choose a smaller audience.`}::text END`;
const leftOutIds = sql`coalesce((SELECT jsonb_agg(id) FROM classified WHERE reason IS NOT NULL),'[]'::jsonb)`;

type Handoff = Awaited<ReturnType<typeof communicationWriter.handOffScheduled>>;
/** The message is saved as scheduled. Only an accepted recipient is called scheduled; unknown ones are counted, never called delivered. */
function scheduleReport(sent: Handoff, scheduledAt: string): MailReport {
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
	};
}

const schedule: ReviewedWrite<z.infer<typeof scheduleInput>> = {
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
			), ${classifiedPeople(actor.owner.id, facts)}
			SELECT ${withRefusal(
				refusal,
				sql`jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("recipients", null, sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name) ORDER BY name,id) FROM classified WHERE reason IS NULL),'[]'::jsonb)`)},
					${change("leftOut", null, sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'reason',reason) ORDER BY name,id) FROM classified WHERE reason IS NOT NULL),'[]'::jsonb)`)},
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
		return { ...first, report: scheduleReport(sent, scheduledAt) };
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

const reschedule: ReviewedWrite<z.infer<typeof scheduleInput>> = {
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
	return {
		receiptId: communicationId,
		revision: saved.expectedRevision,
		report: {
			kind: "cancel",
			// Cancelled only once the email service confirmed every recipient it held.
			confirmation:
				v.scheduledCancel === "confirmed" ? "confirmed" : v.scheduledCancel === "reconcile" ? "not_confirmed" : "none",
			cancelled: v.confirmedCount,
			sent: v.sentCount,
			open: v.openCount,
		},
	};
}

const cancel: ReviewedWrite<z.infer<typeof cancelInput>> = {
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
		},
	};
}

const replace: ReviewedWrite<z.infer<typeof replaceInput>> = {
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
			), ${classifiedPeople(actor.owner.id, facts)}
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

/** The installed Communication reviewed writes, keyed by operation. */
export const COMMUNICATION_COMMANDS = {
	"communication.saveDraft": saveDraft,
	"communication.scheduleReviewed": schedule,
	"communication.rescheduleReviewed": reschedule,
	"communication.cancelScheduledReviewed": cancel,
	"communication.replaceScheduledReviewed": replace,
} as const;
