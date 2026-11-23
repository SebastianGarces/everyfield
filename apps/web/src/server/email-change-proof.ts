import "server-only";
import { cookies } from "next/headers";
import { z } from "zod";
import { EMAIL_CHANGE_PATH, EMAIL_CHANGE_PROOF_COOKIE } from "../proxy.ts";
import { parseJson } from "./platform/json.ts";

const SESSION_CHANGES = new Set(["/api/auth/sign-in/email", "/api/auth/register", "/api/auth/sign-out"]);
const signedInReply = z.object({ returnTo: z.string() });

export async function readEmailChangeProof(): Promise<string | null> {
	return (await cookies()).get(EMAIL_CHANGE_PROOF_COOKIE)?.value ?? null;
}

export async function forgetEmailChangeProof(): Promise<void> {
	(await cookies()).delete({ name: EMAIL_CHANGE_PROOF_COOKIE, path: EMAIL_CHANGE_PATH });
}

async function continuesEmailChange(response: Response): Promise<boolean> {
	const reply = signedInReply.safeParse(parseJson(await response.clone().text()));
	return reply.success && new URL(reply.data.returnTo, "https://everyfield.invalid").pathname === EMAIL_CHANGE_PATH;
}

export async function endEmailChangeProofOnSessionChange(request: Request, response: Response): Promise<Response> {
	const url = new URL(request.url);
	if (!response.ok || !SESSION_CHANGES.has(url.pathname) || (await continuesEmailChange(response))) return response;
	const secure = url.protocol === "https:" ? "; Secure" : "";
	response.headers.append(
		"set-cookie",
		`${EMAIL_CHANGE_PROOF_COOKIE}=; Path=${EMAIL_CHANGE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
	);
	return response;
}
