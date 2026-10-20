import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/** The request's path, for server layouts, which Next.js does not give one (the product frame's Settings read). */
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

// Signed-out visitors to product pages go to sign-in before any server work; the pages still check the real session.
export const config = { matcher: ["/people/:path*", "/settings/:path*", "/onboarding/:path*"] };
