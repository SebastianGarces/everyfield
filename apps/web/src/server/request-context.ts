import "server-only";
import { readRequestViewer } from "@everyfield/domain/access";
import { signedSessionToken } from "@everyfield/domain/identity";
import { peopleViewer } from "@everyfield/domain/people";
import { sessionResult } from "@everyfield/contracts/identity";
import { avatarReference } from "@everyfield/contracts/settings";
import { requestDatabase } from "./database";
import { serverConfigProblem } from "./config.ts";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { requestAuth } from "./identity";

const getSession = cache(async () => {
	const request = new Headers(await headers());
	request.set("cookie", (await cookies()).toString());
	return requestAuth().api.getSession({ headers: request });
});

export const getViewer = cache(async () => {
	const unauthenticated = {
		status: "unauthenticated",
		authority: null,
		people: null,
		discovery: false,
		verified: false,
		displayName: null,
		email: null,
		avatar: null,
	} as const;
	if (serverConfigProblem()) return unauthenticated;
	const db = requestDatabase();
	const auth = await requestAuth().$context;
	const jar = await cookies();
	const token = signedSessionToken(jar.get(auth.authCookies.sessionToken.name)?.value, auth.secret);
	if (!token) return unauthenticated;
	const found = await readRequestViewer(db, token);
	if (!found) {
		await getSession();
		return unauthenticated;
	}
	let expiresAt = found.session.expiresAt;
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
		return { ...identity, authority: null, people: null, discovery: false, verified, displayName, email, avatar: null };
	return {
		...identity,
		displayName,
		email,
		authority: v.authority,
		people: v.authority ? peopleViewer(v.authority, v.person) : null,
		discovery: v.authority?.actor.context.kind === "account" ? v.discovery : false,
		verified,
		avatar: v.avatar && avatarReference.parse({ accountId: v.accountId, versionId: v.avatar }),
	};
});

export type PlantSeat = NonNullable<Awaited<ReturnType<typeof getViewer>>["people"]>;

export function signIn(returnTo: string): never {
	redirect(`/signin?returnTo=${encodeURIComponent(returnTo)}`);
}

export async function plantSeat(): Promise<PlantSeat | null> {
	return (await getViewer()).people;
}

export async function requireSeat(returnTo: string): Promise<PlantSeat | null> {
	const v = await getViewer();
	if (v.status === "unauthenticated") signIn(returnTo);
	return v.people;
}

export const SEAT_DENIED = { status: "refused", code: "access_denied" } as const;

export async function seated<R>(run: (seat: PlantSeat) => Promise<R>): Promise<R | typeof SEAT_DENIED> {
	const seat = await plantSeat();
	return seat ? run(seat) : SEAT_DENIED;
}
