import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "../../../packages/contracts/node_modules/zod/index.cjs";
import { CommandScope } from "../../../packages/contracts/src/common/scope.ts";
import { accountId, sessionId, owner, commandEnvelope, revision, instant, subject, auditEntry,
  auditInput, buildHumanAudit, buildServiceAudit, boundedAuditDiff, auditDiffBytes, safeError } from "../../../packages/contracts/src/common/index.ts";

const A = "11111111-1111-4111-8111-111111111111";
const P = "22222222-2222-4222-8222-222222222222";
const Q = "33333333-3333-4333-8333-333333333333";
const ID = "44444444-4444-4444-8444-444444444444";
const at = instant.parse("2026-10-13T16:00:00Z");
const plant = owner.parse({ kind: "plant", id: P });
const session = sessionId.parse("valid-session");
const current = { accountId: A, sessionId: session, sessionExpiresAt: "2026-10-14T00:00:00Z", accountActive: true,
  context: { kind: "seat", owner: plant, role: "admin", active: true } };
const input = { id: ID, operationId: ID, effectId: null, recordedAt: at,
  subject: { kind: "person", id: ID, owner: plant },
  change: { action: "people.updated", diff: { before: { revision: "7" }, after: { revision: "8" }, changedFields: ["name"] } } };
const load = (value: unknown = current) => CommandScope.load({}, session, plant, at, async () => value);

test("AC:C0-SCOPE-001 AC:AUDIT-002 trusted current scope rejects forged actor, role, owner and stale session", async () => {
  const scope = await load();
  assert.ok(scope);
  assert.deepEqual(scope.actor, { kind: "human", accountId: A });
  assert.equal(scope.role, "admin");
  const command = commandEnvelope(z.strictObject({ name: z.string() }));
  assert.deepEqual(command.parse({ requestKey: "request-1", expectedRevision: "7", input: { name: "Example" } }),
    { requestKey: "request-1", expectedRevision: "7", input: { name: "Example" } });
  for (const forbidden of ["actor", "role", "origin", "approval", "execution", "subjectOwner"]) {
    assert.equal(command.safeParse({ requestKey: "request-1", expectedRevision: "7", input: { name: "Example" }, [forbidden]: A }).success, false);
  }
  for (const value of [
    { ...current, accountActive: false },
    { ...current, sessionId: "forged" },
    { ...current, sessionExpiresAt: at },
    { ...current, context: { ...current.context, role: "lead_planter" } },
    { ...current, context: { ...current.context, owner: { kind: "plant", id: Q } } },
    { ...current, context: { ...current.context, active: false } },
  ]) assert.equal(await load(value), null);
  assert.throws(() => Object.assign(scope.owner, { id: Q }), TypeError);
  assert.equal(scope.owner.id, P);
  const self = owner.parse({ kind: "account", id: A });
  const ownScope = await CommandScope.load({}, session, self, at, async () => ({ ...current, context: { kind: "account", owner: self, active: true } }));
  assert.ok(ownScope);
  assert.equal(ownScope.role, null);
  assert.equal(ownScope.actor.accountId, accountId.parse(A));
});

test("AC:C0-PERSON-001 AC:C0-REVISION-001 AC:AUDIT-002 Person audit round-trip retains exact owner and provenance", async () => {
  const scope = await load(); assert.ok(scope);
  const parsedInput = auditInput.parse(input);
  const entry = buildHumanAudit(scope, parsedInput); assert.ok(entry);
  assert.deepEqual(auditEntry.parse(JSON.parse(JSON.stringify(entry))), entry);
  assert.deepEqual(entry.actor, { kind: "human", accountId: A });
  assert.equal(entry.subject.kind, "person");
  assert.equal(entry.subject.owner.id, P);
  assert.equal(buildHumanAudit(scope, { ...parsedInput, subject: subject.parse({ ...input.subject, owner: { kind: "plant", id: Q } }) }), null);
  for (const forged of [
    { ...input.subject, kind: "private_week" },
    { ...input.subject, kind: "plant" },
    { ...input.subject, organizationId: Q },
    { ...input.subject, owner: { kind: "organization", id: P, organizationKind: "network" } },
  ]) assert.equal(subject.safeParse(forged).success, false);
  assert.equal(auditEntry.safeParse({ ...input, actor: { kind: "human", accountId: A }, change: { ...input.change, action: "tasks.completed" } }).success, false);
  const service = buildServiceAudit({ kind: "service", cause: "job", operationId: parsedInput.operationId }, plant, parsedInput);
  assert.deepEqual(service?.actor, { kind: "service", cause: "job", operationId: ID });
  assert.equal(revision.parse(JSON.parse(JSON.stringify("9007199254740993"))), "9007199254740993");
  assert.equal(revision.safeParse(9007199254740993).success, false);
});

test("AC:AUDIT-003 closed audit projections exclude private content and enforce the 2048 UTF-8 byte bound", async () => {
  const scope = await load(); assert.ok(scope);
  const entry = buildHumanAudit(scope, auditInput.parse(input)); assert.ok(entry);
  assert.equal(JSON.stringify(entry).includes("TOKEN-CANARY"), false);
  for (const field of ["credential", "address", "private_note", "prompt", "mail_body", "attachment", "signed_url", "private_week", "private_count"]) {
    assert.equal(auditEntry.safeParse({ ...entry, change: { ...entry.change, diff: { ...entry.change.diff, [field]: "TOKEN-CANARY" } } }).success, false);
  }
  // A producer's closed scalar projection still has the shared byte guard.
  const diff = boundedAuditDiff(z.strictObject({ before: z.strictObject({ status: z.string() }), after: z.strictObject({ status: z.literal("complete") }) }));
  const base = { before: { status: "" }, after: { status: "complete" as const } };
  const padding = 2048 - auditDiffBytes(base);
  const exact = { ...base, before: { status: "é".repeat(padding / 2) + (padding % 2 ? "a" : "") } };
  assert.equal(auditDiffBytes(diff.parse(exact)), 2048);
  const over = diff.safeParse({ ...exact, before: { status: exact.before.status + "a" } });
  assert.equal(over.success, false);
  if (!over.success) assert.equal(over.error.issues[0]?.message, "audit_diff_too_large");
  const unknown = safeError.parse({ code: "unknown", correlationId: ID, retry: "reconcile" });
  assert.deepEqual(unknown, { code: "unknown", correlationId: ID, retry: "reconcile" });
  assert.equal(safeError.safeParse({ ...unknown, retry: "same_request" }).success, false);
  assert.equal(safeError.safeParse({ ...unknown, sql: "TOKEN-CANARY" }).success, false);
});
