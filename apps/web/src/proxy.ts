import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

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
