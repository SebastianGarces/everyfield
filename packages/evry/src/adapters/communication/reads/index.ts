import type { Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { communicationWriter, optedOutSql } from "@everyfield/domain/communication";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { personRow } from "../../../catalog/person-row.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { audienceInput, classifiedPeople } from "../audience.ts";

// The Communication reads. Evry finds the church's drafts and scheduled messages by subject and send time, so "cancel
// the Friday email" names one message id. Only the safe identifying fields reach the model: never a body or an address.
// Any seat in the church may read them; writes need Owner or Admin.

const inPlant = (actor: EvryActor) => actor.owner.kind === "plant" && actor.role !== null;
const listInput = z.strictObject({
	subject: z.string().trim().min(1).max(200).optional().describe("Words from the subject"),
	state: z.enum(["draft", "scheduled"]).optional(),
	sendOn: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe("The church's local date a scheduled message sends on, like 2026-11-06"),
	limit: z.int().min(1).max(50).optional(),
});
const messageRow = z.object({
	id: z.uuid(),
	subject: z.string().nullable(),
	state: z.string(),
	sends_at: z.string().nullable(),
	sends_at_instant: z.string().nullable(),
	zone: z.string(),
	held: z.number().int(),
});

const mailOf = (message: string) =>
	`m.tenant_id=${message}.plant_id AND m.logical_key LIKE 'communication/'||${message}.id||'/%'`;
/**
 * Recipients still to go out for message `c`, so a cancel or a time change has something to act on: waiting in Everyfield
 * for the send time (`scheduled`, T-241), or held by the email service.
 */
const holding = (message: string) =>
	`${mailOf(message)} AND m.state IN ('scheduled','accepted','unknown','dispatched')`;
export const held = sql.raw(`(SELECT count(*)::int FROM mail m WHERE ${holding("c")})`);
/** Of those, the recipients the email service never answered about: they have no email service id to move by. */
export const unanswered = sql.raw(
	`(SELECT count(*)::int FROM mail m WHERE ${mailOf("c")} AND m.state IN ('unknown','dispatched'))`,
);
/**
 * Message `c` can still go out. A cancel, a replacement or a sent email changes only mail rows, so a message whose every
 * recipient is finished stays `scheduled`, and the read must not offer it as the one to act on.
 */
const canStillGoOut = sql.raw(
	`(c.state='draft' OR NOT EXISTS(SELECT FROM mail m WHERE ${mailOf("c")})
		OR EXISTS(SELECT FROM mail m WHERE ${mailOf("c")} AND m.state NOT IN ('sent','cancelled','refused','failed')))`,
);
/** Of those, the recipients with no cancel asked: a cancel or a sent email in Messages lowers it. */
export const untouchedMail = (message: string) =>
	`(SELECT count(*)::int FROM mail m WHERE ${holding(message)} AND m.cancel_requested_at IS NULL)`;

export const listMessages: ReadAdapter<z.infer<typeof listInput>> = {
	operation: "communication.list",
	description:
		"Find this church's email drafts and scheduled messages by subject words, state or send date. Each row has the message id, subject, state and send time in the church's time zone.",
	input: listInput,
	allowed: inPlant,
	async invoke(tx: Transaction, actor: EvryActor, input): Promise<SourceResult> {
		const limit = input.limit ?? 20;
		const words = input.subject ? `%${input.subject.replace(/[\\%_]/g, "\\$&")}%` : null;
		const r = await tx.execute(sql`
			SELECT c.id,c.subject,c.state,
				to_char(c.scheduled_at AT TIME ZONE pl.timezone,'Dy YYYY-MM-DD HH24:MI') AS sends_at,
				to_char(c.scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS sends_at_instant,pl.timezone AS zone,
				${held} AS held
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			WHERE c.plant_id=${actor.owner.id}::uuid AND c.state IN ('draft','scheduled') AND ${canStillGoOut}
				AND ${liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined })}
				AND (${input.state ?? null}::text IS NULL OR c.state=${input.state ?? null})
				AND (${words}::text IS NULL OR c.subject ILIKE ${words} ESCAPE '\\')
				AND (${input.sendOn ?? null}::text IS NULL OR to_char(c.scheduled_at AT TIME ZONE pl.timezone,'YYYY-MM-DD')=${input.sendOn ?? null})
			ORDER BY c.scheduled_at NULLS LAST,c.created_at DESC,c.id LIMIT ${limit + 1}`);
		const rows = r.rows.map((raw) => messageRow.parse(raw));
		const shown = rows.slice(0, limit);
		return {
			operation: "communication.list",
			status: shown.length ? "available" : "not_found",
			rows: shown.map((m) => ({
				kind: "message" as const,
				id: m.id,
				label: m.subject || "Untitled draft",
				fields: {
					state: m.state,
					sendsAt: m.sends_at,
					sendsAtInstant: m.sends_at_instant,
					zone: m.zone,
					// A scheduled message the email service holds can be cancelled, moved or replaced; a draft can only be scheduled.
					handedOff: m.held > 0,
				},
			})),
			total: rows.length > limit ? null : shown.length,
			page: 1,
			next: null,
			completeness: rows.length > limit ? "partial" : "complete",
			exclusions: ["message bodies", "email addresses", "sent messages"],
		};
	},
};

// --- The delivery reads (COM-01, COM-02, COM-03, COM-06, COM-07, COM-009) ---------------------------------------------
// Each says only what Messages recorded. An open is a tracking pixel the email service saw, never proof that someone
// read the email, will come, or talked to anyone; an email is never a call. Addresses and bodies never reach the model.

const live = (actor: EvryActor) =>
	liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined });
/** A time in the church's own zone, like "Thu 2026-10-15 19:00". `zone` is the church's time zone column. */
const local = (at: string, zone = "pl.timezone") => `to_char((${at}) AT TIME ZONE ${zone},'Dy YYYY-MM-DD HH24:MI')`;

/**
 * What became of one recipient `m`, in the order a person would ask: left out first, then what the email service said.
 * `sent` is accepted or sent with no delivery confirmed yet; `checking` is a handoff the email service never answered.
 */
const RESULT = `CASE WHEN m.refusal='unsubscribed' THEN 'unsubscribed'
	WHEN m.state='cancelled' THEN 'cancelled'
	WHEN m.bounced_at IS NOT NULL THEN 'bounced'
	WHEN m.state IN ('refused','failed') THEN 'failed'
	WHEN m.opened_at IS NOT NULL OR m.clicked_at IS NOT NULL THEN 'opened'
	WHEN m.delivered_at IS NOT NULL THEN 'delivered'
	WHEN m.state='scheduled' OR (m.state='accepted' AND m.scheduled_at>clock_timestamp()) THEN 'waiting'
	WHEN m.state IN ('accepted','sent') OR m.sent_at IS NOT NULL THEN 'sent'
	ELSE 'checking' END`;
/** When message `c` went out: the first recipient the email service sent, or accepted for sending at once. */
const sentAt = (c: string) =>
	`(SELECT min(coalesce(m.sent_at,m.delivered_at,CASE WHEN m.scheduled_at IS NULL THEN m.accepted_at END))
		FROM mail m WHERE m.tenant_id=${c}.plant_id AND m.communication_id=${c}.id)`;
const OPEN_NOTE =
	"proof anyone read it, will come or talked to anyone (an open is only what the email service's tracking saw; it misses some opens and counts some automatic ones)";

const resultRow = z.object({
	id: z.uuid(),
	name: z.string(),
	result: z.string(),
	delivered_at: z.string().nullable(),
	opened_at: z.string().nullable(),
});
const recipientRow = (actor: EvryActor, r: z.infer<typeof resultRow>) =>
	personRow(actor, r.id, r.name, { result: r.result, deliveredAt: r.delivered_at, openedAt: r.opened_at });

const meetingRow = z.object({ id: z.uuid(), title: z.string(), type: z.string(), starts: z.string() });
const previewInput = z.strictObject({
	subject: z.string().trim().min(1).max(200).describe("The drafted subject"),
	body: z.string().trim().min(1).max(20_000).describe("The drafted body, plain text"),
	audience: audienceInput,
	meetingWords: z
		.string()
		.trim()
		.min(3)
		.max(120)
		.optional()
		.describe("Words naming the meeting the email is about, like 'vision night'"),
	meetingOn: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe("That meeting's local date, like 2026-10-15"),
});

export const preview: ReadAdapter<z.infer<typeof previewInput>> = {
	operation: "communication.preview",
	description:
		"Check an email you have drafted (subject and body) before it is saved or sent: exactly who its audience reaches. Each person row says leftOut: null when they get it, or why they are left out (no_address, unsubscribed, duplicate_address); the left-out come first, so name them and their reasons. When the email is about a meeting, meetingWords or meetingOn also returns the church's matching meetings, newest first, so the email names the right one. Saves and sends nothing.",
	input: previewInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const plant = actor.owner.id;
		const words = (input.meetingWords ?? "")
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((w) => w.length >= 3 && !["the", "and", "our", "for"].includes(w))
			.map((w) => `%${w}%`);
		const wantMeeting = words.length > 0 || input.meetingOn !== undefined;
		const r = await tx.execute(sql`WITH ${classifiedPeople(plant, input.audience, null)}
			SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'reason',reason) ORDER BY reason IS NULL,name,id) FROM classified),'[]'::jsonb) AS people,
				CASE WHEN ${wantMeeting} THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'type',x.type,'starts',x.starts) ORDER BY x.starts_at DESC)
					FROM (SELECT mt.id,mt.title,mt.type,mt.starts_at,${sql.raw(local("mt.starts_at", "mt.timezone"))} AS starts
						FROM meeting mt WHERE mt.plant_id=${plant}::uuid AND mt.status<>'cancelled'
							AND (${input.meetingOn ?? null}::date IS NULL OR mt.local_date=${input.meetingOn ?? null}::date)
							AND (cardinality(${sql.param(words)}::text[])=0 OR EXISTS(SELECT FROM unnest(${sql.param(words)}::text[]) w(p)
								WHERE mt.title ILIKE w.p OR replace(mt.type,'_',' ') ILIKE w.p))
						ORDER BY mt.starts_at DESC LIMIT 3) x),'[]'::jsonb) END AS meetings
			WHERE ${live(actor)}`);
		if (!r.rows.length) throw new EvryRefusal("access_denied");
		const found = z
			.object({
				people: z.array(z.object({ id: z.uuid(), name: z.string(), reason: z.string().nullable() })),
				meetings: z.array(meetingRow).nullable(),
			})
			.parse(r.rows[0]);
		const rows: SourceRow[] = [
			...(found.meetings ?? []).map((m) => ({
				kind: "meeting" as const,
				id: m.id,
				label: m.title,
				fields: { startsAt: m.starts, type: m.type },
			})),
			...found.people.map((p) => personRow(actor, p.id, p.name, { leftOut: p.reason })),
		];
		return {
			operation: "communication.preview",
			status: rows.length ? "available" : "not_found",
			rows,
			total: found.people.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [
				"email addresses",
				"addresses the email service blocks: the send review checks them",
				...(wantMeeting && !found.meetings?.length ? ["no meeting matched"] : []),
			],
		};
	},
};

const getInput = z.strictObject({
	communicationId: z.uuid().optional().describe("A message id from an earlier result"),
	subject: z.string().trim().min(1).max(200).optional().describe("Words from the subject"),
});

/** One message `c` with the counts of each recipient result. */
const messageFacts =
	sql.raw(`jsonb_build_object('id',c.id,'subject',coalesce(nullif(c.subject,''),'Untitled'),'state',c.state,
	'sentAt',${local(sentAt("c"))},'scheduledFor',${local("c.scheduled_at")},
	'results',coalesce((SELECT jsonb_object_agg(x.result,x.n) FROM (SELECT ${RESULT} AS result,count(*) AS n
		FROM mail m WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id GROUP BY 1) x),'{}'::jsonb))`);
const facts = z.object({
	id: z.uuid(),
	subject: z.string(),
	state: z.string(),
	sentAt: z.string().nullable(),
	scheduledFor: z.string().nullable(),
	results: z.record(z.string(), z.number()),
});
const factFields = (m: z.infer<typeof facts>) => ({
	state: m.state,
	sentAt: m.sentAt,
	scheduledFor: m.state === "scheduled" ? m.scheduledFor : null,
	results:
		Object.entries(m.results)
			.map(([k, n]) => `${k} ${n}`)
			.join(", ") || "no recipients handed off",
});

export const getMessage: ReadAdapter<z.infer<typeof getInput>> = {
	operation: "communication.get",
	description:
		"What happened to one email: by id, or else the most recent email handed to the email service whose subject matches. Each recipient row has result: waiting (held for its send time), checking (the email service has not answered, so it may or may not have gone), sent (accepted, delivery not confirmed yet), delivered, opened, bounced, failed, cancelled or unsubscribed. Never call an email delivered before its result says delivered.",
	input: getInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const words = input.subject ? `%${input.subject.replace(/[\\%_]/g, "\\$&")}%` : null;
		const r = await tx.execute(sql`
			SELECT ${messageFacts} AS message,
				coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name,'result',${sql.raw(RESULT)},
					'delivered_at',${sql.raw(local("m.delivered_at"))},'opened_at',${sql.raw(local("coalesce(m.opened_at,m.clicked_at)"))}) ORDER BY p.display_name,p.id)
					FROM mail m JOIN person p ON p.id=m.recipient_person_id AND p.tenant_id=m.tenant_id
					WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id),'[]'::jsonb) AS recipients
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			WHERE c.plant_id=${actor.owner.id}::uuid AND ${live(actor)}
				AND (${input.communicationId ?? null}::uuid IS NULL OR c.id=${input.communicationId ?? null}::uuid)
				AND (${input.communicationId ?? null}::uuid IS NOT NULL OR EXISTS(SELECT FROM mail m WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id))
				AND (${words}::text IS NULL OR c.subject ILIKE ${words} ESCAPE '\\')
			ORDER BY (SELECT max(m.created_at) FROM mail m WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id) DESC NULLS LAST,c.created_at DESC
			LIMIT 1`);
		const row = r.rows[0];
		if (!row) return notFound("communication.get", ["email addresses", "message bodies"]);
		const m = facts.parse(row.message);
		const people = z.array(resultRow).parse(row.recipients);
		return {
			operation: "communication.get",
			status: "available",
			rows: [
				{ kind: "message", id: m.id, label: m.subject, fields: factFields(m) },
				...people.map((p) => recipientRow(actor, p)),
			],
			total: people.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["email addresses", "message bodies", OPEN_NOTE],
		};
	},
};

const notFound = (operation: string, exclusions: string[]): SourceResult => ({
	operation,
	status: "not_found",
	rows: [],
	total: 0,
	page: 1,
	next: null,
	completeness: "complete",
	exclusions,
});

const forPersonInput = z.strictObject({
	personId: z
		.uuid()
		.optional()
		.describe("A person id from an earlier result. Leave it out to list the people no email has gone out to."),
	limit: z.int().min(1).max(100).optional(),
});
/** An email that went out, or may have: anything handed to the email service. Waiting, refused or cancelled is not. */
const WENT_OUT = `(m.sent_at IS NOT NULL OR m.delivered_at IS NOT NULL OR m.accepted_at IS NOT NULL OR m.state IN ('sent','unknown','dispatched'))`;

export const forPerson: ReadAdapter<z.infer<typeof forPersonInput>> = {
	operation: "communication.forPerson",
	description:
		"The emails Messages sent one person, newest first, each with that person's result (sent, delivered, opened, bounced, failed, checking). Calls, visits and other recorded contacts are not in it, and an email is never one. With no personId: the live people in this church that no email has gone out to.",
	input: forPersonInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const limit = input.limit ?? 20;
		const plant = actor.owner.id;
		if (!input.personId) {
			const r = await tx.execute(sql`
				SELECT p.id,p.display_name AS name,count(*) OVER()::int AS total FROM person p
				WHERE p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid AND p.state='live' AND ${live(actor)}
					AND NOT EXISTS(SELECT FROM mail m WHERE m.tenant_id=p.tenant_id AND m.recipient_person_id=p.id
						AND m.purpose='communication' AND ${sql.raw(WENT_OUT)})
				ORDER BY p.display_name,p.id LIMIT ${limit}`);
			const rows = z.array(z.object({ id: z.uuid(), name: z.string(), total: z.number() })).parse(r.rows);
			const total = rows[0]?.total ?? 0;
			return {
				operation: "communication.forPerson",
				status: rows.length ? "available" : "not_found",
				rows: rows.map((p) => personRow(actor, p.id, p.name, { email: "no email recorded" })),
				total,
				page: 1,
				next: null,
				completeness: total > rows.length ? "partial" : "complete",
				exclusions: [
					"calls, texts, visits and email sent outside Everyfield (Evry checked every live person against Messages history for an email that went out)",
				],
			};
		}
		const r = await tx.execute(sql`
			SELECT EXISTS(SELECT FROM person p WHERE p.id=${input.personId}::uuid AND p.tenant_id=${plant}::uuid AND p.state='live') AS found,
				coalesce((SELECT jsonb_agg(x ORDER BY x.at DESC) FROM (
					SELECT c.id,coalesce(nullif(c.subject,''),'Untitled') AS subject,${sql.raw(RESULT)} AS result,
						coalesce(m.sent_at,m.accepted_at,m.created_at) AS at,
						${sql.raw(local("coalesce(m.sent_at,m.accepted_at,m.created_at)"))} AS sent_at,
						${sql.raw(local("m.delivered_at"))} AS delivered_at,${sql.raw(local("coalesce(m.opened_at,m.clicked_at)"))} AS opened_at
					FROM mail m JOIN communication c ON c.id=m.communication_id AND c.plant_id=m.tenant_id
					WHERE m.tenant_id=${plant}::uuid AND m.recipient_person_id=${input.personId}::uuid AND m.purpose='communication'
					ORDER BY at DESC LIMIT ${limit}) x),'[]'::jsonb) AS emails
			FROM plant pl WHERE pl.id=${plant}::uuid AND ${live(actor)}`);
		const found = z
			.object({
				found: z.boolean(),
				emails: z.array(
					z.object({
						id: z.uuid(),
						subject: z.string(),
						result: z.string(),
						sent_at: z.string(),
						delivered_at: z.string().nullable(),
						opened_at: z.string().nullable(),
					}),
				),
			})
			.optional()
			.parse(r.rows[0]);
		if (!found?.found) return notFound("communication.forPerson", ["email addresses", "message bodies"]);
		const rows: SourceRow[] = [
			...found.emails.map((e) => ({
				kind: "message" as const,
				id: e.id,
				label: e.subject,
				fields: { sentAt: e.sent_at, result: e.result, deliveredAt: e.delivered_at, openedAt: e.opened_at },
			})),
		];
		return {
			operation: "communication.forPerson",
			status: "available",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: [
				"email addresses",
				"message bodies",
				OPEN_NOTE,
				"calls, visits and other recorded contacts (an email is never one)",
			],
		};
	},
};

export const listTemplates: ReadAdapter<Record<string, never>> = {
	operation: "communication.templates.list",
	description:
		"The church's email templates by name. origin is system (Everyfield's own: it can't be edited, only copied first into a church template) or church (the church's own, which can be edited).",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor): Promise<SourceResult> {
		const reply = await communicationWriter.listTemplates(tx, actor.authority);
		if (reply.status !== "ok") throw new EvryRefusal("source_unavailable");
		const rows = reply.value.templates
			.filter((t) => !t.archived)
			.map((t) => ({
				kind: "template" as const,
				id: t.templateId,
				label: t.name,
				fields: {
					origin: t.origin === "system" ? "system" : "church",
					category: t.category,
					subject: t.subject,
					sourceKey: t.origin === "system" ? t.sourceKey : null,
				},
			}));
		return {
			operation: "communication.templates.list",
			status: rows.length ? "available" : "not_found",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["template bodies", "archived templates"],
		};
	},
};

const resendInput = z.strictObject({
	communicationId: z.uuid().describe("A sent message id from communication.get"),
	selection: z
		.enum(["delivered_nonopeners", "proven_failed"])
		.describe(
			"delivered_nonopeners: delivered but no open seen; proven_failed: the email service refused or bounced it",
		),
});
export const resendCandidates: ReadAdapter<z.infer<typeof resendInput>> = {
	operation: "communication.resendCandidates",
	description:
		"Who a resend of a sent email would go to and who is left out. delivered_nonopeners needs the email sent at least 24 hours ago with a delivery confirmed: tooSoon and resendFrom say when it can go. proven_failed lists only recipients the email service refused or bounced; one it never answered is still being checked and is never resent. Open tracking is not reliable.",
	input: resendInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const native = await communicationWriter.listResendCandidates(tx, actor.authority, input);
		if (native.status !== "ok")
			return native.error.code === "not_found"
				? notFound("communication.resendCandidates", [])
				: (() => {
						throw new EvryRefusal(native.error.code === "access_denied" ? "access_denied" : "source_unavailable");
					})();
		const eligible = new Set<string>(native.value.eligibleIds);
		const r = await tx.execute(sql`
			SELECT coalesce(nullif(c.subject,''),'Untitled') AS subject,${sql.raw(local(sentAt("c")))} AS sent_at,
				${sql.raw(local(`${sentAt("c")}+interval '24 hours'`))} AS resend_from,
				coalesce(${sql.raw(sentAt("c"))}+interval '24 hours'>clock_timestamp(),true) AS too_soon,
				coalesce((SELECT jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'result',z.result,'hard_reason',z.hard_reason) ORDER BY z.name,z.id)
					FROM (SELECT y.id,y.name,y.result,coalesce(y.hard_reason,CASE WHEN row_number() OVER (PARTITION BY y.hard_reason IS NULL,coalesce(y.address_hash,y.id::text) ORDER BY y.name,y.id)>1
						THEN 'duplicate_address' END) AS hard_reason
					FROM (SELECT DISTINCT ON (p.id) p.id,p.display_name AS name,m.address_hash,${sql.raw(RESULT)} AS result,
						-- Who no resend may reach now, whatever the email service said before: the same rules as a send.
						CASE WHEN p.state<>'live' OR btrim(coalesce(p.email,''))='' THEN 'cannot_be_emailed'
							WHEN ${optedOutSql(sql`c.plant_id`, sql`p.id`)} THEN 'unsubscribed'
							WHEN EXISTS(SELECT FROM suppression s WHERE s.address_hash=m.address_hash AND s.cleared_at IS NULL) THEN 'blocked'
							WHEN m.state IN ('unknown','dispatched') AND m.delivered_at IS NULL THEN 'still_checking' END AS hard_reason
						FROM mail m JOIN person p ON p.id=m.recipient_person_id AND p.tenant_id=m.tenant_id
						WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id ORDER BY p.id,m.created_at DESC) y) z),'[]'::jsonb) AS people
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			WHERE c.id=${input.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND ${live(actor)}`);
		const found = z
			.object({
				subject: z.string(),
				sent_at: z.string().nullable(),
				resend_from: z.string().nullable(),
				too_soon: z.boolean(),
				people: z.array(
					z.object({ id: z.uuid(), name: z.string(), result: z.string(), hard_reason: z.string().nullable() }),
				),
			})
			.optional()
			.parse(r.rows[0]);
		if (!found) return notFound("communication.resendCandidates", []);
		const nonopeners = input.selection === "delivered_nonopeners";
		const tooSoon = nonopeners && found.too_soon;
		/** Why a recipient is left out, in words of the facts: their own result, or the 24-hour wait. */
		const reason = (p: (typeof found.people)[number]) =>
			p.hard_reason ??
			(eligible.has(p.id)
				? null
				: nonopeners
					? p.result === "opened"
						? "opened"
						: p.result === "delivered" && tooSoon
							? "too_soon"
							: "not_delivered"
					: p.result);
		return {
			operation: "communication.resendCandidates",
			status: "available",
			rows: [
				{
					kind: "message",
					id: input.communicationId,
					label: found.subject,
					fields: {
						selection: input.selection,
						sentAt: found.sent_at,
						tooSoon,
						resendFrom: nonopeners ? found.resend_from : null,
						confirmedDelivery: native.value.confirmedDelivery,
						openTrackingIsCertain: false,
					},
				},
				...found.people.map((p) => personRow(actor, p.id, p.name, { result: p.result, leftOut: reason(p) })),
			],
			total: found.people.filter((p) => reason(p) === null).length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["email addresses", "message bodies", OPEN_NOTE],
		};
	},
};

/** The installed Communication read tools, in catalog order. */
export const COMMUNICATION_READS = [
	listMessages,
	preview,
	getMessage,
	forPerson,
	listTemplates,
	resendCandidates,
] as const;
