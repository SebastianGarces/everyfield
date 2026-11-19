import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

export const PATH_HEADER = "x-everyfield-path";
export const EMAIL_CHANGE_PROOF_COOKIE = "ef-email-change-proof";
const EMAIL_CHANGE_PATH = "/confirm-email";

function keepEmailChangeProof(request: NextRequest, proof: string) {
	const clean = request.nextUrl.clone();
	clean.searchParams.delete("token");
	const response = NextResponse.redirect(clean);
	response.cookies.set(EMAIL_CHANGE_PROOF_COOKIE, proof, {
		httpOnly: true,
		sameSite: "lax",
		secure: request.nextUrl.protocol === "https:",
		path: EMAIL_CHANGE_PATH,
		maxAge: 24 * 60 * 60,
	});
	return response;
}

export function proxy(request: NextRequest) {
	const proof = request.nextUrl.pathname === EMAIL_CHANGE_PATH ? request.nextUrl.searchParams.get("token") : null;
	if (proof) return keepEmailChangeProof(request, proof);
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
		"/confirm-email",
	],
};
