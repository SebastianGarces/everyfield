import assert from "node:assert/strict";
import { test } from "node:test";
import { checkReplay, checkRevision, requestIdentity, receipt, revision } from "../../../packages/contracts/src/common/index.ts";

const A = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const ID = "44444444-4444-4444-8444-444444444444";
const identity = requestIdentity.parse({ owner: { kind: "plant", id: P }, actorId: A,
  operation: "people.createPerson", requestKey: "request-1", digest: "a".repeat(64), origin: { kind: "native" } });

// A bounded in-memory transaction example demonstrates how producers use the
// shared decisions. It is not SQL atomicity, race or feature acceptance proof.
function fixture() {
  let saved = { value: "before", revision: "7", receipts: [] as ReturnType<typeof receipt.parse>[], history: [] as string[], intents: [] as string[] };
  return {
    state: () => structuredClone(saved),
    execute(fault?: "facts" | "history" | "intent" | "receipt", incoming = identity) {
      const prior = saved.receipts[0] ?? null;
      const decision = checkReplay(incoming, prior);
      if (decision.kind !== "new") return decision;
      assert.equal(checkRevision(revision.parse("7"), revision.parse(saved.revision)), "current");
      const tx = structuredClone(saved);
      tx.value = "after"; tx.revision = "8";
      if (fault === "facts") throw new Error(fault);
      tx.history.push("event-1");
      if (fault === "history") throw new Error(fault);
      tx.intents.push("intent-1");
      if (fault === "intent") throw new Error(fault);
      const result = receipt.parse({ id: ID, request: incoming, completedAt: "2026-10-13T16:00:00Z", outcome: "changed", subjects: [{ kind: "person", id: ID, owner: {kind: "plant", id: P} }], eventIds: [ID], effectIds: [ID] });
      tx.receipts.push(result);
      if (fault === "receipt") throw new Error(fault);
      saved = tx;
      return { kind: "committed", receipt: result };
    },
  };
}

test("AC:C0-REPLAY-001 AC:AUDIT-001 bounded transaction example rolls back each required write and preserves replay identities", () => {
  for (const fault of ["facts", "history", "intent", "receipt"] as const) {
    const example = fixture();
    assert.throws(() => example.execute(fault), new RegExp(fault));
    assert.deepEqual(example.state(), { value: "before", revision: "7", receipts: [], history: [], intents: [] });
  }
  const example = fixture();
  const result = example.execute(); assert.equal(result.kind, "committed");
  if (result.kind !== "committed") throw new Error("Expected committed example");
  const saved = example.state();
  assert.deepEqual(saved, { value: "after", revision: "8", receipts: [result.receipt], history: ["event-1"], intents: ["intent-1"] });
  assert.deepEqual(example.execute(), { kind: "replay", receipt: result.receipt });
  assert.deepEqual(example.execute(undefined, requestIdentity.parse({ ...identity, digest: "b".repeat(64) })), { kind: "conflict" });
  assert.deepEqual(example.state(), saved);
  assert.deepEqual(receipt.parse(JSON.parse(JSON.stringify(result.receipt))), result.receipt);
  assert.equal(receipt.safeParse({ ...result.receipt, subjects: [{ kind: "person", id: ID, owner: { kind: "plant", id: A } }] }).success, false);
  const changedOrigin = requestIdentity.parse({ ...identity, origin: { kind: "assistant", reviewId: ID, conversationId: ID, planDigest: "a".repeat(64) } });
  assert.deepEqual(checkReplay(changedOrigin, result.receipt), { kind: "conflict" });
  assert.equal(checkRevision(revision.parse("7"), revision.parse("8")), "conflict");
  const noop = receipt.parse({ ...result.receipt, outcome: "noop", eventIds: [], effectIds: [] });
  assert.deepEqual(checkReplay(identity, noop), { kind: "replay", receipt: noop });
  assert.equal(requestIdentity.safeParse({ ...identity, operation: "privateCare.save" }).success, false);
});
