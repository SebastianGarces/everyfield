import type { Refusal } from "./api";

// One place for refusal copy, so no screen can word a refusal in a way that tells whether an account exists
// (REQ-IDN-001 one invalid-credentials response, REQ-IDN-002 and REQ-IDN-009 non-enumeration).

export type Screen = "sign_in" | "register" | "recover" | "reset" | "session";

/** "4:12 PM" for today, or "Oct 19, 4:12 PM" for a later day, in the reader's own time zone. */
export function retryTime(retryAt: string, now = new Date()): string {
	const at = new Date(retryAt);
	const sameDay = at.toDateString() === now.toDateString();
	return new Intl.DateTimeFormat(undefined, {
		...(sameDay ? {} : { month: "short", day: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	}).format(at);
}

const UNREACHABLE = "Unable to reach Everyfield. Check your connection and try again.";

export function refusalMessage(screen: Screen, error: Refusal): string {
	const later = error.retryAt ? ` Try again after ${retryTime(error.retryAt)}.` : " Try again later.";
	switch (error.code) {
		// A blocked or deleting account answers like a wrong password, so sign-in never confirms that it exists.
		case "invalid_credentials":
		case "unauthenticated":
			return screen === "session" ? "Your session ended. Sign in again." : "Email or password is incorrect.";
		case "rate_limited":
			return screen === "register"
				? `Too many sign-up attempts from this network.${later}`
				: screen === "recover"
					? `Too many reset requests for this email.${later}`
					: `Too many attempts.${later}`;
		case "admission_unavailable":
			return screen === "register"
				? "Sign-up is unavailable from this network right now. Try again in a few minutes."
				: "Sign-in is unavailable right now. Try again in a few minutes.";
		case "invalid_proof":
			return "This link has expired or was already used.";
		// The client checks length and matching first, so a refusal here is the unchanged-password rule.
		case "invalid_input":
			return screen === "reset"
				? "Choose a password that is different from your current one."
				: "Check the details and try again.";
		default:
			return UNREACHABLE;
	}
}
