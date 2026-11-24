import { asLogNames, logLine } from "@everyfield/domain/log";
import { z } from "zod";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);

export const mailKeys = z.object({
	IDENTITY_MAIL_KEY: hexKey,
	IDENTITY_ADDRESS_KEY: hexKey,
	IDENTITY_MAIL_FROM: z.email(),
});

const required = mailKeys.extend({
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
});
export type ServerConfig = Readonly<z.infer<typeof required>>;
export type ServerEnv = Readonly<Record<string, string | undefined>>;

let parsed: ServerConfig | undefined;

export const serverConfig = (): ServerConfig => (parsed ??= Object.freeze(required.parse(process.env)));

export function refuseInvalidServerConfig() {
	const result = required.safeParse(process.env);
	if (result.success) return;
	const refused = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))].sort();
	const missing = refused.filter((key) => !process.env[key]);
	const malformed = refused.filter((key) => process.env[key]);
	if (missing.length) logLine({ component: "server", event: "settings_missing", missing: asLogNames(missing) });
	if (malformed.length) logLine({ component: "server", event: "settings_malformed", malformed: asLogNames(malformed) });
	process.exit(1);
}

export const serverEnv = (): ServerEnv => process.env;
