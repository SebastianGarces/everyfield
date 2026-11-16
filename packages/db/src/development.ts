export const developmentHosts: ReadonlySet<string> = new Set([
	"ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech",
	"ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech",
]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

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
