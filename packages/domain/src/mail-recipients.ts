import { isProduction } from "@everyfield/db/deployment";

export type MailEnv = Readonly<Record<string, string | undefined>>;

const normalize = (address: string) => address.trim().toLowerCase();

export function mailRecipientAllowed(env: MailEnv, address: string): boolean {
	if (isProduction(env)) return true;
	const normalized = normalize(address);
	const [local, domain, ...rest] = normalized.split("@");
	if (!local || !domain || rest.length > 0 || local.includes("*")) return false;
	if (local.startsWith("delivered+") && domain === "resend.dev") return true;
	return (env.EMAIL_TEST_RECIPIENTS ?? "").split(",").map(normalize).includes(normalized);
}
