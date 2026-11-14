import { randomUUID } from "node:crypto";

/** Every refusal or failure Evry can show. None of them says whether a hidden record exists. */
export type EvryErrorCode =
	| "not_found"
	| "access_denied"
	| "invalid_input"
	| "run_active"
	| "model_unavailable"
	| "source_unavailable"
	| "interrupted"
	| "review_changed"
	| "review_expired"
	| "review_closed"
	| "photo_unavailable"
	| "not_assigned"
	| "assignee_ineligible"
	| "owner_ineligible"
	| "unknown";

export class EvryRefusal extends Error {
	readonly code: EvryErrorCode;
	constructor(code: EvryErrorCode) {
		super(code);
		this.code = code;
	}
}

const retry: Record<EvryErrorCode, "never" | "same_request" | "new_turn"> = {
	not_found: "never",
	access_denied: "never",
	invalid_input: "never",
	run_active: "same_request",
	model_unavailable: "new_turn",
	source_unavailable: "new_turn",
	interrupted: "new_turn",
	// A changed, expired or closed review needs a new exact review; the old approval never applies again.
	review_changed: "never",
	review_expired: "never",
	review_closed: "never",
	// The staged upload of a photo proposal is gone or no longer readable; a new upload needs a new review.
	photo_unavailable: "never",
	// A Member asked to change a task that is not assigned to them: they may change only their own.
	not_assigned: "never",
	// A named account has no current seat in the church, so it can't hold a task.
	assignee_ineligible: "never",
	// A named account can't own a person follow-up (REQ-TSK-012).
	owner_ineligible: "never",
	unknown: "new_turn",
};

/**
 * evry.projectError: the only error shape that leaves Evry. It carries a code, a fresh correlation id and whether a
 * retry is useful; never a message, stack, SQL, provider payload or record identity. "unknown" says the outcome is not
 * known rather than claiming a failure.
 */
export function projectError(error: unknown) {
	const code: EvryErrorCode = error instanceof EvryRefusal ? error.code : "unknown";
	return {
		code,
		correlationId: randomUUID(),
		retry: retry[code],
		outcome: code === "unknown" || code === "interrupted" ? ("unknown" as const) : ("refused" as const),
	};
}
export type ProjectedError = ReturnType<typeof projectError>;

const secrets = [
	/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
	/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@[^\s]+/gi,
	/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
	/\bre_[A-Za-z0-9]{20,}\b/g,
];
/** Removes credential-shaped values from text that came from a source or a user before it reaches a model or a log. */
export function scrub(text: string): string {
	return secrets.reduce((value, pattern) => value.replace(pattern, "[removed]"), text);
}
