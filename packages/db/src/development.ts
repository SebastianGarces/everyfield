// The shared development database's host names, and the one guard every script, test and tool calls before it writes
// to a database it was not given by the app. No server-only and no database client, so tools load it on its own
// (`@everyfield/db/development`). If the development branch is replaced, change the hosts here and nowhere else.
// Production's host fragment is `ep-gentle-dust-b8tvq4ha`; never add it.

/** The development branch's direct and pooled endpoint host names. */
export const developmentHosts: ReadonlySet<string> = new Set([
	"ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech",
	"ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech",
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * `url` parsed, when it names the development branch (pooled or direct) or, with CI=true and
 * EARLY_ACCESS_TEST_DATABASE=1, CI's throwaway localhost database. Throws for every other host, for an empty or
 * unparsable URL and under NODE_ENV=production. The message names no setting value.
 */
export function assertDevelopmentDatabase(url: string | URL | undefined): URL {
	const refused = () => Error("Approved shared development database or disposable CI database required");
	if (process.env.NODE_ENV === "production" || !url) throw refused();
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw refused();
	}
	const ci = process.env.CI === "true" && process.env.EARLY_ACCESS_TEST_DATABASE === "1";
	if (developmentHosts.has(parsed.hostname) || (ci && LOCAL_HOSTS.has(parsed.hostname))) return parsed;
	throw refused();
}
