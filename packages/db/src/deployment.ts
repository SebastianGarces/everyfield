import { z } from "zod";

type Env = Readonly<Record<string, string | undefined>>;

export type DeploymentKind = "local" | "development" | "preview" | "production" | "unrecognized";

export function deploymentKind(env: Env): DeploymentKind {
	const named = env.VERCEL_ENV;
	if (named === undefined) return "local";
	return named === "development" || named === "preview" || named === "production" ? named : "unrecognized";
}

export const isProduction = (env: Env): boolean => deploymentKind(env) === "production";
export const isTestDeployment = (env: Env): boolean => {
	const kind = deploymentKind(env);
	return kind === "local" || kind === "development" || kind === "preview";
};
export const runsOffVercel = (env: Env): boolean => deploymentKind(env) === "local";
export const trustsVercelForwardedFor = (env: Env): boolean => env.VERCEL === "1";

export type ProviderPath = { model: string; endpoint: string; sdk: string };
const OPENAI = "https://api.openai.com/v1";
export const chatPath = (model: string) =>
	({ model, baseURL: OPENAI, endpoint: `${OPENAI}/responses`, sdk: "@ai-sdk/openai" }) as const;
export const EMBEDDING_PATH = {
	model: "text-embedding-3-small",
	endpoint: `${OPENAI}/embeddings`,
	sdk: "fetch",
} as const satisfies ProviderPath;

const IDENTIFIER = /\b(?:sk|pk|rk|org|proj|project|acct|account|user)[-_]/i;
const providerRecord = z.strictObject({
	verifiedOn: z.iso.date(),
	programSharing: z.literal("off"),
	zeroDataRetention: z.literal("verified"),
	region: z.enum(["us", "global"]),
	cache: z.enum(["none", "in-memory"]),
	paths: z
		.array(
			z.strictObject({
				model: z.string().min(1).max(64),
				endpoint: z.url().max(200),
				sdk: z.string().min(1).max(64),
			}),
		)
		.min(1)
		.max(8),
});

function parsedRecord(raw: string) {
	if (raw.length > 4_000 || IDENTIFIER.test(raw)) return null;
	try {
		return providerRecord.safeParse(JSON.parse(raw)).data ?? null;
	} catch {
		return null;
	}
}

export function providerVerified(env: Env, path: ProviderPath, now = new Date()): boolean {
	const record = parsedRecord(env.AI_PROVIDER_RECORD ?? "");
	return (
		record !== null &&
		record.verifiedOn <= now.toISOString().slice(0, 10) &&
		record.paths.some((p) => p.model === path.model && p.endpoint === path.endpoint && p.sdk === path.sdk)
	);
}

export const providerAllowed = (env: Env, path: ProviderPath): boolean =>
	isTestDeployment(env) || providerVerified(env, path);
export const evryAvailable = (env: Env = process.env): boolean => providerAllowed(env, chatPath(env.EVRY_MODEL ?? ""));
