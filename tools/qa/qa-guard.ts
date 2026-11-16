import { developmentHosts } from "../../packages/db/src/development.ts";

const endpointOf = (host: string) => host.split(".")[0]!.replace(/-pooler$/, "");

export const NEON_PROJECT = "cool-math-76767811";
export const DEV_ENDPOINT = endpointOf([...developmentHosts][0]!);
export const PROD_ENDPOINT = "ep-gentle-dust";

export const FULL_ADDRESS = /^[^\s@*,]+@[^\s@*,.]+(\.[^\s@*,.]+)+$/;

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
	triage: "delivered+qa-triage@resend.dev",
	graceOwner: "delivered+qa-grace-owner@resend.dev",
	graceAdmin: "delivered+qa-grace-admin@resend.dev",
	graceDirector: "delivered+qa-grace-director@resend.dev",
	graceStaff: "delivered+qa-grace-staff@resend.dev",
	graceMember: "delivered+qa-grace-member@resend.dev",
	resident: "delivered+qa-resident@resend.dev",
	hillOwner: "delivered+qa-hill-owner@resend.dev",
} as const;

export const QA_ROLES = { runtime: "evf_qa_runtime", auth: "evf_qa_auth" } as const;

export function roleUrl(source: string, role: string, password: string): string {
	const u = new URL(source);
	u.username = role;
	u.password = password;
	return u.href;
}

const HEX_KEY = /^[a-f0-9]{64}$/;

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
	const mail = env.IDENTITY_MAIL_KEY ?? "",
		address = env.IDENTITY_ADDRESS_KEY ?? "";
	if (!HEX_KEY.test(mail) || !HEX_KEY.test(address))
		return "IDENTITY_MAIL_KEY and IDENTITY_ADDRESS_KEY must each hold 64 hex characters, the preview's own keys.";
	return null;
}

export type NeonEndpoint = { id: string; branch_id: string };
export type NeonBranch = { id: string; name: string };

export function devParent(endpoints: NeonEndpoint[], branches: NeonBranch[]): NeonBranch | string {
	const dev = endpoints.filter((e) => e.id.startsWith(DEV_ENDPOINT));
	if (dev.length !== 1) return `No single ${DEV_ENDPOINT} endpoint in Neon project ${NEON_PROJECT}.`;
	const branch = branches.find((b) => b.id === dev[0]!.branch_id);
	if (!branch) return `The ${DEV_ENDPOINT} endpoint names a branch that does not exist.`;
	if (endpoints.some((e) => e.branch_id === branch.id && e.id.startsWith(PROD_ENDPOINT)))
		return `The resolved parent branch serves ${PROD_ENDPOINT}, the production database.`;
	return branch;
}

const redactConnections = (text: string) =>
	text.replace(/\b(postgres(?:ql)?):\/\/[^\s"'<>]+/g, "$1://<redacted>").replace(/\bnpg_[A-Za-z0-9]+/g, "<redacted>");

export class Redactor {
	private values: string[] = [];
	add(...values: string[]): void {
		for (const v of values) if (v.length >= 6) this.values.push(v);
	}
	clean(text: string): string {
		let out = text;
		for (const v of this.values) out = out.split(v).join("<redacted>");
		return redactConnections(out);
	}
}
