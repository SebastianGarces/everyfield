/**
 * OPS-106: the database rules every QA preview step obeys. A QA preview owns a Neon branch made off the shared
 * development branch (endpoint ep-autumn-dew). It must never write to that branch itself, nor to production
 * (endpoint ep-gentle-dust). Pure functions, so `qa`, the QA seed and the tests share one rule.
 */
export const NEON_PROJECT = "cool-math-76767811";
export const DEV_ENDPOINT = "ep-autumn-dew";
export const PROD_ENDPOINT = "ep-gentle-dust";

/** One full mail address, as mailRecipientAllowed compares them: a local part, an @ and a dotted domain, no wildcard. */
export const FULL_ADDRESS = /^[^\s@*,]+@[^\s@*,.]+(\.[^\s@*,.]+)+$/;

/**
 * The known QA logins. They exist only on QA Neon branches, behind Vercel Deployment Protection (OPS-106 decision).
 * The plant's Owner, Admin and Member, then the network Admin and the sending-church director (OPS-126), then a second
 * Member whose seat a tester may remove and a fresh sign-up with no church yet (Nora QA 2026-11-04), then the Owner of
 * the second church, Riverside (QA) (T-255).
 */
export const QA_PASSWORD = "Everyfield-QA-preview-1";
export const QA_LOGINS = {
	owner: "delivered+qa-owner@resend.dev",
	admin: "delivered+qa-admin@resend.dev",
	member: "delivered+qa-member@resend.dev",
	network: "delivered+qa-network-admin@resend.dev",
	sending: "delivered+qa-sending-director@resend.dev",
	member2: "delivered+qa-member-2@resend.dev",
	signup: "delivered+qa-signup@resend.dev",
	riverside: "delivered+qa-riverside-owner@resend.dev",
} as const;

/** The two app logins the QA seed creates on a QA branch, one for each app database role. */
export const QA_ROLES = { runtime: "evf_qa_runtime", auth: "evf_qa_auth" } as const;

/** `source` with the login replaced: how the app reaches a QA branch as one of the seed's roles. */
export function roleUrl(source: string, role: string, password: string): string {
	const u = new URL(source);
	u.username = role;
	u.password = password;
	return u.href;
}

const HEX_KEY = /^[a-f0-9]{64}$/;

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
	// The preview's mail keys: the seed's suppression and mail rows match on the preview only under the same keys.
	const mail = env.IDENTITY_MAIL_KEY ?? "",
		address = env.IDENTITY_ADDRESS_KEY ?? "";
	if (!HEX_KEY.test(mail) || !HEX_KEY.test(address))
		return "IDENTITY_MAIL_KEY and IDENTITY_ADDRESS_KEY must each hold 64 hex characters, the preview's own keys.";
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
