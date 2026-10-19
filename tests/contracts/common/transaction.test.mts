import assert from "node:assert/strict";
import { test } from "node:test";
import {
	checkReplay,
	checkRevision,
	requestIdentity,
	receipt,
	revision,
	writeRequiredConsequences,
} from "../../../packages/contracts/src/common/index.ts";
import type { Receipt } from "../../../packages/contracts/src/common/index.ts";

const A = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const ID = "44444444-4444-4444-8444-444444444444";
const identity = requestIdentity.parse({
	owner: { kind: "plant", id: P },
	actorId: A,
	operation: "people.createPerson",
	requestKey: "request-1",
	digest: "a".repeat(64),
	origin: { kind: "native" },
});
type State = { value: string; revision: string; receipts: Receipt[]; history: string[]; intents: string[] };

// A disposable transaction adapter commits its copy only if the package's actual
// required-write helper completes. Real SQL rollback/races remain downstream proof.
function fixture() {
	let saved: State = { value: "before", revision: "7", receipts: [], history: [], intents: [] };
	return {
		state: () => structuredClone(saved),
		async execute(fault?: "facts" | "history" | "intents" | "receipt", incoming = identity) {
			const decision = checkReplay(incoming, saved.receipts[0] ?? null);
			if (decision.kind !== "new") return decision;
			assert.equal(checkRevision(revision.parse("7"), revision.parse(saved.revision)), "current");
			const tx = structuredClone(saved);
			const result = await writeRequiredConsequences(tx, {
				async facts(connection) {
					connection.value = "after";
					connection.revision = "8";
					if (fault === "facts") throw new Error(fault);
					return receipt.parse({
						id: ID,
						request: incoming,
						completedAt: "2026-10-13T16:00:00Z",
						outcome: "changed",
						subjects: [{ kind: "person", id: ID, owner: { kind: "plant", id: P } }],
						eventIds: [ID],
						effectIds: [ID],
					});
				},
				async history(connection, result) {
					connection.history.push(result.eventIds.join(","));
					if (fault === "history") throw new Error(fault);
				},
				async receipt(connection, result) {
					connection.receipts.push(result);
					if (fault === "receipt") throw new Error(fault);
				},
				async intents(connection, result) {
					connection.intents.push(result.effectIds.join(","));
					if (fault === "intents") throw new Error(fault);
				},
			});
			saved = tx;
			return { kind: "committed", receipt: result };
		},
	};
}

test("INV-tenancy: AC:C0-REPLAY-001 AC:AUDIT-001 required-write helper propagates every fault to the owning transaction and preserves replay identities", async () => {
	for (const fault of ["facts", "history", "intents", "receipt"] as const) {
		const example = fixture();
		await assert.rejects(example.execute(fault), new RegExp(fault));
		assert.deepEqual(example.state(), { value: "before", revision: "7", receipts: [], history: [], intents: [] });
	}
	const example = fixture();
	const result = await example.execute();
	assert.equal(result.kind, "committed");
	if (result.kind !== "committed") throw new Error("Expected committed example");
	const saved = example.state();
	assert.deepEqual(saved, { value: "after", revision: "8", receipts: [result.receipt], history: [ID], intents: [ID] });
	assert.deepEqual(await example.execute(), { kind: "replay", receipt: result.receipt });
	assert.deepEqual(await example.execute(undefined, requestIdentity.parse({ ...identity, digest: "b".repeat(64) })), {
		kind: "conflict",
	});
	assert.deepEqual(example.state(), saved);
	assert.deepEqual(receipt.parse(JSON.parse(JSON.stringify(result.receipt))), result.receipt);
	assert.equal(
		receipt.safeParse({ ...result.receipt, subjects: [{ kind: "person", id: ID, owner: { kind: "plant", id: A } }] })
			.success,
		false,
	);
	for (const changed of [
		{ actorId: ID },
		{ owner: { kind: "plant", id: A } },
		{ owner: { kind: "account", id: P } },
		{ requestKey: "request-2" },
		{ operation: "people.updatePerson" },
		{ origin: { kind: "assistant", reviewId: ID, conversationId: ID, planDigest: "a".repeat(64) } },
	])
		assert.deepEqual(checkReplay(requestIdentity.parse({ ...identity, ...changed }), result.receipt), {
			kind: "conflict",
		});
	assert.equal(checkRevision(revision.parse("7"), revision.parse("8")), "conflict");
	const noop = receipt.parse({ ...result.receipt, outcome: "noop", eventIds: [], effectIds: [] });
	assert.deepEqual(checkReplay(identity, noop), { kind: "replay", receipt: noop });
	assert.equal(requestIdentity.safeParse({ ...identity, operation: "privateCare.save" }).success, false);
});

test("INV-receipt-bound: a receipt lists up to 4096 subjects, events and effects and refuses one more (ruling D57)", () => {
	const ids = (n: number) =>
		Array.from({ length: n }, (_, k) => `${(k + 1).toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`);
	const base = { id: ID, request: identity, completedAt: "2026-10-13T16:00:00Z", outcome: "changed" as const };
	const of = (n: number) => ({
		...base,
		subjects: ids(n).map((id) => ({ kind: "person", id, owner: { kind: "plant", id: P } })),
		eventIds: ids(n),
		effectIds: ids(n),
	});
	for (const n of [100, 4096]) assert.equal(receipt.safeParse(of(n)).success, true, `${n} items`);
	for (const key of ["subjects", "eventIds", "effectIds"] as const)
		assert.equal(receipt.safeParse({ ...of(4096), [key]: of(4097)[key] }).success, false, `4097 ${key}`);
});
