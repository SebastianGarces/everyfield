import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * The request's path, which Next.js gives no server layout. Its one reader is `sectionSeed` in
 * features/settings/routes.tsx, which the product frame calls to open Settings on first paint.
 */
export const PATH_HEADER = "x-everyfield-path";

export function proxy(request: NextRequest) {
	if (!getSessionCookie(request)) {
		const signin = new URL("/signin", request.url);
		signin.searchParams.set("returnTo", request.nextUrl.pathname + request.nextUrl.search);
		return NextResponse.redirect(signin);
	}
	const headers = new Headers(request.headers);
	headers.set(PATH_HEADER, request.nextUrl.pathname);
	return NextResponse.next({ request: { headers } });
}

// The matcher holds every top-level product prefix whose page sends a signed-out visitor to sign-in: the (frame) group
// (communication, documents, follow-ups, intelligence, me, meetings, ministries, network, notifications, overview,
// people, settings, tasks) plus /home and /onboarding. The proxy sends a visitor with no session cookie to /signin?returnTo=<path> before
// any server work, and sets PATH_HEADER on the rest; the pages still check the real session. Routes that serve
// signed-out visitors stay out: /wiki (crawler previews), rsvp, unsubscribe, email-preferences, confirm-email,
// account-deletion, connections/respond, the identity pages, access, design, marketing, legal and /api. The one
// product section outside the matcher, /wiki, sends a signed-out reader to sign-in from its page
// (features/wiki/routes.tsx) instead.
export const config = {
	matcher: [
		"/communication/:path*",
		"/documents/:path*",
		"/follow-ups/:path*",
		"/intelligence/:path*",
		"/me/:path*",
		"/meetings/:path*",
		"/ministries/:path*",
		"/network/:path*",
		"/notifications/:path*",
		"/overview/:path*",
		"/people/:path*",
		"/settings/:path*",
		"/tasks/:path*",
		"/home",
		"/onboarding/:path*",
	],
};
