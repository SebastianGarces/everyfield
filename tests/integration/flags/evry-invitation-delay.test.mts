import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	openLatestConversation,
	readConversation,
	readReview,
	shownReview,
	submitTurn,
	withMailDelays,
	type EvryActor,
	type NativePorts,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { readSwitches } from "../../../packages/domain/src/flags/index.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { invitationServiceOn } from "../../../apps/web/src/server/invitations/index.ts";
import { current as organizationMount } from "../../../apps/web/src/features/organizations/mount.ts";
import { nativePorts } from "../../evry/evals/settings-ports.mts";
import {
	accounts,
	actor,
	admin,
	db,
	plant,
	queries,
	scripted,
	setup,
	sql,
	teardown,
	work,
} from "../../evry/runtime/support.mts";
import { setServerEnv } from "../../support/server-env.mts";
import { capturedLines, withSwitchOff } from "../../support/flags.mts";

setServerEnv();
const PAUSED = { flag: "outbound-mail", operator: accounts.owner.id } as const;
let owner: EvryActor;
let native: NativePorts;

before(async () => {
	await setup();
	owner = await actor("owner");
	native = { ...nativePorts(), invitations: invitationServiceOn, organizations: organizationMount().adapter };
});
after(teardown);

async function prepared(text: string) {
	const c = await createConversation(db, owner, { requestKey: randomUUID() });
	await submitTurn(db, owner, c.id, { requestKey: randomUUID(), text });
	assert.equal(await work(scripted(), { native }), "succeeded");
	const proposal = Object.values((await readConversation(db, owner, c.id)).reviews)[0];
	assert.ok(proposal, text);
	return proposal;
}
async function approved(proposal: Proposal) {
	const { proposal: running } = await approveProposal(
		db,
		owner,
		proposal.id,
		{ revision: proposal.revision, digest: proposal.digest },
		null,
	);
	assert.equal((await shownReview(db, owner, running)).mailDelayed, undefined, "an approved card waits, undelayed");
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{
			reminders: async () => undefined,
			phaseNotices: async () => {
				throw Error("unexpected phase notice");
			},
		},
		null,
		native,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	assert.equal(outcome, "completed");
	return readReview(db, owner, proposal.id);
}
const run = async (text: string) => approved(await prepared(text));
const whenOff = async <T,>(body: () => Promise<T>) => {
	const { value, lines } = await capturedLines(() => withSwitchOff(db, PAUSED, body));
	assert.deepEqual(
		lines.filter((l) => l.component === "kill-switch" || l.component === "mail-delay"),
		[],
	);
	return value;
};
const delayed = async (id: string) =>
	(await shownReview(db, owner, await readReview(db, owner, id))).mailDelayed === true;
const pastCooldown = (id: string) =>
	admin.execute(sql`UPDATE invitation SET created_at=created_at-interval '2 minutes',
		resent_at=resent_at-interval '2 minutes' WHERE id=${id}::uuid`);
const invitationOf = (proposal: Proposal) => {
	assert.ok(proposal.receipt?.receiptId);
	return proposal.receipt.receiptId;
};
async function rowsOf(proposal: Proposal) {
	const { rows } = await admin.execute(sql`
		SELECT to_jsonb(p.*)->>'state' AS state, p.outcome, p.receipt - 'receiptId' AS receipt, i.state AS invitation,
			i.revision::text AS revision, m.purpose, m.state AS mail, j.state AS job, j.attempt_count AS attempts,
			a.result::text LIKE '%elayed%' OR to_jsonb(p.*)::text LIKE '%elayed%' AS stored
		FROM proposal p JOIN invitation i ON i.id=(p.receipt->>'receiptId')::uuid
		JOIN audit_event a ON a.tenant_id=p.tenant_id AND a.request_key='evry:'||p.id||':'||p.revision
		JOIN mail m ON m.operation_id=a.id JOIN job j ON j.id=m.job_id WHERE p.id=${proposal.id}::uuid`);
	return rows;
}
const address = () => `${randomUUID()}@example.test`;
async function connection() {
	const name = `Grace ${randomUUID().slice(0, 8)}`;
	const id = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${id},'sending_church',${name},'America/Chicago',1)`,
	);
	return `invite ${name} to be our sending church at ${address()}`;
}
async function resendAsk() {
	const email = address();
	await pastCooldown(invitationOf(await run(`invite ${email} as a Member`)));
	return `resend the invitation to ${email}`;
}
const ASKS = {
	"seats.invite": async () => `invite ${address()} as a Member`,
	"seats.resendInvitation": resendAsk,
	"associations.invite": connection,
};

for (const [operation, ask] of Object.entries(ASKS))
	test(`${operation} approved with mail off completes, queues the same rows and says delayed only while it is off`, async () => {
		const proposal = await prepared(await ask());
		assert.equal(proposal.operation, operation);
		const done = await whenOff(async () => {
			assert.equal((await shownReview(db, owner, proposal)).mailDelayed, undefined, "a pending card reads as before");
			const card = await approved(proposal);
			assert.equal(await delayed(card.id), true);
			const { mailDelayed, ...rest } = await shownReview(db, owner, card);
			assert.equal(mailDelayed, true);
			assert.deepEqual(rest, card, "only the delay is added");
			const page = await openLatestConversation(db, owner);
			assert.ok(page);
			assert.equal((await withMailDelays(db, owner, page.reviews))[card.id]?.mailDelayed, true);
			return card;
		});
		assert.equal(await delayed(done.id), false, "back on, the next read is the ordinary card");
		const on = await run(await ask());
		assert.equal(await delayed(on.id), false);
		const offRows = await rowsOf(done);
		assert.equal(offRows.length, 1);
		assert.deepEqual(offRows, await rowsOf(on));
		assert.deepEqual(
			[offRows[0]!.mail, offRows[0]!.job, Number(offRows[0]!.attempts), offRows[0]!.stored],
			["pending", "ready", 0, false],
		);
	});

test("a card whose mail already went out does not say delayed in a later pause; mail the provider refused and will retry does", async () => {
	const card = await run(await ASKS["seats.invite"]());
	const mail = (state: string, job: string) =>
		admin.execute(sql`WITH m AS (UPDATE mail SET state=${state} FROM audit_event a WHERE a.id=mail.operation_id
			AND a.request_key=${`evry:${card.id}:${card.revision}`} RETURNING mail.job_id)
			UPDATE job SET state=${job} FROM m WHERE job.id=m.job_id`);
	for (const [state, job, expected] of [
		["pending", "ready", true],
		["refused", "retry_wait", true],
		["refused", "failed", false],
		["cancelled", "cancelled", false],
		["dispatched", "claimed", false],
		["unknown", "reconcile", false],
		["accepted", "succeeded", false],
	] as const) {
		await mail(state, job);
		assert.equal(await whenOff(() => delayed(card.id)), expected, `${state}/${job}`);
	}
});

test("a card whose invitation was resent, revoked, accepted, declined or expired since does not say delayed", async () => {
	const email = address();
	const first = await run(`invite ${email} as a Member`);
	assert.equal(await whenOff(() => delayed(first.id)), true);
	await pastCooldown(invitationOf(first));
	const again = await run(`resend the invitation to ${email}`);
	assert.deepEqual(await whenOff(async () => [await delayed(first.id), await delayed(again.id)]), [false, true]);
	await run(`revoke the invitation to ${email}`);
	assert.equal(await whenOff(() => delayed(again.id)), false);

	for (const change of [sql`state='accepted'`, sql`state='declined'`, sql`created_at=created_at-interval '31 days'`]) {
		const card = await run(await ASKS["associations.invite"]());
		assert.equal(await whenOff(() => delayed(card.id)), true);
		await admin.execute(sql`UPDATE invitation SET ${change} WHERE id=${invitationOf(card)}::uuid`);
		assert.equal(await whenOff(() => delayed(card.id)), false);
	}
});

test("a failed switch read or mail read leaves the ordinary completed card", async () => {
	const card = await run(await ASKS["seats.invite"]());
	const failing = new Proxy(db, {
		get(target, key) {
			if (key !== "execute") return Reflect.get(target, key);
			return async (query: Parameters<typeof db.execute>[0]) => {
				if (JSON.stringify(query).includes("JOIN mail m")) throw Error("mail_read_down");
				return target.execute(query);
			};
		},
	});
	const down = () => Promise.reject(Error("flag_read_down"));
	for (const read of [
		() => shownReview(db, owner, card, down),
		() => withSwitchOff(db, PAUSED, () => shownReview(failing, owner, card)),
	]) {
		const { value, lines } = await capturedLines(read);
		assert.deepEqual(value, card);
		assert.deepEqual(
			lines.map((l) => [l.component, l.outcome]),
			[["mail-delay", "read_failed"]],
		);
	}
});

test("only the global switch counts, read once for a completed invitation card and never for another card", async () => {
	const card = await run(await ASKS["seats.invite"]());
	const second = await run(await ASKS["associations.invite"]());
	const pending = await prepared(await ASKS["seats.invite"]());
	const revoked = await run(`revoke the invitation to ${String(card.review.changes[0]!.after)}`);
	const reads = async (reviews: Record<string, Proposal | null>) => {
		const start = queries.length;
		const shown = await withMailDelays(db, owner, reviews);
		return { shown, statements: queries.length - start };
	};
	const others = {
		pending,
		revoked,
		gone: null,
		refused: { ...second, id: randomUUID(), outcome: "refused" as const },
	};
	const cards = { second, ...others };
	const on = await reads(cards);
	assert.deepEqual([on.statements, on.shown], [1, cards]);
	const off = await whenOff(async () => ({ none: await reads(others), all: await reads(cards) }));
	assert.deepEqual([off.none.statements, off.none.shown], [0, others]);
	assert.deepEqual([off.all.statements, off.all.shown], [2, { ...cards, second: { ...second, mailDelayed: true } }]);

	let given = 0;
	await shownReview(db, owner, second, () => (given++, readSwitches(db)));
	assert.equal(given, 1);
	await admin.execute(sql`INSERT INTO feature_flag(name,tenant_id,value) VALUES('outbound-mail',${plant}::uuid,false)`);
	assert.equal(await delayed(second.id), false, "a church's own value is ignored");
});
