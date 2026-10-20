import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
	if (!getSessionCookie(request)) {
		const signin = new URL("/signin", request.url);
		signin.searchParams.set("returnTo", request.nextUrl.pathname + request.nextUrl.search);
		return NextResponse.redirect(signin);
	}
	return NextResponse.next();
}

// Signed-out visitors to product pages go to sign-in before any server work; the pages still check the real session.
export const config = { matcher: ["/people/:path*", "/settings/:path*", "/onboarding/:path*"] };
