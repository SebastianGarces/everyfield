import { assertDevelopmentDatabase, developmentHosts } from "../../packages/db/src/development.ts";
import { DEV_ENDPOINT, NEON_PROJECT, PROD_ENDPOINT } from "../qa/qa-guard.ts";
import { FlagError, take } from "./flag.ts";

const PRODUCTION_ENV = "FLAG_PRODUCTION_DATABASE_URL";
export const READER_ENV = "FLAG_READER_DATABASE_URL";

type Env = Readonly<Record<string, string | undefined>>;
export type Target = { label: string; url: string; readOnly?: true } | { label: string; missing: true };
export type Neon = (args: readonly string[]) => { status: number | null; stdout: string };

const endpointOf = (url: URL) => url.hostname.split(".")[0]!.replace(/-pooler$/, "");

function productionUrl(name: string, raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new FlagError(`${name} is not a URL. Nothing changed.`);
	}
	if (!endpointOf(url).startsWith(PROD_ENDPOINT))
		throw new FlagError(`${name} does not name the production endpoint. Nothing changed.`);
	return url;
}

export function resolveTarget(argv: readonly string[], env: Env, neon: Neon): { args: string[]; target: Target } {
	const args = [...argv];
	const qa = take(args, "--qa");
	const production = args.includes("--production");
	const rest = args.filter((a) => a !== "--production");
	if (qa !== undefined && production) throw new FlagError("Choose --qa or --production, not both.", 2);

	if (production) {
		if (env.CI) throw new FlagError("bin/flag --production never runs under CI.");
		const raw = env[PRODUCTION_ENV]?.trim();
		if (!raw)
			throw new FlagError(
				`--production needs ${PRODUCTION_ENV} set from Sebastian's production env (AGENTS guard 1). Nothing changed.`,
			);
		const url = productionUrl(PRODUCTION_ENV, raw);
		return { args: rest, target: { label: `the PRODUCTION database (${endpointOf(url)})`, url: url.href } };
	}

	const reader = env[READER_ENV]?.trim();
	if (reader && qa === undefined) {
		if (rest[0] !== "stale" || rest.length !== 1)
			throw new FlagError(
				`${READER_ENV} is a read-only route for bin/flag stale alone: it cannot run ${rest.join(" ")}. Nothing changed.`,
			);
		const url = productionUrl(READER_ENV, reader);
		url.searchParams.set("sslmode", "verify-full");
		return {
			args: rest,
			target: { label: `the PRODUCTION database, read-only (${endpointOf(url)})`, url: url.href, readOnly: true },
		};
	}

	if (qa !== undefined) {
		if (!/^qa-[a-z0-9]+(-[a-z0-9]+)*$/.test(qa)) throw new FlagError(`${qa} is not a QA preview id (bin/qa list).`);
		const found = neon([
			"connection-string",
			qa,
			"--role-name",
			"neondb_owner",
			"--database-name",
			"neondb",
			"--project-id",
			NEON_PROJECT,
		]);
		if (found.status !== 0)
			throw new FlagError(`neonctl found no Neon branch ${qa} (bin/qa list shows the open ones).`);
		const url = new URL(found.stdout.trim());
		const endpoint = endpointOf(url);
		if (endpoint.startsWith(PROD_ENDPOINT) || endpoint.startsWith(DEV_ENDPOINT))
			throw new FlagError(`The Neon branch ${qa} is not a QA branch. Nothing changed.`);
		return { args: rest, target: { label: `the QA branch ${qa} (${endpoint})`, url: url.href } };
	}

	const raw = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;
	if (!raw?.trim())
		return {
			args: rest,
			target: { label: "no flag database (DATABASE_URL is unset and no apps/web/.env.local was found)", missing: true },
		};
	let url: URL;
	try {
		url = assertDevelopmentDatabase(raw);
	} catch {
		throw new FlagError(
			"DATABASE_URL is not the shared development database, so bin/flag refuses it. Use --qa <id> for a QA branch.",
		);
	}
	const shared = developmentHosts.has(url.hostname);
	if (shared) url.searchParams.set("sslmode", "verify-full");
	const label = shared
		? `the shared development database (${endpointOf(url)})`
		: `the disposable CI database (${url.hostname}${url.pathname})`;
	return { args: rest, target: { label, url: url.href } };
}
