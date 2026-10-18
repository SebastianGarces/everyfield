import type { z } from "zod";
import type { Owner, sessionId } from "../common/values.ts";
import type { commandOrigin } from "../common/transaction.ts";
import type * as request from "./requests.ts";
import type * as result from "./results.ts";

// Server adapters construct context from a validated session/review, never a
// request body. The producer freshly loads active self identity, lifecycle and
// exact seat/profile. An organization context cannot operate on a resident.
type Scope = Extract<Owner, { kind: "account" | "plant" }>;
export type OnboardingContext = { session: z.infer<typeof sessionId>; selected: Scope;
  purpose: "native" | "model" };
type Origin = z.infer<typeof commandOrigin>;
export type OnboardingWriteContext = Omit<OnboardingContext, "purpose"> & (
  { purpose: "native"; origin: Extract<Origin, { kind: "native" }> } |
  { purpose: "model"; origin: Extract<Origin, { kind: "assistant" }> }
);
export type OnboardingReply<T> = { status: "ok"; value: T } |
  { status: "refused"; error: z.infer<typeof result.onboardingError> };

// WP-009/api owns these transactions. Lock account/profile and invitation or
// relationship subjects in stable order; arbitrate the single active seat with
// WP-008. Validate current relationships/consent/revisions before conversion.
// Same intent returns the original receipt and actual current phase, not another
// creation entry. Required facts, Owner/Person link, all-OFF self-start settings
// or selected exact-pair consent, history, audit, receipt and WP-031 mail intents
// commit together. Mail dispatch happens after commit through the outbox only.
// Person bootstrap uses the WP-011 same-transaction producer, never email alone.
// Lead answers require the actual created Owner/account-linked Person and use
// ordinary role assignment; occupied roles conflict, no templates/readers/care
// copy and no authority activation. WP-017 proves that integration separately.
// Unsure/discerning/skip are saved answers, not phase writes. Existing journey
// is a separate once-only explicit attestation with the server-reserved reason;
// phase+launch effects are one
// reviewed resumable intent if their producers cannot share a short transaction.
// no_date/skip never clear a schedule. Finish stamps completion once and material
// source revision; it does not fill missing facts or run an assessment.
export interface OnboardingProducer<Tx> {
  createPlant(tx: Tx, context: OnboardingWriteContext, input: z.infer<typeof request.createPlantRequest>): Promise<OnboardingReply<z.infer<typeof result.createPlantResult>>>;
  createDiscovery(tx: Tx, context: OnboardingWriteContext, input: z.infer<typeof request.createDiscoveryRequest>): Promise<OnboardingReply<z.infer<typeof result.createDiscoveryResult>>>;
  getDiscoveryProfile(tx: Tx, context: OnboardingContext, input: z.infer<typeof request.getDiscoveryProfileRequest>): Promise<OnboardingReply<z.infer<typeof result.discoveryProfileResult>>>;
  convertDiscovery(tx: Tx, context: OnboardingWriteContext, input: z.infer<typeof request.convertDiscoveryRequest>): Promise<OnboardingReply<z.infer<typeof result.convertDiscoveryResult>>>;
  answerLead(tx: Tx, context: OnboardingWriteContext, input: z.infer<typeof request.answerLeadRequest>): Promise<OnboardingReply<z.infer<typeof result.leadAnswerResult>>>;
  declareJourney(tx: Tx, context: OnboardingWriteContext, input: z.infer<typeof request.declareJourneyRequest>): Promise<OnboardingReply<z.infer<typeof result.journeyResult>>>;
  complete(tx: Tx, context: OnboardingWriteContext, input: z.infer<typeof request.completeOnboardingRequest>): Promise<OnboardingReply<z.infer<typeof result.completeOnboardingResult>>>;
  getResume(tx: Tx, context: OnboardingContext, input: z.infer<typeof request.getResumeRequest>): Promise<OnboardingReply<z.infer<typeof result.resumeResult>>>;
}
