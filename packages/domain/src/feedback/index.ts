import * as c from "@everyfield/contracts/feedback";
import type { Database } from "@everyfield/db/client";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { queueJobsFor } from "../jobs/queue.ts";

export { authorizeOperatorMail } from "./operator-mail.ts";

type Code = z.infer<typeof c.feedbackErrorCode>;
class Refusal extends Error {
	readonly code: Code;
	constructor(code: Code) {
		super(code);
		this.code = code;
	}
}
function deny(code: Code): never {
	throw new Refusal(code);
}
async function settle<T>(body: () => Promise<T>): Promise<c.FeedbackReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (error instanceof Refusal) return { status: "refused", error: { code: error.code } };
		throw error;
	}
}
function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	return found.success ? found.data : deny("invalid_input");
}
async function rows(db: Pick<Database, "execute">, query: SQL) {
	return (await db.execute(query)).rows as Record<string, unknown>[];
}

const ownAccount = (authority: RequestActor) =>
	liveRead({ session: authority.session, owner: { kind: "account", id: authority.actor.accountId } });

function seatLabels(authority: RequestActor): SQL {
	const context = authority.actor.context;
	return context.kind === "seat"
		? sql`SELECT coalesce(p.name, o.name) AS church, initcap(s.role) AS role FROM seat s
 LEFT JOIN plant p ON p.id=s.plant_id LEFT JOIN organization o ON o.id=s.organization_id
 WHERE s.id=${context.seatId}::uuid AND s.account_id=${authority.actor.accountId}::uuid AND s.ended_at IS NULL`
		: sql`SELECT NULL::text AS church, NULL::text AS role WHERE false`;
}

const triageAuthority = (authority: RequestActor): SQL =>
	sql`(${ownAccount(authority)} AND EXISTS(SELECT FROM platform_grant g WHERE g.account_id=${authority.actor.accountId}::uuid
 AND g.capability='feedback_triage' AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>clock_timestamp())))`;

export async function authorizeTriage(db: Pick<Database, "execute">, authority: RequestActor): Promise<boolean> {
	const [row] = await rows(db, sql`SELECT ${triageAuthority(authority)} AS ok`);
	return row?.ok === true;
}

const cursorOf = (at: string, id: string) => Buffer.from(`${at}|${id}`).toString("base64url");
const after = z
	.string()
	.transform((v) => Buffer.from(v, "base64url").toString().split("|"))
	.pipe(z.tuple([z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/), z.uuid()]));
function keyset(cursor: string | null): SQL {
	if (!cursor) return sql`true`;
	const found = after.safeParse(cursor);
	if (!found.success) deny("invalid_input");
	const [at, id] = found.data;
	return sql`(f.submitted_at, f.id) < (${at}::timestamptz, ${id}::uuid)`;
}
function page<T>(found: Record<string, unknown>[], item: (row: Record<string, unknown>) => T) {
	const sorted = found.sort((a, b) =>
		a.at === b.at ? String(b.id).localeCompare(String(a.id)) : String(b.at).localeCompare(String(a.at)),
	);
	const shown = sorted.slice(0, c.PAGE_SIZE);
	const last = shown.at(-1);
	return {
		items: shown.map(item),
		next: sorted.length > c.PAGE_SIZE && last ? cursorOf(String(last.at), String(last.id)) : null,
	};
}
const AT = sql`to_char(f.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const ownItem = (row: Record<string, unknown>) =>
	c.ownFeedback.parse({
		id: row.id,
		category: row.category,
		submittedAt: row.at,
		status: row.status,
		publicUrl: row.issue_url ?? null,
	});

const MAIL_STATE: Record<string, c.OperatorMailState> = {
	pending: "sending",
	scheduled: "sending",
	dispatched: "sending",
	accepted: "sent",
	sent: "sent",
	refused: "failed",
	failed: "failed",
	cancelled: "failed",
	unknown: "unknown",
};

function triageItem(row: Record<string, unknown>) {
	return c.triageFeedback.parse({
		id: row.id,
		category: row.category,
		description: row.description,
		status: row.status,
		revision: row.revision,
		submittedAt: row.at,
		author: { name: row.author_name ?? "Removed account", email: row.author_email ?? "" },
		details: {
			page: row.page_label,
			address: row.page_address,
			church: row.church_label,
			role: row.role_label,
			browser: row.browser,
			screenWidth: row.screen_width,
			screenHeight: row.screen_height,
			theme: row.theme,
			appVersion: row.app_version,
		},
		reference: row.reference,
		publication: { state: row.publication_state, heldReason: row.held_reason ?? null, url: row.issue_url ?? null },
		operatorMail: typeof row.mail_state === "string" ? (MAIL_STATE[row.mail_state] ?? null) : null,
	});
}
const TRIAGE_COLUMNS = sql`f.id, f.category, f.description, f.status, f.revision::text AS revision, ${AT} AS at,
 f.page_label, f.page_address, f.church_label, f.role_label, f.browser, f.screen_width, f.screen_height, f.theme,
 f.app_version, (SELECT display_name FROM seat_identity(f.account_id)) AS author_name,
 (SELECT email FROM access_account_contact(f.account_id)) AS author_email, f.reference, f.publication_state,
 f.held_reason, f.issue_url, (SELECT m.state FROM mail m WHERE m.tenant_id=f.account_id
  AND m.logical_key='feedback/'||f.id::text) AS mail_state`;

async function replay(db: Pick<Database, "execute">, authority: RequestActor, requestKey: string) {
	const [row] = await rows(
		db,
		sql`SELECT f.id, f.category, f.page_label, ${AT} AS at,
 (SELECT email FROM access_account_contact(f.account_id)) AS email FROM feedback f
 WHERE ${ownAccount(authority)} AND f.account_id=${authority.actor.accountId}::uuid AND f.request_key=${requestKey}::uuid`,
	);
	if (!row) deny("unavailable");
	return submitted(row);
}
const submitted = (row: Record<string, unknown>) =>
	c.submittedFeedback.parse({
		id: row.id,
		category: row.category,
		page: row.page_label,
		replyTo: row.email,
		submittedAt: row.at,
	});

export const feedbackWriter = {
	async submit(
		db: Pick<Database, "execute">,
		authority: RequestActor,
		raw: unknown,
		server: { appVersion: string | null },
	) {
		return settle(async () => {
			const input = parse(c.submitFeedbackRequest, raw);
			const account = authority.actor.accountId;
			const [row] = await rows(
				db,
				sql`WITH gate AS (SELECT ${ownAccount(authority)} AS ok), seat AS (${seatLabels(authority)}),
ins AS (
 INSERT INTO feedback (account_id, request_key, category, description, page_label, page_address, church_label, role_label,
  browser, screen_width, screen_height, theme, app_version)
 SELECT ${account}::uuid, ${input.requestKey}::uuid, ${input.category}, ${input.description.trim()}, ${input.page},
  ${input.address}, (SELECT church FROM seat), (SELECT role FROM seat), ${input.browser}, ${input.screenWidth}::int,
  ${input.screenHeight}::int, ${input.theme}, ${server.appVersion}
 FROM gate WHERE gate.ok
 ON CONFLICT (account_id, request_key) DO NOTHING
 RETURNING id, category, page_label, submitted_at
), job AS (${queueJobsFor(sql`ins`, { tenant: account, kind: "feedback_publication", keyPrefix: "feedback/" })}
), aud AS (
 INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_id)
 SELECT ${account}::uuid, ${account}::uuid, 'feedback.received', 'create', id FROM ins RETURNING 1
), saved AS (
 SELECT id, category, page_label, submitted_at FROM ins
 UNION ALL
 SELECT f.id, f.category, f.page_label, f.submitted_at FROM feedback f JOIN gate ON gate.ok
 WHERE f.account_id=${account}::uuid AND f.request_key=${input.requestKey}::uuid
)
SELECT (SELECT ok FROM gate) AS ok, f.id, f.category, f.page_label, ${AT} AS at,
 (SELECT email FROM access_account_contact(${account}::uuid)) AS email
FROM (SELECT 1) one LEFT JOIN LATERAL (SELECT * FROM saved LIMIT 1) f ON true`,
			);
			if (row?.ok !== true) deny("access_denied");
			if (!row.id) return replay(db, authority, input.requestKey);
			return submitted(row);
		});
	},

	async getSendContext(db: Database, authority: RequestActor) {
		return settle(async () => {
			const [row] = await rows(
				db,
				sql`SELECT (SELECT email FROM access_account_contact(${authority.actor.accountId}::uuid)) AS email, s.church, s.role
 FROM (SELECT 1) one LEFT JOIN LATERAL (${seatLabels(authority)}) s ON true WHERE ${ownAccount(authority)}`,
			);
			if (!row) deny("access_denied");
			return c.sendContext.parse({ church: row.church ?? null, role: row.role ?? null, replyTo: row.email });
		});
	},

	async listOwn(db: Database, authority: RequestActor, raw: unknown = {}) {
		return settle(async () => {
			const input = parse(c.listOwnRequest, raw);
			const found = await rows(
				db,
				sql`SELECT g.ok, f.* FROM (SELECT ${ownAccount(authority)} AS ok) g LEFT JOIN LATERAL (
 SELECT f.id, f.category, f.status, f.issue_url, ${AT} AS at FROM feedback f
 WHERE g.ok AND f.account_id=${authority.actor.accountId}::uuid AND ${keyset(input.cursor)}
 ORDER BY f.submitted_at DESC, f.id DESC LIMIT ${c.PAGE_SIZE + 1}) f ON true`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			return c.ownFeedbackPage.parse(
				page(
					found.filter((r) => r.id),
					ownItem,
				),
			);
		});
	},

	async getOwnStatus(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.getOwnStatusRequest, raw);
			const [row] = await rows(
				db,
				sql`SELECT f.id, f.category, f.status, f.issue_url, ${AT} AS at FROM feedback f
 WHERE ${ownAccount(authority)} AND f.id=${input.feedbackId}::uuid AND f.account_id=${authority.actor.accountId}::uuid`,
			);
			return row ? ownItem(row) : deny("unavailable");
		});
	},

	async "admin.list"(db: Database, authority: RequestActor, raw: unknown = {}) {
		return settle(async () => {
			const input = parse(c.triageListRequest, raw);
			const found = await rows(
				db,
				sql`SELECT g.ok, f.* FROM (SELECT ${triageAuthority(authority)} AS ok) g LEFT JOIN LATERAL (
 SELECT ${TRIAGE_COLUMNS} FROM feedback f
 WHERE g.ok AND ${keyset(input.cursor)}
  ${input.status ? sql`AND f.status=${input.status}` : sql``} ${input.category ? sql`AND f.category=${input.category}` : sql``}
 ORDER BY f.submitted_at DESC, f.id DESC LIMIT ${c.PAGE_SIZE + 1}) f ON true`,
			);
			if (found[0]?.ok !== true) deny("access_denied");
			return c.triagePage.parse(
				page(
					found.filter((r) => r.id),
					triageItem,
				),
			);
		});
	},

	async "admin.get"(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.triageGetRequest, raw);
			const [row] = await rows(
				db,
				sql`SELECT g.ok, f.*, (SELECT coalesce(jsonb_agg(jsonb_build_object('from', e.before_value->>'status',
  'to', e.after_value->>'status', 'by', coalesce((SELECT display_name FROM seat_identity(e.actor_id)), 'Removed account'),
  'at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) ORDER BY e.occurred_at, e.id), '[]'::jsonb)
  FROM audit_event e
  WHERE f.id IS NOT NULL AND e.subject_id=f.id AND e.tenant_id=f.account_id AND e.action='feedback.status_changed') AS history
 FROM (SELECT ${triageAuthority(authority)} AS ok) g LEFT JOIN LATERAL (
 SELECT ${TRIAGE_COLUMNS}, f.account_id FROM feedback f WHERE g.ok AND f.id=${input.feedbackId}::uuid) f ON true`,
			);
			if (row?.ok !== true) deny("access_denied");
			if (!row.id) deny("unavailable");
			return c.triageDetail.parse({ ...triageItem(row), history: row.history });
		});
	},

	async "admin.changeStatus"(db: Database, authority: RequestActor, raw: unknown) {
		return settle(async () => {
			const input = parse(c.changeStatusRequest, raw);
			const [row] = await rows(
				db,
				sql`WITH gate AS (SELECT ${triageAuthority(authority)} AS ok),
cur AS (
 SELECT f.id, f.account_id, f.status, f.revision FROM feedback f WHERE (SELECT ok FROM gate) AND f.id=${input.feedbackId}::uuid
 FOR UPDATE OF f
), upd AS (
 UPDATE feedback f SET status=${input.status}, revision=cur.revision+1 FROM cur
 WHERE f.id=cur.id AND cur.revision=${input.expectedRevision}::bigint AND cur.status<>${input.status}
 RETURNING f.id, f.account_id, f.revision, cur.status AS before, cur.revision AS before_revision
), aud AS (
 INSERT INTO audit_event (tenant_id, actor_id, action, kind, subject_id, before_value, after_value, before_revision,
  after_revision)
 SELECT account_id, ${authority.actor.accountId}::uuid, 'feedback.status_changed', 'triage', id,
  jsonb_build_object('status', before), jsonb_build_object('status', ${input.status}::text), before_revision, revision
 FROM upd RETURNING 1
)
SELECT (SELECT ok FROM gate) AS ok, cur.status, cur.revision::text AS revision, upd.revision::text AS changed
FROM (SELECT 1) one LEFT JOIN cur ON true LEFT JOIN upd ON true`,
			);
			if (row?.ok !== true) deny("access_denied");
			if (!row.status) deny("unavailable");
			if (row.changed) return c.statusChange.parse({ outcome: "changed", status: input.status, revision: row.changed });
			return c.statusChange.parse({
				outcome: row.status === input.status ? "unchanged" : "stale",
				status: row.status,
				revision: row.revision,
			});
		});
	},
};
