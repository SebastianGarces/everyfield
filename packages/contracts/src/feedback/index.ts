import { z } from "zod";

export const feedbackCategory = z.enum(["bug", "suggestion", "question", "other"]);
export type FeedbackCategory = z.infer<typeof feedbackCategory>;
export const feedbackStatus = z.enum(["new", "reviewed", "resolved", "dismissed"]);
export type FeedbackStatus = z.infer<typeof feedbackStatus>;

export const DESCRIPTION_MAX = 5000;
export function descriptionProblem(text: string): "empty" | "too_long" | null {
	const trimmed = text.trim();
	if (!trimmed) return "empty";
	return trimmed.length > DESCRIPTION_MAX ? "too_long" : null;
}

const TOKEN_ROUTES = new Set(["invite", "rsvp", "unsubscribe", "email-preferences", "reset-password", "verify"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function canonicalAddress(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const path = raw.replace(/[?#][\s\S]*$/, "");
	if (!path.startsWith("/") || path.startsWith("//")) return null;
	const segments = path.split("/");
	let previous = "";
	const kept = segments.map((segment) => {
		const token = TOKEN_ROUTES.has(previous) || (/^[A-Za-z0-9_.~-]{24,}$/.test(segment) && !UUID.test(segment));
		previous = segment;
		return token ? "[token]" : segment;
	});
	const address = kept.join("/");
	return address.length <= 500 ? address : null;
}

const text = (max: number) =>
	z
		.string()
		.transform((v) => v.trim().slice(0, max))
		.transform((v) => v || null)
		.nullable()
		.catch(null);
const dimension = z.number().int().min(1).max(100000).nullable().catch(null);

export const submitFeedbackRequest = z.strictObject({
	requestKey: z.uuid(),
	category: feedbackCategory,
	description: z.string().refine((v) => descriptionProblem(v) === null, "Describe it in 1 to 5,000 characters."),
	page: text(500).optional().default(null),
	address: z.string().nullable().optional().catch(null).transform(canonicalAddress),
	browser: text(500).optional().default(null),
	screenWidth: dimension.optional().default(null),
	screenHeight: dimension.optional().default(null),
	theme: z.enum(["light", "dark"]).nullable().optional().catch(null).default(null),
});
export type SubmitFeedbackRequest = z.input<typeof submitFeedbackRequest>;

export const submittedFeedback = z.strictObject({
	id: z.uuid(),
	category: feedbackCategory,
	page: z.string().nullable(),
	replyTo: z.string(),
	submittedAt: z.string(),
});
export type SubmittedFeedback = z.infer<typeof submittedFeedback>;

export const sendContext = z.strictObject({
	church: z.string().nullable(),
	role: z.string().nullable(),
	replyTo: z.string(),
});
export type SendContext = z.infer<typeof sendContext>;

export const ownFeedback = z.strictObject({
	id: z.uuid(),
	category: feedbackCategory,
	submittedAt: z.string(),
	status: feedbackStatus,
	publicUrl: z.url().nullable(),
});
export type OwnFeedback = z.infer<typeof ownFeedback>;
export const PAGE_SIZE = 25;
export const ownFeedbackPage = z.strictObject({
	items: z.array(ownFeedback).max(PAGE_SIZE),
	next: z.string().nullable(),
});
export type OwnFeedbackPage = z.infer<typeof ownFeedbackPage>;
export const listOwnRequest = z.strictObject({ cursor: z.string().max(200).nullable().optional().default(null) });
export const getOwnStatusRequest = z.strictObject({ feedbackId: z.uuid() });

export const publicationState = z.enum(["pending", "publishing", "unknown", "published", "held"]);
export type PublicationState = z.infer<typeof publicationState>;
export const heldReason = z.enum(["unsafe_fields", "github_refused", "search_failed", "ambiguous", "unresolved"]);
export type HeldReason = z.infer<typeof heldReason>;
export const operatorMailState = z.enum(["sending", "sent", "failed", "unknown"]);
export type OperatorMailState = z.infer<typeof operatorMailState>;

export const triageFeedback = z.strictObject({
	id: z.uuid(),
	category: feedbackCategory,
	description: z.string(),
	status: feedbackStatus,
	revision: z.string(),
	submittedAt: z.string(),
	author: z.strictObject({ name: z.string(), email: z.string() }),
	details: z.strictObject({
		page: z.string().nullable(),
		address: z.string().nullable(),
		church: z.string().nullable(),
		role: z.string().nullable(),
		browser: z.string().nullable(),
		screenWidth: z.number().nullable(),
		screenHeight: z.number().nullable(),
		theme: z.enum(["light", "dark"]).nullable(),
		appVersion: z.string().nullable(),
	}),
	reference: z.string(),
	publication: z.strictObject({ state: publicationState, heldReason: heldReason.nullable(), url: z.url().nullable() }),
	operatorMail: operatorMailState.nullable(),
});
export const triagePage = z.strictObject({
	items: z.array(triageFeedback).max(PAGE_SIZE),
	next: z.string().nullable(),
});
export type TriagePage = z.infer<typeof triagePage>;
export const triageListRequest = z.strictObject({
	status: feedbackStatus.nullable().optional().default(null),
	category: feedbackCategory.nullable().optional().default(null),
	cursor: z.string().max(200).nullable().optional().default(null),
});
export const triageGetRequest = z.strictObject({ feedbackId: z.uuid() });

export const triageChange = z.strictObject({
	from: feedbackStatus,
	to: feedbackStatus,
	by: z.string(),
	at: z.string(),
});
export type TriageChange = z.infer<typeof triageChange>;
export const triageDetail = triageFeedback.extend({ history: z.array(triageChange) });
export type TriageDetail = z.infer<typeof triageDetail>;

export const changeStatusRequest = z.strictObject({
	feedbackId: z.uuid(),
	expectedRevision: z.string().regex(/^[1-9]\d{0,18}$/),
	status: feedbackStatus,
});
export const statusChange = z.strictObject({
	outcome: z.enum(["changed", "unchanged", "stale"]),
	status: feedbackStatus,
	revision: z.string(),
});
export type StatusChange = z.infer<typeof statusChange>;

export const feedbackErrorCode = z.enum(["invalid_input", "access_denied", "unavailable"]);
export type FeedbackReply<T> =
	{ status: "ok"; value: T } | { status: "refused"; error: { code: z.infer<typeof feedbackErrorCode> } };
