import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import foundations from "../../../../docs/reference/discovery-foundations.json" with { type: "json" };
import * as C from "@everyfield/contracts/onboarding";

const id = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000001";
const plant = { kind: "plant", id: other };
const account = { kind: "account", id };
const organization = { kind: "organization", id: other, organizationKind: "sending_church" };
const now = "2026-10-18T15:00:00.000Z";
const choices = { people: false, meetings: false, tasks: false, ministry_teams: false,
  wiki: false, activity: false, shared_findings: false };
const basics = { name: "Harvest Point", locality: { city: "Boston", stateProvince: null, country: null }, confirmed: true };
const command = <T,>(input: T) => ({ requestKey: "confirmed-creation", expectedRevision: "0", input });
const wire = <T,>(schema: z.ZodType<T>, value: unknown): T => schema.parse(JSON.parse(JSON.stringify(value)));
const refuses = (schema: z.ZodType, value: unknown) => assert.throws(() => wire(schema, value), z.ZodError);
const receipt = { id, request: { owner: account, actorId: id, operation: "onboarding.createPlant",
  requestKey: "confirmed-creation", digest: "a".repeat(64), origin: { kind: "native" } },
  completedAt: now, outcome: "changed", subjects: [], eventIds: [id], effectIds: [other] };
const entry = { kind: "church_creation", eventId: id, fromPhase: null, toPhase: 1, recordedAt: now };
const created = { status: "created", plant, revision: "1", materialRevision: "1",
  ownerSeat: { seatId: id, role: "owner", personId: id }, creation: entry,
  currentPhase: 1, initialSharing: choices, receipt };
const plantReceipt = (operation: string) => ({ ...receipt, request: { ...receipt.request, owner: plant, operation } });

test("AC:WP009-MUL-006 confirmed creation boundary round trips partial locality without residency commissioning or caller authority", () => {
  assert.deepEqual(wire(C.createPlantRequest, command({ ...basics, name: "  Harvest Point  ",
    locality: { ...basics.locality, city: "  Boston  " } })), command(basics));
  assert.deepEqual(wire(C.createPlantRequest, command({ name: "Grace", confirmed: true })), command({ name: "Grace", confirmed: true }));
  for (const extra of [{ phase: 4 }, { organizationActorId: id }, { seatTransfer: true },
    { commissioned: true }, { geographicAttestation: "Boston" }, { lineage: id }, { readinessComplete: true },
    { actorId: id }, { role: "owner" }, { readingComplete: true }, { confirmed: false }]) {
    refuses(C.createPlantRequest, command({ ...basics, ...extra }));
  }
  refuses(C.createPlantRequest, { ...command(basics), origin: { kind: "native" } });
});

test("INV-onboarding-creation: wire result distinguishes actual Phase 1 insertion from replay after a later phase", () => {
  assert.deepEqual(wire(C.createPlantResult, created), created);
  const replay = { ...created, status: "existing", currentPhase: 4 };
  assert.deepEqual(wire(C.createPlantResult, replay), replay);
  for (const invalid of [
    { ...created, currentPhase: 4 }, { ...created, currentPhase: 0 },
    { ...created, creation: { ...entry, fromPhase: 0 } },
    { ...created, creation: { ...entry, toPhase: 4 } },
    { ...created, ownerSeat: { ...created.ownerSeat, role: "admin" } },
    { ...created, ownerSeat: { seatId: id, role: "owner" } },
    { ...created, initialSharing: { ...choices, people: true } },
    { ...created, initialSharing: { people: false } },
    { ...created, receipt: { ...receipt, eventIds: [] } },
    { ...created, receipt: { ...receipt, eventIds: [other] } },
    { ...created, receipt: { ...receipt, outcome: "noop" } },
    { ...created, receipt: { ...receipt, request: { ...receipt.request, owner: organization } } },
    { ...created, receipt: { ...receipt, request: { ...receipt.request, actorId: other } } },
    { ...created, receipt: { ...receipt, request: { ...receipt.request, operation: "discovery.create" } } },
    { ...created, receipt: { ...receipt, outcome: "partial" } },
    { ...created, assessment: "complete" }, { ...created, emailDelivered: true },
  ]) refuses(C.createPlantResult, invalid);
});

test("INV-onboarding-lead: yes discloses the ordinary role proposal and no or skip cannot assign a Person or grant authority", () => {
  const yes = { answer: "yes", assignment: { kind: "minimal_role", roleName: "Lead planter",
    container: { kind: "minimal", name: "Leadership" } } };
  assert.deepEqual(wire(C.answerLeadRequest, command(yes)), command(yes));
  const reuse = { answer: "yes", assignment: { kind: "existing_role", teamId: id, roleId: other,
    expectedTeamRevision: "1", expectedRoleRevision: "2" } };
  assert.deepEqual(wire(C.answerLeadRequest, command(reuse)), command(reuse));
  for (const answer of ["no", "skip"]) {
    assert.deepEqual(wire(C.answerLeadRequest, command({ answer })), command({ answer }));
    refuses(C.answerLeadRequest, command({ answer, assignment: yes.assignment }));
  }
  for (const extra of [{ personId: other }, { activateAuthority: true }, { templateId: id }, { readerAccountId: id }]) {
    refuses(C.answerLeadRequest, command({ ...yes, ...extra }));
  }
  const lead = { answer: "yes", assignment: { teamId: id, roleId: other, personId: id }, savedAt: now };
  const result = { plant, revision: "2", lead, receipt: plantReceipt("identity.answerLeadOnboarding") };
  assert.deepEqual(wire(C.leadAnswerResult, result), result);
  for (const request of [
    { ...result.receipt.request, owner: account },
    { ...result.receipt.request, operation: "discovery.create" },
  ]) refuses(C.leadAnswerResult, { ...result, receipt: { ...result.receipt, request } });
  refuses(C.leadAnswerResult, { ...result, lead: { ...lead, answer: "no" } });
  refuses(C.leadAnswerResult, { ...result, newGrants: [id] });
  refuses(C.leadAnswerResult, { ...result, lead: { answer: "pending" } });
});

test("INV-onboarding-journey: saved nonattestations contain no phase and no-date cannot clear a launch schedule", () => {
  for (const answer of ["unsure", "discerning", "skip"]) {
    const input = { journey: { answer }, launch: { answer: "no_date" } };
    assert.deepEqual(wire(C.declareJourneyRequest, command(input)), command(input));
    refuses(C.declareJourneyRequest, command({ ...input, journey: { answer, phase: 0 } }));
    refuses(C.declareJourneyRequest, command({ ...input, launch: { answer: "no_date", date: null } }));
  }
  const input = { journey: { answer: "existing", phase: 4 },
    launch: { answer: "planned", date: "2026-11-10", expectedScheduleRevision: "3" } };
  assert.deepEqual(wire(C.declareJourneyRequest, command(input)), command(input));
  for (const phase of [0, 6]) {
    const explicit = { ...input, journey: { answer: "existing", phase } };
    assert.deepEqual(wire(C.declareJourneyRequest, command(explicit)), command(explicit));
  }
  for (const phase of [7, 4.5]) refuses(C.declareJourneyRequest, command({ ...input, journey: { answer: "existing", phase } }));
  refuses(C.declareJourneyRequest, command({ ...input, journey: { ...input.journey, reason: "Caller reason" } }));
  refuses(C.declareJourneyRequest, command({ ...input, journey: { ...input.journey, kind: "initial_declaration" } }));
  const result = { plant, revision: "2", currentPhase: 4,
    journey: { status: "saved", value: { answer: "unsure" }, savedAt: now },
    launch: { status: "saved", value: { answer: "no_date" }, savedAt: now },
    scheduledLaunchDate: "2026-11-10", receipt: plantReceipt("onboarding.declareJourney") };
  assert.deepEqual(wire(C.journeyResult, result), result);
  for (const request of [
    { ...result.receipt.request, owner: account },
    { ...result.receipt.request, operation: "discovery.create" },
  ]) refuses(C.journeyResult, { ...result, receipt: { ...result.receipt, request } });
});

test("INV-onboarding-conversion: carry only selected exact-pair consent and private document references without bodies", () => {
  const selected = { relationshipId: id, organization, expectedRelationshipRevision: "2",
    expectedConsentRevision: "3", choices: { ...choices, wiki: true } };
  const input = { ...basics, discoveryId: id, relationships: [selected] };
  assert.deepEqual(wire(C.convertDiscoveryRequest, command(input)), command(input));
  refuses(C.convertDiscoveryRequest, command({ ...input, relationships: [selected, selected] }));
  refuses(C.convertDiscoveryRequest, command({ ...input, relationships: [selected, { ...selected, relationshipId: other }] }));
  refuses(C.convertDiscoveryRequest, command({ ...input, relationships: [{ ...selected, organization: plant }] }));
  refuses(C.convertDiscoveryRequest, command({ ...input, relationships: [{ ...selected, choices: { wiki: true } }] }));
  refuses(C.convertDiscoveryRequest, command({ ...input, transferSeat: id }));
  const result = { status: "existing", discoveryId: id, plant, revision: "2", materialRevision: "2",
    ownerSeat: created.ownerSeat, creation: entry, currentPhase: 4, convertedAt: now,
    relationships: [{ relationshipId: id, organization, revision: "1", consentRevision: "3", choices: selected.choices }],
    documentProposals: [{ documentId: id, revisionId: other, expectedRevision: "3" }],
    receipt: { ...receipt, request: { ...receipt.request, operation: "discovery.convertToPlant" } } };
  assert.deepEqual(wire(C.convertDiscoveryResult, result), result);
  const initial = { ...result, status: "converted", currentPhase: 1 };
  assert.deepEqual(wire(C.convertDiscoveryResult, initial), initial);
  refuses(C.convertDiscoveryResult, { ...initial, receipt: { ...initial.receipt, outcome: "noop" } });
  refuses(C.convertDiscoveryResult, { ...result, status: "converted" });
  refuses(C.convertDiscoveryResult, { ...result, relationships: [result.relationships[0], result.relationships[0]] });
  refuses(C.convertDiscoveryResult, { ...result, documentProposals: [{ ...result.documentProposals[0], body: "private" }] });
  refuses(C.convertDiscoveryResult, { ...result, receipt: { ...result.receipt, outcome: "partial" } });
});

test("INV-onboarding-reading: completion carries one eligible reader and all six canonical published sources strictly above 80 percent", () => {
  const articles = foundations.articles.map(a => ({ readerAccountId: id, articleId: a.id,
    source: { owner: { kind: "global", id: "00000000-0000-0000-0000-000000000000" }, publishedRevisionId: other, revision: "1" },
    scrollRatio: 0.81, readAt: now }));
  const complete = { status: "complete", plant, readerAccountId: id, eligibility: { kind: "current_owner" }, articles };
  assert.deepEqual(wire(C.foundationReading, complete), complete);
  const admin = { ...complete, eligibility: { kind: "current_admin_lead", personId: other } };
  assert.deepEqual(wire(C.foundationReading, admin), admin);
  assert.deepEqual(wire(C.foundationReading, { status: "incomplete" }), { status: "incomplete" });
  for (const invalid of [
    { ...complete, articles: articles.slice(0, 3) },
    { ...complete, articles: articles.map((a, i) => i === 0 ? { ...a, scrollRatio: 0.8 } : a) },
    { ...complete, articles: articles.map((a, i) => i > 2 ? { ...a, readerAccountId: other } : a) },
    { ...complete, articles: articles.map(a => ({ ...a, articleId: foundations.articles[0]?.id })) },
    { ...complete, articles: articles.map((a, i) => i === 0 ? { ...a, articleId: id } : a) },
    { ...complete, eligibility: { kind: "lead_title" } },
    { ...complete, eligibility: { kind: "current_member" } },
    { ...complete, articles: articles.map(a => ({ ...a, source: { ...a.source, owner: account } })) },
    { ...complete, articles: articles.map(a => ({ ...a, body: "retained private text" })) },
  ]) refuses(C.foundationReading, invalid);
  assert.deepEqual(wire(C.ownDiscoveryReading, { readerAccountId: id, articles }), { readerAccountId: id, articles });
  refuses(C.ownDiscoveryReading, { readerAccountId: id, articles: articles.map((a, i) => i === 0 ? { ...a, readerAccountId: other } : a) });
});

test("INV-onboarding-resume: completion, current phase, reading and missing facts remain independent without reprovisioning controls", () => {
  const resume = { status: "available", plant, revision: "4", materialRevision: "7", currentPhase: 4,
    basics: "created", lead: { answer: "skip", savedAt: now }, journey: { status: "pending" }, launch: { status: "pending" },
    scheduledLaunchDate: "2026-11-10", peopleStep: "skipped", completion: { status: "completed", completedAt: now, materialRevision: "7" },
    reading: { status: "incomplete" }, values: "missing" };
  assert.deepEqual(wire(C.resumeResult, resume), resume);
  const completeReading = { status: "complete", plant, readerAccountId: id, eligibility: { kind: "current_owner" },
    articles: foundations.articles.map(a => ({ readerAccountId: id, articleId: a.id,
      source: { owner: { kind: "global", id: "00000000-0000-0000-0000-000000000000" }, publishedRevisionId: other, revision: "1" },
      scrollRatio: 0.81, readAt: now })) };
  assert.deepEqual(wire(C.resumeResult, { ...resume, reading: completeReading }), { ...resume, reading: completeReading });
  refuses(C.resumeResult, { ...resume, reading: { ...completeReading, plant: { ...plant, id } } });
  const unfinished = { ...resume, completion: { status: "unfinished" } };
  assert.deepEqual(wire(C.resumeResult, unfinished), unfinished);
  refuses(C.resumeResult, { ...resume, basics: "pending" });
  refuses(C.resumeResult, { ...resume, privateCare: { exists: true } });
  for (const schema of [C.getResumeRequest, C.getDiscoveryProfileRequest]) {
    assert.deepEqual(wire(schema, {}), {});
    refuses(schema, { accountId: other });
  }
  const result = { plant, revision: "4", completion: resume.completion, receipt: plantReceipt("onboarding.complete") };
  assert.deepEqual(wire(C.completeOnboardingResult, result), result);
  for (const request of [
    { ...result.receipt.request, owner: account },
    { ...result.receipt.request, operation: "discovery.create" },
  ]) refuses(C.completeOnboardingResult, { ...result, receipt: { ...result.receipt, request } });
  refuses(C.completeOnboardingResult, { ...result, completion: { status: "unfinished" } });
  assert.deepEqual(wire(C.completeOnboardingRequest, command({})), command({}));
  refuses(C.completeOnboardingRequest, command({ markArticlesComplete: true }));
});

test("INV-onboarding-discovery: explicit account profile has no phantom tenant, phase or foreign-body grant", () => {
  const profile = { discoveryId: id, revision: "1", relationships: [],
    reading: { readerAccountId: id, articles: [] }, documentProposals: [] };
  const active = { status: "active", profile };
  assert.deepEqual(wire(C.discoveryProfileResult, active), active);
  const result = { ...active, receipt: { ...receipt, request: { ...receipt.request, operation: "discovery.create" } } };
  assert.deepEqual(wire(C.createDiscoveryResult, result), result);
  assert.deepEqual(wire(C.createDiscoveryRequest, command({})), command({}));
  refuses(C.createDiscoveryResult, { ...result, profile: { ...profile, reading: { readerAccountId: other, articles: [] } } });
  for (const extra of [{ plant }, { phase: 0 }, { seatId: id }, { privateBody: "private" }, { organizationStaff: true }]) {
    refuses(C.discoveryProfileResult, { ...active, profile: { ...profile, ...extra } });
  }
  assert.deepEqual(wire(C.discoveryProfileResult, { status: "unavailable" }), { status: "unavailable" });
  for (const code of ["active_seat_conflict", "association_resolution_required", "already_declared"]) {
    const error = { code, details: {}, correlationId: id, retry: "refresh" };
    assert.deepEqual(wire(C.onboardingError, error), error);
    refuses(C.onboardingError, { ...error, details: { foreignAccountId: other } });
  }
});
