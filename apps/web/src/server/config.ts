import { z } from "zod";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);

export const mailKeys = z.object({
	IDENTITY_MAIL_KEY: hexKey,
	IDENTITY_ADDRESS_KEY: hexKey,
	IDENTITY_MAIL_FROM: z.email(),
});
export type MailKeys = z.infer<typeof mailKeys>;

const required = mailKeys.extend({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
});
export type ServerConfig = Readonly<z.infer<typeof required>>;
export type ServerEnv = Readonly<Record<string, string | undefined>>;

export class ServerConfigError extends Error {
	readonly names: readonly string[];
	constructor(names: readonly string[]) {
		super("server_config_missing");
		this.name = "ServerConfigError";
		this.names = names;
	}
}

let parsed: { config: ServerConfig } | { problem: ServerConfigError } | undefined;

function parse() {
	if (parsed) return parsed;
	const result = required.safeParse(process.env);
	parsed = result.success
		? { config: Object.freeze(result.data) }
		: {
				problem: new ServerConfigError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort()),
			};
	return parsed;
}

export const serverConfigProblem = (): ServerConfigError | null => {
	const result = parse();
	return "problem" in result ? result.problem : null;
};

export function serverConfig(): ServerConfig {
	const result = parse();
	if ("problem" in result) throw result.problem;
	return result.config;
}

export const serverEnv = (): ServerEnv => process.env;
