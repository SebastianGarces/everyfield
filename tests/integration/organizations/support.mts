import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql, type SQLWrapper } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomBytes, randomUUID } from "node:crypto";

import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";

const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const ci =
	process.env.CI === "true" &&
	process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
	["localhost", "127.0.0.1"].includes(source.hostname) &&
	source.pathname === "/everyfield_ci";
if (
	(!ci && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
	process.env.NODE_ENV === "production"
)
	throw Error("Only shared development direct endpoint allowed");
if (!ci) source.searchParams.set("sslmode", "verify-full");
export const schema = "wp007_" + randomUUID().replaceAll("-", "");
export const db = createDatabase({
	connectionString: source.href,
	max: 8,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
const role = "wp007_" + randomBytes(8).toString("hex"),
	password = randomBytes(32).toString("hex"),
	runtimeUrl = new URL(source);
runtimeUrl.username = role;
runtimeUrl.password = password;
export const runtime = createDatabase({
	connectionString: runtimeUrl.href,
	max: 8,
	options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
export async function setup() {
	await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(db, schema);
	await db.execute(
		sql.raw(`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`),
	);
	await db.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
}
export async function teardown() {
	await closeDatabase(runtime);
	await db.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
	await db.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
	await closeDatabase(db);
}
export async function tx<T>(
	body: (c: import("../../../packages/db/src/client.ts").Transaction) => Promise<T>,
): Promise<T> {
	return runtime.transaction(async (c) => {
		await c.execute(sql`SET LOCAL statement_timeout='10s'`);
		return body(c);
	});
}

export async function tenant(kind: "plant" | "sending_church" | "sending_network", name = "Synthetic") {
	const id = randomUUID();
	if (kind === "plant")
		await db.execute(
			sql`INSERT INTO plant(id,name,street,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${sql.param(id)},${sql.param(name)},'private street','America/Chicago',7,14,0,16,1,1)`,
		);
	else
		await db.execute(
			sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${sql.param(id)},${sql.param(kind)},${sql.param(name)},'UTC',1)`,
		);
	return owner.parse(kind === "plant" ? { kind: "plant", id } : { kind: "organization", id, organizationKind: kind });
}
export async function identity(selected?: ReturnType<typeof owner.parse>, role = "owner") {
	const user = randomUUID(),
		account = randomUUID(),
		handle = randomUUID(),
		email = randomUUID() + "@example.test";
	await db.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${sql.param(user)},${sql.param(email)},true,'Synthetic')`,
	);
	await db.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${sql.param(account)},${sql.param(user)},'active',${sql.param(
			selected?.kind === "plant"
				? "planter"
				: selected?.kind === "organization"
					? selected.organizationKind === "sending_church"
						? "sending_church"
						: "network"
					: "discovery",
		)})`,
	);
	await db.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${sql.param(handle)},${sql.param(user)},${sql.param(randomUUID())},clock_timestamp()+interval '1 day')`,
	);
	if (selected)
		await db.execute(
			sql`INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at) VALUES(${sql.param(account)},${sql.param(selected.kind === "plant" ? selected.id : null)},${sql.param(selected.kind === "organization" ? selected.id : null)},${sql.param(role)},clock_timestamp())`,
		);
	return {
		account,
		session: sessionId.parse(handle),
		email,
		selected: selected ?? owner.parse({ kind: "account", id: account }),
	};
}
export const proofs = new Map<string, string>();
export const mail = createMailService({
	db: runtime,
	encryptionKey: randomBytes(32),
	addressKey: randomBytes(32),
	from: "test@example.test",
	authorize: async (_tx, mail) => new Set(mail.map((m) => m.id)),
	transport: {
		send: async () => {
			throw Error("No provider call allowed");
		},
		lookup: async () => {
			throw Error("No provider call allowed");
		},
	},
});
export const effects = {
	async invitation(
		c: import("../../../packages/db/src/client.ts").Transaction,
		v: Parameters<import("../../../packages/domain/src/organizations/index.ts").OrganizationEffects["invitation"]>[1],
		writes: SQLWrapper[],
	) {
		proofs.set(v.invitationId, v.proof);
		await mail.append(
			c,
			{
				owner:
					v.owner.kind === "global"
						? (() => {
								throw Error("global");
							})()
						: v.owner,
				purpose: "relationship_invitation",
				logicalKey: "relationship/" + v.invitationId + "/" + v.operationId,
				recipient: null,
				address: v.recipientEmail,
				content: { subject: v.inviterDescription, text: "https://example.test/accept-relationship?token=" + v.proof },
				operation: v.operationId,
				notice: null,
				eligibleAt: new Date().toISOString(),
			},
			writes,
		);
	},
	notice(
		c: import("../../../packages/db/src/client.ts").Transaction,
		v: Parameters<import("../../../packages/domain/src/organizations/index.ts").OrganizationEffects["notice"]>[1],
	) {
		const target = v.pair.kind === "plant" ? v.pair.subject.id : v.pair.organization.id;
		return queueJobs(c, [
			{
				tenant: target,
				kind: "notification",
				subject: v.relationshipId,
				key: v.kind + "/" + v.eventId,
				revision: v.revision,
				eligibleAt: new Date().toISOString(),
			},
		]);
	},
	invalidate(
		_c: import("../../../packages/db/src/client.ts").Transaction,
		v: Parameters<import("../../../packages/domain/src/organizations/index.ts").OrganizationEffects["invalidate"]>[1],
	) {
		return sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${sql.param(v.sourceId)} AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`;
	},
};
export const api = createOrganizationAdapter(effects, { candidates: async () => [] });
export const command = (input: unknown, expectedRevision = "1", requestKey = randomUUID()) => ({
	requestKey,
	expectedRevision,
	input,
});
/** The operations the production mounts run through query(), without the write gate. Every other one is a command. */
const reads = new Set<keyof typeof api>([
	"associations.getHistory",
	"organizations.getProfile",
	"privacy.getSharing",
	"residency.readSharing",
	"pipelineSharing.readConsent",
	"pipelineSharing.checkAggregateAccess",
]);
export type Actor = Pick<Awaited<ReturnType<typeof identity>>, "session" | "selected">;
/**
 * One command transaction as the production mounts run it (command() in apps/web/src/server/organizations): the write
 * gate locks the actor's account and selected owner before the body starts. A body that locks first hides lock-order
 * faults that production has.
 */
export async function write<T>(
	actor: Actor,
	body: (c: import("../../../packages/db/src/client.ts").Transaction) => Promise<T>,
): Promise<T> {
	return tx(async (c) => {
		if (!(await RequestActor.claimWrite(c, actor.session, actor.selected))) throw Error("unavailable");
		return body(c);
	});
}
export async function call(name: keyof typeof api, actor: Actor, input: unknown) {
	const run = (c: import("../../../packages/db/src/client.ts").Transaction) =>
		api[name](c, actor.session, actor.selected, input as never);
	return reads.has(name) ? tx(run) : write(actor, run);
}
/** Resolves once another transaction of this test role waits for a row lock. */
export async function waitingOnLock() {
	for (let attempt = 0; attempt < 400; attempt++) {
		const r = await runtime.execute(
			sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename=current_user AND wait_event_type='Lock'`,
		);
		if ((r.rows[0] as { n: number }).n > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw Error("the rival transaction never waited for a lock");
}
export async function affiliation(
	plant: ReturnType<typeof owner.parse>,
	org: ReturnType<typeof owner.parse>,
	share = false,
) {
	const r =
		await db.execute(sql`INSERT INTO affiliation(plant_id,account_id,sending_church_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
 VALUES(${sql.param(plant.kind === "plant" ? plant.id : null)},${sql.param(plant.kind === "account" ? plant.id : null)},${sql.param(plant.kind === "organization" ? plant.id : null)},${sql.param(org.id)},clock_timestamp(),${sql.param(share)},${sql.param(share)},${sql.param(share)},${sql.param(share)},${sql.param(share)},${sql.param(share)},${sql.param(share)}) RETURNING id`);
	return r.rows[0].id;
}
/**
 * The holder binds its write gate and waits until the rival transaction waits for a lock, then runs its body. Each
 * side settles to its value, `{ refused: code }` for a domain refusal or `{ failed: code }` for a Postgres error such
 * as a deadlock (40P01) or lock timeout (55P03).
 */
export async function race<A, B>(
	holder: Actor,
	held: (c: import("../../../packages/db/src/client.ts").Transaction) => Promise<A>,
	rival: () => Promise<B>,
) {
	let bound!: () => void;
	const gate = new Promise<void>((resolve) => (bound = resolve));
	const first = write(holder, async (c) => {
		bound();
		await waitingOnLock();
		return held(c);
	});
	await gate;
	const second = rival();
	const outcome = (r: PromiseSettledResult<unknown>) => {
		if (r.status === "fulfilled") return r.value;
		const e = r.reason as Error & { cause?: { code?: string } };
		return /^[a-z_]{3,40}$/.test(e.message) ? { refused: e.message } : { failed: e.cause?.code ?? String(e) };
	};
	return (await Promise.allSettled([first, second])).map(outcome) as [unknown, unknown];
}
