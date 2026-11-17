import type { z } from "zod";
import type { Owner, sessionId, Reply } from "../common/values.ts";
import type * as request from "./requests.ts";
import type * as result from "./results.ts";

type Scope = Extract<Owner, { kind: "account" | "plant" }>;
export type OnboardingContext = { session: z.infer<typeof sessionId>; selected: Scope };
export type OnboardingWriteContext = OnboardingContext;
export type OnboardingReply<T> = Reply<T, z.infer<typeof result.onboardingError>>;

export interface OnboardingProducer<Tx> {
	createPlant(
		tx: Tx,
		context: OnboardingWriteContext,
		input: z.infer<typeof request.createPlantRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.createPlantResult>>>;
	createDiscovery(
		tx: Tx,
		context: OnboardingWriteContext,
		input: z.infer<typeof request.createDiscoveryRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.createDiscoveryResult>>>;
	getDiscoveryProfile(
		tx: Tx,
		context: OnboardingContext,
		input: z.infer<typeof request.getDiscoveryProfileRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.discoveryProfileResult>>>;
	convertDiscovery(
		tx: Tx,
		context: OnboardingWriteContext,
		input: z.infer<typeof request.convertDiscoveryRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.convertDiscoveryResult>>>;
	answerLead(
		tx: Tx,
		context: OnboardingWriteContext,
		input: z.infer<typeof request.answerLeadRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.leadAnswerResult>>>;
	declareJourney(
		tx: Tx,
		context: OnboardingWriteContext,
		input: z.infer<typeof request.declareJourneyRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.journeyResult>>>;
	complete(
		tx: Tx,
		context: OnboardingWriteContext,
		input: z.infer<typeof request.completeOnboardingRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.completeOnboardingResult>>>;
	getResume(
		tx: Tx,
		context: OnboardingContext,
		input: z.infer<typeof request.getResumeRequest>,
	): Promise<OnboardingReply<z.infer<typeof result.resumeResult>>>;
}
