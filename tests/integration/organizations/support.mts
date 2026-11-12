import { sql, type SQLWrapper } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { randomBytes, randomUUID } from "node:crypto";

import { testDatabase } from "../../support/test-database.mts";
import { seeds, waitingOnLock as sharedWaitingOnLock } from "../../support/fixture.mts";
import { createOrganizationAdapter } from "../../../packages/domain/src/organizations/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { queueJobs } from "../../../apps/web/src/server/jobs/queue.ts";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";

// The schema exists from import on; `teardown` drops it.
const database = await testDatabase({ prefix: "wp007", max: 8 });
export const { schema, admin: db } = database;
export const runtime = database.pools.runtime;
export const teardown = database.close;
const seed = seeds(db);
export async function tx<T>(
	body: (c: import("../../../packages/db/src/client.ts").Transaction) => Promise<T>,
): Promise<T> {
	return runtime.transaction(async (c) => {
		await c.execute(sql`SET LOCAL statement_timeout='10s'`);
		return body(c);
	});
}

export async function tenant(kind: "plant" | "sending_church" | "sending_network", name = "Synthetic") {
	const created =
		kind === "plant"
			? await seed.plant({ name, street: "private street", digest_weekday: 0, digest_hour: 16 })
			: await seed.organization(kind, { name });
	return owner.parse(created);
}
export async function identity(selected?: ReturnType<typeof owner.parse>, role = "owner") {
	const a = await seed.actor(selected?.kind === "account" ? null : (selected as never), role as never, {
		email: randomUUID() + "@example.test",
	});
	return {
		account: a.id,
		session: sessionId.parse(a.session),
		email: a.email,
		selected: selected ?? owner.parse({ kind: "account", id: a.id }),
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
	invalidate(
		_c: import("../../../packages/db/src/client.ts").Transaction,
		v: Parameters<import("../../../packages/domain/src/organizations/index.ts").OrganizationEffects["invalidate"]>[1],
	) {
		return sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${sql.param(v.sourceId)} AND kind='digest' AND state IN ('ready','retry_wait','claimed')`;
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
/** Resolves once another transaction of this test role waits for a row lock (the shared wait on lock state). */
export const waitingOnLock = () => sharedWaitingOnLock(runtime);
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
