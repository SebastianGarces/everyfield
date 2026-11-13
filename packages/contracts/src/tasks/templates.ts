import { z } from "zod";
import { instant, localDate } from "../common/time.ts";
import { operationId, recordId, requestKey } from "../common/values.ts";
import { phaseNumber } from "../phases/index.ts";
import { taskItem } from "./results.ts";
import { category, priority } from "./values.ts";

// Phase checklists (REQ-TSK-009, REQ-TSK-010, REQ-PHASE-006): the fixed Everyfield catalog in code, under one version.
// An import or an accepted offer copies a checklist into ordinary top-level tasks; nothing links them back, so a later
// catalog version never changes them. Owner and Admin only.

/** A checklist's or an item's stable key, as the catalog names it. */
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
/** One task a checklist will create, with the plant-local date it will be due. */
export const templateTask = z.strictObject({
	key: templateKey,
	title: z.string(),
	// Canonical Markdown, "" when the item has none.
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
/** Due dates count from `anchorDate`, the plant-local date today. */
export const templatePreview = z.strictObject({ catalogVersion, anchorDate: localDate, checklist: checklistPreview });
/**
 * Import the previewed items of one checklist. The request key makes a lost reply safe to retry; a new key is a new
 * import and adds a second set. A stale version or a key the catalog lacks refuses the whole import.
 */
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

/** The latest unanswered phase move, by default; a named transition reads that one, answered or not. */
export const readPhaseOfferRequest = z.strictObject({ transitionId: recordId.optional() });
export const offerTransition = z.strictObject({
	id: recordId,
	fromPhase: phaseNumber,
	toPhase: phaseNumber,
	occurredAt: instant,
	// The plant-local date of the move: accepted tasks count their due dates from it.
	anchorDate: localDate,
});
export const wikiRecommendation = z.strictObject({
	slug: z.string(),
	title: z.string(),
	excerpt: z.string().nullable(),
});
/** What an answer decided, read back from its audit record: the checklists and the tasks it actually created. */
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
		// The new phase's checklists that no earlier offer of this church accepted or declined.
		checklists: z.array(checklistPreview).min(1).max(20),
		recommendations: z.array(wikiRecommendation).max(50),
	}),
	z.strictObject({ status: z.literal("answered"), transition: offerTransition, answer: offerAnswer }),
]);
/** Accept some of the offered checklists. Their tasks, the answer and its audit record commit together. */
export const acceptPhaseOfferRequest = z.strictObject({
	requestKey,
	input: z.strictObject({
		transitionId: recordId,
		catalogVersion,
		checklistKeys: z.array(templateKey).min(1).max(20).refine(unique),
	}),
});
/** Decline every offered checklist. */
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
