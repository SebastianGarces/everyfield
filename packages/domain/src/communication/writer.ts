import { createHash, randomUUID } from "node:crypto";
import { sql, type SQL } from "@everyfield/db/query";
import * as c from "@everyfield/contracts/communication";
import {
	scheduleAccepted,
	plainText,
	renderBody,
	sanitizeHtml,
	systemInvitation,
	systemTemplate,
	systemTemplates,
} from "@everyfield/contracts/communication";
import { z } from "zod";
import type { RequestActor } from "../access/session.ts";
import { liveRead } from "../access/session.ts";
import { audiencePeople, eligibleIds, summarizeAudience } from "./audience.ts";
import {
	administers,
	audit,
	command,
	deny,
	hash,
	parse,
	readReply,
	readerOf,
	reply,
	type Command,
	type CommunicationContext,
	type Tx,
} from "./core.ts";

const emptyAudience = { groups: [] as string[], teamIds: [] as string[], personIds: [] as string[] };

function forkId(plantId: string, sourceKey: string): string {
	const bytes = createHash("sha256").update(`${plantId}\0${sourceKey}`).digest();
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const bump = (revision: string) => String(BigInt(revision) + 1n);
const one = (result: { rows: unknown[] }) => result.rows[0];

const draftRow = z.object({
	id: z.uuid(),
	revision: z.string(),
	state: z.enum(c.communicationStates),
	subject: z.string().nullable(),
	body_html: z.string().nullable(),
	body_text: z.string().nullable(),
	template_id: z.uuid().nullable(),
	template_source: z.string().nullable(),
	meeting_id: z.uuid().nullable(),
	audience: c.audienceInput,
	scheduled_at: z.string().nullable(),
	review_digest: z.string().nullable(),
});
type DraftRow = z.infer<typeof draftRow>;
const templateRow = z.object({
	id: z.uuid(),
	revision: z.string(),
	source_key: z.string().nullable(),
	name: z.string(),
	description: z.string().nullable(),
	category: c.templateCategory,
	meeting_type: c.meetingTemplateType.nullable(),
	subject: z.string(),
	body_html: z.string(),
	archived_at: z.string().nullable(),
});
type TemplateRow = z.infer<typeof templateRow>;

function asDraft(row: DraftRow) {
	return c.draftResult.parse({
		communicationId: row.id,
		revision: row.revision,
		state: row.state,
		subject: row.subject,
		bodyHtml: row.body_html,
		bodyText: row.body_text,
		audience: row.audience,
		meetingId: row.meeting_id,
		templateId: row.template_id,
		templateSource: row.template_source,
	});
}
function asTemplate(row: TemplateRow) {
	return c.templateResult.parse({
		templateId: row.id,
		revision: row.revision,
		sourceKey: row.source_key,
		name: row.name,
		description: row.description,
		category: row.category,
		meetingType: row.meeting_type,
		subject: row.subject,
		bodyHtml: row.body_html,
		archived: row.archived_at !== null,
		origin: "plant",
	});
}
function asSystem(template: c.SystemTemplate) {
	return c.templateResult.parse({
		templateId: forkId("00000000-0000-0000-0000-000000000000", template.sourceKey),
		revision: "1",
		sourceKey: template.sourceKey,
		name: template.name,
		description: template.description,
		category: template.category,
		meetingType: template.meetingType,
		subject: template.subject,
		bodyHtml: template.bodyHtml,
		archived: false,
		origin: "system",
	});
}
function draftSelect(actor: Command["actor"], session: string, id: string) {
	return sql`SELECT id, revision::text AS revision, state, subject, body_html, body_text, template_id, template_source,
		meeting_id, audience, to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS scheduled_at,
		review_digest
		FROM communication WHERE id = ${id}::uuid AND plant_id = ${actor.plantId}::uuid AND ${writeBound(actor, session)} FOR UPDATE`;
}
function templateSelect(actor: Command["actor"], session: string, id: string) {
	return sql`SELECT id, revision::text AS revision, source_key, name, description, category, meeting_type, subject, body_html,
		to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS archived_at
		FROM message_template WHERE id = ${id}::uuid AND plant_id = ${actor.plantId}::uuid AND ${writeBound(actor, session)} FOR UPDATE`;
}
async function lockDraft(
	tx: Tx,
	actor: Command["actor"],
	session: string,
	id: string,
	revision: string,
	states: readonly DraftRow["state"][],
) {
	const row = draftRow.safeParse(one(await tx.execute(draftSelect(actor, session, id))));
	if (!row.success) deny("not_found");
	if (row.data.revision !== revision || !states.includes(row.data.state)) deny("conflict");
	return row.data;
}
async function lockTemplate(tx: Tx, actor: Command["actor"], session: string, id: string, revision: string) {
	const row = templateRow.safeParse(one(await tx.execute(templateSelect(actor, session, id))));
	if (!row.success) deny("not_found");
	if (row.data.revision !== revision) deny("conflict");
	return row.data;
}
async function subjects(
	tx: Tx,
	actor: Command["actor"],
	session: string,
	meetingId: string | null,
	templateId: string | null,
) {
	if (!meetingId && !templateId) return;
	const raw = one(
		await tx.execute(
			whenLive(
				writeBound(actor, session),
				sql`SELECT
					(${meetingId}::uuid IS NULL OR EXISTS (SELECT 1 FROM meeting m WHERE m.id = ${meetingId}::uuid AND m.plant_id = ${actor.plantId}::uuid)) AS meeting_ok,
					(${templateId}::uuid IS NULL OR EXISTS (SELECT 1 FROM message_template t WHERE t.id = ${templateId}::uuid AND t.plant_id = ${actor.plantId}::uuid)) AS template_ok`,
			),
		),
	) as { allowed: boolean; meeting_ok: boolean | null; template_ok: boolean | null };
	if (raw.allowed !== true) deny("access_denied");
	if (!raw.meeting_ok || !raw.template_ok) deny("invalid_subject");
}
function storedBody(value: string | null | undefined): string | null {
	if (value == null) return null;
	const html = sanitizeHtml(value);
	return html ? html : null;
}
function templateBody(input: c.TemplateDraft) {
	const bodyHtml = sanitizeHtml(input.bodyHtml);
	if (!bodyHtml) deny("invalid_input");
	const meetingType = input.meetingType ?? null;
	if (meetingType && input.category !== "meeting_invitation") deny("invalid_input");
	return {
		name: input.name,
		description: input.description ?? null,
		category: input.category,
		meetingType,
		subject: input.subject,
		bodyHtml,
		bodyText: plainText(bodyHtml),
	};
}
function accessOf(authority: RequestActor) {
	const reader = readerOf(authority);
	return {
		reader,
		access: { session: reader.session, owner: reader.owner, seatId: reader.seatId, role: reader.role },
	};
}
/**
 * C13. live_session joins account.auth_user_id to auth_session.user_id.
 * The runtime role cannot read auth_session, so this statement binds that account to the claimed actor.
 */
function sessionActor(
	reader: { session: string; accountId: string; plantId: string; seatId: string; role: Command["actor"]["role"] },
	admin: boolean,
) {
	return sql`EXISTS (SELECT 1 FROM live_session(${reader.session}::uuid) i
		JOIN account a ON a.id = i.account_id AND a.id = ${reader.accountId}::uuid AND a.auth_user_id IS NOT NULL
		JOIN seat st ON st.account_id = a.id AND st.id = ${reader.seatId}::uuid AND st.plant_id = ${reader.plantId}::uuid
			AND st.ended_at IS NULL AND st.accepted_at <= clock_timestamp() AND st.role = ${reader.role}
			AND (${admin}::boolean = false OR st.role <> 'member')
		WHERE i.registration_state = 'active' AND i.expires_at > clock_timestamp())`;
}
function allowed(
	access: {
		session: string;
		owner: ReturnType<typeof readerOf>["owner"];
		seatId: string;
		role: Command["actor"]["role"];
	},
	reader: { session: string; accountId: string; plantId: string; seatId: string; role: Command["actor"]["role"] },
	admin: boolean,
) {
	return sql`${liveRead(access, admin)} AND ${sessionActor(reader, admin)}`;
}
function writeBound(actor: Command["actor"], session: string) {
	return sessionActor(
		{
			session,
			accountId: actor.accountId,
			plantId: actor.plantId,
			seatId: actor.seatId,
			role: actor.role,
		},
		true,
	);
}
function requireAllowed(allowed: boolean) {
	if (allowed !== true) deny("access_denied");
}
/** C13. Columns of `query` are computed only while `live` is true, in this same statement. */
function whenLive(live: SQL, query: SQL) {
	return sql`SELECT g.allowed, q.* FROM (SELECT ${live} AS allowed) g LEFT JOIN LATERAL (${query}) q ON g.allowed`;
}
/** The fields a schedule stores and a later preview compares. Both calls use this one value. */
function reviewedDigest(subject: string | null, body: string | null, people: readonly string[]) {
	return hash({ subject, body, people });
}
const draftFields = [
	"state",
	"subject",
	"audience",
	"meeting_id",
	"template_id",
	"template_source",
	"scheduled_at",
	"review_digest",
] as const;
const templateFields = ["name", "category", "meeting_type", "source_key", "subject", "archived_at"] as const;
function permitted(row: object | null, keys: readonly string[]) {
	if (!row) return null;
	const source = row as Record<string, unknown>;
	const value: Record<string, unknown> = {};
	for (const key of keys) if (Object.hasOwn(source, key)) value[key] = source[key];
	if (Object.hasOwn(source, "body_html")) value.body_sha256 = source.body_html == null ? null : hash(source.body_html);
	return value;
}
function changed(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
	const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
		(key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]),
	);
	return {
		before: before ? Object.fromEntries(keys.map((key) => [key, before[key] ?? null])) : null,
		after: after ? Object.fromEntries(keys.map((key) => [key, after[key] ?? null])) : null,
	};
}

export const communicationWriter = {
	async saveDraft(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => saveDraft(tx, context, raw));
	},
	async deleteDraft(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => mutateDraft(tx, context, raw, "communication.deleteDraft"));
	},
	async scheduleReviewed(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => schedule(tx, context, raw, false));
	},
	async rescheduleReviewed(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => schedule(tx, context, raw, true));
	},
	async createTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => createTemplate(tx, context, raw));
	},
	async forkTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => forkTemplate(tx, context, raw));
	},
	async updateTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => updateTemplate(tx, context, raw));
	},
	async archiveTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => archiveTemplate(tx, context, raw));
	},
	async deleteTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
		return reply(tx, () => deleteTemplate(tx, context, raw));
	},
	readPreview: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => preview(tx, authority, raw)),
	readAudience: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => audience(tx, authority, raw)),
	readRecipients: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => recipients(tx, authority, raw)),
	readMergeFields: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => merge(tx, authority, raw)),
	readMeetingTemplate: (tx: Tx, authority: RequestActor, raw: unknown) =>
		readReply(() => meetingTemplate(tx, authority, raw)),
	list: (tx: Tx, authority: RequestActor) => readReply(() => listDrafts(tx, authority, null)),
	get: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => getDraft(tx, authority, raw)),
	getDraft: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => getDraft(tx, authority, raw)),
	listDrafts: (tx: Tx, authority: RequestActor) => readReply(() => listDrafts(tx, authority, "draft")),
	listAudienceTeams: (tx: Tx, authority: RequestActor) => readReply(() => teams(tx, authority)),
	listTemplates: (tx: Tx, authority: RequestActor) => readReply(() => templates(tx, authority)),
	getTemplate: (tx: Tx, authority: RequestActor, raw: unknown) => readReply(() => template(tx, authority, raw)),
};

type DraftValue = z.infer<typeof c.draftResult>;
async function saveDraft(tx: Tx, context: CommunicationContext, raw: unknown): Promise<DraftValue> {
	const input = parse(c.saveDraftRequest, raw);
	if (input.input.communicationId && !input.expectedRevision) deny("invalid_input");
	return command(tx, context, "communication.saveDraft", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const meetingId = input.input.meetingId ?? null;
		const templateId = input.input.templateId ?? null;
		await subjects(tx, cmd.actor, context.session, meetingId, templateId);
		const body = storedBody(input.input.bodyHtml);
		if (input.input.communicationId) {
			const current = await lockDraft(
				tx,
				cmd.actor,
				context.session,
				input.input.communicationId,
				input.expectedRevision!,
				["draft"],
			);
			const next = {
				subject: input.input.subject === undefined ? current.subject : input.input.subject,
				body_html: input.input.bodyHtml === undefined ? current.body_html : body,
				body_text: input.input.bodyHtml === undefined ? current.body_text : body ? plainText(body) : null,
				audience: input.input.audience ?? current.audience,
				meeting_id: input.input.meetingId === undefined ? current.meeting_id : meetingId,
				template_id: input.input.templateId === undefined ? current.template_id : templateId,
				template_source:
					input.input.templateSource === undefined ? current.template_source : (input.input.templateSource ?? null),
				revision: bump(current.revision),
			};
			cmd.writes
				.push(sql`UPDATE communication SET subject = ${next.subject}, body_html = ${next.body_html}, body_text = ${next.body_text},
				audience = ${JSON.stringify(next.audience)}::jsonb, meeting_id = ${next.meeting_id}::uuid, template_id = ${next.template_id}::uuid,
				template_source = ${next.template_source}, revision = ${next.revision}::bigint, updated_at = clock_timestamp()
				WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND revision = ${current.revision}::bigint AND state = 'draft'
				AND ${writeBound(cmd.actor, context.session)}`);
			audit(
				cmd,
				fact(
					cmd,
					"communication",
					"edit",
					current.id,
					current.revision,
					next.revision,
					"communication.saveDraft",
					current,
					{ ...current, ...next },
				),
			);
			return asDraft({ ...current, ...next, state: "draft" });
		}
		const id = randomUUID();
		const created: DraftRow = {
			id,
			revision: "1",
			state: "draft",
			subject: input.input.subject ?? null,
			body_html: body,
			body_text: body ? plainText(body) : null,
			template_id: templateId,
			template_source: input.input.templateSource ?? null,
			meeting_id: meetingId,
			audience: input.input.audience ?? emptyAudience,
			scheduled_at: null,
			review_digest: null,
		};
		cmd.writes
			.push(sql`INSERT INTO communication (id, plant_id, author_id, revision, state, subject, body_html, body_text, template_id, template_source, meeting_id, audience)
			SELECT ${id}::uuid, ${cmd.actor.plantId}::uuid, ${cmd.actor.accountId}::uuid, 1, 'draft', ${created.subject}, ${created.body_html}, ${created.body_text},
				${created.template_id}::uuid, ${created.template_source}, ${created.meeting_id}::uuid, ${JSON.stringify(created.audience)}::jsonb
			WHERE ${writeBound(cmd.actor, context.session)}`);
		audit(cmd, fact(cmd, "communication", "create", id, null, "1", "communication.saveDraft", null, created));
		return asDraft(created);
	});
}
function fact(
	_cmd: Command,
	subjectType: "communication" | "message_template",
	kind: "create" | "edit" | "remove",
	subjectId: string,
	beforeRevision: string | null,
	afterRevision: string,
	operation: string,
	beforeRow: object | null,
	afterRow: object | null,
) {
	const values = changed(
		permitted(beforeRow, subjectType === "communication" ? draftFields : templateFields),
		permitted(afterRow, subjectType === "communication" ? draftFields : templateFields),
	);
	return {
		subjectId,
		subjectType,
		kind,
		before: values.before,
		after: values.after,
		beforeRevision,
		afterRevision,
		operation,
	};
}
async function mutateDraft(tx: Tx, context: CommunicationContext, raw: unknown, operation: string) {
	const input = parse(c.deleteDraftRequest, raw);
	return command(tx, context, operation, input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const current = await lockDraft(
			tx,
			cmd.actor,
			context.session,
			input.input.communicationId,
			input.expectedRevision,
			["draft"],
		);
		cmd.writes.push(
			sql`DELETE FROM communication WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND state = 'draft' AND revision = ${current.revision}::bigint AND ${writeBound(cmd.actor, context.session)}`,
		);
		audit(
			cmd,
			fact(cmd, "communication", "remove", current.id, current.revision, current.revision, operation, current, null),
		);
		return asDraft(current);
	});
}
async function schedule(tx: Tx, context: CommunicationContext, raw: unknown, onlyTime: boolean) {
	const input = parse(c.scheduleRequest, raw);
	const operation = onlyTime ? "communication.rescheduleReviewed" : "communication.scheduleReviewed";
	return command(tx, context, operation, input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const at = new Date(input.input.scheduledAt);
		if (!scheduleAccepted(new Date(), at)) deny("schedule_window_exceeded", { providerHandoffs: 0 });
		const current = await lockDraft(
			tx,
			cmd.actor,
			context.session,
			input.input.communicationId,
			input.expectedRevision,
			onlyTime ? ["scheduled"] : ["draft", "reviewed"],
		);
		if (!onlyTime) {
			if (!current.subject || !current.body_html) deny("invalid_input");
			const peopleRaw = one(
				await tx.execute(
					whenLive(
						writeBound(cmd.actor, context.session),
						sql`SELECT ${audiencePeople(cmd.actor.plantId, current.audience)} AS people`,
					),
				),
			) as { allowed: boolean; people: unknown };
			if (peopleRaw.allowed !== true) deny("access_denied");
			const people = peopleRaw.people;
			if (!eligibleIds(people).length) deny("invalid_input");
			const digest = reviewedDigest(current.subject, current.body_html, eligibleIds(people));
			const revision = bump(current.revision);
			const scheduled = {
				...current,
				revision,
				state: "scheduled" as const,
				scheduled_at: at.toISOString(),
				review_digest: digest,
			};
			cmd.writes.push(sql`UPDATE communication SET state = 'scheduled', scheduled_at = ${at.toISOString()}::timestamptz,
				review_digest = ${digest}, revision = ${revision}::bigint, updated_at = clock_timestamp()
				WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND revision = ${current.revision}::bigint AND ${writeBound(cmd.actor, context.session)}`);
			audit(
				cmd,
				fact(cmd, "communication", "edit", current.id, current.revision, revision, operation, current, scheduled),
			);
			return c.scheduleResult.parse({
				...asDraft(scheduled),
				scheduleStatus: "accepted",
				scheduleSent: false,
				draftIntents: 0,
				replacementIntents: 0,
				scheduledAt: at.toISOString(),
			});
		}
		const revision = bump(current.revision);
		const moved = { ...current, revision, scheduled_at: at.toISOString() };
		cmd.writes
			.push(sql`UPDATE communication SET scheduled_at = ${at.toISOString()}::timestamptz, revision = ${revision}::bigint, updated_at = clock_timestamp()
			WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND state = 'scheduled' AND revision = ${current.revision}::bigint AND ${writeBound(cmd.actor, context.session)}`);
		audit(cmd, fact(cmd, "communication", "edit", current.id, current.revision, revision, operation, current, moved));
		return c.scheduleResult.parse({
			...asDraft(moved),
			scheduleStatus: "accepted",
			scheduleSent: false,
			draftIntents: 0,
			replacementIntents: 0,
			scheduledAt: at.toISOString(),
		});
	});
}
async function createTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.createTemplateRequest, raw);
	return command(tx, context, "communication.templates.create", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const body = templateBody(input.input);
		const id = randomUUID();
		cmd.writes
			.push(sql`INSERT INTO message_template (id, plant_id, name, description, category, meeting_type, subject, body_html, body_text)
			SELECT ${id}::uuid, ${cmd.actor.plantId}::uuid, ${body.name}, ${body.description}, ${body.category}, ${body.meetingType}, ${body.subject}, ${body.bodyHtml}, ${body.bodyText}
			WHERE ${writeBound(cmd.actor, context.session)}`);
		const created = {
			id,
			revision: "1",
			source_key: null,
			name: body.name,
			description: body.description,
			category: body.category,
			meeting_type: body.meetingType,
			subject: body.subject,
			body_html: body.bodyHtml,
			archived_at: null,
		};
		audit(cmd, fact(cmd, "message_template", "create", id, null, "1", "communication.templates.create", null, created));
		return asTemplate(created);
	});
}
async function forkTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.forkTemplateRequest, raw);
	const source = systemTemplate(input.input.sourceKey);
	if (!source) deny("invalid_subject");
	return command(tx, context, "communication.templates.fork", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		await tx.execute(
			sql`SELECT pg_advisory_xact_lock(hashtext(${cmd.actor.plantId}), hashtext(${source.sourceKey})) WHERE ${writeBound(cmd.actor, context.session)}`,
		);
		const existing = templateRow.safeParse(
			one(
				await tx.execute(sql`SELECT id, revision::text AS revision, source_key, name, description, category, meeting_type, subject, body_html,
					to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS archived_at
					FROM message_template WHERE plant_id = ${cmd.actor.plantId}::uuid AND source_key = ${source.sourceKey} AND ${writeBound(cmd.actor, context.session)}`),
			),
		);
		if (existing.success) return asTemplate(existing.data);
		const id = forkId(cmd.actor.plantId, source.sourceKey);
		const bodyText = plainText(source.bodyHtml);
		cmd.writes
			.push(sql`INSERT INTO message_template (id, plant_id, source_key, name, description, category, meeting_type, subject, body_html, body_text)
			SELECT ${id}::uuid, ${cmd.actor.plantId}::uuid, ${source.sourceKey}, ${source.name}, ${source.description}, ${source.category}, ${source.meetingType},
				${source.subject}, ${source.bodyHtml}, ${bodyText}
			WHERE ${writeBound(cmd.actor, context.session)}
			ON CONFLICT (id) DO NOTHING`);
		const created = {
			id,
			revision: "1",
			source_key: source.sourceKey,
			name: source.name,
			description: source.description,
			category: source.category,
			meeting_type: source.meetingType,
			subject: source.subject,
			body_html: source.bodyHtml,
			archived_at: null,
		};
		audit(cmd, fact(cmd, "message_template", "create", id, null, "1", "communication.templates.fork", null, created));
		return asTemplate(created);
	});
}
async function updateTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.updateTemplateRequest, raw);
	return command(tx, context, "communication.templates.update", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const current = await lockTemplate(tx, cmd.actor, context.session, input.input.templateId, input.expectedRevision);
		const body = templateBody(input.input.patch);
		const revision = bump(current.revision);
		cmd.writes
			.push(sql`UPDATE message_template SET name = ${body.name}, description = ${body.description}, category = ${body.category},
			meeting_type = ${body.meetingType}, subject = ${body.subject}, body_html = ${body.bodyHtml}, body_text = ${body.bodyText}, revision = ${revision}::bigint
			WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND revision = ${current.revision}::bigint AND ${writeBound(cmd.actor, context.session)}`);
		const next = {
			...current,
			revision,
			name: body.name,
			description: body.description,
			category: body.category,
			meeting_type: body.meetingType,
			subject: body.subject,
			body_html: body.bodyHtml,
		};
		audit(
			cmd,
			fact(
				cmd,
				"message_template",
				"edit",
				current.id,
				current.revision,
				revision,
				"communication.templates.update",
				current,
				next,
			),
		);
		return asTemplate(next);
	});
}
async function archiveTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.templateIdRequest, raw);
	return command(tx, context, "communication.templates.archive", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const current = await lockTemplate(tx, cmd.actor, context.session, input.input.templateId, input.expectedRevision);
		const revision = bump(current.revision);
		cmd.writes
			.push(sql`UPDATE message_template SET archived_at = coalesce(archived_at, clock_timestamp()), revision = ${revision}::bigint
			WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND revision = ${current.revision}::bigint AND ${writeBound(cmd.actor, context.session)}`);
		const next = { ...current, revision, archived_at: current.archived_at ?? new Date().toISOString() };
		audit(
			cmd,
			fact(
				cmd,
				"message_template",
				"edit",
				current.id,
				current.revision,
				revision,
				"communication.templates.archive",
				current,
				next,
			),
		);
		return asTemplate(next);
	});
}
async function deleteTemplate(tx: Tx, context: CommunicationContext, raw: unknown) {
	const input = parse(c.templateIdRequest, raw);
	return command(tx, context, "communication.templates.delete", input, async (cmd) => {
		if (!administers(cmd.actor)) deny("access_denied");
		const current = await lockTemplate(tx, cmd.actor, context.session, input.input.templateId, input.expectedRevision);
		const used = one(
			await tx.execute(
				whenLive(
					writeBound(cmd.actor, context.session),
					sql`SELECT EXISTS (SELECT 1 FROM communication c WHERE c.template_id = ${current.id}::uuid AND c.plant_id = ${cmd.actor.plantId}::uuid) AS referenced`,
				),
			),
		) as { allowed: boolean; referenced: boolean | null };
		if (used.allowed !== true) deny("access_denied");
		if (used.referenced) deny("referenced");
		cmd.writes.push(
			sql`DELETE FROM message_template WHERE id = ${current.id}::uuid AND plant_id = ${cmd.actor.plantId}::uuid AND revision = ${current.revision}::bigint AND ${writeBound(cmd.actor, context.session)}`,
		);
		audit(
			cmd,
			fact(
				cmd,
				"message_template",
				"remove",
				current.id,
				current.revision,
				current.revision,
				"communication.templates.delete",
				current,
				null,
			),
		);
		return asTemplate(current);
	});
}

async function preview(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.previewRequest, request);
	const { reader, access } = accessOf(authority);
	const audience = input.audience ?? emptyAudience;
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, true),
				sql`SELECT
					(${input.meetingId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM meeting m WHERE m.id = ${input.meetingId ?? null}::uuid AND m.plant_id = ${reader.plantId}::uuid)) AS meeting_ok,
					(${input.templateId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM message_template t WHERE t.id = ${input.templateId ?? null}::uuid AND t.plant_id = ${reader.plantId}::uuid)) AS template_ok,
					(${input.communicationId ?? null}::uuid IS NULL OR EXISTS (SELECT 1 FROM communication c WHERE c.id = ${input.communicationId ?? null}::uuid AND c.plant_id = ${reader.plantId}::uuid)) AS known,
					(SELECT c.subject FROM communication c WHERE c.id = ${input.communicationId ?? null}::uuid AND c.plant_id = ${reader.plantId}::uuid) AS subject,
					(SELECT c.review_digest FROM communication c WHERE c.id = ${input.communicationId ?? null}::uuid AND c.plant_id = ${reader.plantId}::uuid) AS review_digest,
					${audiencePeople(reader.plantId, audience)} AS people`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z
		.object({
			meeting_ok: z.boolean(),
			template_ok: z.boolean(),
			known: z.boolean(),
			subject: z.string().nullable(),
			review_digest: z.string().nullable(),
			people: z.unknown(),
		})
		.parse(raw);
	if (!found.meeting_ok || !found.template_ok || !found.known) deny("invalid_subject");
	const summary = summarizeAudience(found.people);
	const previewBody = renderBody(input.bodyHtml, input.merge);
	const sourceBody = sanitizeHtml(input.bodyHtml);
	const digest = reviewedDigest(found.subject, sourceBody ? sourceBody : null, eligibleIds(found.people));
	if (input.audienceChangedAfterReview || (found.review_digest !== null && found.review_digest !== digest))
		deny("stale_review", { previewBody, scriptExecution: false, providerCalls: 0 });
	return c.previewResult.parse({
		previewBody,
		scriptExecution: false,
		providerCalls: 0,
		eligibleEmails: summary.eligibleEmails,
		excludedMissingEmail: summary.missingEmailExclusions,
		duplicateAddressesRemoved: summary.duplicateAddressesRemoved,
	});
}
async function audience(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.resolveAudienceRequest, request);
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(allowed(access, reader, true), sql`SELECT ${audiencePeople(reader.plantId, input)} AS people`),
		),
	) as { allowed: boolean; people: unknown };
	requireAllowed(raw.allowed);
	return summarizeAudience(raw.people);
}
async function recipients(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.searchRecipientsRequest, request);
	const { reader, access } = accessOf(authority);
	const like = `%${input.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, true),
				sql`SELECT coalesce((
					SELECT jsonb_agg(jsonb_build_object('id', id, 'displayName', display_name, 'email', email))
					FROM (
						SELECT id, display_name, email FROM person
						WHERE plant_id = ${reader.plantId}::uuid AND tenant_id = ${reader.plantId}::uuid AND state = 'live'
						AND email IS NOT NULL AND btrim(email) <> ''
						AND (display_name ILIKE ${like} ESCAPE '\\' OR email ILIKE ${like} ESCAPE '\\')
						ORDER BY display_name, id LIMIT 20
					) found
				), '[]'::jsonb) AS people`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z
		.object({ people: z.array(z.object({ id: z.uuid(), displayName: z.string(), email: z.string() })) })
		.parse(raw);
	return c.recipientResult.parse({ people: found.people, limit: 20 });
}
async function merge(tx: Tx, authority: RequestActor, raw: unknown) {
	const input = parse(c.resolveMergeRequest, raw);
	const { reader, access } = accessOf(authority);
	const found = z
		.object({ allowed: z.boolean() })
		.parse(one(await tx.execute(sql`SELECT ${allowed(access, reader, true)} AS allowed`)));
	requireAllowed(found.allowed);
	const bodyHtml = renderBody(input.bodyHtml, input.merge);
	return c.mergeResult.parse({ bodyHtml, bodyText: plainText(bodyHtml) });
}
async function templates(tx: Tx, authority: RequestActor) {
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT coalesce((
					SELECT jsonb_agg(jsonb_build_object(
						'id', id, 'revision', revision::text, 'source_key', source_key, 'name', name, 'description', description,
						'category', category, 'meeting_type', meeting_type, 'subject', subject, 'body_html', body_html,
						'archived_at', to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
					))
					FROM message_template WHERE plant_id = ${reader.plantId}::uuid
				), '[]'::jsonb) AS rows`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z.object({ rows: z.array(templateRow) }).parse(raw);
	const forks = new Map(
		found.rows.filter((row) => row.source_key && !row.archived_at).map((row) => [row.source_key, row]),
	);
	const listed = [
		...systemTemplates.map((template) => {
			const fork = forks.get(template.sourceKey);
			return fork ? asTemplate(fork) : asSystem(template);
		}),
		...found.rows.filter((row) => !row.source_key && !row.archived_at).map(asTemplate),
	];
	return c.templateListResult.parse({ templates: listed });
}
async function template(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.recordRequest, request);
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT (
					SELECT jsonb_build_object(
						'id', id, 'revision', revision::text, 'source_key', source_key, 'name', name, 'description', description,
						'category', category, 'meeting_type', meeting_type, 'subject', subject, 'body_html', body_html,
						'archived_at', to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
					)
					FROM message_template WHERE id = ${input.id}::uuid AND plant_id = ${reader.plantId}::uuid
				) AS row`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z.object({ row: templateRow.nullable() }).parse(raw);
	if (!found.row) deny("not_found");
	return asTemplate(found.row);
}
async function meetingTemplate(tx: Tx, authority: RequestActor, raw: unknown) {
	const input = parse(c.meetingTemplateRequest, raw);
	const listed = await templates(tx, authority);
	const fork = listed.templates.find(
		(template) =>
			template.origin === "plant" &&
			template.category === "meeting_invitation" &&
			template.meetingType === input.meetingType &&
			!template.archived,
	);
	return fork ?? asSystem(systemInvitation(input.meetingType)!);
}
async function getDraft(tx: Tx, authority: RequestActor, request: unknown) {
	const input = parse(c.recordRequest, request);
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT (
					SELECT jsonb_build_object(
						'id', id, 'revision', revision::text, 'state', state, 'subject', subject, 'body_html', body_html, 'body_text', body_text,
						'template_id', template_id, 'template_source', template_source, 'meeting_id', meeting_id, 'audience', audience,
						'scheduled_at', to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'review_digest', review_digest
					)
					FROM communication WHERE id = ${input.id}::uuid AND plant_id = ${reader.plantId}::uuid
				) AS row`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z.object({ row: draftRow.nullable() }).parse(raw);
	if (!found.row) deny("not_found");
	return asDraft(found.row);
}
async function listDrafts(tx: Tx, authority: RequestActor, state: "draft" | null) {
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, false),
				sql`SELECT coalesce((
					SELECT jsonb_agg(jsonb_build_object(
						'id', id, 'revision', revision::text, 'state', state, 'subject', subject, 'body_html', body_html, 'body_text', body_text,
						'template_id', template_id, 'template_source', template_source, 'meeting_id', meeting_id, 'audience', audience,
						'scheduled_at', to_char(scheduled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'review_digest', review_digest
					) ORDER BY created_at, id)
					FROM communication WHERE plant_id = ${reader.plantId}::uuid AND (${state}::text IS NULL OR state = ${state})
				), '[]'::jsonb) AS rows`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z.object({ rows: z.array(draftRow) }).parse(raw);
	return c.draftListResult.parse({ drafts: found.rows.map(asDraft) });
}
async function teams(tx: Tx, authority: RequestActor) {
	const { reader, access } = accessOf(authority);
	const raw = one(
		await tx.execute(
			whenLive(
				allowed(access, reader, true),
				sql`SELECT coalesce((
					SELECT jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY sort_order, name)
					FROM team WHERE plant_id = ${reader.plantId}::uuid AND state IN ('active', 'forming') AND archived_at IS NULL
				), '[]'::jsonb) AS teams`,
			),
		),
	) as { allowed: boolean };
	requireAllowed(raw.allowed);
	const found = z.object({ teams: z.array(z.object({ id: z.uuid(), name: z.string() })) }).parse(raw);
	return c.teamListResult.parse({ teams: found.teams });
}
