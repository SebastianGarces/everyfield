// Pure boundary helpers. A local URL never creates authority.
export function safeReturn(input: string | null | undefined): string | null {
	if (!input || input.length > 8192 || !input.startsWith("/") || input.startsWith("//")) return null;
	let decoded = input;
	try {
		for (;;) {
			if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return null;
			const next = decoded.replace(/%([a-f0-9]{2})/gi, (_, hex: string) =>
				String.fromCharCode(Number.parseInt(hex, 16)),
			);
			if (next === decoded) break;
			decoded = next;
		}
		const url = new URL(input, "https://local.invalid");
		if (url.origin !== "https://local.invalid" || url.pathname.startsWith("//")) return null;
		return input;
	} catch {
		return null;
	}
}

/** A church plant's home: Overview (WP-048). */
export const DASHBOARD_HOME = "/overview";
export const ONBOARDING_HOME = "/onboarding";
/** A sending church's or network's home: its plants (WP-047). */
export const ORGANIZATION_HOME = "/network";
/** The landing route every post-sign-in and "home" link points at. The server page applies landingFor. */
export const LANDING_ROUTE = "/home";

/**
 * Whether the viewer's selected plant has finished setup. "organization" is a sending church or network seat; "none"
 * means no plant or organization context (D-c).
 */
export type PlantSetup = "complete" | "incomplete" | "organization" | "none";

/**
 * Where a signed-in person lands (ADM-004). A new account or an unfinished plant always goes back to onboarding, where
 * setup resumes at its saved step: a returnTo never skips setup. Otherwise a safe returnTo, else the organization home
 * for an organization seat, onboarding (the account's Discovery page) for a viewer outside a plant or organization and
 * the dashboard home for a plant. An unsafe returnTo counts as none.
 */
export function landingFor(input: {
	returnTo?: string | null;
	status: "pending_domain" | "active";
	plant: PlantSetup;
}): string {
	if (input.status === "pending_domain" || input.plant === "incomplete") return ONBOARDING_HOME;
	const back = safeReturn(input.returnTo);
	if (back) return back;
	if (input.plant === "organization") return ORGANIZATION_HOME;
	return input.plant === "complete" ? DASHBOARD_HOME : ONBOARDING_HOME;
}

export function invalidSessionReturn(returnTo: string | null | undefined): string {
	const path = safeReturn(returnTo);
	// Authentication screens stay directly reachable with an expired cookie.
	if (!path || /^\/(?:signin|login|recover-password)(?:[/?#]|$)/.test(path)) return "/signin";
	return `/signin?returnTo=${encodeURIComponent(path)}`;
}
