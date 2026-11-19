type Env = Readonly<Record<string, string | undefined>>;

export type Deployment = {
	readonly kind: "local" | "development" | "preview" | "production" | "unrecognized";
	readonly onVercel: boolean;
};

export function deployment(env: Env): Deployment {
	const named = env.VERCEL_ENV;
	const kind =
		named === undefined
			? "local"
			: named === "development" || named === "preview" || named === "production"
				? named
				: "unrecognized";
	return { kind, onVercel: env.VERCEL === "1" };
}

export const isProduction = (env: Env): boolean => deployment(env).kind === "production";
export const isTestDeployment = (env: Env): boolean => {
	const { kind } = deployment(env);
	return kind === "local" || kind === "development" || kind === "preview";
};
export const runsOffVercel = (env: Env): boolean => deployment(env).kind === "local";
export const trustsVercelForwardedFor = (env: Env): boolean => deployment(env).onVercel;
