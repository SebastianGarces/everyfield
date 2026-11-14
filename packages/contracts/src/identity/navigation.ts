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
 * Pages a sign-in may return to before setup is finished: each finishes a proof or response the account itself holds (a
 * seat invitation, an email change, an organization connection, an account deletion), not a page of the plant.
 */
const BEFORE_SETUP = /^\/(?:invitation|confirm-email|connections\/respond|account-deletion)(?:[/?#]|$)/;

/**
 * Where a signed-in person lands (ADM-004). A new account or an unfinished plant goes back to onboarding, where setup
 * resumes at its saved step; a returnTo skips that only to a BEFORE_SETUP page. Otherwise a safe returnTo, else the
 * organization home for an organization seat, onboarding (the account's Discovery page) for a viewer outside a plant or
 * organization and the dashboard home for a plant. An unsafe returnTo, or one back to the landing route, counts as none.
 */
export function landingFor(input: {
	returnTo?: string | null;
	status: "pending_domain" | "active";
	plant: PlantSetup;
}): string {
	const safe = safeReturn(input.returnTo);
	const back = safe && !/^\/home(?:[/?#]|$)/.test(safe) ? safe : null;
	if (input.status === "pending_domain" || input.plant === "incomplete")
		return back && BEFORE_SETUP.test(back) ? back : ONBOARDING_HOME;
	if (back) return back;
	if (input.plant === "organization") return ORGANIZATION_HOME;
	return input.plant === "complete" ? DASHBOARD_HOME : ONBOARDING_HOME;
}

/** The address a finished sign-in loads: the landing route, which applies landingFor to the returnTo on the server. */
export function afterSignIn(returnTo: string | null | undefined): string {
	const back = safeReturn(returnTo);
	return back ? `${LANDING_ROUTE}?returnTo=${encodeURIComponent(back)}` : LANDING_ROUTE;
}

export function invalidSessionReturn(returnTo: string | null | undefined): string {
	const path = safeReturn(returnTo);
	// Authentication screens stay directly reachable with an expired cookie.
	if (!path || /^\/(?:signin|login|recover-password)(?:[/?#]|$)/.test(path)) return "/signin";
	return `/signin?returnTo=${encodeURIComponent(path)}`;
}
