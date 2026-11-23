import "server-only";
import { identityError } from "@everyfield/contracts/identity";
import { readBoundedBody } from "@everyfield/domain/operations";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { LINK_PROOFS, isLinkProofPage, linkProofCookies, type LinkProofPage } from "../proxy.ts";
import { parseJson } from "./platform/json.ts";

const BODY_MAX = 24576;

export async function hasLinkProof(page: LinkProofPage): Promise<boolean> {
	return (await cookies()).has(LINK_PROOFS[page].cookie);
}

function answeredPage(pathname: string): LinkProofPage | null {
	const page = pathname.replace(/^\/api\/auth/, "");
	return isLinkProofPage(page) && LINK_PROOFS[page].answer === pathname ? page : null;
}

const fields = (bytes: Uint8Array | null): Record<string, unknown> => {
	const body = bytes ? parseJson(bytes) : undefined;
	return typeof body === "object" && body !== null && !Array.isArray(body) ? { ...body } : {};
};

async function final(response: Response): Promise<boolean> {
	if (response.ok) return true;
	return identityError.safeParse(parseJson(await response.clone().text())).data?.code === "invalid_proof";
}

export async function answerWithLinkProof(
	request: Request,
	handle: (request: Request) => Response | Promise<Response>,
): Promise<Response> {
	const url = new URL(request.url);
	const page = answeredPage(url.pathname);
	if (!page) return handle(request);
	const proof = new NextRequest(url, { headers: request.headers }).cookies.get(LINK_PROOFS[page].cookie)?.value;
	if (!proof)
		return Response.json(
			identityError.parse({ code: "invalid_proof", details: {}, correlationId: randomUUID(), retry: "never" }),
			{ status: 400 },
		);
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	const body = JSON.stringify({ ...fields(await readBoundedBody(request, BODY_MAX)), proof });
	const response = await handle(new Request(request.url, { method: request.method, headers, body }));
	if (await final(response))
		for (const cookie of linkProofCookies(page, "", 0, url.protocol === "https:"))
			response.headers.append("set-cookie", cookie);
	return response;
}
