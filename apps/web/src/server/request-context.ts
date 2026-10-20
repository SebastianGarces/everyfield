import "server-only";
import { readViewer } from "@everyfield/domain/access";
import { peopleViewer } from "@everyfield/domain/people";
import { sessionId } from "@everyfield/contracts/common";
import { sessionResult } from "@everyfield/contracts/identity";
import { requestDatabase } from "./database";
import { headers } from "next/headers";
import { cache } from "react";
import { requestAuth } from "./identity";

// Better Auth checks the session against the database once per render request.
export const getSession = cache(async () => requestAuth().api.getSession({ headers: await headers() }));

/** One identity, actor and own-Person observation shared by every mount in this request: two statements in total. */
export const getViewer = cache(async () => {
	const db = requestDatabase();
	if (!db) return null;
	const native = await getSession();
	const unauthenticated = { status: "unauthenticated", authority: null, people: null, discovery: false } as const;
	if (!native) return unauthenticated;
	const v = await readViewer(db, sessionId.parse(native.session.id));
	if (!v) return unauthenticated;
	const identity = sessionResult.parse({
		status: v.registration,
		accountId: v.accountId,
		sessionId: native.session.id,
		expiresAt: native.session.expiresAt.toISOString(),
	});
	if (identity.status !== "active") return { ...identity, authority: null, people: null, discovery: false };
	return {
		...identity,
		authority: v.authority,
		people: v.authority ? peopleViewer(v.authority, v.person) : null,
		discovery: v.authority?.actor.context.kind === "account" ? v.discovery : false,
	};
});
