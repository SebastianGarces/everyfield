import { z } from "zod";
import { asLogSettings, logLine } from "@everyfield/domain/log";

const hexKey = z.string().regex(/^[a-f0-9]{64}$/);

export const mailEnv = {
	IDENTITY_MAIL_KEY: hexKey,
	IDENTITY_ADDRESS_KEY: hexKey,
	IDENTITY_MAIL_FROM: z.email(),
};

type Check = "identity" | "mail";

const reported = new Set<string>();

export function refuseSettings(check: Check, names: readonly string[]): null {
	const settings = [...new Set(names)].sort();
	const key = `${check}:${settings.join(",")}`;
	if (!reported.has(key)) {
		reported.add(key);
		logLine({ component: check, event: "settings_refused", settings: asLogSettings(settings) });
	}
	return null;
}

export function checkSettings<S extends z.ZodObject>(check: Check, schema: S, values: unknown): z.output<S> | null {
	const parsed = schema.safeParse(values);
	return parsed.success
		? parsed.data
		: refuseSettings(
				check,
				parsed.error.issues.map((issue) => String(issue.path[0])),
			);
}
