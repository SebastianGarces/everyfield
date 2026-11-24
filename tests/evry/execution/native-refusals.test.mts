import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { WriteUnavailable } from "../../../packages/domain/src/operations/refusals.ts";
import type { EvryActor, NativePorts } from "../../../packages/evry/src/index.ts";
import type { ReviewedWrite } from "../../../packages/evry/src/proposals/types.ts";
import { SEAT_COMMANDS } from "../../../packages/evry/src/adapters/identity/commands/index.ts";
import { CHURCH_COMMANDS } from "../../../packages/evry/src/adapters/settings/commands/index.ts";
import { SHARING_COMMANDS } from "../../../packages/evry/src/adapters/sharing/commands/index.ts";
import { ACCOUNT_COMMANDS } from "../../../packages/evry/src/adapters/account/commands/index.ts";
import { ORGANIZATION_COMMANDS } from "../../../packages/evry/src/adapters/organization/commands/index.ts";
import { ACTOR_SPECS, goldenChurch, NETWORK, type GoldenChurch } from "../evals/golden-church.mts";
import { nativePorts } from "../evals/settings-ports.mts";

const real = nativePorts();
const effects = {
	reminders: async () => {
		throw Error("unexpected task reminder replan");
	},
	phaseNotices: async () => undefined,
};
let church: GoldenChurch;

before(async () => {
	church = await goldenChurch({ seatNames: true });
});
after(() => church?.close());

async function reviewedArgs<I>(write: ReviewedWrite<I>, actor: EvryActor, value: I) {
	const query = await write.review(actor, value, { db: church.db, mail: null, native: real, conversationId: null });
	assert.ok(query, "the review has a target");
	const [row] = (await church.admin.execute(query)).rows as { args: Record<string, unknown> }[];
	assert.ok(row, "the review finds its target");
	return row.args;
}

function execute<I>(write: ReviewedWrite<I>, actor: EvryActor, args: unknown, native: NativePorts = real) {
	const context = { session: actor.session, selected: actor.owner };
	return gatedTransaction(church.db, async (tx) => {
		const claimed = await RequestActor.claimWrite(tx, context.session, context.selected);
		assert.ok(claimed, "the approving session holds write authority");
		return write.execute(tx, context, args, `evry:${randomUUID()}:1`, effects, {
			authority: claimed.authority,
			ports: native,
		});
	});
}

async function seatOf(account: string) {
	const [row] = (
		await church.admin.execute(sql`SELECT id FROM seat WHERE account_id=${account}::uuid AND ended_at IS NULL`)
	).rows as { id: string }[];
	assert.ok(row);
	return row.id;
}

const stale = (args: Record<string, unknown>) => ({ ...args, expectedRevision: "999999" });

test("a native write whose domain refuses answers that refusal's exact code", async (t) => {
	const { admin, network } = church.actors;

	await t.test("a seat refusal thrown by the identity service", async () => {
		const role = SEAT_COMMANDS["seats.changeOrdinaryRole"];
		const args = await reviewedArgs(role, admin, { seatId: await seatOf(ACTOR_SPECS.member.account), role: "admin" });
		assert.deepEqual(await execute(role, admin, stale(args)), { refused: "conflict" });
	});

	await t.test("a settings refusal answered as a reply and settled", async () => {
		const profile = CHURCH_COMMANDS["plant.updateProfile"];
		const args = await reviewedArgs(profile, admin, { patch: { city: "Round Rock" } });
		assert.deepEqual(await execute(profile, admin, stale(args)), { refused: "conflict" });
	});

	await t.test("an organization refusal on a connection", async () => {
		const sharing = SHARING_COMMANDS["privacy.setSharing"];
		const args = await reviewedArgs(sharing, admin, { organizationId: NETWORK, category: "wiki", enabled: false });
		assert.deepEqual(await execute(sharing, admin, stale(args)), { refused: "stale_revision" });
	});

	await t.test("an organization profile write the adapter reports unavailable", async () => {
		const profile = ORGANIZATION_COMMANDS["organizations.updateProfile"];
		const args = await reviewedArgs(profile, network, { patch: { city: "Dallas" } });
		const unavailable: NativePorts = {
			...real,
			organizations: { ...real.organizations, "organizations.updateProfile": async () => ({ status: "unavailable" }) },
		};
		assert.deepEqual(await execute(profile, network, args, unavailable), { refused: "unavailable" });
	});

	await t.test("a write whose authority lapses inside the port", async () => {
		const profile = CHURCH_COMMANDS["plant.updateProfile"];
		const args = await reviewedArgs(profile, admin, { patch: { city: "Round Rock" } });
		const lapsed: NativePorts = {
			...real,
			settings: {
				...real.settings,
				updatePlantProfile: async () => {
					throw new WriteUnavailable();
				},
			},
		};
		assert.deepEqual(await execute(profile, admin, args, lapsed), { refused: "unavailable" });
	});
});

test("a native write whose port fails without a domain refusal is never reported as a refusal", async (t) => {
	const { admin } = church.actors;

	await t.test("an error whose message is a snake_case word", async () => {
		const profile = CHURCH_COMMANDS["plant.updateProfile"];
		const args = await reviewedArgs(profile, admin, { patch: { city: "Round Rock" } });
		const failure = Error("missing_audit_entry");
		const broken: NativePorts = {
			...real,
			settings: {
				...real.settings,
				updatePlantProfile: async () => {
					throw failure;
				},
			},
		};
		await assert.rejects(execute(profile, admin, args, broken), (error) => error === failure);
	});

	await t.test("an error whose code property is a snake_case word", async () => {
		const deletion = ACCOUNT_COMMANDS["account.requestDeletion"];
		const args = await reviewedArgs(deletion, admin, {});
		const failure = Object.assign(new Error("The deletion receipt was not written"), { code: "receipt_lost" });
		const broken: NativePorts = {
			...real,
			account: {
				...real.account,
				requestAccountDeletion: async () => {
					throw failure;
				},
			},
		};
		await assert.rejects(execute(deletion, admin, args, broken), (error) => error === failure);
	});
});
