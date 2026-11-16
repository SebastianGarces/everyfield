import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { operationId, recordId, requestKey } from "../common/values.ts";
import { phaseNumber } from "../phases/index.ts";
import { taskItem } from "./results.ts";
import { category, priority } from "./values.ts";

export const templateKey = z
	.string()
	.max(80)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const catalogVersion = z.int().min(1);
const unique = (keys: readonly string[]) => new Set(keys).size === keys.length;

export const checklistSummary = z.strictObject({
	key: templateKey,
	name: z.string(),
	description: z.string(),
	phase: phaseNumber,
	category,
	taskCount: z.int().min(1),
});
export const templateTask = z.strictObject({
	key: templateKey,
	title: z.string(),
	description: z.string(),
	priority,
	due: localDate,
});
export const checklistPreview = checklistSummary.extend({ tasks: z.array(templateTask).min(1).max(100) });

export const listTemplatesRequest = z.strictObject({});
export const templateCatalog = z.strictObject({
	catalogVersion,
	currentPhase: phaseNumber,
	checklists: z.array(checklistSummary).max(100),
});
export const previewTemplateRequest = z.strictObject({ checklistKey: templateKey });
export const templatePreview = z.strictObject({ catalogVersion, anchorDate: localDate, checklist: checklistPreview });
export const importTemplateRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		catalogVersion,
		checklistKey: templateKey,
		itemKeys: z.array(templateKey).min(1).max(100).refine(unique),
	}),
});
export const templateImport = z.strictObject({
	receiptId: operationId,
	checklistKey: templateKey,
	catalogVersion,
	tasks: z.array(taskItem).min(1).max(100),
});

export const readPhaseOfferRequest = z.strictObject({ transitionId: recordId.optional() });
export const offerTransition = z.strictObject({
	id: recordId,
	fromPhase: phaseNumber,
	toPhase: phaseNumber,
	occurredAt: instant,
	anchorDate: localDate,
});
export const wikiRecommendation = z.strictObject({
	slug: z.string(),
	title: z.string(),
	excerpt: z.string().nullable(),
});
export const offerAnswer = z.strictObject({
	answer: z.enum(["accepted", "declined"]),
	answeredAt: instant,
	accepted: z.array(templateKey).max(20),
	declined: z.array(templateKey).max(20),
	tasks: z.array(z.strictObject({ id: recordId, title: z.string() })).max(200),
});
export const phaseOffer = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("none") }),
	z.strictObject({
		status: z.literal("open"),
		transition: offerTransition,
		catalogVersion,
		checklists: z.array(checklistPreview).min(1).max(20),
		recommendations: z.array(wikiRecommendation).max(50),
	}),
	z.strictObject({ status: z.literal("answered"), transition: offerTransition, answer: offerAnswer }),
]);
export const acceptPhaseOfferRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		transitionId: recordId,
		catalogVersion,
		checklistKeys: z.array(templateKey).min(1).max(20).refine(unique),
	}),
});
export const declinePhaseOfferRequest = z.strictObject({
	requestKey,
	input: z.strictObject({ transitionId: recordId }),
});
export const offerAnswered = z.strictObject({
	receiptId: operationId,
	transitionId: recordId,
	answer: offerAnswer,
	created: z.array(taskItem).max(200),
});
