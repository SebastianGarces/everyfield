import type { Refusal } from "./api";

export type Screen = "sign_in" | "register" | "recover" | "reset" | "session";

function retryTime(retryAt: string, now = new Date()): string {
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
		case "invalid_input":
			return screen === "reset"
				? "Choose a password that is different from your current one."
				: "Check the details and try again.";
		default:
			return UNREACHABLE;
	}
}
