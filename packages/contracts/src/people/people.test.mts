import assert from "node:assert/strict";
import test from "node:test";
import * as people from "./index.ts";

const P = "10000000-0000-4000-8000-000000000001";
const Q = "10000000-0000-4000-8000-000000000002";
const R = "10000000-0000-4000-8000-000000000003";
const owner = { kind: "plant", id: P };
const organization = { kind: "organization", id: P, organizationKind: "sending_church" };
const now = "2026-10-18T13:00:00.000Z";
const command = { requestKey: "people-1", expectedRevision: "4" };
const identity = { id: Q, revision: "4", createdAt: now, displayName: "Jamie", lifecycle: { state: "live" } };
const profile = { ...identity, owner, stage: "leader", source: "other", sourceDetails: null,
  summaryNotes: null, adultClassification: "unknown", birthDate: null, commitment: { state: "unknown" } };
function roundTrip<T>(schema: { parse(input: unknown): T }, input: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(input)));
}

test("AC:WP011-KNOW-098 AC:WP011-KNOW-099 named guest and explicit existing selection cross a closed boundary", () => {
  assert.deepEqual(roundTrip(people.guestSelection, { kind: "new", displayName: "  Jamie  " }),
    { kind: "new", displayName: "Jamie" });
  assert.deepEqual(roundTrip(people.guestSelection, { kind: "existing", personId: Q }),
    { kind: "existing", personId: Q });
  const created = roundTrip(people.createPersonRequest, { requestKey: "guest-1", input: { displayName: " Jamie " } });
  assert.deepEqual(created, { requestKey: "guest-1", input: { displayName: "Jamie", stage: "prospect", source: "other", adultClassification: "unknown" } });
  for (const extra of [{ accountId: P }, { firstName: "made up" }, { commitment: "active" }, { personId: Q }]) {
    assert.equal(people.guestSelection.safeParse({ kind: "new", displayName: "Jamie", ...extra }).success, false);
  }
  assert.equal(people.guestSelection.safeParse({ kind: "existing", displayName: "Jamie" }).success, false);
});

test("INV-person-write: explicit clears survive while profile edits cannot forge authority or change stage", () => {
  assert.deepEqual(roundTrip(people.updatePersonRequest, { ...command, input: { personId: Q,
    patch: { email: null, street: null, city: " Chicago " } } }),
  { ...command, input: { personId: Q, patch: { email: null, street: null, city: "Chicago" } } });
  assert.deepEqual(roundTrip(people.createPersonRequest, { requestKey: "new", input: { displayName: " J ", email: " j@example.test " } }).input.email, "j@example.test");
  for (const patch of [{ accountId: P }, { owner }, { creator: P }, { revision: "5" },
    { storageKey: "synthetic-object" }, { backgroundCheck: "passed" }, { stage: "leader" },
    { adultClassification: "adult" }, { commitment: { state: "unknown" } }]) {
    assert.equal(people.updatePersonRequest.safeParse({ ...command, input: { personId: Q, patch } }).success, false, JSON.stringify(patch));
  }
  assert.equal(people.createPersonRequest.safeParse({ requestKey: "blank", input: { displayName: "   " } }).success, false);
});

test("AC:WP011-MUL-001 organization identity preserves C0 owners and excludes plant facts and restored authority", () => {
  for (const organizationKind of ["sending_church", "sending_network"]) {
    const row = { ...identity, owner: { ...organization, organizationKind } };
    assert.deepEqual(roundTrip(people.organizationPerson, row), row);
    for (const extra of [{ stage: "leader" }, { householdId: R }, { commitment: { state: "active" } },
      { adultClassification: "adult" }, { staffNotes: "protected" }, { seatId: R }, { consent: true }]) {
      assert.equal(people.organizationPerson.safeParse({ ...row, ...extra }).success, false);
      assert.equal(people.createOrganizationPersonRequest.safeParse({ requestKey: "org", input: { displayName: "Jamie", ...extra } }).success, false);
    }
  }
  for (const badOwner of [{ kind: "account", id: P }, { kind: "global", id: "00000000-0000-0000-0000-000000000000" },
    { ...organization, id: "00000000-0000-0000-0000-000000000000" }, { kind: "organization", id: P }]) {
    assert.equal(people.organizationPerson.safeParse({ ...identity, owner: badOwner }).success, false);
  }
  assert.equal(people.ordinaryRestoreDecision(people.personLifecycle.parse({ state: "retired", retiredAt: now })), "restore");
  assert.equal(people.ordinaryRestoreDecision(people.personLifecycle.parse({ state: "merged", retiredAt: now, survivorId: R })), "use_reviewed_unmerge");
  assert.equal(people.ordinaryRestoreDecision(people.personLifecycle.parse({ state: "live" })), "noop");
});

test("AC:WP011-KNOW-069 retained Person attribution belongs to a tenant, independently of its creator", () => {
  const retained = { owner: organization, personId: Q, receiptId: R,
    attribution: { kind: "former_account", scopeLocalToken: "local-opaque-1" } };
  assert.deepEqual(roundTrip(people.retainedPersonHistory, retained), retained);
  for (const extra of [{ creatorId: P }, { privateCare: "secret" }, { email: "former@example.test" }, { documentBody: "secret" }]) {
    assert.equal(people.retainedPersonHistory.safeParse({ ...retained, ...extra }).success, false);
  }
  assert.equal(people.retainedPersonHistory.safeParse({ ...retained, owner: { kind: "account", id: P } }).success, false);
  assert.deepEqual(roundTrip(people.accountLinkResult, { status: "linked", personId: Q }), { status: "linked", personId: Q });
  assert.equal(people.accountLinkResult.safeParse({ status: "linked", personId: Q, accountId: R }).success, false);
});

test("AC:WP011-MUL-005 removal and export exclude protected bodies and cancellation deadlines", () => {
  const exported = { organization, personId: Q, sourceRevision: "4", consentRevision: null, producedAt: now,
    contact: { displayName: "Jamie", email: "j@example.test" }, stageHistory: [], programs: [], completions: [] };
  assert.deepEqual(roundTrip(people.organizationExport, exported), exported);
  for (const extra of [{ staffNotes: "secret" }, { feedback: "secret" }, { reasons: "secret" },
    { privateDocuments: [R] }, { foundationProgress: true }, { signedUrl: "https://example.test/private" }]) {
    assert.equal(people.organizationExport.safeParse({ ...exported, ...extra }).success, false);
  }
  const removed = { witness: { organization, personRecordId: Q, removedAt: now, revision: "5", checkpoint: "1" },
    receiptId: R, retained: [{ category: "program_completion", reason: "independent_organization_fact", attribution: "scope_local" }] };
  assert.deepEqual(roundTrip(people.removalResult, removed), removed);
  assert.equal(people.removalResult.safeParse({ ...removed, cancelUntil: "2026-11-17T13:00:00Z" }).success, false);
  assert.equal(people.removalResult.safeParse({ ...removed, retained: [{ category: "program_completion", attribution: "scope_local" }] }).success, false);
  assert.equal(people.removalResult.safeParse({ ...removed, witness: { ...removed.witness, contactBody: "secret" } }).success, false);
  for (const field of ["revision", "checkpoint"]) {
    assert.equal(people.removalWitness.safeParse({ ...removed.witness, [field]: "0" }).success, false);
  }
});

test("INV-person-read: directory, timeline and cursors expose only the allowed operational projection", () => {
  assert.deepEqual(roundTrip(people.listPeopleRequest, { search: "%/_", tags: [Q, R] }), {
    limit: 24, search: "%/_", view: "list", stages: [], sources: [], tags: [Q, R], tagOperator: "all",
    commitment: "any", archived: "exclude", sort: "created_at_id" });
  for (const query of [{ limit: 101 }, { limit: 0 }, { tagOperator: "any" }, { interviewExists: true },
    { sort: "assessment_rating" }, { privateCareExists: false }, { owner: organization }]) {
    assert.equal(people.listPeopleRequest.safeParse(query).success, false);
  }
  assert.deepEqual(roundTrip(people.peoplePage, { owner, items: [profile], next: "opaque", completeness: "partial", total: null }).items[0], profile);
  assert.equal(people.peoplePage.safeParse({ owner: { kind: "plant", id: R }, items: [profile], next: null, completeness: "complete", total: 1 }).success, false);
  assert.equal(people.plantPerson.safeParse({ ...profile, adultClassification: null }).success, false);
  assert.equal(people.plantPerson.safeParse({ ...profile, lifecycle: { state: "merged", retiredAt: now, survivorId: Q } }).success, false);
  const leaderCard = { person: profile, activeParentDuties: [], coverage: "uncovered" };
  const pipeline = { owner, groups: ["prospect", "attendee", "following_up", "interviewed", "core_group"].map(column =>
    ({ column, revision: "1", cards: column === "core_group" ? [leaderCard] : [], total: null, next: null })), completeness: "complete" };
  assert.deepEqual(roundTrip(people.pipelineResult, pipeline), pipeline);
  const wrongColumn = { ...pipeline, groups: pipeline.groups.map(g =>
    ({ ...g, cards: g.column === "prospect" ? [leaderCard] : [] })) };
  assert.equal(people.pipelineResult.safeParse(wrongColumn).success, false);
  assert.deepEqual(roundTrip(people.activityRequest, { personId: Q, limit: 2, kinds: ["note", "follow_up"] }),
    { personId: Q, limit: 2, kinds: ["note", "follow_up"] });
  for (const kind of ["assessment", "interview", "commitment", "private_care"]) {
    assert.equal(people.activityRequest.safeParse({ personId: Q, kinds: [kind] }).success, false);
  }
});

test("INV-person-history: notes retain exact Person and revision; status changes require explicit handoff choices", () => {
  assert.deepEqual(roundTrip(people.editNoteRequest, { ...command, input: { personId: Q, noteId: R, body: " Changed. ", reason: " Correct typo. " } }),
    { ...command, input: { personId: Q, noteId: R, body: "Changed.", reason: "Correct typo." } });
  assert.equal(people.editNoteRequest.safeParse({ ...command, input: { noteId: R, body: "Changed.", reason: "Correction." } }).success, false);
  assert.equal(people.addNoteRequest.safeParse({ ...command, input: { personId: Q, body: " ", authorId: P } }).success, false);
  const receipt = { receiptId: R, noteId: Q, revision: "5", outcome: "changed" };
  assert.deepEqual(roundTrip(people.noteMutationResult, receipt), receipt);
  assert.equal(people.noteMutationResult.safeParse({ noteId: Q, revision: "5", outcome: "changed" }).success, false);
  const move = { ...command, input: { personId: Q, stage: "attendee", reason: "Correct actual stage",
    handoffs: [{ kind: "needs_owner", dutyId: R, expectedRevision: "2" }] } };
  assert.deepEqual(roundTrip(people.changeStatusRequest, move), move);
  assert.equal(people.changeStatusRequest.safeParse({ ...move, input: { ...move.input, withdrawCommitment: true } }).success, false);
  assert.deepEqual(roundTrip(people.reorderPipelineRequest, { ...command, input: { column: "core_group", personIds: [] } }),
    { ...command, input: { column: "core_group", personIds: [] } });
  assert.equal(people.reorderPipelineRequest.safeParse({ ...command, input: { column: "core_group", personIds: [Q, Q] } }).success, false);
});

test("INV-person-evidence: current commitment is independent from genuine acquisition and metric denominator", () => {
  const observation = { owner, personId: Q, asOf: now, zone: "America/New_York", sourceRevision: "8", lifecycle: { state: "live" }, classification: "adult",
    current: { state: "withdrawn", evidenceId: R, kind: "core_group", occurredOn: "2026-10-10", revision: "7" },
    firstAcquisition: { status: "known", occurredOn: "2026-09-01", evidenceId: R } };
  assert.deepEqual(roundTrip(people.commitmentObservation, observation), observation);
  const changed = { receiptId: R, outcome: "changed", observation };
  assert.deepEqual(roundTrip(people.classificationMutationResult, changed), changed);
  assert.equal(people.commitmentObservation.safeParse({ ...observation, current: { state: "active" } }).success, false);
  const withoutEvidence = { state: "withdrawn", kind: "core_group", occurredOn: "2026-10-10", revision: "7" };
  assert.equal(people.currentCommitment.safeParse(withoutEvidence).success, false);
  const metrics = { owner, asOf: now, zone: "America/New_York", sourceRevision: "8",
    from: "2026-10-01", through: "2026-10-13", unit: "distinct_canonical_people",
    currentStages: ["prospect", "attendee", "following_up", "interviewed", "core_group", "launch_team", "leader"].map(stage => ({ stage, distinctPeople: 0 })),
    transitions: [{ from: "core_group", to: "launch_team", distinctPeople: 2,
      conversion: { status: "known", cohortPeople: 3, cohortTransitionPeople: 2 } }] };
  assert.deepEqual(roundTrip(people.pipelineMetricsResult, metrics), metrics);
  for (const [from, to] of [["prospect", "interviewed"], ["leader", "core_group"]]) {
    assert.equal(people.pipelineMetricsResult.safeParse({ ...metrics, transitions: [{ ...metrics.transitions[0], from, to }] }).success, false);
  }
  assert.equal(people.pipelineMetricsResult.safeParse({ ...metrics, currentStages: metrics.currentStages.slice(0, 6) }).success, false);
  assert.equal(people.pipelineMetricsResult.safeParse({ ...metrics, currentStages: [...metrics.currentStages.slice(0, 6), metrics.currentStages[0]] }).success, false);
  assert.equal(people.pipelineMetricsResult.safeParse({ ...metrics, currentStages: [...metrics.currentStages, metrics.currentStages[0]] }).success, false);
  assert.deepEqual(roundTrip(people.conversion, { status: "unknown", reason: "cohort_unavailable" }), { status: "unknown", reason: "cohort_unavailable" });
  assert.deepEqual(roundTrip(people.conversion, { status: "known", cohortPeople: 4, cohortTransitionPeople: 2 }), { status: "known", cohortPeople: 4, cohortTransitionPeople: 2 });
  assert.equal(people.conversion.safeParse({ status: "known", cohortPeople: 0, cohortTransitionPeople: 0 }).success, false);
  assert.equal(people.conversion.safeParse({ status: "known", cohortPeople: 1, cohortTransitionPeople: 2 }).success, false);
});

test("INV-person-reference: move reviews keep source and survivor distinct under one exact tenant", () => {
  const ref = { owner: organization, personId: Q, revision: "4", state: "live" };
  const review = { source: ref, survivor: { ...ref, personId: R }, references: [
    { descriptor: "person_note.person_id", recordId: P, beforeRevision: "3", afterRevision: "4", treatment: "preserve_history", inverse: "retain_original" },
  ] };
  assert.deepEqual(roundTrip(people.referenceMoveReview, review), review);
  for (const [treatment, inverse] of [["rewrite_current", "restore_exact"], ["deduplicate", "restore_exact"]]) {
    const value = { ...review, references: [{ ...review.references[0], treatment, inverse }] };
    assert.deepEqual(roundTrip(people.referenceMoveReview, value), value);
  }
  for (const [treatment, inverse] of [["preserve_history", "restore_exact"], ["rewrite_current", "retain_original"], ["deduplicate", "retain_original"]]) {
    assert.equal(people.referenceMoveReview.safeParse({ ...review, references: [{ ...review.references[0], treatment, inverse }] }).success, false);
  }
  for (const survivor of [{ ...ref }, { ...ref, personId: R, owner: { ...organization, id: R } },
    { ...ref, personId: R, owner: { kind: "plant", id: P } },
    { ...ref, personId: R, owner: { ...organization, organizationKind: "sending_network" } }]) {
    assert.equal(people.referenceMoveReview.safeParse({ ...review, survivor }).success, false);
  }
  assert.equal(people.lockedPersonReference.safeParse({ ...ref, state: "retired" }).success, false);
});
