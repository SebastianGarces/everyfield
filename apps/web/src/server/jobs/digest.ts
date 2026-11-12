import { localDate, timeZone } from "@everyfield/contracts/common";
import { defaultChannelEnabled, defaultDigestCadence } from "@everyfield/contracts/settings";
import type { Database, Transaction } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import {
	compileOversightDigest,
	compilePlanterDigest,
	digestRecipientLive,
	renderOversightDigest,
	renderPlanterDigest,
} from "@everyfield/domain/notifications";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { mailEnv } from "../mail-env.ts";
import { transaction } from "../platform/database.ts";
import { owedPeriod } from "./calendar.ts";
import { mailUnsubscribe, type AuthorizeMail, type createMailService } from "./mail.ts";
import { claimDue, finishClaim, finishJob, lockClaim, type Claim } from "./queue.ts";
import { queuedMailService } from "./seated-notifications.ts";

// The church digest (NTF-007) and the oversight digest (NTF-008), delivered by the scheduled runner. Each minute the
// planner queues one `digest` job for every Owner or Admin whose period has ended; the worker then compiles that job's
// digest from current facts and writes its bell entry, its email intent and the coverage advance in one statement.
// The church schedule (Settings → Church) sets the church digest's weekday and hour; the oversight digest goes out at
// 07:00 in the organization's zone and covers completed days only (WP-030 decisions D-b, D-c).

const OVERSIGHT_SLOT = { weekday: 1, hour: 7 } as const;
/** Coverage starts and jobs queued by one planner statement, and digests one runner tick delivers. */
const PLAN_LIMIT = 500;
const DIGESTS_PER_RUN = 20;

/**
 * Queues the digests owed at `asOf`. One statement. A recipient seen for the first time starts their coverage at the
 * period that just ended, so the first digest is the next one and no backlog is sent. A recipient whose coverage is
 * behind gets one job for the latest period end: a run after missed slots queues one catch-up, not one per slot. The
 * job key holds the period end, so overlapping runs queue it once. The worker rechecks everything.
 */
export async function planDigests(db: Database, asOf: string): Promise<{ started: number; queued: number }> {
	const at = z.iso.datetime().parse(asOf);
	const pref = (category: string, fallback: string) =>
		sql`coalesce((SELECT n.cadence FROM notification_preference n WHERE n.account_id = s.account_id
			AND n.category = ${category} AND n.cadence IS NOT NULL LIMIT 1), ${fallback})`;
	const r = await db.execute(sql`WITH candidates AS (
			SELECT s.account_id AS recipient, p.id AS owner, 'planter' AS purpose, p.timezone AS zone,
				${pref("planter_digest", defaultDigestCadence.planter_digest)} AS cadence,
				p.digest_weekday AS weekday, p.digest_hour AS hour, 0 AS lag
			FROM plant p JOIN seat s ON s.plant_id = p.id
			WHERE p.digest_cadence <> 'off' AND s.role IN ('owner','admin') AND s.ended_at IS NULL
				AND s.accepted_at <= clock_timestamp()
			UNION ALL
			SELECT s.account_id, o.id, 'oversight', o.timezone,
				${pref("oversight_digest", defaultDigestCadence.oversight_digest)},
				${OVERSIGHT_SLOT.weekday}, ${OVERSIGHT_SLOT.hour}, 1
			FROM organization o JOIN seat s ON s.organization_id = o.id
			WHERE s.role IN ('owner','admin') AND s.ended_at IS NULL AND s.accepted_at <= clock_timestamp()
		), slots AS (
			SELECT c.*, w.wall::date - CASE WHEN w.wall::time >= make_time(c.hour, 0, 0) THEN 0 ELSE 1 END AS last_slot
			FROM candidates c JOIN account a ON a.id = c.recipient AND a.registration_state = 'active'
			CROSS JOIN LATERAL (SELECT ${at}::timestamptz AT TIME ZONE c.zone AS wall) w
		), due AS (
			SELECT s.*, g.id AS coverage, g.covered_through,
				(CASE WHEN s.cadence = 'weekly' THEN s.last_slot - ((extract(dow FROM s.last_slot)::int - s.weekday + 7) % 7)
					ELSE s.last_slot END) - s.lag AS period_end
			FROM slots s LEFT JOIN digest_coverage g ON g.tenant_id = s.owner AND g.recipient_id = s.recipient
				AND g.purpose = s.purpose
		), started AS (
			INSERT INTO digest_coverage(tenant_id, recipient_id, purpose, cadence, timezone, covered_through)
			SELECT owner, recipient, purpose, cadence, zone, period_end FROM due WHERE coverage IS NULL LIMIT ${PLAN_LIMIT}
			ON CONFLICT (tenant_id, recipient_id, purpose) DO NOTHING RETURNING id
		), queued AS (
			INSERT INTO job(tenant_id, kind, subject_record_id, producer_key, state, eligible_at, attempt_count, max_attempts, claim_generation)
			SELECT d.owner, 'digest', d.recipient, 'digest/' || d.purpose || '/' || d.owner || '/' || d.period_end, 'ready',
				clock_timestamp(), 0, 4, 0
			FROM due d
			WHERE d.coverage IS NOT NULL AND (d.covered_through IS NULL OR d.covered_through < d.period_end)
				AND NOT EXISTS (SELECT FROM job j WHERE j.kind = 'digest' AND j.subject_record_id = d.recipient
					AND j.producer_key = 'digest/' || d.purpose || '/' || d.owner || '/' || d.period_end)
			LIMIT ${PLAN_LIMIT}
			ON CONFLICT DO NOTHING RETURNING id
		)
		SELECT (SELECT count(*) FROM started)::int AS started, (SELECT count(*) FROM queued)::int AS queued`);
	return z.object({ started: z.number().int(), queued: z.number().int() }).parse(r.rows[0]);
}

const organizationKind = z.enum(["sending_church", "sending_network"]);
const recipientRow = z.object({
	kind: z.enum(["plant", "organization"]),
	organization_kind: organizationKind.nullable(),
	zone: timeZone,
	church_cadence: z.enum(["daily", "weekly", "off"]).nullable(),
	weekday: z.number().int().min(0).max(6).nullable(),
	hour: z.number().int().min(0).max(23).nullable(),
	cadence: z.enum(["daily", "weekly"]).nullable(),
	in_app: z.boolean().nullable(),
	email: z.boolean().nullable(),
	address: z.email().nullable(),
	coverage: z.uuid().nullable(),
	covered_through: localDate.nullable(),
	revision: z.string().nullable(),
});

/** A digest notice and its email share one key: tenant, category, coverage row and the covered dates. */
const digestKey = (tenant: string, category: string, coverage: string, start: string, end: string) =>
	`${tenant}/${category}/${coverage}/${start}/${end}`;
const parseKey = (key: string) => {
	const [, category, , start, end] = key.split("/");
	return { category, start: localDate.parse(start), end: localDate.parse(end) };
};

export function createDigestWorker(config: { mail: ReturnType<typeof createMailService>; origin: string }) {
	const origin = new URL(config.origin).origin;

	/** One claimed job: compile the owed digest for its recipient and deliver it, or finish with nothing owed. */
	async function deliver(tx: Transaction, claim: Claim, asOf: string) {
		if (!(await lockClaim(tx, claim))) return "lost" as const;
		const tenant = claim.tenant_id;
		const recipient = z.uuid().parse(claim.subject_record_id);
		const read = await tx.execute(sql`WITH cov AS MATERIALIZED (
				SELECT id, covered_through, revision FROM digest_coverage
				WHERE tenant_id = ${tenant}::uuid AND recipient_id = ${recipient}::uuid FOR UPDATE
			), category AS (SELECT CASE kind WHEN 'plant' THEN 'planter_digest' ELSE 'oversight_digest' END AS name
				FROM tenant WHERE id = ${tenant}::uuid)
			SELECT t.kind, o.kind AS organization_kind, coalesce(p.timezone, o.timezone, 'UTC') AS zone,
				p.digest_cadence AS church_cadence, p.digest_weekday AS weekday, p.digest_hour AS hour,
				(SELECT n.cadence FROM notification_preference n WHERE n.account_id = ${recipient}::uuid
					AND n.category = (SELECT name FROM category) AND n.cadence IS NOT NULL LIMIT 1) AS cadence,
				(SELECT n.enabled FROM notification_preference n WHERE n.account_id = ${recipient}::uuid
					AND n.category = (SELECT name FROM category) AND n.channel = 'in_app') AS in_app,
				(SELECT n.enabled FROM notification_preference n WHERE n.account_id = ${recipient}::uuid
					AND n.category = (SELECT name FROM category) AND n.channel = 'email') AS email,
				(SELECT c.email FROM account a CROSS JOIN LATERAL access_account_contact(a.id) c
					WHERE a.id = ${recipient}::uuid) AS address,
				(SELECT id FROM cov) AS coverage, (SELECT covered_through::text FROM cov) AS covered_through,
				(SELECT revision::text FROM cov) AS revision
			FROM tenant t LEFT JOIN plant p ON p.id = t.id LEFT JOIN organization o ON o.id = t.id
			WHERE t.id = ${tenant}::uuid`);
		const row = read.rows[0] ? recipientRow.parse(read.rows[0]) : null;
		// A job whose subject is no recipient (a church schedule change queues one), or a recipient whose coverage the
		// planner never started, has nothing owed.
		if (!row?.coverage || !row.revision || row.church_cadence === "off") return "nothing" as const;
		const plant = row.kind === "plant";
		const category = plant ? "planter_digest" : "oversight_digest";
		const cadence = row.cadence ?? defaultDigestCadence[category];
		const period = owedPeriod(
			{
				zone: row.zone,
				cadence,
				weekday: plant ? z.number().parse(row.weekday) : OVERSIGHT_SLOT.weekday,
				hour: plant ? z.number().parse(row.hour) : OVERSIGHT_SLOT.hour,
				completedDaysOnly: !plant,
			},
			asOf,
			row.covered_through,
		);
		if (!period) return "nothing" as const;
		const digest = plant
			? await compilePlanterDigest(tx, { plant: tenant, recipient, asOf, through: period.next }).then((d) => ({
					...d,
					text: renderPlanterDigest({ ...period, ...d }),
				}))
			: await compileOversightDigest(tx, { organization: tenant, recipient, ...period }).then((d) => ({
					...d,
					text: renderOversightDigest({ ...period, ...d }),
				}));
		// A recipient who lost their seat or account gets nothing, and their coverage stays where it was.
		if (!digest.live) return "nothing" as const;
		const inApp = row.in_app ?? defaultChannelEnabled(category, "in_app");
		const email = (row.email ?? defaultChannelEnabled(category, "email")) && row.address !== null;
		const send = digest.total > 0 && (inApp || email);
		const { text } = digest;
		const key = digestKey(tenant, category, row.coverage, period.start, period.end);
		const notice = randomUUID();
		const mail = config.mail.queued(
			send && email
				? [
						{
							owner: plant
								? { kind: "plant", id: tenant }
								: { kind: "organization", id: tenant, organizationKind: organizationKind.parse(row.organization_kind) },
							recipient,
							address: row.address!,
							purpose: category,
							logicalKey: key,
							notice,
							operation: null,
							eligibleAt: new Date().toISOString(),
							content: {
								subject: text.title,
								text: [text.title, "", ...text.lines, "", `Open Everyfield: ${origin}/notifications`].join("\n"),
							},
						},
					]
				: [],
		);
		// Coverage advances with what the period delivered, in one statement: an empty period or one with both channels
		// off advances it alone. A notice whose bell channel is off is archived, and its email still goes.
		const write = await tx.execute(sql`WITH advanced AS (
				UPDATE digest_coverage SET covered_through = ${period.end}::date, cadence = ${cadence},
					timezone = ${row.zone}, revision = revision + 1
				WHERE id = ${row.coverage}::uuid AND revision = ${row.revision}::bigint RETURNING id, revision
			), notices AS (
				INSERT INTO notice(id, tenant_id, recipient_id, category, purpose, logical_key, source_record_id, source_revision,
					title, safe_body, eligible_at, created_at, timezone, archived_at)
				SELECT ${notice}::uuid, ${tenant}::uuid, ${recipient}::uuid, 'digest', ${category}, ${key}, a.id, a.revision,
					${text.title}, ${text.lines.join(" ")}, clock_timestamp(), clock_timestamp(), ${row.zone},
					CASE WHEN ${inApp}::boolean THEN NULL ELSE clock_timestamp() END
				FROM advanced a WHERE ${send}::boolean
				ON CONFLICT (recipient_id, logical_key) DO NOTHING RETURNING id
			)${send && email ? sql`, ${mail.ctes}` : sql``}
			SELECT (SELECT count(*) FROM advanced)::int AS advanced, (SELECT count(*) FROM notices)::int AS notices,
				${send && email ? sql`(SELECT count(*) FROM mail_inserted)::int` : sql`0`} AS mail`);
		const done = z.object({ advanced: z.number(), notices: z.number(), mail: z.number() }).parse(write.rows[0]);
		if (done.advanced !== 1 || done.notices !== (send ? 1 : 0) || done.mail !== (send && email ? 1 : 0))
			throw Error("digest_identity_conflict");
		return send ? ("sent" as const) : ("nothing" as const);
	}

	/** Runs up to `limit` due digest jobs before `until`, one transaction each. Returns how many it delivered. */
	async function run(db: Database, asOf: string, limit = DIGESTS_PER_RUN, until = Infinity) {
		let sent = 0;
		for (let n = 0; n < limit && Date.now() < until; n++) {
			const [claim] = await claimDue(db, ["digest"]);
			if (!claim) break;
			try {
				const outcome = await transaction(db, async (tx) => {
					const result = await deliver(tx, claim, asOf);
					if (result !== "lost") await finishClaim(tx, claim, { state: "succeeded" });
					return result;
				});
				if (outcome === "sent") sent++;
			} catch {
				// No error text: it can carry row values.
				console.error(JSON.stringify({ component: "digest", outcome: "error" }));
				await finishJob(db, claim, { state: "retry_wait", code: "digest_failed" });
			}
		}
		return sent;
	}

	return { run };
}
export type DigestWorker = ReturnType<typeof createDigestWorker>;

/**
 * Dispatch's check for a digest email (REQ-NTF-008: sharing gates each contribution at compile and dispatch). The
 * recipient must still hold their seat. An oversight email goes only while a fresh compile of its dates gives the
 * same text its notice holds; when a plant stopped sharing or its link ended, the email is withdrawn and the bell
 * entry stays as it was delivered.
 */
export const authorizeDigestMail: AuthorizeMail = async (tx, list) => {
	const allowed = new Set<string>();
	for (const m of list) {
		if ((m.purpose !== "planter_digest" && m.purpose !== "oversight_digest") || !m.notice || !m.recipient) continue;
		const { category, start, end } = parseKey(m.logicalKey);
		if (category !== m.purpose) continue;
		if (m.purpose === "planter_digest") {
			if (await digestRecipientLive(tx, m.tenant, m.recipient)) allowed.add(m.id);
			continue;
		}
		const fresh = await compileOversightDigest(tx, {
			organization: m.tenant,
			recipient: m.recipient,
			notice: { id: m.notice, logicalKey: m.logicalKey },
			start,
			end,
		});
		if (fresh.live && renderOversightDigest({ start, end, ...fresh }).lines.join(" ") === fresh.stored)
			allowed.add(m.id);
	}
	return allowed;
};

const env = z.object({
	...mailEnv,
	IDENTITY_ORIGIN: z.url(),
});
let mounted: DigestWorker | undefined;
/** The runner's digest worker, or null when the deployment has no mail configuration. Mail is queued here only. */
export function digestsMount(db: Database | null): DigestWorker | null {
	const v = env.safeParse(process.env);
	if (!db || !v.success) return null;
	mounted ??= createDigestWorker({
		origin: v.data.IDENTITY_ORIGIN,
		mail: queuedMailService({ db, env: v.data, authorize: authorizeDigestMail, unsubscribe: mailUnsubscribe() }),
	});
	return mounted;
}
