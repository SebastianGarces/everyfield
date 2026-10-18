import type { z } from "zod";
import type { accountId, sessionId, Owner } from "../common/values.ts";
import type * as request from "./requests.ts";
import type * as result from "./results.ts";
import type { OrganizationExport, RemovalResult } from "./removal.ts";
import type { commandOrigin } from "../common/transaction.ts";
import type { lockedPersonReference } from "./references.ts";

// Server-only producer interface. Each invocation reads the real session,
// account, exact current seat/duty, purpose, lifecycle and consent inside Tx.
// Missing/foreign/inaccessible subjects use the same non-revealing refusal.
// Queries validate every predicate before querying/counting, search metacharacters
// literally, and bind opaque cursors to exact owner/query plus timestamp + ID.
// Changed filters reset cursors. Totals describe full authorized queries, not pages.
// Note edits lock exact Person/note/kind/original author, never a caller-sent author.
// Handoff review must account for every current actionable duty; omissions conflict.
// Mutations lock/CAS, then write facts + history + receipt + required intents
// atomically. Native and reviewed Evry share this implementation, not cached
// authority. General reads never imply private intake or organization notes.
export type PeopleContext = { session: z.infer<typeof sessionId>; selected: Owner;
  purpose: "native" | "model" | "export" };
// Origin is built by the trusted native/review adapter, never parsed from an
// action body. Assistant review binds exact initiator/owner/effects/revisions;
// the producer rechecks approval and current authority at execution.
type Origin = z.infer<typeof commandOrigin>;
export type PeopleWriteContext = Omit<PeopleContext, "purpose"> & (
  { purpose: "native"; origin: Extract<Origin, { kind: "native" }> } |
  { purpose: "model"; origin: Extract<Origin, { kind: "assistant" }> }
);
export type PeopleReply<T> = { status: "ok"; value: T } |
  { status: "refused"; error: z.infer<typeof result.peopleError> };
export interface PeopleReader<Tx> {
  getPipelineData(tx: Tx, context: PeopleContext, input: z.infer<typeof request.listPeopleRequest>): Promise<PeopleReply<z.infer<typeof result.pipelineResult>>>;
  getStatusWarnings(tx: Tx, context: PeopleContext, input: z.infer<typeof request.personRequest>): Promise<PeopleReply<z.infer<typeof result.statusWarningsResult>>>;
  getPerson(tx: Tx, context: PeopleContext, input: z.infer<typeof request.personRequest>): Promise<PeopleReply<z.infer<typeof result.personResult>>>;
  listPeople(tx: Tx, context: PeopleContext, input: z.infer<typeof request.listPeopleRequest>): Promise<PeopleReply<z.infer<typeof result.peoplePage>>>;
  getActivities(tx: Tx, context: PeopleContext, input: z.infer<typeof request.activityRequest>): Promise<PeopleReply<z.infer<typeof result.activitiesResult>>>;
  getOwnAccountPerson(tx: Tx, context: PeopleContext, input: z.infer<typeof request.ownAccountPersonRequest>): Promise<PeopleReply<z.infer<typeof result.accountLinkResult>>>;
  readPipelineMetrics(tx: Tx, context: PeopleContext & { purpose: "native" }, input: z.infer<typeof request.pipelineMetricsRequest>): Promise<PeopleReply<z.infer<typeof result.pipelineMetricsResult>>>;
}
export interface PeopleWriter<Tx> {
  addNote(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.addNoteRequest>): Promise<PeopleReply<z.infer<typeof result.noteMutationResult>>>;
  editNote(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.editNoteRequest>): Promise<PeopleReply<z.infer<typeof result.noteMutationResult>>>;
  deleteNote(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.deleteNoteRequest>): Promise<PeopleReply<z.infer<typeof result.noteMutationResult>>>;
  recordAdultClassification(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.classifyAdultRequest>): Promise<PeopleReply<z.infer<typeof result.classificationMutationResult>>>;
  correctAdultClassification(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.classifyAdultRequest>): Promise<PeopleReply<z.infer<typeof result.classificationMutationResult>>>;
  reorderPipeline(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.reorderPipelineRequest>): Promise<PeopleReply<{ receiptId: z.infer<typeof import("../common/values.ts").operationId>; outcome: "changed" | "noop" }>>;

  createPerson(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.createPersonRequest>): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
  updatePerson(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.updatePersonRequest>): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
  changeStatus(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.changeStatusRequest>): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
  retirePerson(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.retirePersonRequest>): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
  restorePerson(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.restorePersonRequest>): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
}
// Internal collaborators only: no transport/model-selected account or plant.
// Caller is the authenticated provisioning/seat/attendance transaction. It locks
// the account/owner and validates eligibility. Exact prior link wins; ambiguous
// email requires reviewed explicit selection. A unique live account/plant link
// arbitrates concurrent attempts. Bootstrap is no adult/commitment evidence.
export interface AccountPersonProducer<Tx> {
  ensureAccountPerson(tx: Tx, input: { accountId: z.infer<typeof accountId>;
    owner: z.infer<typeof import("./values.ts").plantOwner>;
    selection: { kind: "resolve" } | { kind: "reviewed_contact"; person: z.infer<typeof lockedPersonReference> } |
      { kind: "create"; displayName: string } }): Promise<PeopleReply<z.infer<typeof result.accountPersonResolution>>>;
  ensureGuest(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.guestSelection>): Promise<PeopleReply<z.infer<typeof lockedPersonReference>>>;
}
export interface OrganizationPeopleProducer<Tx> {
  read(tx: Tx, context: PeopleContext, input: z.infer<typeof request.personRequest>): Promise<PeopleReply<z.infer<typeof result.organizationPerson>>>;
  retire(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.retirePersonRequest>): Promise<PeopleReply<z.infer<typeof result.organizationPersonMutationResult>>>;
  restore(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.restorePersonRequest>): Promise<PeopleReply<z.infer<typeof result.organizationPersonMutationResult>>>;

  create(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.createOrganizationPersonRequest>): Promise<PeopleReply<z.infer<typeof result.organizationPersonMutationResult>>>;
  update(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.updateOrganizationPersonRequest>): Promise<PeopleReply<z.infer<typeof result.organizationPersonMutationResult>>>;
  // Production AND download recheck exact Owner/Admin, source and consent.
  export(tx: Tx, context: PeopleContext & { purpose: "native" | "export" }, input: z.infer<typeof request.exportOrganizationPersonRequest>): Promise<PeopleReply<OrganizationExport>>;
  // Revoke links/source access and purge unneeded bodies. Retain only independently
  // needed org facts with scope-local attribution; reapply witness before recovery.
  // Retirement is separate. No account 30-day hold or new retention period.
  remove(tx: Tx, context: PeopleWriteContext, input: z.infer<typeof request.removeOrganizationPersonRequest>): Promise<PeopleReply<RemovalResult>>;
}
