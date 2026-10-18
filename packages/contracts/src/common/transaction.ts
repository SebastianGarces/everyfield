import { z } from "zod";
import { digest, requestKey, revision, operationId, eventId, effectId, accountId, owner, sameOwner, reviewId, conversationId } from "./values.ts";
import type { Owner, Revision } from "./values.ts";
import { instant } from "./time.ts";
import { sharedOperationNames } from "./vocabulary.ts";
import { subject } from "./audit.ts";
import type { CommandScope } from "./scope.ts";

// Extend with each producer's CLOSED input parser. Authority/origin/approval are
// deliberately absent; strict objects refuse those fields rather than stripping them.
export function commandEnvelope<T extends z.ZodType>(input: T) {
  return z.strictObject({ requestKey, expectedRevision: revision, input });
}
const operationNames = new Set<string>(sharedOperationNames);
export const operationName = z.string().refine(value => operationNames.has(value)).brand<"OperationName">();
export const commandOrigin = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("native") }),
  z.strictObject({ kind: z.literal("assistant"), reviewId, conversationId, planDigest: digest }),
]);
export const requestIdentity = z.strictObject({ owner, actorId: accountId,
  operation: operationName, requestKey, digest, origin: commandOrigin });
export type RequestIdentity = z.infer<typeof requestIdentity>;
export const receipt = z.strictObject({
  id: operationId, request: requestIdentity, completedAt: instant,
  outcome: z.enum(["changed", "noop", "partial", "unknown"]),
  subjects: z.array(subject).max(100),
  eventIds: z.array(eventId).max(100), effectIds: z.array(effectId).max(100),
}).refine(value => value.subjects.every(s => sameOwner(s.owner, value.request.owner)), { message: "invalid_subject_owner" });
export type Receipt = z.infer<typeof receipt>;
export type ReplayDecision = { kind: "new" } | { kind: "replay"; receipt: Receipt } | { kind: "conflict" };

// Call only AFTER fresh authority/lifecycle checks, inside the transaction and
// under its unique request identity lock. SQL uniqueness remains producer-owned.
export function checkReplay(incoming: RequestIdentity, prior: Receipt | null): ReplayDecision {
  if (!prior) return { kind: "new" };
  const saved = prior.request;
  if (!sameOwner(saved.owner, incoming.owner) || saved.actorId !== incoming.actorId ||
      saved.operation !== incoming.operation || saved.requestKey !== incoming.requestKey || saved.digest !== incoming.digest || JSON.stringify(saved.origin) !== JSON.stringify(incoming.origin)) {
    return { kind: "conflict" };
  }
  return { kind: "replay", receipt: prior };
}
export function checkRevision(expected: Revision, current: Revision): "current" | "conflict" {
  return expected === current ? "current" : "conflict";
}

// A domain producer implements this protocol using its own connection and policies.
// Required collaborators take the SAME Tx. This declares ordering; it runs no SQL,
// provider callbacks or generic event dispatch, and never increments PI revisions.
export interface TransactionPattern<Tx, Input, Output> {
  run(input: Input, body: (tx: Tx) => Promise<Output>): Promise<Output>;
  loadCurrentScope(tx: Tx): Promise<CommandScope | null>;
  lockSubjectsInStableOrder(tx: Tx, input: Input): Promise<void>;
  checkLifecycleAndRevisions(tx: Tx, input: Input): Promise<void>;
  readPriorReceipt(tx: Tx, identity: RequestIdentity): Promise<Receipt | null>;
  writeFactsRequiredHistoryAndIntents(tx: Tx, input: Input): Promise<Output>;
  appendReceipt(tx: Tx, receipt: Receipt): Promise<void>;
}
// Durable advisory intent contains identifiers, not copied authority. Domain
// uniqueness and current subject/permission rechecks belong to its consumer.
export interface DurableIntent<Kind extends string, Subject> {
  readonly kind: Kind;
  readonly owner: Owner;
  readonly subject: Subject;
  readonly producerKey: z.infer<typeof requestKey>;
  readonly sourceRevision: Revision;
}

// Run inside the producer's existing transaction, after its live authority,
// lifecycle, replay and revision checks. Every required writer receives that same
// connection. An error propagates to the owner so its transaction rolls back.
// SQL transaction control, domain policy and provider calls remain outside this helper.
export interface RequiredWrites<Tx, Result> {
  facts(tx: Tx): Promise<Result>;
  history(tx: Tx, result: Result): Promise<void>;
  receipt(tx: Tx, result: Result): Promise<void>;
  intents(tx: Tx, result: Result): Promise<void>;
}
export async function writeRequiredConsequences<Tx, Result>(tx: Tx, writes: RequiredWrites<Tx, Result>): Promise<Result> {
  const result = await writes.facts(tx);
  await writes.history(tx, result);
  await writes.receipt(tx, result);
  await writes.intents(tx, result);
  return result;
}
