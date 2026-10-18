import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as C from "@everyfield/contracts/identity";

const id = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000001";
const plant = { kind: "plant", id };
const organization = { kind: "organization", id: other, organizationKind: "sending_church" };
const now = "2026-10-18T16:00:00.000Z";
const choices = { shareFoundations: true, shareMilestones: false };
const command = <T,>(input: T) => ({ requestKey: "invitation-1", expectedRevision: "2", input });
const wire = <T,>(schema: z.ZodType<T>, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(value)));
const refuses = (schema: z.ZodType, value: unknown) => assert.throws(() => wire(schema, value), z.ZodError);
const receipt = { id, request: { owner: plant, actorId: id, operation: "seats.acceptInvitation",
  requestKey: "invitation-1", digest: "a".repeat(64), origin: { kind: "native" } },
  completedAt: now, outcome: "changed", subjects: [{ kind: "invitation", id, owner: plant }],
  eventIds: [id], effectIds: [other] };

test("INV-invitations: shared invite commands bind exact tenant and ordinary role without accepting account resolution or authority", () => {
  for (const workspace of [plant, organization, { ...organization, organizationKind: "sending_network" }]) {
    const input = { workspace, recipientEmail: "  CASEY@Example.test ", role: "member" };
    assert.deepEqual(wire(C.inviteSeatRequest, command(input)), command({ ...input, recipientEmail: "casey@example.test" }));
    for (const role of ["owner", "lead_planter", "platform_admin"]) refuses(C.inviteSeatRequest, command({ ...input, role }));
    for (const extra of [{ accountId: id }, { accountExists: false }, { approved: true }, { actorId: id }]) {
      refuses(C.inviteSeatRequest, command({ ...input, ...extra }));
    }
  }
  const resident = command({ organization, personId: id, recipientEmail: "CASEY@Example.test" });
  assert.deepEqual(wire(C.inviteResidentRequest, resident), command({ ...resident.input, recipientEmail: "casey@example.test" }));
  refuses(C.inviteResidentRequest, command({ ...resident.input, organization: plant }));
  for (const schema of [C.resendInvitationRequest, C.revokeInvitationRequest]) {
    assert.deepEqual(wire(schema, command({ invitationId: id })), command({ invitationId: id }));
    refuses(schema, command({ invitationId: id, token: "caller-chosen" }));
  }
});

test("AC:ADR1-004 resident native response boundary separates explicit acceptance choices from decline and refuses caller-selected grants", () => {
  const accept = command({ invitationId: id, proof: "native-addressed-proof", decision: "accept", choices });
  assert.deepEqual(wire(C.respondResidentInvitationRequest, accept), accept);
  const decline = command({ invitationId: id, proof: "native-addressed-proof", decision: "decline" });
  assert.deepEqual(wire(C.respondResidentInvitationRequest, decline), decline);
  for (const input of [
    { ...accept.input, choices: { shareFoundations: true } },
    { ...accept.input, choices: undefined }, { ...accept.input, proof: undefined },
    { ...decline.input, choices }, { ...accept.input, accountId: id },
    { ...accept.input, role: "member" }, { ...accept.input, seatId: id },
    { ...accept.input, personId: other }, { ...accept.input, addressVerified: true },
  ]) refuses(C.respondResidentInvitationRequest, command(input));
  const seat = command({ invitationId: id, proof: "native-addressed-proof" });
  assert.deepEqual(wire(C.acceptSeatInvitationRequest, seat), seat);
  for (const extra of [{ role: "admin" }, { workspace: organization }, { accountId: id }, { personId: id }]) {
    refuses(C.acceptSeatInvitationRequest, command({ ...seat.input, ...extra }));
  }
});

test("INV-privacy: invitation descriptions and sender projections exclude account-existence, token, lookup and private pipeline fields", () => {
  const pending = { status: "pending", invitationId: id, subject: { purpose: "seat", workspace: plant, role: "admin" },
    revision: "2", inviterDescription: "Alex invited you to Grace Church", workspaceName: "Grace Church", expiresAt: now };
  assert.deepEqual(wire(C.invitationDescriptionResult, pending), pending);
  assert.deepEqual(wire(C.invitationDescriptionResult, { status: "unavailable" }), { status: "unavailable" });
  const row = { ...pending, recipientEmail: "casey@example.test", resendAvailableAt: now };
  const sent = { invitation: row, receipt: { ...receipt, request: { ...receipt.request, operation: "seats.invite" } } };
  assert.deepEqual(wire(C.invitationSentResult, sent), sent);
  const list = { workspace: plant, items: [row], next: null, completeness: "complete" };
  assert.deepEqual(wire(C.invitationListResult, list), list);
  refuses(C.invitationListResult, { ...list, workspace: organization });
  refuses(C.invitationSentResult, { ...sent, receipt: { ...sent.receipt, request: { ...sent.receipt.request, owner: organization }, subjects: [] } });
  for (const extra of [{ accountExists: true }, { acceptedAccountId: id }, { tokenHash: "a".repeat(64) },
    { proof: "private" }, { staffNotes: "private" }, { privateCare: "private" }]) {
    refuses(C.invitationDescriptionResult, { ...pending, ...extra });
    refuses(C.invitationListResult, { ...list, items: [{ ...row, ...extra }] });
  }
  for (const status of ["expired", "revoked", "accepted"]) refuses(C.invitationDescriptionResult, { ...pending, status });
  const error = { code: "invitation_unavailable", details: {}, correlationId: id, retry: "never" };
  assert.deepEqual(wire(C.invitationError, error), error);
  refuses(C.invitationError, { ...error, details: { accountExists: true } });
});

test("INV-atomic-acceptance: accepted seat result requires active registration, exact ordinary grant, plant Person, complete receipt and required intents", () => {
  const accepted = { status: "accepted", invitationId: id, accountId: id, registrationState: "active",
    seat: { kind: "plant", workspace: plant, seatId: other, role: "member", personId: id }, receipt };
  assert.deepEqual(wire(C.seatInvitationAcceptedResult, accepted), accepted);
  const orgReceipt = { ...receipt, request: { ...receipt.request, owner: organization }, subjects: [] };
  const org = { ...accepted, seat: { kind: "organization", workspace: organization, seatId: other, role: "admin" }, receipt: orgReceipt };
  assert.deepEqual(wire(C.seatInvitationAcceptedResult, org), org);
  for (const invalid of [
    { ...accepted, registrationState: "pending_domain" }, { ...accepted, accountId: other },
    { ...accepted, seat: { ...accepted.seat, role: "owner" } },
    { ...accepted, seat: { ...accepted.seat, personId: undefined } },
    { ...accepted, seat: { ...accepted.seat, workspace: organization } },
    { ...accepted, receipt: { ...receipt, outcome: "partial" } },
    { ...accepted, receipt: { ...receipt, eventIds: [] } },
    { ...accepted, receipt: { ...receipt, effectIds: [] } },
    { ...accepted, receipt: { ...receipt, request: { ...receipt.request, proof: "native-proof" } } },
    { ...accepted, deliveryStatus: "sent" },
  ]) refuses(C.seatInvitationAcceptedResult, invalid);
  const residentReceipt = { ...orgReceipt, request: { ...orgReceipt.request, operation: "residency.respondInvitation" }, effectIds: [] };
  const resident = { status: "accepted", invitationId: id, linkId: other, organization, personId: id,
    consentRevision: "1", choices, receipt: residentReceipt };
  assert.deepEqual(wire(C.residentInvitationDecisionResult, resident), resident);
  for (const extra of [{ seatId: id }, { registrationState: "active" }, { accountExists: true }]) {
    refuses(C.residentInvitationDecisionResult, { ...resident, ...extra });
  }
  const declined = { status: "declined", invitationId: id, receipt: residentReceipt };
  assert.deepEqual(wire(C.residentInvitationDecisionResult, declined), declined);
  refuses(C.residentInvitationDecisionResult, { ...declined, linkId: id });
});

test("INV-seat-authority: roster and role commands protect actual Owner and expose join provenance without login identifiers", () => {
  const change = command({ seatId: id, expectedRole: "member", to: "admin" });
  assert.deepEqual(wire(C.changeOrdinaryRoleRequest, change), change);
  assert.deepEqual(wire(C.appointAdminRequest, change), change);
  const demote = command({ seatId: id, expectedRole: "admin", to: "member" });
  assert.deepEqual(wire(C.demoteSeatRequest, demote), demote);
  for (const input of [{ ...change.input, expectedRole: "owner" }, { ...change.input, to: "owner" }]) {
    refuses(C.changeOrdinaryRoleRequest, command(input));
  }
  const roster = { workspace: plant, items: [{ seatId: id, displayName: "Alex", role: "owner", revision: "2",
    status: "active", isSelf: true, joined: { source: "original_account_fallback", at: now }, allowedActions: [] }],
    next: null, completeness: "complete" };
  assert.deepEqual(wire(C.seatListResult, roster), roster);
  refuses(C.seatListResult, { ...roster, items: [{ ...roster.items[0], allowedActions: ["remove"] }] });
  refuses(C.seatListResult, { ...roster, items: [{ ...roster.items[0], email: "alex@example.test" }] });
  assert.deepEqual(wire(C.seatJoinedProvenance, { source: "accepted_invitation", invitationId: id, at: now }), {
    source: "accepted_invitation", invitationId: id, at: now,
  });
  refuses(C.seatJoinedProvenance, { source: "accepted_invitation", at: now });
  const protectedOwner = { code: "protected_owner", details: {}, correlationId: id, retry: "never" };
  assert.deepEqual(wire(C.seatError, protectedOwner), protectedOwner);
  assert.deepEqual(wire(C.currentMembershipRequest, {}), {});
  refuses(C.currentMembershipRequest, { accountId: other });
  assert.deepEqual(wire(C.currentMembershipResult, { status: "active", workspace: plant, seatId: id, role: "member", revision: "2" }), {
    status: "active", workspace: plant, seatId: id, role: "member", revision: "2",
  });
});

test("INV-seat-duties: removal binds individual duty revisions and cannot report hidden remaining duties as complete", () => {
  const remove = command({ seatId: id, expectedRole: "admin", handoffs: [
    { kind: "assign", dutyId: id, expectedRevision: "4", recipientAccountId: other },
    { kind: "needs_owner", dutyId: other, expectedRevision: "3" },
  ] });
  assert.deepEqual(wire(C.removeSeatRequest, remove), remove);
  refuses(C.removeSeatRequest, command({ ...remove.input, handoffs: [remove.input.handoffs[0], remove.input.handoffs[0]] }));
  refuses(C.removeSeatRequest, command({ ...remove.input, expectedRole: "owner" }));
  const result = { seatId: id, revision: "3", outcome: "partial", duties: [
    { status: "moved", dutyId: id, recipientAccountId: other }, { status: "remaining", dutyId: other },
  ], receipt: { ...receipt, outcome: "partial" } };
  assert.deepEqual(wire(C.seatMutationResult, result), result);
  refuses(C.seatMutationResult, { ...result, outcome: "changed", receipt: { ...receipt, outcome: "changed" } });
  const complete = { ...result, outcome: "changed", duties: [
    { status: "moved", dutyId: id, recipientAccountId: other }, { status: "needs_owner", dutyId: other },
  ], receipt };
  assert.deepEqual(wire(C.seatMutationResult, complete), complete);
  refuses(C.seatMutationResult, { ...complete, receipt: { ...receipt, outcome: "partial" } });
});
