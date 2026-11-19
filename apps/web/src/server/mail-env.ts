import { logLine } from "@everyfield/domain/log";
import { z } from "zod";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);

export const mailEnv = {
	IDENTITY_MAIL_KEY: hexKey,
	IDENTITY_ADDRESS_KEY: hexKey,
	IDENTITY_MAIL_FROM: z.email(),
};

export const identityEnv = {
	IDENTITY_DATABASE_URL: z.string().min(1),
	IDENTITY_AUTH_DATABASE_URL: z.string().min(1),
	IDENTITY_ORIGIN: z.url(),
	IDENTITY_SECRET: z.string().min(32),
	...mailEnv,
};

export function refuseMissingIdentitySettings() {
	const missing = Object.keys(identityEnv).filter((key) => !process.env[key]);
	if (!missing.length) return;
	logLine({
		component: "server",
		event: "settings_missing",
		...Object.fromEntries(missing.map((key) => [key, true] as const)),
	});
	process.exit(1);
}
