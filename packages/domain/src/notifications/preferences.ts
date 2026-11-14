import {
	notificationCategory,
	preferenceResult,
	preferenceWriteResult,
	setDigestCadenceRequest,
	setOversightDigestCadenceRequest,
	setPreferenceRequest,
	setPreferencesRequest,
} from "@everyfield/contracts/notifications";
import {
	defaultChannelEnabled as defaultEnabled,
	defaultDigestCadence,
	notificationChannels as channels,
} from "@everyfield/contracts/settings";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { liveRead } from "../access/session.ts";
import {
	RequestActor,
	accountOwner,
	audit,
	deny,
	jsonValue,
	readReply,
	runWrite,
	selfSql,
	type NotificationCommand,
	type Tx,
} from "./core.ts";

const categories = notificationCategory.options;
const storedRow = z.object({
	category: notificationCategory,
	channel: z.enum(["email", "in_app"]),
	enabled: z.boolean(),
	cadence: z.enum(["daily", "weekly"]).nullable(),
});
const readRow = z.object({
	account_id: z.uuid(),
	revision: z.string(),
	rows: z.array(storedRow),
	organization: z.boolean(),
});
const writeRow = z.object({
	me: z.uuid().nullable(),
	seat_ok: z.boolean(),
	locked: z.uuid().nullable(),
	revision: z.string().nullable(),
	changed: z.boolean(),
});

/**
 * The account's notification choices, in one statement: its revision, its stored choices with the defaults filled in
 * (defaultChannelEnabled, defaultDigestCadence) and whether it has a current organization seat. The oversight digest
 * applies only with one. The notifications feed and bell, and the Settings Notifications section, all read this.
 * Null when the session is no longer live.
 */
export async function readPreferences(
	db: Pick<Database, "execute">,
	access: { session: string; actor: Pick<RequestActor["actor"], "accountId"> },
) {
	const accountId = access.actor.accountId;
	const result = await db.execute(sql`SELECT a.id AS account_id, a.revision::text AS revision,
			COALESCE((SELECT json_agg(json_build_object(
				'category', p.category, 'channel', p.channel, 'enabled', p.enabled, 'cadence', p.cadence
			)) FROM notification_preference p WHERE p.account_id = a.id), '[]'::json) AS rows,
			EXISTS(SELECT FROM seat s WHERE s.account_id = a.id AND s.ended_at IS NULL AND s.organization_id IS NOT NULL) AS organization
		FROM account a
		WHERE a.id = ${accountId}::uuid AND ${liveRead({ session: access.session, owner: { kind: "account", id: accountId } })}`);
	if (!result.rows[0]) return null;
	const row = readRow.parse({ ...result.rows[0], rows: jsonValue(result.rows[0].rows) });
	const stored = (category: string, channel?: string) =>
		row.rows.find((r) => r.category === category && (channel ? r.channel === channel : r.cadence));
	const choices = categories
		.filter((category) => category !== "oversight_digest" || row.organization)
		.flatMap((category) =>
			channels(category).map((channel) => ({
				category,
				channel,
				enabled: stored(category, channel)?.enabled ?? defaultEnabled(category, channel),
			})),
		);
	return {
		accountId: row.account_id,
		revision: row.revision,
		stored: row.rows,
		values: {
			choices,
			planterCadence: stored("planter_digest")?.cadence ?? defaultDigestCadence.planter_digest,
			oversightCadence: row.organization
				? (stored("oversight_digest")?.cadence ?? defaultDigestCadence.oversight_digest)
				: null,
		},
	};
}

export async function getPreferences(db: Pick<Database, "execute">, authority: RequestActor) {
	return readReply(async () => {
		const read = await readPreferences(db, authority);
		if (!read) deny();
		return preferenceResult.parse({
			...read.values,
			suppression: "unavailable",
			revision: read.revision,
			explicitEmail: categories.filter((category) =>
				read.stored.some((r) => r.category === category && r.channel === "email"),
			),
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
		upserted AS (
			${preferenceUpsert(accountId, rows, cadenceWrite, sql`EXISTS (SELECT FROM locked)`)}
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

type PreferenceRow = { category: string; channel: string; enabled: boolean; cadence: string | null };

/** The only channel and cadence write for notification_preference. Settings and this producer both call it. */
export function preferenceUpsert(
	accountId: string,
	rows: readonly PreferenceRow[],
	cadenceWrite: boolean,
	gate: ReturnType<typeof sql>,
) {
	return sql`INSERT INTO notification_preference
			(account_id, category, channel, enabled, cadence, weekday, hour, unsubscribe_revision)
		SELECT ${accountId}::uuid, i.category, i.channel,
			CASE WHEN ${cadenceWrite} THEN COALESCE(p.enabled, i.enabled) ELSE i.enabled END,
			CASE WHEN ${cadenceWrite} THEN i.cadence ELSE p.cadence END,
			CASE WHEN ${cadenceWrite} THEN 0 ELSE p.weekday END,
			CASE WHEN ${cadenceWrite} THEN 16 ELSE p.hour END,
			COALESCE(p.unsubscribe_revision, 0)
		FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
			AS i(category text, channel text, enabled boolean, cadence text)
		LEFT JOIN notification_preference p
			ON p.account_id = ${accountId}::uuid AND p.category = i.category AND p.channel = i.channel
		WHERE ${gate}
		ON CONFLICT (account_id, category, channel) DO UPDATE SET
			enabled = CASE WHEN ${cadenceWrite} THEN notification_preference.enabled ELSE EXCLUDED.enabled END,
			cadence = CASE WHEN ${cadenceWrite} THEN EXCLUDED.cadence ELSE notification_preference.cadence END,
			weekday = CASE WHEN ${cadenceWrite} THEN EXCLUDED.weekday ELSE notification_preference.weekday END,
			hour = CASE WHEN ${cadenceWrite} THEN EXCLUDED.hour ELSE notification_preference.hour END,
			revision = notification_preference.revision + 1
		WHERE (${cadenceWrite} AND (notification_preference.cadence IS DISTINCT FROM EXCLUDED.cadence
				OR notification_preference.weekday IS DISTINCT FROM EXCLUDED.weekday
				OR notification_preference.hour IS DISTINCT FROM EXCLUDED.hour))
			OR (NOT ${cadenceWrite} AND notification_preference.enabled IS DISTINCT FROM EXCLUDED.enabled)`;
}

const selfSeat = sql`SELECT 1`;

function choiceRows(choices: readonly { category: string; channel: string; enabled: boolean }[]) {
	return choices.map((choice) => ({ ...choice, cadence: null }));
}

const preferenceCommand = <S extends typeof setPreferenceRequest | typeof setPreferencesRequest>(
	schema: S,
	operation: string,
	choices: (input: z.output<S>) => readonly { category: string; channel: string; enabled: boolean }[],
): NotificationCommand<S, z.output<typeof preferenceWriteResult>> => ({
	schema,
	operation,
	result: preferenceWriteResult,
	async body(tx, cmd, input, authority) {
		const chosen = choices(input);
		const row = await save(
			tx,
			authority.session,
			authority.actor.accountId,
			input.expectedRevision,
			selfSeat,
			choiceRows(chosen),
			false,
		);
		audit(cmd, {
			subjectId: authority.actor.accountId,
			kind: row.changed ? "preference" : "noop",
			fields: row.changed ? chosen.map((choice) => `${choice.category}.${choice.channel}`) : [],
		});
		return { revision: row.revision, changed: row.changed, cadence: null };
	},
});
const setPreferenceCommand = preferenceCommand(setPreferenceRequest, "notifications.setPreference", (input) => [
	input.input.choice,
]);
export const setPreferencesCommand = preferenceCommand(
	setPreferencesRequest,
	"notifications.setPreferences",
	(input) => input.input.choices,
);

const cadenceCommand = <S extends typeof setDigestCadenceRequest | typeof setOversightDigestCadenceRequest>(
	schema: S,
	operation: string,
	category: "planter_digest" | "oversight_digest",
	seat: (input: z.output<S>) => ReturnType<typeof sql>,
): NotificationCommand<S, z.output<typeof preferenceWriteResult>> => ({
	schema,
	operation,
	result: preferenceWriteResult,
	async body(tx, cmd, input, authority) {
		const cadence = input.input.cadence;
		const row = await save(
			tx,
			authority.session,
			authority.actor.accountId,
			input.expectedRevision,
			seat(input),
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
	},
});
export const setDigestCadenceCommand = cadenceCommand(
	setDigestCadenceRequest,
	"notifications.digestCadence.set",
	"planter_digest",
	(
		input,
	) => sql`SELECT 1 FROM seat s WHERE s.account_id = (SELECT account_id FROM me) AND s.plant_id = ${input.input.plantId}::uuid
		AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()`,
);
export const setOversightDigestCadenceCommand = cadenceCommand(
	setOversightDigestCadenceRequest,
	"notifications.oversightDigestCadence.set",
	"oversight_digest",
	(input) => sql`SELECT 1 FROM seat s JOIN organization o ON o.id = s.organization_id
		WHERE s.account_id = (SELECT account_id FROM me) AND s.organization_id = ${input.input.organizationId}::uuid
			AND o.kind = ${input.input.organizationKind}
			AND s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()`,
);

export const setPreference = (db: Database, authority: RequestActor, raw: unknown) =>
	runWrite(db, authority, accountOwner(authority.actor.accountId), raw, setPreferenceCommand);
export const setPreferences = (db: Database, authority: RequestActor, raw: unknown) =>
	runWrite(db, authority, accountOwner(authority.actor.accountId), raw, setPreferencesCommand);
export const setDigestCadence = (db: Database, authority: RequestActor, raw: unknown) =>
	runWrite(db, authority, accountOwner(authority.actor.accountId), raw, setDigestCadenceCommand);
export const setOversightDigestCadence = (db: Database, authority: RequestActor, raw: unknown) =>
	runWrite(db, authority, accountOwner(authority.actor.accountId), raw, setOversightDigestCadenceCommand);
