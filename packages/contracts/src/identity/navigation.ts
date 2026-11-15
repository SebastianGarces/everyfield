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

export const DASHBOARD_HOME = "/overview";
export const ONBOARDING_HOME = "/onboarding";
export const ORGANIZATION_HOME = "/network";
export const LANDING_ROUTE = "/home";

export type PlantSetup = "complete" | "incomplete" | "organization" | "none";

const BEFORE_SETUP = /^\/(?:invitation|confirm-email|connections\/respond|account-deletion)(?:[/?#]|$)/;

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

export function afterSignIn(returnTo: string | null | undefined): string {
	const back = safeReturn(returnTo);
	return back ? `${LANDING_ROUTE}?returnTo=${encodeURIComponent(back)}` : LANDING_ROUTE;
}

export function invalidSessionReturn(returnTo: string | null | undefined): string {
	const path = safeReturn(returnTo);
	if (!path || /^\/(?:signin|login|recover-password)(?:[/?#]|$)/.test(path)) return "/signin";
	return `/signin?returnTo=${encodeURIComponent(path)}`;
}
