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
