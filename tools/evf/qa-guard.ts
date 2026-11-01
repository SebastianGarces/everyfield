/**
 * OPS-106: the database rules every QA preview step obeys. A QA preview owns a Neon branch made off the shared
 * development branch (endpoint ep-autumn-dew). It must never write to that branch itself, nor to production
 * (endpoint ep-gentle-dust). Pure functions, so `evf qa`, the QA seed and the tests share one rule.
 */
export const NEON_PROJECT = "cool-math-76767811";
export const DEV_ENDPOINT = "ep-autumn-dew";
export const PROD_ENDPOINT = "ep-gentle-dust";

/** The known QA login. It exists only on QA Neon branches, behind Vercel Deployment Protection (OPS-106 decision). */
export const QA_PASSWORD = "Everyfield-QA-preview-1";
export const QA_LOGINS = {
	owner: "delivered+qa-owner@resend.dev",
	admin: "delivered+qa-admin@resend.dev",
	member: "delivered+qa-member@resend.dev",
} as const;

/** `source` with the login replaced: how the app reaches a QA branch as one of the seed's roles. */
export function roleUrl(source: string, role: string, password: string): string {
	const u = new URL(source);
	u.username = role;
	u.password = password;
	return u.href;
}

const endpointOf = (host: string) => host.split(".")[0]!.replace(/-pooler$/, "");

/** Why the QA seed must not run against this environment, or null when it may. Never echoes a value. */
export function seedRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
	if (env.NODE_ENV === "production") return "NODE_ENV is production.";
	const raw = env.DATABASE_URL?.trim();
	if (!raw) return "DATABASE_URL is not set.";
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		return "DATABASE_URL is not a URL.";
	}
	const endpoint = endpointOf(host);
	if (endpoint.startsWith(PROD_ENDPOINT)) return "DATABASE_URL names the production database.";
	if (endpoint.startsWith(DEV_ENDPOINT)) return "DATABASE_URL names the shared development branch, not a QA branch.";
	return null;
}

export type NeonEndpoint = { id: string; branch_id: string };
export type NeonBranch = { id: string; name: string };

/**
 * The branch a QA branch is made from: the one that owns the ep-autumn-dew endpoint. Refuses when no such endpoint
 * exists, or when that branch also serves the production endpoint.
 */
export function devParent(endpoints: NeonEndpoint[], branches: NeonBranch[]): NeonBranch | string {
	const dev = endpoints.filter((e) => e.id.startsWith(DEV_ENDPOINT));
	if (dev.length !== 1) return `No single ${DEV_ENDPOINT} endpoint in Neon project ${NEON_PROJECT}.`;
	const branch = branches.find((b) => b.id === dev[0]!.branch_id);
	if (!branch) return `The ${DEV_ENDPOINT} endpoint names a branch that does not exist.`;
	if (endpoints.some((e) => e.branch_id === branch.id && e.id.startsWith(PROD_ENDPOINT)))
		return `The resolved parent branch serves ${PROD_ENDPOINT}, the production database.`;
	return branch;
}
