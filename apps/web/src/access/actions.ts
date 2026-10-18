"use server";

import { headers } from "next/headers";
import { receiveAccessRequest } from "@everyfield/domain/early-access";
import type { AccessRequestFields, AccessRequestKind, AccessRequestResult } from "./contract";

export async function submitAccessRequest(
	kind: AccessRequestKind,
	fields: AccessRequestFields,
): Promise<AccessRequestResult> {
	const requestHeaders = await headers();
	// Vercel overwrites this header at the proxy. Do not trust client-supplied forwarding headers.
	const ip =
		process.env.VERCEL === "1" ? (requestHeaders.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() ?? null) : null;
	return receiveAccessRequest(kind, fields, ip);
}
