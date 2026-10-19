import "server-only";
import { readIdentitySession } from "@everyfield/domain/identity";
import { RequestActor } from "@everyfield/domain/access";
import { readPeopleViewer } from "@everyfield/domain/people";
import { hasDiscoveryProfile } from "@everyfield/domain/organizations";
import { sessionId } from "@everyfield/contracts/common";
import { requestDatabase } from "./database";
import { headers } from "next/headers";
import { cache } from "react";
import { requestAuth } from "./identity";

// Better Auth checks the session against the database once per render request.
export const getSession = cache(async () => requestAuth().api.getSession({ headers: await headers() }));

/** One identity, actor and own-Person observation shared by every mount in this request. */
export const getViewer = cache(async () => {
	const db = requestDatabase();
	if (!db) return null;
	const native = await getSession();
	if (!native) return { status: "unauthenticated", authority: null, people: null, discovery: false } as const;
	const identity = await readIdentitySession(db, native);
	if (identity.status !== "active") return { ...identity, authority: null, people: null, discovery: false };
	return db.transaction(async (tx) => {
		const resolved = await RequestActor.resolve(tx, sessionId.parse(identity.sessionId));
		const authority = resolved instanceof RequestActor ? resolved : null;
		const people =
			authority?.actor.context.owner.kind === "plant" ? await readPeopleViewer(tx, authority.session, authority) : null;
		const discovery =
			authority?.actor.context.kind === "account" ? await hasDiscoveryProfile(tx, identity.accountId) : false;
		return { ...identity, authority, people: people?.status === "viewer" ? people.viewer : null, discovery };
	});
});
