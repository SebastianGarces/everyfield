import "server-only";
import { readRequestViewer } from "@everyfield/domain/access";
import { signedSessionToken } from "@everyfield/domain/identity";
import { peopleViewer } from "@everyfield/domain/people";
import { sessionResult } from "@everyfield/contracts/identity";
import { requestDatabase } from "./database";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { requestAuth } from "./identity";

// Better Auth's own session read: two statements (session row, then user row). The request viewer calls it only when
// the session needs Better Auth's own handling: a missing or expired session (Better Auth deletes it and clears the
// cookie) or a session due for its expiry extension. The cookie comes from cookies(), which includes the cookies a
// server action set: after a password change replaces the session, the page that action renders must read the new
// session, not the revoked one in the request's Cookie header.
const getSession = cache(async () => {
	const request = new Headers(await headers());
	request.set("cookie", (await cookies()).toString());
	return requestAuth().api.getSession({ headers: request });
});

/**
 * One identity, actor and own-Person observation shared by every mount in this request: one statement reads the
 * session, its user and the viewer (RT-1). Cookie cache stays off (D64), so a revoked session fails on the next request.
 */
export const getViewer = cache(async () => {
	const db = requestDatabase();
	if (!db) return null;
	const unauthenticated = {
		status: "unauthenticated",
		authority: null,
		people: null,
		discovery: false,
		verified: false,
		displayName: null,
		email: null,
	} as const;
	const auth = await requestAuth().$context;
	const jar = await cookies();
	const token = signedSessionToken(jar.get(auth.authCookies.sessionToken.name)?.value, auth.secret);
	if (!token) return unauthenticated;
	const found = await readRequestViewer(db, token);
	if (!found) {
		// Let Better Auth delete an expired session and clear its cookie, as before.
		await getSession();
		return unauthenticated;
	}
	let expiresAt = found.session.expiresAt;
	// Better Auth extends a session once updateAge has passed since its last extension, unless it is not remembered.
	const { expiresIn, updateAge } = auth.sessionConfig;
	if (
		expiresAt.valueOf() - (expiresIn - updateAge) * 1000 <= Date.now() &&
		!jar.has(auth.authCookies.dontRememberToken.name)
	) {
		const refreshed = await getSession();
		if (!refreshed) return unauthenticated;
		expiresAt = refreshed.session.expiresAt;
	}
	const v = found.viewer;
	if (!v) return unauthenticated;
	const identity = sessionResult.parse({
		status: v.registration,
		accountId: v.accountId,
		sessionId: found.session.id,
		expiresAt: expiresAt.toISOString(),
	});
	const { emailVerified: verified, name: displayName, email } = found.user;
	if (identity.status !== "active")
		return { ...identity, authority: null, people: null, discovery: false, verified, displayName, email };
	return {
		...identity,
		displayName,
		email,
		authority: v.authority,
		people: v.authority ? peopleViewer(v.authority, v.person) : null,
		discovery: v.authority?.actor.context.kind === "account" ? v.discovery : false,
		verified,
	};
});
