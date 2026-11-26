import type { Transaction } from "@everyfield/db/client";
import { meetingTitle } from "@everyfield/contracts/common";
import { plainText } from "@everyfield/contracts/communication";
import { meetingType } from "@everyfield/contracts/meetings";
import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "@everyfield/domain/access";
import { communicationWriter, optedOutSql } from "@everyfield/domain/communication";
import { currentPersonJoin, lineageOf } from "@everyfield/domain/people";
import { z } from "zod";
import type { EvryActor } from "../../../context/actor.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import { personRow } from "../../../catalog/person-row.ts";
import { captured } from "../../../runtime/captured.ts";
import { churchZone, localTime, ownerOrAdmin } from "../../tasks/reads/index.ts";
import { id } from "../../tasks/values.ts";
import type { ReadAdapter, SourceResult, SourceRow } from "../../../catalog/types.ts";
import { audienceInput, classifiedPeople, LEFT_OUT_CHILD, ROUTED_CHILD } from "../audience.ts";

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
const messageRow = z.strictObject({
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
const holding = (message: string) =>
	`${mailOf(message)} AND m.state IN ('scheduled','accepted','unknown','dispatched')`;
export const held = sql.raw(`(SELECT count(*)::int FROM mail m WHERE ${holding("c")})`);
export const unanswered = sql.raw(
	`(SELECT count(*)::int FROM mail m WHERE ${mailOf("c")} AND m.state IN ('unknown','dispatched'))`,
);
const canStillGoOut = sql.raw(
	`(c.state='draft' OR NOT EXISTS(SELECT FROM mail m WHERE ${mailOf("c")})
		OR EXISTS(SELECT FROM mail m WHERE ${mailOf("c")} AND m.state NOT IN ('sent','cancelled','refused','failed')))`,
);
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

const live = (actor: EvryActor) =>
	liveRead({ session: actor.session, owner: actor.owner, seatId: actor.seatId ?? undefined });
const local = (at: string, zone = "pl.timezone") => `to_char((${at}) AT TIME ZONE ${zone},'Dy YYYY-MM-DD HH24:MI')`;

const RESULT = `CASE WHEN m.refusal='unsubscribed' THEN 'unsubscribed'
	WHEN m.refusal='child' THEN 'marked as a child'
	WHEN m.refusal='guardian' THEN 'sent to a parent or guardian instead'
	WHEN m.state='cancelled' THEN 'cancelled'
	WHEN m.bounced_at IS NOT NULL THEN 'bounced'
	WHEN m.state IN ('refused','failed') THEN 'failed'
	WHEN m.opened_at IS NOT NULL OR m.clicked_at IS NOT NULL THEN 'opened'
	WHEN m.delivered_at IS NOT NULL THEN 'delivered'
	WHEN m.state='scheduled' OR (m.state='accepted' AND m.scheduled_at>clock_timestamp()) THEN 'waiting'
	WHEN m.state IN ('accepted','sent') OR m.sent_at IS NOT NULL THEN 'sent'
	ELSE 'checking' END`;
const sentAt = (c: string) =>
	`(SELECT min(coalesce(m.sent_at,m.delivered_at,CASE WHEN m.scheduled_at IS NULL THEN m.accepted_at END))
		FROM mail m WHERE m.tenant_id=${c}.plant_id AND m.communication_id=${c}.id)`;
const OPEN_NOTE =
	"proof anyone read it, will come or talked to anyone (an open is only what the email service's tracking saw; it misses some opens and counts some automatic ones)";

const resultRow = z.strictObject({
	id: z.uuid(),
	name: z.string(),
	result: z.string(),
	delivered_at: z.string().nullable(),
	opened_at: z.string().nullable(),
});
const recipientRow = (actor: EvryActor, r: z.infer<typeof resultRow>) =>
	personRow(actor, r.id, r.name, { result: r.result, deliveredAt: r.delivered_at, openedAt: r.opened_at });

const meetingRow = z.strictObject({
	id: z.uuid(),
	title: z.string().nullable(),
	type: meetingType,
	vision: z.number().int().nullable(),
	starts: z.string(),
});
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

const meetingPatterns = (words: string | undefined) =>
	(words ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length >= 3 && !["the", "and", "our", "for"].includes(w))
		.map((w) => `%${w}%`);
const SOONEST = sql.raw(
	"mt.starts_at < statement_timestamp(), CASE WHEN mt.starts_at >= statement_timestamp() THEN mt.starts_at END, mt.starts_at DESC, mt.id",
);
export const preview: ReadAdapter<z.infer<typeof previewInput>> = {
	operation: "communication.preview",
	description:
		"Check an email you have drafted (subject and body) before it is saved or sent: exactly who its audience reaches. Each person row says leftOut: null when they get it, or why they are left out (no_address, unsubscribed, duplicate_address); the left-out come first: name every one of them with their reason in your answer, however large the audience. When the email is about a meeting, meetingWords or meetingOn also returns the church's matching meetings, upcoming ones soonest first, then past ones latest first: the email is about the first one unless the user named another, so name it without asking which. Saves and sends nothing.",
	input: previewInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const plant = actor.owner.id;
		const words = meetingPatterns(input.meetingWords);
		const wantMeeting = words.length > 0 || input.meetingOn !== undefined;
		const r = await tx.execute(sql`WITH ${classifiedPeople(plant, input.audience, null)}
			SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'reason',reason) ORDER BY reason IS NULL,lower(name) COLLATE "C",id) FROM classified),'[]'::jsonb) AS people,
				CASE WHEN ${wantMeeting} THEN coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'title',x.title,'type',x.type,'vision',x.vision_number,'starts',x.starts) ORDER BY x.n)
					FROM (SELECT mt.id,mt.title,mt.type,mt.vision_number,${sql.raw(local("mt.starts_at", "mt.timezone"))} AS starts,
							row_number() OVER (ORDER BY ${SOONEST}) AS n
						FROM meeting mt WHERE mt.plant_id=${plant}::uuid AND mt.status<>'cancelled'
							AND (${input.meetingOn ?? null}::date IS NULL OR mt.local_date=${input.meetingOn ?? null}::date)
							AND (cardinality(${sql.param(words)}::text[])=0 OR EXISTS(SELECT FROM unnest(${sql.param(words)}::text[]) w(p)
								WHERE mt.title ILIKE w.p OR replace(mt.type,'_',' ') ILIKE w.p))
						ORDER BY ${SOONEST} LIMIT 3) x),'[]'::jsonb) END AS meetings
			WHERE ${live(actor)}`);
		if (!r.rows.length) throw new EvryRefusal("access_denied");
		const found = z
			.strictObject({
				people: z.array(z.strictObject({ id: z.uuid(), name: z.string(), reason: z.string().nullable() })),
				meetings: z.array(meetingRow).nullable(),
			})
			.parse(r.rows[0]);
		const rows: SourceRow[] = [
			...(found.meetings ?? []).map((m) => ({
				kind: "meeting" as const,
				id: m.id,
				label: meetingTitle({ title: m.title, type: m.type, visionNumber: m.vision }),
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

const messageFacts =
	sql.raw(`jsonb_build_object('id',c.id,'subject',coalesce(nullif(c.subject,''),'Untitled'),'state',c.state,
	'sentAt',${local(sentAt("c"))},'scheduledFor',${local("c.scheduled_at")},
	'results',coalesce((SELECT jsonb_object_agg(x.result,x.n) FROM (SELECT ${RESULT} AS result,count(*) AS n
		FROM mail m WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id GROUP BY 1) x),'{}'::jsonb))`);
const facts = z.strictObject({
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
					'delivered_at',${sql.raw(local("m.delivered_at"))},'opened_at',${sql.raw(local("coalesce(m.opened_at,m.clicked_at)"))}) ORDER BY lower(p.display_name) COLLATE "C",p.id)
					FROM mail m ${currentPersonJoin(sql`m.recipient_person_id`, sql`m.tenant_id`)}
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

const draftInput = z.strictObject({
	communicationId: id,
	page: z.int().min(1).max(100).optional().describe("The next part of a long body, from a previous result's next"),
});
const PART_CHARS = 12_000;
const BREAK = "\u0000";
const bodyText = (html: string) =>
	html
		.replace(/<\/(?:p|h[1-3]|blockquote|ul|ol)>/gi, `$&${BREAK}${BREAK}`)
		.replace(/<\/li>|<br\s*\/?>/gi, `$&${BREAK}`)
		.split(BREAK)
		.map((piece) => plainText(piece))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
function bodyParts(body: string) {
	const parts: string[] = [];
	let part = "";
	let size = 0;
	for (const char of body) {
		const length = JSON.stringify(char).length - 2;
		if (size + length > PART_CHARS) {
			parts.push(part);
			part = "";
			size = 0;
		}
		part += char;
		size += length;
	}
	return [...parts, part];
}
export const getDraft: ReadAdapter<z.infer<typeof draftInput>> = {
	operation: "communication.getDraft",
	description:
		"Read back one email's subject and full body as Messages holds it, by its id from communication.list. A long body comes in parts: when next is not null, read that page too before saying you read it all, or say how many parts are left",
	input: draftInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const reply = await communicationWriter.getDraft(tx, actor.authority, { id: input.communicationId });
		if (reply.status !== "ok") {
			if (reply.error.code === "not_found") return notFound("communication.getDraft", []);
			throw new EvryRefusal("source_unavailable");
		}
		const draft = reply.value;
		const parts = bodyParts(bodyText(draft.bodyHtml ?? ""));
		const page = input.page ?? 1;
		const body = parts[page - 1];
		if (body === undefined) return notFound("communication.getDraft", []);
		const next = page < parts.length ? page + 1 : null;
		return {
			operation: "communication.getDraft",
			status: "available",
			rows: [
				{
					kind: "message",
					id: draft.communicationId,
					label: draft.subject ?? "No subject",
					fields: { state: draft.state, subject: draft.subject, body, part: page, parts: parts.length },
				},
			],
			total: 1,
			page,
			next,
			completeness: next === null ? "complete" : "partial",
			exclusions: ["email addresses"],
		};
	},
};

const forPersonInput = z.strictObject({
	personId: z
		.uuid()
		.optional()
		.describe("A person id from an earlier result. Leave it out to list the people no email has gone out to."),
	limit: z.int().min(1).max(100).optional(),
});
const WENT_OUT = `(m.sent_at IS NOT NULL OR m.delivered_at IS NOT NULL OR m.accepted_at IS NOT NULL OR m.state IN ('sent','unknown','dispatched'))`;

export const forPerson: ReadAdapter<z.infer<typeof forPersonInput>> = {
	operation: "communication.forPerson",
	description:
		"The emails Messages sent one person, newest first, each with that person's result (sent, delivered, opened, bounced, failed, checking). Use it whenever someone asks whether a person or household was called, emailed or contacted: list their emails by subject, apart from calls. Calls, visits and other recorded contacts are not in it, and an email is never one. An opened result does not mean they will come or that anyone talked to them: say so. With no personId: the live people in this church that no email has gone out to.",
	input: forPersonInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const limit = input.limit ?? 20;
		const plant = actor.owner.id;
		if (!input.personId) {
			const r = await tx.execute(sql`
				SELECT p.id,p.display_name AS name,count(*) OVER()::int AS total FROM person p
				WHERE p.tenant_id=${plant}::uuid AND p.plant_id=${plant}::uuid AND p.state='live' AND ${live(actor)}
					AND NOT EXISTS(SELECT FROM mail m WHERE m.tenant_id=p.tenant_id AND m.recipient_person_id IN ${lineageOf(sql`p.id`, sql`p.tenant_id`)}
						AND m.purpose='communication' AND ${sql.raw(WENT_OUT)})
				ORDER BY lower(p.display_name) COLLATE "C",p.id LIMIT ${limit}`);
			const rows = z.array(z.strictObject({ id: z.uuid(), name: z.string(), total: z.number() })).parse(r.rows);
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
					WHERE m.tenant_id=${plant}::uuid AND m.recipient_person_id IN ${lineageOf(sql`${input.personId}::uuid`, sql`${plant}::uuid`)} AND m.purpose='communication'
					ORDER BY at DESC LIMIT ${limit}) x),'[]'::jsonb) AS emails
			FROM plant pl WHERE pl.id=${plant}::uuid AND ${live(actor)}`);
		const found = z
			.strictObject({
				found: z.boolean(),
				emails: z.array(
					z.strictObject({
						id: z.uuid(),
						subject: z.string(),
						result: z.string(),
						at: z.string(),
						sent_at: z.string(),
						delivered_at: z.string().nullable(),
						opened_at: z.string().nullable(),
					}),
				),
			})
			.optional()
			.parse(r.rows[0]);
		if (!found?.found) return notFound("communication.forPerson", ["email addresses", "message bodies"]);
		const rows: SourceRow[] = found.emails.map((e) => ({
			kind: "message",
			id: e.id,
			label: e.subject,
			fields: { sentAt: e.sent_at, result: e.result, deliveredAt: e.delivered_at, openedAt: e.opened_at },
		}));
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

const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}/g;
function invitationText(t: { origin: string; meetingType: string | null; bodyHtml: string }): Record<string, string> {
	if (t.origin !== "plant" || !t.meetingType) return {};
	const body = plainText(t.bodyHtml);
	const placeholders = [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => captured(m, 1)))];
	return { meetingType: t.meetingType, body, placeholders: placeholders.join(", ") };
}

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
					...invitationText(t),
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
			exclusions: [
				rows.some((r) => "body" in r.fields) ? "other template bodies" : "template bodies",
				"archived templates",
			],
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
	allowed: (actor) => actor.owner.kind === "plant" && (actor.role === "owner" || actor.role === "admin"),
	async invoke(tx, actor, input): Promise<SourceResult> {
		const native = await communicationWriter.listResendCandidates(tx, actor.authority, input);
		if (native.status !== "ok") {
			if (native.error.code === "not_found") return notFound("communication.resendCandidates", []);
			throw new EvryRefusal(native.error.code === "access_denied" ? "access_denied" : "source_unavailable");
		}
		const eligible = new Set<string>(native.value.eligibleIds);
		const r = await tx.execute(sql`
			SELECT coalesce(nullif(c.subject,''),'Untitled') AS subject,${sql.raw(local(sentAt("c")))} AS sent_at,
				${sql.raw(local(`${sentAt("c")}+interval '24 hours'`))} AS resend_from,
				coalesce(${sql.raw(sentAt("c"))}+interval '24 hours'>clock_timestamp(),true) AS too_soon,
				coalesce((SELECT jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'result',z.result,'hard_reason',z.hard_reason) ORDER BY lower(z.name) COLLATE "C",z.id)
					FROM (SELECT y.id,y.name,y.result,coalesce(y.hard_reason,CASE WHEN row_number() OVER (PARTITION BY y.hard_reason IS NULL,coalesce(y.address_hash,y.id::text) ORDER BY lower(y.name) COLLATE "C",y.id)>1
						THEN 'duplicate_address' END) AS hard_reason
					FROM (SELECT DISTINCT ON (p.id) p.id,p.display_name AS name,m.address_hash,${sql.raw(RESULT)} AS result,
						CASE WHEN p.state<>'live' OR btrim(coalesce(p.email,''))='' THEN 'cannot_be_emailed'
							WHEN ${optedOutSql(sql`c.plant_id`, sql`p.id`)} THEN 'unsubscribed'
							WHEN EXISTS(SELECT FROM suppression s WHERE s.address_hash=m.address_hash AND s.cleared_at IS NULL) THEN 'blocked'
							WHEN m.state IN ('unknown','dispatched') AND m.delivered_at IS NULL THEN 'still_checking' END AS hard_reason
						FROM mail m ${currentPersonJoin(sql`m.recipient_person_id`, sql`m.tenant_id`)}
						WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id ORDER BY p.id,m.created_at DESC) y) z),'[]'::jsonb) AS people
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			WHERE c.id=${input.communicationId}::uuid AND c.plant_id=${actor.owner.id}::uuid AND ${live(actor)}`);
		const found = z
			.strictObject({
				subject: z.string(),
				sent_at: z.string().nullable(),
				resend_from: z.string().nullable(),
				too_soon: z.boolean(),
				people: z.array(
					z.strictObject({ id: z.uuid(), name: z.string(), result: z.string(), hard_reason: z.string().nullable() }),
				),
			})
			.optional()
			.parse(r.rows[0]);
		if (!found) return notFound("communication.resendCandidates", []);
		const nonopeners = input.selection === "delivered_nonopeners";
		const tooSoon = nonopeners && found.too_soon;
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

const localDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/)
	.describe("That meeting's local date, like 2026-11-12");
const meetingInput = z.strictObject({
	meetingId: z.uuid().optional().describe("A meeting id from an earlier result"),
	meetingWords: z.string().trim().min(3).max(120).optional().describe("Words naming the meeting, like 'vision night'"),
	meetingOn: localDate.optional(),
});
type MeetingInput = z.infer<typeof meetingInput>;

const HAS_EMAILS = sql`EXISTS(SELECT FROM communication c WHERE c.plant_id=mt.plant_id AND c.meeting_id=mt.id)`;
const HAS_RECIPIENTS = sql`EXISTS(SELECT FROM communication c JOIN mail m ON m.tenant_id=c.plant_id AND m.communication_id=c.id
	WHERE c.plant_id=mt.plant_id AND c.meeting_id=mt.id AND m.recipient_person_id IS NOT NULL)`;
async function findMeeting(tx: Transaction, actor: EvryActor, input: MeetingInput, holds: SQL) {
	const words = sql`${sql.param(meetingPatterns(input.meetingWords))}::text[]`;
	const matched = sql`(SELECT count(*) FROM unnest(${words}) w(p) WHERE mt.title ILIKE w.p OR replace(mt.type,'_',' ') ILIKE w.p)`;
	const r = await tx.execute(sql`
		SELECT mt.id,mt.title,mt.type,mt.vision_number AS vision,${sql.raw(local("mt.starts_at", "mt.timezone"))} AS starts
		FROM meeting mt WHERE mt.plant_id=${actor.owner.id}::uuid AND ${live(actor)}
			AND (${input.meetingId ?? null}::uuid IS NULL OR mt.id=${input.meetingId ?? null}::uuid)
			AND (${input.meetingId ?? null}::uuid IS NOT NULL OR mt.status<>'cancelled')
			AND (${input.meetingOn ?? null}::date IS NULL OR mt.local_date=${input.meetingOn ?? null}::date)
			AND (cardinality(${words})=0 OR ${matched}>0)
		ORDER BY ${matched} DESC,${holds} DESC, ${SOONEST} LIMIT 1`);
	const found = meetingRow.optional().parse(r.rows[0]);
	return found
		? {
				kind: "meeting" as const,
				id: found.id,
				label: meetingTitle({ title: found.title, type: found.type, visionNumber: found.vision }),
				fields: { startsAt: found.starts, type: found.type },
			}
		: null;
}
const NO_MEETING = "no meeting matched";
const nativeRefusal = (code: string) =>
	new EvryRefusal(code === "access_denied" ? "access_denied" : "source_unavailable");

export const forMeeting: ReadAdapter<MeetingInput> = {
	operation: "communication.forMeeting",
	description:
		"The emails Messages holds about one meeting: by meetingId, or the church's matching meeting from meetingWords or meetingOn (the meeting matching the most words, then one that has emails, then upcoming soonest, then past latest). The first row is the meeting; each email row has its subject, state (draft, scheduled, sending, sent, cancelled, failed and the like) and its send time in the church's time zone. Emails about other meetings are not in it. A sent state is not a confirmed delivery.",
	input: meetingInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const meeting = await findMeeting(tx, actor, input, HAS_EMAILS);
		if (!meeting) return notFound("communication.forMeeting", [NO_MEETING]);
		const reply = await communicationWriter.listForMeeting(tx, actor.authority, { meetingId: meeting.id, limit: 50 });
		if (reply.status !== "ok") {
			if (reply.error.code === "not_found") return notFound("communication.forMeeting", [NO_MEETING]);
			throw nativeRefusal(reply.error.code);
		}
		const zone = await churchZone(tx, actor);
		const rows = reply.value.items.map((m) => ({
			kind: "message" as const,
			id: m.id,
			label: m.subject || "Untitled",
			fields: {
				state: m.state,
				sentAt: localTime(m.sentAt, zone),
				scheduledFor: localTime(m.scheduledAt, zone),
			},
		}));
		return {
			operation: "communication.forMeeting",
			status: "available",
			rows: [meeting, ...rows],
			total: reply.value.nextCursor ? null : rows.length,
			page: 1,
			next: null,
			completeness: reply.value.nextCursor ? "partial" : "complete",
			exclusions: ["email addresses", "message bodies", "emails about other meetings"],
		};
	},
};

const trackedRow = z.strictObject({
	id: z.uuid(),
	result: z.string(),
	delivered_at: z.string().nullable(),
	opened_at: z.string().nullable(),
});
export const meetingRecipientTracking: ReadAdapter<MeetingInput> = {
	operation: "communication.meetingRecipientTracking",
	description:
		"Who the emails about one meeting went to (its invitation and the rest), found like communication.forMeeting, and each person's latest result: waiting (held for its send time), checking (the email service has not answered, so it may or may not have gone), sent (accepted, delivery not confirmed yet), delivered, opened, bounced, failed, cancelled or unsubscribed. Never call one delivered before its result says delivered, and say what an open does not prove.",
	input: meetingInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const meeting = await findMeeting(tx, actor, input, HAS_RECIPIENTS);
		if (!meeting) return notFound("communication.meetingRecipientTracking", [NO_MEETING]);
		const reply = await communicationWriter.listMeetingTracking(tx, actor.authority, { meetingId: meeting.id });
		if (reply.status !== "ok") {
			if (reply.error.code === "not_found") return notFound("communication.meetingRecipientTracking", [NO_MEETING]);
			throw nativeRefusal(reply.error.code);
		}
		const r = await tx.execute(sql`
			SELECT DISTINCT ON (p.id) p.id,${sql.raw(RESULT)} AS result,
				${sql.raw(local("m.delivered_at"))} AS delivered_at,${sql.raw(local("coalesce(m.opened_at,m.clicked_at)"))} AS opened_at
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			JOIN mail m ON m.tenant_id=c.plant_id AND m.communication_id=c.id
			${currentPersonJoin(sql`m.recipient_person_id`, sql`m.tenant_id`)}
			WHERE c.plant_id=${actor.owner.id}::uuid AND c.meeting_id=${meeting.id}::uuid
			ORDER BY p.id,m.created_at DESC,m.id DESC`);
		const results = new Map(
			z
				.array(trackedRow)
				.parse(r.rows)
				.map((row) => [row.id, row]),
		);
		const people = reply.value.items.map((p) => {
			const found = results.get(p.personId);
			return personRow(actor, p.personId, p.name, {
				result: found?.result ?? "checking",
				deliveredAt: found?.delivered_at ?? null,
				openedAt: found?.opened_at ?? null,
			});
		});
		return {
			operation: "communication.meetingRecipientTracking",
			status: "available",
			rows: [meeting, ...people],
			total: people.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["email addresses", "message bodies", OPEN_NOTE],
		};
	},
};

const totalsInput = z.strictObject({
	communicationId: z.uuid().optional().describe("A message id from an earlier result"),
	subject: z.string().trim().min(1).max(200).optional().describe("Words from the subject"),
});
export const deliveryTotals: ReadAdapter<z.infer<typeof totalsInput>> = {
	operation: "communication.deliveryTotals",
	description:
		"How one email did, as counts: by id, or else the most recent email handed to the email service whose subject matches (leave both out for the latest one). sent counts every recipient the email service accepted, delivered only those it confirmed delivered, so never call sent delivered; deliveryNotConfirmed is the difference. opened, bounced, failed, unsubscribed and stillChecking (the email service has not answered yet) follow, with asOf: the time the counts were read, in the church's time zone. Say how many recipients it had, give every count that isn't zero and say what an open does not prove.",
	input: totalsInput,
	allowed: inPlant,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const words = input.subject ? `%${input.subject.replace(/[\\%_]/g, "\\$&")}%` : null;
		const found = await tx.execute(sql`
			SELECT c.id,coalesce(nullif(c.subject,''),'Untitled') AS subject,${sql.raw(local(sentAt("c")))} AS sent_at
			FROM communication c JOIN plant pl ON pl.id=c.plant_id
			WHERE c.plant_id=${actor.owner.id}::uuid AND ${live(actor)}
				AND (${input.communicationId ?? null}::uuid IS NULL OR c.id=${input.communicationId ?? null}::uuid)
				AND (${input.communicationId ?? null}::uuid IS NOT NULL OR EXISTS(SELECT FROM mail m WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id))
				AND (${words}::text IS NULL OR c.subject ILIKE ${words} ESCAPE '\\')
			ORDER BY (SELECT max(m.created_at) FROM mail m WHERE m.tenant_id=c.plant_id AND m.communication_id=c.id) DESC NULLS LAST,c.created_at DESC
			LIMIT 1`);
		const message = z
			.strictObject({ id: z.uuid(), subject: z.string(), sent_at: z.string().nullable() })
			.optional()
			.parse(found.rows[0]);
		if (!message) return notFound("communication.deliveryTotals", ["email addresses", "message bodies"]);
		const reply = await communicationWriter.getDeliveryTotals(tx, actor.authority, { communicationId: message.id });
		if (reply.status !== "ok") {
			if (reply.error.code === "not_found")
				return notFound("communication.deliveryTotals", ["email addresses", "message bodies"]);
			throw nativeRefusal(reply.error.code);
		}
		const t = reply.value;
		const zone = await churchZone(tx, actor);
		return {
			operation: "communication.deliveryTotals",
			status: "available",
			rows: [
				{
					kind: "tally",
					id: message.id,
					label: message.subject,
					fields: {
						state: t.state,
						sentAt: message.sent_at,
						recipients: t.selected,
						sent: t.sent,
						delivered: t.delivered,
						deliveryNotConfirmed: Math.max(0, t.sent - t.delivered),
						opened: t.opened,
						bounced: t.bounced,
						failed: t.failed,
						unsubscribed: t.unsubscribed,
						stillChecking: t.unknown,
						asOf: localTime(t.asOf, zone),
					},
				},
			],
			total: 1,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["email addresses", "message bodies", OPEN_NOTE],
		};
	},
};

export const listAudienceTeams: ReadAdapter<Record<string, never>> = {
	operation: "communication.listAudienceTeams",
	description:
		"The church's teams an email can be sent to as an audience, by name, with the id an email's audience teamIds takes.",
	input: z.strictObject({}),
	allowed: ownerOrAdmin,
	async invoke(tx, actor): Promise<SourceResult> {
		const reply = await communicationWriter.listAudienceTeams(tx, actor.authority);
		if (reply.status !== "ok") throw nativeRefusal(reply.error.code);
		const rows = reply.value.teams.map((t) => ({ kind: "team" as const, id: t.id, label: t.name, fields: {} }));
		return {
			operation: "communication.listAudienceTeams",
			status: rows.length ? "available" : "not_found",
			rows,
			total: rows.length,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["archived teams", "team members"],
		};
	},
};

const searchInput = z.strictObject({
	query: z.string().trim().min(1).max(200).describe("A name, or words from one"),
});
export const searchRecipients: ReadAdapter<z.infer<typeof searchInput>> = {
	operation: "communication.searchRecipients",
	description:
		"Find live people by name to email, up to 20. Use this, not people.listPeople, when asked whether someone can be emailed, and when several match, give each one's email status. Each row's email says whether Messages can email them: can_email, no_address (no email address recorded) or unsubscribed (they opted out of this church's email). Never print an email address.",
	input: searchInput,
	allowed: ownerOrAdmin,
	async invoke(tx, actor, input): Promise<SourceResult> {
		const reply = await communicationWriter.readRecipients(tx, actor.authority, { query: input.query });
		if (reply.status !== "ok") throw nativeRefusal(reply.error.code);
		const rows = reply.value.people.map((p) =>
			personRow(actor, p.id, p.displayName, {
				email:
					p.email && p.unsubscribedAt
						? "unsubscribed"
						: p.guardians.length
							? ROUTED_CHILD
							: !p.email
								? "no_address"
								: p.child
									? LEFT_OUT_CHILD
									: "can_email",
			}),
		);
		return {
			operation: "communication.searchRecipients",
			status: rows.length ? "available" : "not_found",
			rows,
			total: rows.length === reply.value.limit ? null : rows.length,
			page: 1,
			next: null,
			completeness: rows.length === reply.value.limit ? "partial" : "complete",
			exclusions: ["email addresses", "addresses the email service blocks: the send review checks them"],
		};
	},
};

const ownEmail = z.strictObject({ email: z.string() });
export const listForSelf: ReadAdapter<Record<string, never>> = {
	operation: "mail.suppression.listForSelf",
	description:
		"Whether the signed-in user's own verified email address is blocked from Everyfield email (after a bounce or a complaint), and when and why it was restored before. It reads only their own address and takes none. Evry can't clear a block: they restore it themselves in Messages.",
	input: z.strictObject({}),
	allowed: inPlant,
	async invoke(tx, actor, _input, _native, _loaded, mail): Promise<SourceResult> {
		if (!mail) throw new EvryRefusal("source_unavailable");
		const r = await tx.execute(
			sql`SELECT c.email FROM access_account_contact(${actor.accountId}::uuid) c WHERE c.verified LIMIT 1`,
		);
		const own = ownEmail.optional().parse(r.rows[0]);
		if (!own) return notFound("mail.suppression.listForSelf", ["your address: it isn't verified"]);
		const reply = await communicationWriter.listForSelf(tx, actor.authority, { address: own.email }, mail.keys);
		if (reply.status !== "ok") throw nativeRefusal(reply.error.code);
		const zone = await churchZone(tx, actor);
		return {
			operation: "mail.suppression.listForSelf",
			status: "available",
			rows: [
				{
					kind: "setting",
					id: actor.accountId,
					label: "Your email address",
					fields: { blocked: reply.value.active, restores: reply.value.restores.length },
				},
				...reply.value.restores.map((x, n) => ({
					kind: "history" as const,
					id: `${actor.accountId}:restore:${n + 1}`,
					label: "Restored",
					fields: { at: localTime(x.at, zone), by: x.actorName, reason: x.reason },
				})),
			],
			total: reply.value.restores.length + 1,
			page: 1,
			next: null,
			completeness: "complete",
			exclusions: ["the address itself", "any address but your own"],
		};
	},
};

export const COMMUNICATION_READS = [
	listMessages,
	preview,
	getMessage,
	forPerson,
	listTemplates,
	resendCandidates,
	forMeeting,
	meetingRecipientTracking,
	deliveryTotals,
	listAudienceTeams,
	searchRecipients,
	listForSelf,
	getDraft,
] as const;
