import type { Database, Transaction } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import { RequestActor } from "@everyfield/domain/access";
import {
	audiencePeople,
	communicationWriter,
	mailAddressHash,
	updatesOff,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import { renderBody, sanitizeHtml } from "@everyfield/contracts/communication";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import type { EffectResult, MailPort, ReviewContext, ReviewedWrite } from "../../../proposals/types.ts";

// The Communication reviewed writes (MAIL51-009). Each review reads the message live in the actor's church and saves the
// native command's exact arguments, including the revision the review showed. Messages and Evry call the same native
// operations: a draft is saved in one transaction; a schedule saves in one transaction and then hands off to the email
// service; a time change, a cancel and a replacement call the email service outside any transaction. Anything that
// changed since the review refuses (revision_conflict) before the email service hears of it.

const ownerOrAdmin = (actor: EvryActor) =>
	actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin");

/** The church's own time zone, as `c`'s plant. */
const zone = sql`(SELECT pl.timezone FROM plant pl WHERE pl.id=c.plant_id)`;
const iso = (column: SQL) => sql`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const message = sql`jsonb_build_object('kind','message','id',c.id,'label',coalesce(nullif(c.subject,''),'Untitled draft'))`;
const change = (field: string, before: SQL | null, after: SQL) =>
	sql`jsonb_build_object('field',${field}::text,'before',${before ?? sql`NULL::jsonb`},'after',${after})`;
const instantAt = (at: SQL) => sql`jsonb_build_object('at',${iso(at)},'zone',${zone})`;
/** Recipients the email service still holds for the message: a cancel or a time change has something to act on. */
const held = sql`(SELECT count(*)::int FROM mail m WHERE m.tenant_id=c.plant_id AND m.logical_key LIKE 'communication/'||c.id||'/%' AND m.state IN ('accepted','unknown','dispatched'))`;
/** An audience with the counts a send would use, from the shared resolver the Messages composer uses. */
const audienceShape = (plantId: string, audience: AudienceValue) =>
	sql`jsonb_build_object('groups',${JSON.stringify(audience.groups)}::jsonb,'teamIds',${JSON.stringify(audience.teamIds)}::jsonb,
		'personIds',${JSON.stringify(audience.personIds)}::jsonb,
		'recipients',(SELECT count(*)::int FROM jsonb_to_recordset(${audiencePeople(plantId, audience)}) x(email text) WHERE btrim(coalesce(x.email,''))<>''),
		'noAddress',(SELECT count(*)::int FROM jsonb_to_recordset(${audiencePeople(plantId, audience)}) x(email text) WHERE btrim(coalesce(x.email,''))=''))`;

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
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const paragraphs = (text: string) =>
	text
		.split(/\n{2,}/)
		.map((block) => block.trim())
		.filter(Boolean)
		.map((block) => `<p>${escape(block).replaceAll("\n", "<br>")}</p>`)
		.join("");

/** The window the email service accepts: not in the past, at most 30 days ahead (scheduleAccepted). */
const acceptedWindow = (at: SQL): SQL =>
	sql`CASE WHEN ${at} < clock_timestamp() THEN 'That time has already passed. Pick a time from now on.'
		WHEN ${at} > clock_timestamp() + interval '30 days' THEN 'The email service holds an email for at most 30 days. Pick a time within the next 30 days.' END`;
const withRefusal = (refusal: SQL, review: SQL): SQL =>
	sql`${review} || CASE WHEN ${refusal} IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('refusal',${refusal}) END`;

/** The args the review saved: the revision it showed and the native input, without a request key. */
const savedArgs = z
	.object({ expectedRevision: z.string().optional(), input: z.record(z.string(), z.unknown()) })
	.loose();
const key = (effectKey: string, step: string) => `${effectKey}:${step}`;

const done = (reply: CommunicationReply<{ communicationId: string; revision: string }>): EffectResult =>
	reply.status === "ok"
		? { receiptId: reply.value.communicationId, revision: reply.value.revision }
		: { refused: reply.error.code };

// --- the reads a review and its steps share --------------------------------------------------------------------

const live = z.object({ revision: z.string(), scheduled_at: z.string().nullable(), state: z.string() });
/** The message's revision and send time now, for a step that must tolerate its own earlier success. */
async function liveMessage(db: Database, authority: RequestActor, communicationId: string) {
	const plantId = authority.actor.context.owner.id;
	const r = await db.execute(
		sql`SELECT c.revision::text AS revision,${iso(sql`c.scheduled_at`)} AS scheduled_at,c.state FROM communication c
			WHERE c.id=${communicationId}::uuid AND c.plant_id=${plantId}::uuid`,
	);
	return r.rows.length ? live.parse(r.rows[0]) : null;
}

const person = z.object({ name: z.string(), outcome: z.string() });
/** What became of each recipient of a message: its mail state in plain words. */
async function recipientOutcomes(db: Database, authority: RequestActor, communicationId: string) {
	const plantId = authority.actor.context.owner.id;
	const r = await db.execute(
		sql`SELECT coalesce(p.display_name,'Unknown') AS name,
				CASE m.state WHEN 'cancelled' THEN 'Cancelled' WHEN 'sent' THEN 'Already sent'
					WHEN 'refused' THEN 'Not accepted' WHEN 'failed' THEN 'Not accepted' ELSE 'Cancel not confirmed' END AS outcome
			FROM mail m LEFT JOIN person p ON p.id=m.recipient_person_id
			WHERE m.tenant_id=${plantId}::uuid AND m.logical_key LIKE ${"communication/" + communicationId + "/%"}
			ORDER BY p.display_name`,
	);
	return r.rows.map((row) => person.parse(row));
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
		const safe = sanitizeHtml(html);
		const shown = readable(safe);
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',jsonb_build_array(
				${change("subject", null, sql`${JSON.stringify(value.subject)}::jsonb`)},
				${change("audience", null, audienceShape(actor.owner.id, value.audience))},
				${change("body", null, sql`${JSON.stringify(shown)}::jsonb`)}))
				|| CASE WHEN ${safe === ""} THEN jsonb_build_object('refusal','The body has no text to send.') ELSE '{}'::jsonb END AS review,
			jsonb_build_object('input',jsonb_build_object('subject',${value.subject}::text,'bodyHtml',${html}::text,'audience',${JSON.stringify(value.audience)}::jsonb)) AS args`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const saved = savedArgs.parse(args);
		return done(
			await communicationWriter.saveDraft(tx, context, { requestKey: key(effectKey, "draft"), input: saved.input }),
		);
	},
};

// --- 2. communication.scheduleReviewed ----------------------------------------------------------------------

const scheduleInput = z.strictObject({ communicationId: messageId, sendAt: localTime });
const draftRead = z.object({
	audience: z.unknown(),
	body_html: z.string().nullable(),
	subject: z.string().nullable(),
	revision: z.string(),
});
/** Stands in for the first recipient's name until the review statement knows who that is. */
const SAMPLE_NAME = "RECIPIENT_NAME_TOKEN_7F3A";
const peopleRead = z.array(z.object({ id: z.uuid(), displayName: z.string(), email: z.string().nullable() }));

/**
 * The address hashes of the audience's addresses, read first because the keys that hash an address are not in the
 * database: the review statement then compares them to the active blocks.
 */
async function audienceFacts(context: ReviewContext, plantId: string, id: string) {
	const found = await context.db.execute(
		sql`SELECT c.audience,c.body_html,c.subject,c.revision::text AS revision FROM communication c
			WHERE c.id=${id}::uuid AND c.plant_id=${plantId}::uuid AND c.state IN ('draft','reviewed')`,
	);
	if (!found.rows.length || !context.mail) return null;
	const draft = draftRead.parse(found.rows[0]);
	const parsed = audienceInput.parse(draft.audience ?? {});
	const people = peopleRead.parse(
		(await context.db.execute(sql`SELECT ${audiencePeople(plantId, parsed)} AS people`)).rows[0]!.people,
	);
	const addresses = [...new Set(people.map((p) => p.email?.trim().toLowerCase()).filter((e): e is string => !!e))];
	const hashes = Object.fromEntries(
		addresses.map((address) => [address, mailAddressHash(context.mail!.keys.addressKey, address)]),
	);
	// The first person who will get it is named in the content; the review statement puts the name in.
	const content = draft.body_html ? readable(renderBody(draft.body_html, { name: SAMPLE_NAME, rsvp_link: "" })) : "";
	return { draft, parsed, hashes, content };
}

export const schedule: ReviewedWrite<z.infer<typeof scheduleInput>> = {
	operation: "communication.scheduleReviewed",
	description:
		"Propose scheduling a saved draft for a send time in the church's time zone, within the next 30 days. The review lists who gets it, who is left out and why, and the exact content. Nothing is sent until the user approves.",
	input: scheduleInput,
	allowed: ownerOrAdmin,
	async review(actor, value, context): Promise<SQL | null> {
		const facts = await audienceFacts(context, actor.owner.id, value.communicationId);
		if (!facts) return null;
		const at = sql`(${value.sendAt}::timestamp AT TIME ZONE ${zone})`;
		const refusal = sql`coalesce(${acceptedWindow(at)},
			CASE WHEN coalesce(c.subject,'')='' OR coalesce(c.body_html,'')='' THEN 'The draft needs a subject and a body before it can be scheduled.'
				WHEN (SELECT count(*) FROM classified WHERE reason IS NULL)=0 THEN 'Nobody in this audience can get this email.' END)`;
		return sql`WITH c AS (
				SELECT * FROM communication WHERE id=${value.communicationId}::uuid AND plant_id=${actor.owner.id}::uuid
					AND state IN ('draft','reviewed') AND revision=${facts.draft.revision}::bigint
			), people AS (
				SELECT * FROM jsonb_to_recordset(${audiencePeople(actor.owner.id, facts.parsed)}) x(id uuid,"displayName" text,email text)
			), hashes AS (SELECT key AS email,value AS hash FROM jsonb_each_text(${JSON.stringify(facts.hashes)}::jsonb)),
			classified AS (
				SELECT p.id,p."displayName" AS name,
					CASE WHEN btrim(coalesce(p.email,''))='' THEN 'no_address'
						WHEN EXISTS(SELECT 1 FROM suppression s JOIN hashes h ON h.hash=s.address_hash
							WHERE h.email=lower(btrim(p.email)) AND s.cleared_at IS NULL) THEN 'blocked'
						WHEN ${updatesOff(sql`p.id`)} THEN 'updates_off' END AS reason
				FROM people p
			)
			SELECT ${withRefusal(
				refusal,
				sql`jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("recipients", null, sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name) ORDER BY name,id) FROM classified WHERE reason IS NULL),'[]'::jsonb)`)},
					${change("leftOut", null, sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'reason',reason) ORDER BY name,id) FROM classified WHERE reason IS NOT NULL),'[]'::jsonb)`)},
					${change("content", null, sql`to_jsonb(replace(${facts.content}::text, ${SAMPLE_NAME}::text, coalesce((SELECT name FROM classified WHERE reason IS NULL ORDER BY name, id LIMIT 1), '')))`)},
					${change("sendAt", null, instantAt(at))}))`,
			)} AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'input',jsonb_build_object('communicationId',c.id,'scheduledAt',${iso(at)})) AS args
			FROM c`;
	},
	async execute(tx, context, args, effectKey): Promise<EffectResult> {
		const saved = savedArgs.parse(args);
		return done(
			await communicationWriter.scheduleReviewed(tx, context, {
				requestKey: key(effectKey, "schedule"),
				expectedRevision: saved.expectedRevision,
				input: saved.input,
			}),
		);
	},
	async reach(db, authority, args, effectKey, first, mail): Promise<EffectResult> {
		const saved = savedArgs.parse(args);
		const sent = await communicationWriter.handOffScheduled(
			db,
			authority,
			{
				requestKey: key(effectKey, "send"),
				expectedRevision: first.revision,
				input: { communicationId: saved.input.communicationId },
			},
			mail.transport,
			mail.keys,
		);
		if (sent.status !== "ok") return { refused: sent.error.code };
		const v = sent.value;
		return {
			...first,
			report: {
				kind: "schedule",
				// The email service accepted at least one recipient; unknown ones are counted, never called delivered.
				confirmation: v.acceptedCount > 0 ? "confirmed" : v.unknownCount > 0 ? "not_confirmed" : "refused",
				scheduledAt: saved.input.scheduledAt,
				accepted: v.acceptedCount,
				refused: v.rejectedCount,
				unknown: v.unknownCount,
			},
		};
	},
};

// --- 3. communication.rescheduleReviewed (time change) ---------------------------------------------------------

const rescheduleInput = z.strictObject({ communicationId: messageId, sendAt: localTime });
/** Moves the time. Safe to repeat: a message already at the new time moves only the recipients that still hold the old one. */
async function moveTime(db: Database, authority: RequestActor, args: unknown, requestKey: string, mail: MailPort) {
	const saved = savedArgs.parse(args);
	const communicationId = z.uuid().parse(saved.input.communicationId);
	const scheduledAt = z.string().parse(saved.input.scheduledAt);
	const now = await liveMessage(db, authority, communicationId);
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
		revision: expectedRevision!,
		report: {
			kind: "reschedule",
			confirmation: v.rescheduleStatus === "accepted" ? "confirmed" : "not_confirmed",
			scheduledAt: v.scheduledAt,
			heldAt: v.heldAt,
			confirmed: v.confirmedCount,
			sent: v.sentCount,
			open: v.openCount,
		},
	} satisfies EffectResult;
}
/** Holds a review's native work in the executor's transaction without changing anything: the email service step does it. */
const checkedOnly = async (_tx: Transaction, _context: unknown, args: unknown): Promise<EffectResult> => {
	const saved = savedArgs.parse(args);
	return { receiptId: z.uuid().parse(saved.input.communicationId), revision: saved.expectedRevision ?? "1" };
};

export const reschedule: ReviewedWrite<z.infer<typeof rescheduleInput>> = {
	operation: "communication.rescheduleReviewed",
	description:
		"Propose moving a scheduled email to a new send time in the church's time zone, within the next 30 days. Recipients and content stay the same. The new time is shown only after the email service confirms it. Nothing changes until the user approves.",
	input: rescheduleInput,
	allowed: ownerOrAdmin,
	review(actor, value) {
		const at = sql`(${value.sendAt}::timestamp AT TIME ZONE ${zone})`;
		return sql`SELECT ${withRefusal(
			acceptedWindow(at),
			sql`jsonb_build_object('target',${message},'changes',jsonb_build_array(
					${change("subject", null, sql`to_jsonb(c.subject)`)},
					${change("recipientCount", null, sql`to_jsonb(${held})`)},
					${change("sendAt", instantAt(sql`c.scheduled_at`), instantAt(at))}))`,
		)} AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'input',jsonb_build_object('communicationId',c.id,'scheduledAt',${iso(at)})) AS args
			FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND c.state='scheduled'`;
	},
	execute: checkedOnly,
	reach: (db, authority, args, effectKey, _first, mail) => moveTime(db, authority, args, key(effectKey, "move"), mail),
	check: (db, authority, args, keys, mail) => moveTime(db, authority, args, key(keys.checkKey, "move"), mail),
};

// --- 4. communication.cancelScheduledReviewed ---------------------------------------------------------------

const cancelInput = z.strictObject({ communicationId: messageId });
async function cancelAt(db: Database, authority: RequestActor, args: unknown, requestKey: string, mail: MailPort) {
	const saved = savedArgs.parse(args);
	const communicationId = z.uuid().parse(saved.input.communicationId);
	const cancelled = await communicationWriter.cancelScheduledReviewed(
		db,
		authority,
		{ requestKey, expectedRevision: saved.expectedRevision, input: { communicationId } },
		mail.transport,
	);
	return { communicationId, revision: saved.expectedRevision!, cancelled };
}
const cancelReport = (v: {
	scheduledCancel: string;
	confirmedCount: number;
	sentCount: number;
	openCount: number;
}) => ({
	kind: "cancel",
	// Cancelled only once the email service confirmed every recipient it held.
	confirmation:
		v.scheduledCancel === "confirmed" ? "confirmed" : v.scheduledCancel === "reconcile" ? "not_confirmed" : "none",
	cancelled: v.confirmedCount,
	sent: v.sentCount,
	open: v.openCount,
});
async function cancelStep(
	db: Database,
	authority: RequestActor,
	args: unknown,
	requestKey: string,
	mail: MailPort,
): Promise<EffectResult> {
	const r = await cancelAt(db, authority, args, requestKey, mail);
	if (r.cancelled.status !== "ok") return { refused: r.cancelled.error.code };
	return { receiptId: r.communicationId, revision: r.revision, report: cancelReport(r.cancelled.value) };
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
			jsonb_build_object('expectedRevision',c.revision::text,'input',jsonb_build_object('communicationId',c.id)) AS args
			FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid
				AND c.state='scheduled' AND ${held}>0`;
	},
	execute: checkedOnly,
	reach: (db, authority, args, effectKey, _first, mail) =>
		cancelStep(db, authority, args, key(effectKey, "cancel"), mail),
	check: (db, authority, args, keys, mail) => cancelStep(db, authority, args, key(keys.checkKey, "cancel"), mail),
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

/**
 * Cancel the old send first. Only when every recipient is confirmed cancelled does it save and hand off the new one,
 * at the same time. Each step replays: the cancel asks only open recipients, and the new message's keys are fixed.
 */
async function replaceStep(
	db: Database,
	authority: RequestActor,
	args: unknown,
	keys: { cancelKey: string; buildKey: string },
	mail: MailPort,
): Promise<EffectResult> {
	const saved = savedArgs.parse(args);
	const input = z
		.object({
			communicationId: z.uuid(),
			subject: z.string(),
			bodyHtml: z.string(),
			audience: z.unknown(),
			meetingId: z.uuid().nullable(),
			scheduledAt: z.string(),
		})
		.parse(saved.input);
	const old = await cancelAt(
		db,
		authority,
		{ ...saved, input: { communicationId: input.communicationId } },
		keys.cancelKey,
		mail,
	);
	if (old.cancelled.status !== "ok") return { refused: old.cancelled.error.code };
	const people = await recipientOutcomes(db, authority, input.communicationId);
	const gate = await communicationWriter.replaceScheduledReviewed(db, authority, {
		requestKey: key(keys.cancelKey, "gate"),
		expectedRevision: saved.expectedRevision,
		input: { communicationId: input.communicationId },
	});
	if (gate.status !== "ok") return { refused: gate.error.code };
	const base = {
		kind: "replace",
		cancelled: old.cancelled.value.confirmedCount,
		sent: old.cancelled.value.sentCount,
		open: old.cancelled.value.openCount,
	};
	if (
		!gate.value.replacementAllowed ||
		old.cancelled.value.scheduledCancel !== "confirmed" ||
		old.cancelled.value.sentCount > 0
	)
		return {
			receiptId: input.communicationId,
			revision: old.revision,
			// No replacement was scheduled. Whoever still holds or got the old send is listed with what happened.
			report: {
				...base,
				confirmation: old.cancelled.value.openCount > 0 ? "not_confirmed" : "blocked",
				replaced: false,
				people: people.filter((p) => p.outcome !== "Cancelled" && p.outcome !== "Not accepted"),
			},
		};
	const session = authority.session;
	const owner = authority.actor.context.owner;
	const scheduled = await db.transaction(async (tx) => {
		if (!(await RequestActor.claimWrite(tx, session, owner))) return null;
		const context: CommunicationContext = { session, selected: owner };
		const draft = await communicationWriter.saveDraft(tx, context, {
			requestKey: key(keys.buildKey, "draft"),
			input: {
				subject: input.subject,
				bodyHtml: input.bodyHtml,
				audience: input.audience,
				...(input.meetingId ? { meetingId: input.meetingId } : {}),
			},
		});
		if (draft.status !== "ok") return draft;
		return communicationWriter.scheduleReviewed(tx, context, {
			requestKey: key(keys.buildKey, "schedule"),
			expectedRevision: draft.value.revision,
			input: { communicationId: draft.value.communicationId, scheduledAt: input.scheduledAt },
		});
	});
	if (!scheduled) return { refused: "access_denied" };
	if (scheduled.status !== "ok") return { refused: scheduled.error.code };
	const replacement = scheduled.value;
	const sent = await communicationWriter.handOffScheduled(
		db,
		authority,
		{
			requestKey: key(keys.buildKey, "send"),
			expectedRevision: replacement.revision,
			input: { communicationId: replacement.communicationId },
		},
		mail.transport,
		mail.keys,
	);
	if (sent.status !== "ok") return { refused: sent.error.code };
	return {
		receiptId: replacement.communicationId,
		revision: replacement.revision,
		report: {
			...base,
			confirmation: "confirmed",
			replaced: true,
			scheduledAt: input.scheduledAt,
			accepted: sent.value.acceptedCount,
			refused: sent.value.rejectedCount,
			unknown: sent.value.unknownCount,
			people: [],
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
		const safe = html === null ? null : sanitizeHtml(html);
		const oldAudience = audienceInput.parse(before.audience ?? {});
		const changes: SQL[] = [
			change("subject", null, sql`to_jsonb(c.subject)`),
			change("sendAt", instantAt(sql`c.scheduled_at`), instantAt(sql`c.scheduled_at`)),
			change("recipientCount", null, sql`to_jsonb(${held})`),
		];
		if (safe !== null)
			changes.push(
				change(
					"body",
					sql`${JSON.stringify(readable(before.body_html ?? ""))}::jsonb`,
					sql`${JSON.stringify(readable(safe))}::jsonb`,
				),
			);
		if (value.audience)
			changes.push(
				change("audience", audienceShape(actor.owner.id, oldAudience), audienceShape(actor.owner.id, value.audience)),
			);
		return sql`SELECT jsonb_build_object('target',${message},'changes',jsonb_build_array(${sql.join(changes, sql`,`)})) AS review,
			jsonb_build_object('expectedRevision',c.revision::text,'input',jsonb_build_object('communicationId',c.id,'subject',coalesce(c.subject,''),
				'bodyHtml',${html === null ? sql`coalesce(c.body_html,'')` : sql`${html}::text`},
				'audience',${value.audience ? sql`${JSON.stringify(value.audience)}::jsonb` : sql`coalesce(c.audience,'{}'::jsonb)`},
				'meetingId',c.meeting_id,'scheduledAt',${iso(sql`c.scheduled_at`)})) AS args
			FROM communication c WHERE c.id=${value.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid
				AND c.state='scheduled' AND ${held}>0`;
	},
	execute: checkedOnly,
	reach: (db, authority, args, effectKey, _first, mail) =>
		replaceStep(db, authority, args, { cancelKey: key(effectKey, "cancel"), buildKey: effectKey }, mail),
	check: (db, authority, args, keys, mail) =>
		replaceStep(db, authority, args, { cancelKey: key(keys.checkKey, "cancel"), buildKey: keys.effectKey }, mail),
};

/** The installed Communication reviewed writes, keyed by operation. */
export const COMMUNICATION_COMMANDS = {
	"communication.saveDraft": saveDraft,
	"communication.scheduleReviewed": schedule,
	"communication.rescheduleReviewed": reschedule,
	"communication.cancelScheduledReviewed": cancel,
	"communication.replaceScheduledReviewed": replace,
} as const;
