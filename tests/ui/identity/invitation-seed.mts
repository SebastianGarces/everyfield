import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const PASSWORD = "Invite-preview-pass-1";

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const { admin, runtime, authDb, secret } = env;
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.loopback("invitation", ip),
		enqueueMail: async () => randomUUID(),
		diagnostic: () => {},
	});
	const host = new URL(origin).host;
	const call = (path: string, body?: unknown, cookie?: string) =>
		identity.handle(
			new Request(`${origin}/api/auth/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { host, origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	async function account(name: string, email: string, state: "active" | "pending_domain") {
		ip++;
		const r = await call("register", {
			kind: "discovery",
			name,
			email,
			password: PASSWORD,
			requestKey: randomUUID(),
		});
		if (!r.ok) throw Error(`register ${email}: ${r.status}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		await admin.execute(
			sql`UPDATE account SET registration_state=${state} WHERE auth_user_id=(SELECT id FROM auth_user WHERE email=${email})`,
		);
		const signedIn = await call("sign-in/email", { email, password: PASSWORD });
		if (!signedIn.ok) throw Error(`sign in ${email}: ${signedIn.status}`);
		const cookie = signedIn.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");
		const s = (await (await call("get-session", undefined, cookie)).json()) as { accountId: string; sessionId: string };
		return { email, accountId: s.accountId, sessionId: s.sessionId };
	}
	const noop = async () => {};
	const onboarding = createOnboardingProducer({ relationships: noop, enqueue: noop });
	const churchOf = async (who: { sessionId: string; accountId: string }, name: string) => {
		const made = await gatedTransaction(runtime, (tx) =>
			onboarding.createPlant(
				tx,
				{ session: who.sessionId, selected: { kind: "account", id: who.accountId } } as never,
				{
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { name, locality: { city: "Austin" }, confirmed: true },
				} as never,
			),
		);
		if (made.status !== "ok") throw Error("createPlant " + name + ": " + JSON.stringify(made));
		return (made.value as { plant: { kind: "plant"; id: string } }).plant;
	};
	const finished = await account("Fiona Finished", "finished@landing.example.test", "active");
	const finishedPlant = await churchOf(finished, "Finished Church");
	await admin.execute(sql`UPDATE plant SET onboarding_completed_at=clock_timestamp() WHERE id=${finishedPlant.id}`);
	const unfinished = await account("Ulrich Unfinished", "unfinished@landing.example.test", "active");
	await churchOf(unfinished, "Unfinished Church");
	const fresh = await account("Nina New", "new@landing.example.test", "pending_domain");
	const landing = { finished: finished.email, unfinished: unfinished.email, pending: fresh.email };

	const fixture = writeFixture("invitation", env.schema, { origin, password: PASSWORD, landing });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("invitation")));
else throw Error("Usage: invitation-seed.mts up <preview-url> | down");
process.exit(0);
