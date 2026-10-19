import "server-only";
import { readIdentitySession } from "@everyfield/domain/identity";
import { sessionResult, type SessionResult } from "@everyfield/contracts/identity";
import { requestDatabase } from "./database";
export { requestDatabase } from "./database";
import { headers } from "next/headers";
import { cache } from "react";
import { requestAuth } from "./identity";

// The supported Better Auth API validates the cookie against the database.
// React owns this memoization for one server request; no authority crosses requests.
type SessionAuth = { api: { getSession: ReturnType<typeof requestAuth>["api"]["getSession"] } };
export const getSession = cache(async (auth: SessionAuth = requestAuth(), requestHeaders?: Headers) =>
	auth.api.getSession({ headers: requestHeaders ?? (await headers()) }),
);

/** The same request's application identity for mounts that also need registration state. */
export const getViewer = cache(async (): Promise<SessionResult | null> => {
	try {
		const native = await getSession();
		if (!native) return sessionResult.parse({ status: "unauthenticated" });
		const db = requestDatabase();
		return db ? await readIdentitySession(db, native) : null;
	} catch {
		return null;
	}
});
