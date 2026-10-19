import "server-only";
import { createDatabase, type Database } from "@everyfield/db/client";
import { headers } from "next/headers";
import { cache } from "react";
import { requestAuth } from "./identity";

let store: Database | undefined;
export function requestDatabase() {
	const url = process.env.IDENTITY_DATABASE_URL;
	if (!url) return null;
	return (store ??= createDatabase({ connectionString: url, max: 5 }));
}

// The supported Better Auth API validates the cookie against the database.
// React owns this memoization for one server request; no authority crosses requests.
export const getSession = cache(async () => {
	const auth = requestAuth();
	return auth.api.getSession({ headers: await headers() });
});
