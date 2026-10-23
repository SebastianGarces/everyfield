import type { Owner } from "@everyfield/contracts/common";
import {
	notificationCategory,
	preferenceResult,
	preferenceWriteResult,
	setDigestCadenceRequest,
	setOversightDigestCadenceRequest,
	setPreferenceRequest,
	setPreferencesRequest,
} from "@everyfield/contracts/notifications";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { RequestActor, accountOwner, audit, deny, jsonValue, readReply, runWrite, selfSql, type Tx } from "./core.ts";

const categories = notificationCategory.options;
const storedRow = z.object({
	category: notificationCategory,
	channel: z.enum(["email", "in_app"]),
	enabled: z.boolean(),
	cadence: z.enum(["daily", "weekly"]).nullable(),
});
const readRow = z.object({
	account_id: z.uuid().nullable(),
	revision: z.string().nullable(),
	rows: z.array(storedRow),
});
const writeRow = z.object({
	me: z.uuid().nullable(),
	seat_ok: z.boolean(),
	locked: z.uuid().nullable(),
	revision: z.string().nullable(),
	changed: z.boolean(),
});

function channels(category: (typeof categories)[number]) {
	return category === "wiki_upstream_review" ? (["in_app"] as const) : (["email", "in_app"] as const);
}
function defaultEnabled(category: string, channel: string) {
	return !(category === "planter_digest" && channel === "in_app");
}

export async function getPreferences(db: Database, authority: RequestActor) {
	return readReply(async () => {
		const result = await db.execute(sql`WITH ${selfSql(authority.session, authority.actor.accountId)}
			SELECT (SELECT account_id FROM me) AS account_id,
				(SELECT revision::text FROM account WHERE id = (SELECT account_id FROM me)) AS revision,
				COALESCE((SELECT json_agg(json_build_object(
					'category', category, 'channel', channel, 'enabled', enabled, 'cadence', cadence
				)) FROM notification_preference WHERE account_id = (SELECT account_id FROM me)), '[]'::json) AS rows`);
		const row = readRow.parse({ ...result.rows[0], rows: jsonValue(result.rows[0]?.rows) });
		if (!row.account_id || !row.revision) deny();
		const stored = new Map(row.rows.map((item) => [`${item.category}:${item.channel}`, item]));
		const choices = categories.flatMap((category) =>
			channels(category).map((channel) => ({
				category,
				channel,
				enabled: stored.get(`${category}:${channel}`)?.enabled ?? defaultEnabled(category, channel),
			})),
		);
		const cadence = (category: string) =>
			row.rows.find((item) => item.category === category && item.cadence)?.cadence ?? null;
		return preferenceResult.parse({
			choices,
			planterCadence: cadence("planter_digest"),
			oversightCadence: cadence("oversight_digest"),
			suppression: "unavailable",
			revision: row.revision,
			explicitEmail: categories.filter((category) => stored.has(`${category}:email`)),
		});
	});
}

async function save(
	tx: Tx,
	session: string,
	accountId: string,
	expected: string,
	seat: ReturnType<typeof sql>,
	rows: readonly { category: string; channel: string; enabled: boolean; cadence: string | null }[],
	cadenceWrite: boolean,
) {
	const result = await tx.execute(sql`WITH ${selfSql(session, accountId)},
		seat_ok AS (${seat}),
		locked AS (
			SELECT a.id, a.revision::text AS revision FROM account a
			WHERE a.id = (SELECT account_id FROM me) AND a.revision = ${expected}::bigint
				AND EXISTS (SELECT FROM seat_ok)
			FOR UPDATE
		),
		input AS (
			SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
				AS i(category text, channel text, enabled boolean, cadence text)
		),
		upserted AS (
			INSERT INTO notification_preference
				(account_id, category, channel, enabled, cadence, weekday, hour, unsubscribe_revision)
			SELECT locked.id, i.category, i.channel,
				CASE WHEN ${cadenceWrite} THEN COALESCE(p.enabled, i.enabled) ELSE i.enabled END,
				CASE WHEN ${cadenceWrite} THEN i.cadence ELSE p.cadence END,
				CASE WHEN ${cadenceWrite} THEN 0 ELSE p.weekday END,
				CASE WHEN ${cadenceWrite} THEN 16 ELSE p.hour END,
				COALESCE(p.unsubscribe_revision, 1)
			FROM locked
			JOIN input i ON true
			LEFT JOIN notification_preference p
				ON p.account_id = locked.id AND p.category = i.category AND p.channel = i.channel
			ON CONFLICT (account_id, category, channel) DO UPDATE SET
				enabled = CASE WHEN ${cadenceWrite} THEN notification_preference.enabled ELSE EXCLUDED.enabled END,
				cadence = CASE WHEN ${cadenceWrite} THEN EXCLUDED.cadence ELSE notification_preference.cadence END,
				weekday = CASE WHEN ${cadenceWrite} THEN EXCLUDED.weekday ELSE notification_preference.weekday END,
				hour = CASE WHEN ${cadenceWrite} THEN EXCLUDED.hour ELSE notification_preference.hour END,
				revision = notification_preference.revision + 1
			WHERE (${cadenceWrite} AND (notification_preference.cadence IS DISTINCT FROM EXCLUDED.cadence
					OR notification_preference.weekday IS DISTINCT FROM EXCLUDED.weekday
					OR notification_preference.hour IS DISTINCT FROM EXCLUDED.hour))
				OR (NOT ${cadenceWrite} AND notification_preference.enabled IS DISTINCT FROM EXCLUDED.enabled)
			RETURNING account_id
		),
		bumped AS (
			UPDATE account SET revision = revision + 1
			WHERE id IN (SELECT account_id FROM upserted)
			RETURNING revision::text AS revision
		)
		SELECT (SELECT account_id FROM me) AS me, EXISTS(SELECT FROM seat_ok) AS seat_ok,
			(SELECT id FROM locked) AS locked,
			COALESCE((SELECT revision FROM bumped), (SELECT revision FROM locked)) AS revision,
			EXISTS(SELECT FROM upserted) AS changed`);
	const row = writeRow.parse(result.rows[0]);
	if (!row.me) deny();
	if (!row.seat_ok) deny("access_denied");
	if (!row.locked || !row.revision) deny("conflict");
	return { revision: row.revision, changed: row.changed };
}

const selfSeat = sql`SELECT 1`;

function choiceRows(choices: readonly { category: string; channel: string; enabled: boolean }[]) {
	return choices.map((choice) => ({ ...choice, cadence: null }));
}

export function setPreference(db: Database, authority: RequestActor, raw: unknown) {
	const selected = accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		setPreferenceRequest,
		"notifications.setPreference",
		preferenceWriteResult,
		async (tx, cmd, input) => {
			const choice = input.input.choice;
			const row = await save(
				tx,
				authority.session,
				authority.actor.accountId,
				input.expectedRevision,
				selfSeat,
				choiceRows([choice]),
				false,
			);
			const field = `${choice.category}.${choice.channel}`;
			audit(cmd, {
				subjectId: authority.actor.accountId,
				kind: row.changed ? "preference" : "noop",
				fields: row.changed ? [field] : [],
			});
			return { revision: row.revision, changed: row.changed, cadence: null };
		},
	);
}

export function setPreferences(db: Database, authority: RequestActor, raw: unknown) {
	const selected = accountOwner(authority.actor.accountId);
	return runWrite(
		db,
		authority,
		selected,
		raw,
		setPreferencesRequest,
		"notifications.setPreferences",
		preferenceWriteResult,
		async (tx, cmd, input) => {
			const row = await save(
				tx,
				authority.session,
				authority.actor.accountId,
				input.expectedRevision,
				selfSeat,
				choiceRows(input.input.choices),
				false,
			);
			audit(cmd, {
				subjectId: authority.actor.accountId,
				kind: row.changed ? "preference" : "noop",
				fields: row.changed ? input.input.choices.map((choice) => `${choice.category}.${choice.channel}`) : [],
			});
			return { revision: row.revision, changed: row.changed, cadence: null };
		},
	);
}

async function saveCadence(
	db: Database,
	authority: RequestActor,
	selected: Owner,
	raw: unknown,
	schema: typeof setDigestCadenceRequest | typeof setOversightDigestCadenceRequest,
	operation: string,
	category: "planter_digest" | "oversight_digest",
	seat: ReturnType<typeof sql>,
) {
	return runWrite(db, authority, selected, raw, schema, operation, preferenceWriteResult, async (tx, cmd, input) => {
		const cadence = input.input.cadence;
		const row = await save(
			tx,
			authority.session,
			authority.actor.accountId,
			input.expectedRevision,
			seat,
			(["email", "in_app"] as const).map((channel) => ({
				category,
				channel,
				enabled: defaultEnabled(category, channel),
				cadence,
			})),
			true,
		);
		audit(cmd, {
			subjectId: authority.actor.accountId,
			kind: row.changed ? "preference" : "noop",
			fields: row.changed ? [`${category}.cadence`] : [],
		});
		return { revision: row.revision, changed: row.changed, cadence };
	});
}

export function setDigestCadence(db: Database, authority: RequestActor, raw: unknown) {
	const parsed = setDigestCadenceRequest.safeParse(raw);
	const plantId = parsed.success ? parsed.data.input.plantId : null;
	return saveCadence(
		db,
		authority,
		accountOwner(authority.actor.accountId),
		raw,
		setDigestCadenceRequest,
		"notifications.digestCadence.set",
		"planter_digest",
		sql`SELECT 1 FROM seat s WHERE s.account_id = (SELECT account_id FROM me) AND s.plant_id = ${plantId}::uuid
			AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()`,
	);
}

export function setOversightDigestCadence(db: Database, authority: RequestActor, raw: unknown) {
	const parsed = setOversightDigestCadenceRequest.safeParse(raw);
	const org = parsed.success ? parsed.data.input.organizationId : null;
	const kind = parsed.success ? parsed.data.input.organizationKind : null;
	return saveCadence(
		db,
		authority,
		accountOwner(authority.actor.accountId),
		raw,
		setOversightDigestCadenceRequest,
		"notifications.oversightDigestCadence.set",
		"oversight_digest",
		sql`SELECT 1 FROM seat s JOIN organization o ON o.id = s.organization_id
			WHERE s.account_id = (SELECT account_id FROM me) AND s.organization_id = ${org}::uuid AND o.kind = ${kind}
			AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()`,
	);
}
