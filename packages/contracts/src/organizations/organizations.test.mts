import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as C from "@everyfield/contracts/organizations";

const id = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000001";
const plant = { kind: "plant", id };
const church = { kind: "organization", id: other, organizationKind: "sending_church" };
const network = { kind: "organization", id: "30000000-0000-4000-8000-000000000001", organizationKind: "sending_network" };
const pair = { kind: "plant", subject: plant, organization: church };
const choices = { people: false, meetings: true, tasks: false, ministry_teams: true, wiki: false, activity: false, shared_findings: true };
const command = <T,>(input: T) => ({ requestKey: "request-1", expectedRevision: "7", input });
const wire = <T,>(schema: z.ZodType<T>, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(value)));
const refuses = (schema: z.ZodType, value: unknown) => assert.throws(() => wire(schema, value), z.ZodError);

test("INV-tenancy: relationship requests admit exactly the five endpoint kinds and bind native commands without caller authority", () => {
  const pairs = [pair, { ...pair, organization: network },
    { kind: "sending_church", subject: church, organization: network },
    { kind: "discovery", accountId: id, organization: church },
    { kind: "discovery", accountId: id, organization: network }];
  for (const endpoints of pairs) {
    const input = command({ pair: endpoints, recipientEmail: "  Admin@Example.test  " });
    assert.deepEqual(wire(C.inviteRelationshipRequest, input), command({ pair: endpoints, recipientEmail: "admin@example.test" }));
    const end = command({ pair: endpoints, relationshipId: id, confirmed: true, reason: null });
    assert.deepEqual(wire(C.endRelationshipRequest, end), end);
    const history = { organization: endpoints.organization, pair: endpoints, after: id };
    assert.deepEqual(wire(C.relationshipHistoryRequest, history), history);
  }
  for (const invalid of [
    { kind: "sending_church", subject: network, organization: church },
    { kind: "sending_church", subject: church, organization: church },
    { kind: "sending_church", subject: network, organization: { ...network, id: other } },
    { kind: "sending_church", subject: church, organization: { ...network, id: church.id } },
    { ...pair, subject: { kind: "account", id } },
    { ...pair, organization: { ...church, id } },
    { ...pair, organization: plant }, { ...pair, organization: { kind: "organization", id } },
    { ...pair, subject: { ...plant, id: "00000000-0000-0000-0000-000000000000" } },
    { ...pair, organization: { kind: "global", id: "00000000-0000-0000-0000-000000000000" } },
  ]) refuses(C.relationshipPair, invalid);
  const input = command({ pair, recipientEmail: "admin@example.test" });
  for (const forged of [{ actorId: id }, { role: "owner" }, { approved: true }, { origin: "assistant" }, { parentNetworkId: id }]) {
    refuses(C.inviteRelationshipRequest, { ...input, ...forged });
    refuses(C.inviteRelationshipRequest, { ...input, input: { ...input.input, ...forged } });
  }
  refuses(C.endRelationshipRequest, command({ relationshipId: id, pair, confirmed: false, reason: null }));
  const response = command({ invitationId: id, proof: "original-address-proof", decision: "accept" });
  assert.deepEqual(wire(C.respondInvitationRequest, response), response);
  assert.deepEqual(wire(C.respondInvitationRequest, { ...response, input: { ...response.input, decision: "decline" } }), { ...response, input: { ...response.input, decision: "decline" } });
  refuses(C.respondInvitationRequest, command({ invitationId: id, decision: "accept" }));
  refuses(C.respondInvitationRequest, command({ invitationId: id, proof: "proof", decision: "approve_all" }));
  const revoke = command({ invitationId: id });
  assert.deepEqual(wire(C.invitationCommandRequest, revoke), revoke);
  for (const extra of [{ actorId: id }, { role: "owner" }, { approved: true }, { grants: [pair] }]) {
    refuses(C.invitationCommandRequest, command({ invitationId: id, ...extra }));
    refuses(C.respondInvitationRequest, { ...response, input: { ...response.input, ...extra } });
  }
});

test("AC:WP007-KNOW-112 exact-org sharing keeps the existing findings category, explicit defaults and bounded audience views", () => {
  for (const category of ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "shared_findings"]) {
    const input = command({ plant, organization: church, relationshipId: id, expectedConsentRevision: "4", category, enabled: false });
    assert.deepEqual(wire(C.setSharingRequest, input), input);
    for (const field of ["finance", "private_care", "launch_summary", "network_intelligence", "background_check", "coaching"]) {
      refuses(C.setSharingRequest, { ...input, input: { ...input.input, category: field } });
    }
  }
  const prior = { kind: "existing_consent", organization: church, consentRevision: "4", choices };
  assert.deepEqual(wire(C.sharingDisclosure, prior), prior);
  const allOn = { people: true, meetings: true, tasks: true, ministry_teams: true, wiki: true, activity: true, shared_findings: true };
  const allOff = { people: false, meetings: false, tasks: false, ministry_teams: false, wiki: false, activity: false, shared_findings: false };
  assert.deepEqual(wire(C.sharingDisclosure, { kind: "first_invitation", organization: church, choices: allOn }), { kind: "first_invitation", organization: church, choices: allOn });
  assert.deepEqual(wire(C.sharingDisclosure, { kind: "self_start", choices: allOff }), { kind: "self_start", choices: allOff });
  refuses(C.sharingDisclosure, { kind: "first_invitation", organization: church, choices });
  refuses(C.sharingDisclosure, { kind: "self_start", choices });
  const info = { plant, organization: church, organizationDisplayName: "Sending church", activeAffiliation: true };
  for (const view of [
    { view: "plant_administration", ...info, consentRevision: "4", choices },
    { view: "plant_member", ...info },
    { view: "organization", ...info, availability: choices },
  ]) assert.deepEqual(wire(C.sharingResult, view), view);
  refuses(C.sharingResult, { view: "plant_member", ...info, choices });
  refuses(C.sharingResult, { view: "organization", ...info, availability: choices, consentRevision: "4" });
  refuses(C.sharingResult, { view: "plant_administration", ...info, consentRevision: "4", choices: { ...choices, privateCare: true } });
  assert.deepEqual(wire(C.sharingResult, { status: "unavailable" }), { status: "unavailable" });
  refuses(C.sharingResult, { status: "unavailable", exists: true });
});

test("AC:WP007-MUL-003 resident boundary requires both explicit categories and fresh consent revision without private content", () => {
  for (const shareFoundations of [false, true]) for (const shareMilestones of [false, true]) {
    const input = command({ linkId: id, expectedConsentRevision: "9", choices: { shareFoundations, shareMilestones } });
    assert.deepEqual(wire(C.setResidencySharingRequest, input), input);
    refuses(C.setResidencySharingRequest, command({ ...input.input, choices: { shareFoundations } }));
    refuses(C.setResidencySharingRequest, command({ linkId: id, choices: input.input.choices }));
    const result = { status: "active", linkId: id, organization: church, consentRevision: "9", choices: input.input.choices };
    assert.deepEqual(wire(C.residencySharingResult, result), result);
    for (const field of ["privateDocuments", "privateCare", "stageReason", "staffNotes", "assessmentMetadata", "seat"]) {
      refuses(C.residencySharingResult, { ...result, [field]: "CANARY" });
    }
  }
  const leave = command({ linkId: id, expectedConsentRevision: "9" });
  assert.deepEqual(wire(C.leaveResidencyRequest, leave), leave);
  const ended = { status: "ended", linkId: id };
  assert.deepEqual(wire(C.residencySharingResult, ended), ended);
  refuses(C.residencySharingResult, { ...ended, choices: { shareFoundations: true, shareMilestones: true } });
});

test("AC:WP007-MUL-016 S0 eligibility exposes only its decision and minimum two contributors", () => {
  assert.deepEqual(wire(C.pipelineAggregateAccessRequest, { network }), { network });
  refuses(C.pipelineAggregateAccessRequest, { network: church });
  for (const allowed of [false, true]) {
    assert.deepEqual(wire(C.pipelineAggregateAccessResult, { allowed, minimumContributors: 2 }), { allowed, minimumContributors: 2 });
    refuses(C.pipelineAggregateAccessResult, { allowed, minimumContributors: 1 });
    for (const extra of [{ totals: 0 }, { contributors: [id] }, { candidates: [] }, { notes: "CANARY" }, { activeResidents: 4 }]) {
      refuses(C.pipelineAggregateAccessResult, { allowed, minimumContributors: 2, ...extra });
      refuses(C.pipelineAggregateAccessRequest, { network, ...extra });
    }
  }
  for (const sharePipelineTotals of [false, true]) {
    const input = command({ relationshipId: id, sharePipelineTotals });
    assert.deepEqual(wire(C.setPipelineConsentRequest, input), input);
    const result = { status: "available", relationshipId: id, revision: "3", sharePipelineTotals, minimumContributors: 2 };
    assert.deepEqual(wire(C.pipelineConsentResult, result), result);
  }
});

test("INV-privacy: profile and reporting-location inputs cannot change identity or carry street, authority or inferred geography", () => {
  const input = command({ organization: church, patch: { name: "  Church  ", city: null } });
  assert.deepEqual(wire(C.updateOrganizationProfileRequest, input), command({ organization: church, patch: { name: "Church", city: null } }));
  for (const patch of [{}, { name: "  " }, { kind: "sending_network" }, { id }, { billing: true }, { ownershipTransfer: id }, { contact: { arbitrary: "value" } }]) {
    refuses(C.updateOrganizationProfileRequest, command({ organization: church, patch }));
  }
  refuses(C.updateOrganizationProfileRequest, command({ organization: plant, patch: { name: "X" } }));
  const location = command({ plant, locality: { city: null, stateProvince: "IL", country: "US" }, referenceVersionId: id, regionItemId: null });
  assert.deepEqual(wire(C.correctReportingLocationRequest, location), location);
  for (const extra of [{ street: "PRIVATE" }, { coordinates: [1, 2] }, { phase: "Phase2" }, { effectiveAt: "2026-01-01T00:00:00Z" }]) {
    refuses(C.correctReportingLocationRequest, { ...location, input: { ...location.input, ...extra } });
  }
});

test("INV-privacy: coarse notices and oversight lines omit restricted toggles, names, bodies and private history", () => {
  const notice = { eventId: id, relationshipId: other, kind: "sharing_changed" };
  assert.deepEqual(wire(C.relationshipNotice, notice), notice);
  const line = { date: "2026-10-18", activity: "meetings", count: 3 };
  assert.deepEqual(wire(C.oversightActivityLine, line), line);
  for (const extra of [{ category: "people" }, { enabled: false }, { name: "Casey" }, { body: "CANARY" }, { privateCareCount: 1 }, { giving: 5 }]) {
    refuses(C.relationshipNotice, { ...notice, ...extra });
    refuses(C.oversightActivityLine, { ...line, ...extra });
  }
  const history = { status: "available", scope: { plant }, activeRelationships: [], items: [{ id, pair, event: "ended", reason: { status: "withheld" }, occurredAt: "2026-10-18T12:00:00.000Z",
    recordedAt: "2026-10-18T12:00:00.000Z", actor: { kind: "deleted_account", token: "scope-local-token" }, sourceInvitationId: null }], next: null, completeness: "partial" };
  assert.deepEqual(wire(C.relationshipHistoryResult, history), history);
  refuses(C.relationshipHistoryResult, { ...history, items: [{ ...history.items[0], reason: "PRIVATE" }] });
  refuses(C.relationshipHistoryResult, { ...history, items: [{ ...history.items[0], privateCare: "PRIVATE" }] });
});

test("INV-privacy: committed invitation results carry safe C0 receipts and no proof or delivery claim", () => {
  const receipt = { id, request: { owner: plant, actorId: id, operation: "associations.invite", requestKey: "request-1",
    digest: "a".repeat(64), origin: { kind: "native" } }, completedAt: "2026-10-18T12:00:00.000Z",
    outcome: "changed", subjects: [], eventIds: [], effectIds: [] };
  const pending = { status: "pending", invitationId: id, pair, revision: "7", expiresAt: "2026-11-17T12:00:00.000Z",
    inviterDescription: "Plant P invited this sending church", receipt };
  assert.deepEqual(wire(C.invitationResult, pending), pending);
  for (const extra of [{ proof: "SECRET" }, { delivered: true }, { recipientEmail: "admin@example.test" }]) refuses(C.invitationResult, { ...pending, ...extra });
  const committed = { status: "committed", receipt };
  assert.deepEqual(wire(C.mutationResult, committed), committed);
  const relationship = { id, pair, revision: "7", acceptedAt: "2026-10-18T12:00:00.000Z", endedAt: null };
  assert.deepEqual(wire(C.invitationDecisionResult, { status: "accepted", relationship, receipt }), { status: "accepted", relationship, receipt });
  const declined = { status: "declined", invitationId: id, receipt };
  assert.deepEqual(wire(C.invitationDecisionResult, declined), declined);
  assert.deepEqual(wire(C.declinedInvitationResult, declined), declined);
  refuses(C.acceptedInvitationResult, declined);
  assert.deepEqual(wire(C.acceptedInvitationResult, { status: "accepted", relationship, receipt }), { status: "accepted", relationship, receipt });
  refuses(C.declinedInvitationResult, { status: "accepted", relationship, receipt });
  refuses(C.relationshipProjection, { ...relationship, endedAt: "2026-10-17T12:00:00.000Z" });
  const profile = { status: "available", organization: church, revision: "7", timeZone: "UTC", profile: {
    name: "Church", city: null, stateProvince: null, country: null, description: null, contactEmail: null, contactPhone: null } };
  assert.deepEqual(wire(C.organizationProfileResult, profile), profile);
  refuses(C.organizationProfileResult, { ...profile, organization: plant });
  refuses(C.organizationProfileResult, { ...profile, profile: { ...profile.profile, billing: true } });
});

test("INV-relationships: subject and organization history reads keep independent active pairs and recorded end reasons", () => {
  const otherPair = { ...pair, organization: network };
  const filter = { plant, pair, after: id };
  assert.deepEqual(wire(C.relationshipHistoryRequest, { plant }), { plant });
  assert.deepEqual(wire(C.relationshipHistoryRequest, filter), filter);
  const sendingPair = { kind: "sending_church", subject: church, organization: network };
  for (const scope of [{ organization: church }, { organization: network }, { sendingChurch: church }]) {
    const query = { ...scope, pair: sendingPair };
    assert.deepEqual(wire(C.relationshipHistoryRequest, query), query);
  }
  const discoveryPair = { kind: "discovery", accountId: id, organization: church };
  assert.deepEqual(wire(C.relationshipHistoryRequest, { discoveryAccountId: id, pair: discoveryPair }), { discoveryAccountId: id, pair: discoveryPair });
  for (const query of [{}, { pair }, { plant, organization: church },
    { plant: { ...plant, id: other }, pair }, { sendingChurch: network },
    { organization: { ...church, id }, pair }, { discoveryAccountId: other, pair: discoveryPair }]) refuses(C.relationshipHistoryRequest, query);
  const active = { id, pair, revision: "7", acceptedAt: "2026-10-18T12:00:00.000Z", endedAt: null };
  const event = { id, pair, event: "ended", reason: { status: "available", value: "Partnership concluded" },
    occurredAt: "2026-10-18T12:00:00.000Z", recordedAt: "2026-10-18T12:00:00.000Z",
    actor: { kind: "account", accountId: id }, sourceInvitationId: null };
  const result = { status: "available", scope: { plant }, activeRelationships: [active, { ...active, id: other, pair: otherPair }],
    items: [event, { ...event, id: other, pair: otherPair, reason: { status: "withheld" } }], next: null, completeness: "complete" };
  assert.deepEqual(wire(C.relationshipHistoryResult, result), result);
  assert.deepEqual(wire(C.relationshipHistoryResult, { ...result, activeRelationships: [] }), { ...result, activeRelationships: [] });
  refuses(C.relationshipHistoryResult, { ...result, activeRelationships: [{ ...active, endedAt: active.acceptedAt }] });
  const foreignPlantPair = { ...pair, subject: { ...plant, id: "40000000-0000-4000-8000-000000000001" } };
  assert.deepEqual(wire(C.relationshipPair, foreignPlantPair), foreignPlantPair);
  refuses(C.relationshipHistoryResult, { ...result, activeRelationships: [{ ...active, pair: foreignPlantPair }] });
  refuses(C.relationshipHistoryResult, { ...result, items: [{ ...event, pair: foreignPlantPair }] });
  refuses(C.relationshipHistoryResult, { ...result, items: [{ ...event, reason: { status: "withheld", value: "PRIVATE" } }] });
  const accept = command({ invitationId: id, proof: "original-address-proof", decision: "accept" });
  assert.deepEqual(wire(C.acceptInvitationRequest, accept), accept);
  refuses(C.acceptInvitationRequest, command({ invitationId: id, decision: "accept" }));
  refuses(C.acceptInvitationRequest, { ...accept, input: { ...accept.input, decision: "decline" } });
});
