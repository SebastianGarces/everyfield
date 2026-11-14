import { z } from "zod";

// Product feedback (WP-049A, REQ-ADM-001, REQ-ADM-002, REQ-KNOW-029). The browser sends the category, the words and the
// details only it can know (page, address, browser, screen, theme). The server adds the church, the role, the app
// version and the time from the signed-in account, never from the request.

export const feedbackCategory = z.enum(["bug", "suggestion", "question", "other"]);
export type FeedbackCategory = z.infer<typeof feedbackCategory>;
export const feedbackStatus = z.enum(["new", "reviewed", "resolved", "dismissed"]);
export type FeedbackStatus = z.infer<typeof feedbackStatus>;

/** The description's limit after trimming: 1 to 5,000 characters. */
export const DESCRIPTION_MAX = 5000;
/** Why a description cannot be sent, or null when it can. The dialog's counter and the server share it. */
export function descriptionProblem(text: string): "empty" | "too_long" | null {
	const trimmed = text.trim();
	if (!trimmed) return "empty";
	return trimmed.length > DESCRIPTION_MAX ? "too_long" : null;
}

const TOKEN_ROUTES = new Set(["invite", "rsvp", "unsubscribe", "email-preferences", "reset-password", "verify"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The internal address to store: the path alone, with no query, fragment or token. A token route's token segment and
 * any long opaque segment that is not a record id become "[token]". Anything that is not an internal path is null.
 */
export function canonicalAddress(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const path = raw.split(/[?#]/, 1)[0]!;
	if (!path.startsWith("/") || path.startsWith("//")) return null;
	const segments = path.split("/");
	const kept = segments.map((segment, i) =>
		(i > 0 && TOKEN_ROUTES.has(segments[i - 1]!)) || (/^[A-Za-z0-9_.~-]{24,}$/.test(segment) && !UUID.test(segment))
			? "[token]"
			: segment,
	);
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

/**
 * What the dialog sends. A detail the browser cannot give is null. Unknown keys, such as a church or a role, are
 * dropped: those come from the account's own seat on the server.
 */
export const submitFeedbackRequest = z.object({
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

/** The saved feedback as its author sees it right after sending: what we reply to and the page it came from. */
export const submittedFeedback = z.object({
	id: z.uuid(),
	category: feedbackCategory,
	page: z.string().nullable(),
	replyTo: z.string(),
	submittedAt: z.string(),
});
export type SubmittedFeedback = z.infer<typeof submittedFeedback>;

/** What the dialog shows before sending: the server's church, role and reply address for the signed-in account. */
export const sendContext = z.object({
	church: z.string().nullable(),
	role: z.string().nullable(),
	replyTo: z.string(),
});
export type SendContext = z.infer<typeof sendContext>;

/** One item of the author's own list: no words, no private details and no triage history (REQ-KNOW-029). */
export const ownFeedback = z.object({
	id: z.uuid(),
	category: feedbackCategory,
	submittedAt: z.string(),
	status: feedbackStatus,
	/** The public issue, once WP-049B publishes one. */
	publicUrl: z.url().nullable(),
});
export type OwnFeedback = z.infer<typeof ownFeedback>;
export const PAGE_SIZE = 25;
export const ownFeedbackPage = z.object({ items: z.array(ownFeedback).max(PAGE_SIZE), next: z.string().nullable() });
export type OwnFeedbackPage = z.infer<typeof ownFeedbackPage>;
export const listOwnRequest = z.object({ cursor: z.string().max(200).nullable().optional().default(null) });
export const getOwnStatusRequest = z.object({ feedbackId: z.uuid() });

/** The private original a triager reads. */
export const triageFeedback = z.object({
	id: z.uuid(),
	category: feedbackCategory,
	description: z.string(),
	status: feedbackStatus,
	revision: z.string(),
	submittedAt: z.string(),
	author: z.object({ name: z.string(), email: z.string() }),
	details: z.object({
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
});
export const triagePage = z.object({ items: z.array(triageFeedback).max(PAGE_SIZE), next: z.string().nullable() });
export type TriagePage = z.infer<typeof triagePage>;
export const triageListRequest = z.object({
	status: feedbackStatus.nullable().optional().default(null),
	category: feedbackCategory.nullable().optional().default(null),
	cursor: z.string().max(200).nullable().optional().default(null),
});
export const triageGetRequest = z.object({ feedbackId: z.uuid() });

/** One status change in the history: who made it and when. */
export const triageChange = z.object({
	from: feedbackStatus,
	to: feedbackStatus,
	by: z.string(),
	at: z.string(),
});
export type TriageChange = z.infer<typeof triageChange>;
export const triageDetail = triageFeedback.extend({ history: z.array(triageChange) });
export type TriageDetail = z.infer<typeof triageDetail>;

export const changeStatusRequest = z.object({
	feedbackId: z.uuid(),
	expectedRevision: z.string().regex(/^[1-9]\d{0,18}$/),
	status: feedbackStatus,
});
/**
 * changed: the new status is saved and in the history. unchanged: it already had that status, so nothing is recorded.
 * stale: someone changed it after the triager loaded it; nothing is saved and `status` is the current one.
 */
export const statusChange = z.object({
	outcome: z.enum(["changed", "unchanged", "stale"]),
	status: feedbackStatus,
	revision: z.string(),
});
export type StatusChange = z.infer<typeof statusChange>;

export const feedbackErrorCode = z.enum(["invalid_input", "access_denied", "unavailable"]);
export type FeedbackReply<T> =
	{ status: "ok"; value: T } | { status: "refused"; error: { code: z.infer<typeof feedbackErrorCode> } };
