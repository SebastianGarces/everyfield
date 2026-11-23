import { IDENTITY_LINK_SECONDS } from "@everyfield/contracts/identity";
import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

export const EMAIL_CHANGE_PROOF_COOKIE = "ef-email-change-proof";
export const EMAIL_CHANGE_PATH = "/confirm-email";

export const LINK_PROOFS = {
	"/reset-password": { cookie: "ef-reset-proof", answer: "/api/auth/reset-password" },
	"/verify-email": { cookie: "ef-verify-proof", answer: "/api/auth/verify-email" },
} as const;
export type LinkProofPage = keyof typeof LINK_PROOFS;

export const isLinkProofPage = (path: string): path is LinkProofPage => Object.hasOwn(LINK_PROOFS, path);

export function linkProofCookies(page: LinkProofPage, value: string, maxAge: number, secure: boolean): string[] {
	const { cookie, answer } = LINK_PROOFS[page];
	return [page, answer].map(
		(path) =>
			`${cookie}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
	);
}

function keepLinkProof(request: NextRequest, page: LinkProofPage, proof: string) {
	const clean = request.nextUrl.clone();
	clean.searchParams.delete("token");
	const response = NextResponse.redirect(clean);
	const secure = request.nextUrl.protocol === "https:";
	for (const cookie of linkProofCookies(page, proof, IDENTITY_LINK_SECONDS, secure))
		response.headers.append("set-cookie", cookie);
	return response;
}

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
	const path = request.nextUrl.pathname;
	const token = request.nextUrl.searchParams.get("token");
	if (isLinkProofPage(path)) return token ? keepLinkProof(request, path, token) : NextResponse.next();
	if (path === EMAIL_CHANGE_PATH && token) return keepEmailChangeProof(request, token);
	if (!getSessionCookie(request)) {
		const signin = new URL("/signin", request.url);
		signin.searchParams.set("returnTo", request.nextUrl.pathname + request.nextUrl.search);
		return NextResponse.redirect(signin);
	}
	return NextResponse.next();
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
		"/reset-password",
		"/verify-email",
	],
};
