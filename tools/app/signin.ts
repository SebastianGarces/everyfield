import { writeFileSync } from "node:fs";
import { closeDatabase, createDatabase } from "../../packages/db/src/client.ts";
import { createIdentityService } from "../../packages/domain/src/identity/index.ts";
import { QA_LOGINS, QA_PASSWORD } from "../qa/qa-guard.ts";

type Input = {
	origin: string;
	secret: string;
	runtimeUrl: string;
	authUrl: string;
	out: string;
	personas: (keyof typeof QA_LOGINS)[];
};

const input = JSON.parse(process.argv[2]!) as Input;
const runtime = createDatabase({ connectionString: input.runtimeUrl, max: 2 });
const authDb = createDatabase({ connectionString: input.authUrl, max: 2 });
let address = 0;
const identity = createIdentityService({
	db: runtime,
	authDb,
	admissionDb: runtime,
	scheduleDelivery: () => {},
	origin: input.origin,
	secret: input.secret,
	trustedIp: () => `127.0.99.${(address = (address % 250) + 1)}`,
	enqueueMail: async () => "",
	diagnostic: () => {},
});
const host = new URL(input.origin).host;
const cookies: Record<string, { name: string; value: string }> = {};
for (const persona of input.personas) {
	const response = await identity.handle(
		new Request(`${input.origin}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { host, origin: input.origin, "content-type": "application/json" },
			body: JSON.stringify({ email: QA_LOGINS[persona], password: QA_PASSWORD }),
		}),
	);
	const token = response.ok
		? response.headers
				.getSetCookie()
				.map((header) => header.split(";")[0]!)
				.find((pair) => pair.includes("session_token"))
		: undefined;
	if (!token) continue;
	const at = token.indexOf("=");
	cookies[persona] = { name: token.slice(0, at), value: token.slice(at + 1) };
}
writeFileSync(input.out, JSON.stringify(cookies), { mode: 0o600 });
await closeDatabase(runtime);
await closeDatabase(authDb);
