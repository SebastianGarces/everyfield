import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  currentActorRequest, currentActorResult, independentGrant, operationCheckResult,
  organizationNotesRequest, organizationNotesResult, organizationPersonRequest,
  ownResidencyProjection, pipelineAccessResult, sharedOperationCheckRequest,
} from "@everyfield/contracts/access";
import { sameOwner, owner } from "@everyfield/contracts/common";

const accountId = "10000000-0000-4000-8000-000000000001";
const otherAccount = "10000000-0000-4000-8000-000000000002";
const id = "20000000-0000-4000-8000-000000000001";
const personId = "30000000-0000-4000-8000-000000000001";
const plant = { kind: "plant", id };
const organization = { kind: "organization", id, organizationKind: "sending_church" };
const wire = <T,>(schema: z.ZodType<T>, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(value)));

test("AC:WP006-IDN-029 current actor boundary admits one typed context without caller authority or title elevation", () => {
  assert.deepEqual(wire(currentActorRequest, {}), {});
  for (const body of [{ actorId: accountId }, { role: "owner" }, { selected: plant }, { session: "forged" }, { grants: [] }]) {
    assert.throws(() => wire(currentActorRequest, body), z.ZodError);
  }
  for (const tenant of [plant, organization, { ...organization, organizationKind: "sending_network" }]) {
    for (const role of ["owner", "admin", "member"]) {
      const result = { status: "active", accountId, context: { kind: "seat", owner: tenant, seatId: id, role, revision: "9" } };
      assert.deepEqual(wire(currentActorResult, result), result);
      for (const extra of [{ leadPlanter: true }, { inheritedRole: "owner" }, { coachId: id }, { platformAdmin: true }, { contexts: [result.context] }]) {
        assert.throws(() => wire(currentActorResult, { ...result, ...extra }), z.ZodError);
      }
    }
  }
  const self = { status: "active", accountId, context: { kind: "account", owner: { kind: "account", id: accountId } } };
  assert.deepEqual(wire(currentActorResult, self), self);
  assert.throws(() => wire(currentActorResult, { ...self, accountId: otherAccount }), z.ZodError);
  const seat = { kind: "seat", owner: organization, seatId: id, role: "admin", revision: "9" };
  for (const invalid of [
    { status: "active", accountId, context: [seat, seat] },
    { status: "active", accountId, context: { ...seat, owner: { kind: "organization", id } } },
    { status: "active", accountId, context: { ...seat, owner: { ...plant, id: "00000000-0000-0000-0000-000000000000" } } },
    { status: "active", accountId, context: { ...seat, role: "coach" } },
    { status: "pending_domain", accountId, context: seat },
    { status: "unavailable", accountId },
  ]) assert.throws(() => wire(currentActorResult, invalid), z.ZodError);
  assert.deepEqual(wire(currentActorResult, { status: "pending_domain", accountId }), { status: "pending_domain", accountId });
  assert.deepEqual(wire(currentActorResult, { status: "unavailable" }), { status: "unavailable" });
});

test("AC:WP006-KNOW-116 shared write input is adapter-neutral, revision-bound and refuses claimed approval", () => {
  const subject = { kind: "plant", id, owner: plant };
  for (const operation of ["launch.addGuestAttendance", "launch.correctDebrief", "launch.publishDebriefSummary"]) {
    const input = { kind: "write", operation, subject, expectedRevision: "9223372036854775807" };
    assert.deepEqual(wire(sharedOperationCheckRequest, input), input);
    assert.throws(() => wire(sharedOperationCheckRequest, { kind: "write", operation, subject }), z.ZodError);
    for (const extra of [{ expectedRevision: 1 }, { role: "owner" }, { actorId: accountId }, { approved: true }, { reviewId: id }, { origin: "assistant" }]) {
      assert.throws(() => wire(sharedOperationCheckRequest, { ...input, ...extra }), z.ZodError);
    }
  }
  const read = { kind: "read", operation: "people.getPerson", subject: { kind: "person", id: personId, owner: plant }, purpose: "native" };
  assert.deepEqual(wire(sharedOperationCheckRequest, read), read);
  for (const operation of ["coaches.readAssignments", "privateCare.readCurrent"]) {
    assert.throws(() => wire(sharedOperationCheckRequest, { ...read, operation }), z.ZodError);
  }
  assert.deepEqual(wire(operationCheckResult, { status: "allowed" }), { status: "allowed" });
  assert.deepEqual(wire(operationCheckResult, { status: "unavailable" }), { status: "unavailable" });
  for (const extra of [{ exists: true }, { reason: "foreign_person" }, { subject }, { privateCareCount: 1 }]) {
    assert.throws(() => wire(operationCheckResult, { status: "unavailable", ...extra }), z.ZodError);
  }
});

test("AC:WP006-MUL-002 general pipeline, resident and protected-note wire results remain separate", () => {
  assert.deepEqual(wire(organizationPersonRequest, { personId }), { personId });
  assert.deepEqual(wire(organizationNotesRequest, { personId, after: id }), { personId, after: id });
  assert.throws(() => wire(organizationPersonRequest, { personId, duty: "responsible_staff" }), z.ZodError);
  const director = { kind: "program_director", canReadStaffNotes: false };
  const staff = { kind: "responsible_staff", canReadStaffNotes: true };
  const base = { status: "allowed", organization, personId, duties: [director] };
  assert.deepEqual(wire(pipelineAccessResult, base), base);
  assert.deepEqual(wire(pipelineAccessResult, { ...base, duties: [staff, director] }), { ...base, duties: [staff, director] });
  assert.deepEqual(wire(pipelineAccessResult, { ...base, duties: [{ kind: "organization_administration", canReadStaffNotes: true }] }), { ...base, duties: [{ kind: "organization_administration", canReadStaffNotes: true }] });
  for (const duties of [[], [director, director], [{ ...director, canReadStaffNotes: true }], [{ kind: "resident", canReadStaffNotes: false }]]) {
    assert.throws(() => wire(pipelineAccessResult, { ...base, duties }), z.ZodError);
  }
  const resident = { organization, personId, linkId: id, revision: "2" };
  assert.deepEqual(wire(ownResidencyProjection, resident), resident);
  for (const field of ["stage", "reason", "notes", "assessmentMetadata", "inactive", "privateCare", "privateCareCount", "credentials", "directory", "canEditPlant"]) {
    assert.throws(() => wire(ownResidencyProjection, { ...resident, [field]: "CANARY" }), z.ZodError);
    assert.throws(() => wire(pipelineAccessResult, { ...base, [field]: "CANARY" }), z.ZodError);
  }
  const notes = { status: "allowed", purpose: "native_org_person_notes", organization, personId, duty: "responsible_staff",
    notes: [{ id, authorAccountId: accountId, body: "Protected staff conversation", occurredAt: "2026-10-17T12:00:00.000Z", revision: "2" }], next: null };
  assert.deepEqual(wire(organizationNotesResult, notes), notes);
  assert.deepEqual(wire(organizationNotesResult, { ...notes, duty: "organization_administration" }), { ...notes, duty: "organization_administration" });
  for (const change of [{ duty: "program_director" }, { purpose: "model" }, { organization: plant }, { feedback: "PRIVATE" }, { privateCare: "PRIVATE" }]) {
    assert.throws(() => wire(organizationNotesResult, { ...notes, ...change }), z.ZodError);
  }
  assert.deepEqual(wire(organizationNotesResult, { status: "unavailable" }), { status: "unavailable" });
  assert.throws(() => wire(organizationNotesResult, { status: "unavailable", notes: [] }), z.ZodError);
});

test("INV-tenancy: independent grant boundaries retain exact endpoints and closed capabilities without inherited authority", () => {
  const episode = { id, revision: "7", acceptedAt: "2026-10-17T12:00:00.000Z" };
  const sharing = { people: false, meetings: true, tasks: false, ministry: false, wiki: true, activity: false, findings: false };
  const affiliation = { kind: "plant_affiliation", ...episode, plant, organization, sharing };
  assert.deepEqual(wire(independentGrant, affiliation), affiliation);
  const otherOrg = { ...organization, id: otherAccount, organizationKind: "sending_network" };
  const independent = wire(independentGrant, { ...affiliation, organization: otherOrg, sharing: { ...sharing, findings: true } });
  assert.equal(sameOwner(owner.parse(organization), owner.parse(otherOrg)), false);
  const typedNetwork = wire(independentGrant, { ...affiliation, organization: { ...organization, organizationKind: "sending_network" } });
  assert.equal(typedNetwork.kind, "plant_affiliation");
  if (typedNetwork.kind !== "plant_affiliation") throw new Error("Expected affiliation");
  assert.equal(sameOwner(owner.parse(organization), typedNetwork.organization), false);
  assert.deepEqual(independent, { ...affiliation, organization: otherOrg, sharing: { ...sharing, findings: true } });
  for (const grant of [
    { kind: "discovery_relationship", ...episode, accountId, organization },
    { kind: "residency_link", ...episode, accountId, organization, personId, consentRevision: "3", shareFoundations: false, shareMilestones: true },
    { kind: "platform", id, revision: "7", accountId, capability: "reference_publish", expiresAt: null },
  ]) assert.deepEqual(wire(independentGrant, grant), grant);
  for (const change of [
    { role: "owner" }, { inheritedFrom: id }, { kind: "coach" }, { endedAt: episode.acceptedAt },
    { organization: plant }, { plant: organization }, { sharing: { ...sharing, privateCare: true } },
    { organization: { ...organization, id: "00000000-0000-0000-0000-000000000000" } },
    { organization: { kind: "global", id: "00000000-0000-0000-0000-000000000000" } },
    { sharing: { findings: true } },
  ]) assert.throws(() => wire(independentGrant, { ...affiliation, ...change }), z.ZodError);
  assert.throws(() => wire(independentGrant, { kind: "platform", id, revision: "7", accountId, capability: "*", expiresAt: null }), z.ZodError);
});
