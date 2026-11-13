// One rule for who may receive mail. Only a production deployment mails any address. Everywhere else mail reaches an
// approved test recipient: a Resend test address (delivered+<label>@resend.dev) or a full address listed in
// EMAIL_TEST_RECIPIENTS. Every sender that talks to the provider asks this function right before the provider call.

export type MailEnv = Readonly<Record<string, string | undefined>>;

const normalize = (address: string) => address.trim().toLowerCase();

/** Only `VERCEL_ENV`, exactly "production", opens the rule. An absent or unknown value stays restricted. */
export function mailRecipientAllowed(env: MailEnv, address: string): boolean {
	if (env.VERCEL_ENV === "production") return true;
	const normalized = normalize(address);
	const [local, domain, ...rest] = normalized.split("@");
	// One local part, one domain and no wildcard: a list entry is a full address, never a pattern.
	if (!local || !domain || rest.length > 0 || local.includes("*")) return false;
	if (local.startsWith("delivered+") && domain === "resend.dev") return true;
	return (env.EMAIL_TEST_RECIPIENTS ?? "").split(",").map(normalize).includes(normalized);
}
