import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createIdentityService, createInvitationService } from "../../../packages/domain/src/identity/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { addressSuppressed } from "../../../packages/domain/src/jobs/mail.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { createHmac, randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";

const PASSWORD = "Invite-preview-pass-1";
const ENGINE_NAMES = ["chromium", "webkit"] as const;

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
	async function account(
		name: string,
		email: string,
		state: "active" | "pending_domain",
		kind: "plant_precreation" | "discovery" = "discovery",
	) {
		ip++;
		const r = await call("register", {
			kind,
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
	const fresh = await account("Nina New", "new@landing.example.test", "pending_domain", "plant_precreation");
	const exploring = await account("Dara Discovery", "discovery@landing.example.test", "pending_domain");
	const landing = {
		finished: finished.email,
		unfinished: unfinished.email,
		pending: fresh.email,
		discovery: exploring.email,
	};

	const links: string[] = [];
	const invitations = createInvitationService({
		db: runtime,
		origin,
		budgetSecret: createHmac("sha256", secret).update("invitation-budget").digest("hex"),
		people: accountPersonProducer,
		addressBlocked: (email) =>
			addressSuppressed(createHmac("sha256", env.addressKey).update(email.trim().toLowerCase()).digest("hex")),
		enqueueMail: async (_tx, mail) => {
			const link = /\S+\/invitation#\S+/.exec(mail.text)?.[0];
			if (!link) throw Error("No invitation link in the mail");
			links.push(new URL(link).pathname + new URL(link).hash);
			return randomUUID();
		},
	});
	const actor = (session: string) =>
		gatedTransaction(runtime, (tx) => RequestActor.resolve(tx, sessionId.parse(session))) as Promise<RequestActor>;
	const invite = async (session: string, resident: boolean, input: Record<string, unknown>) => {
		const command = { requestKey: randomUUID(), expectedRevision: "1", input };
		await (resident ? invitations.inviteResident : invitations.invite)(await actor(session), command);
		return links.at(-1)!;
	};

	const hana = await account("Hana Host", "host@landing.example.test", "active");
	const harvest = await churchOf(hana, "Harvest Point");
	await admin.execute(sql`UPDATE plant SET onboarding_completed_at=clock_timestamp() WHERE id=${harvest.id}`);
	const made = await admin.execute(
		sql`INSERT INTO organization(kind,name,timezone,material_revision) VALUES ('sending_church','Grace Sending Church','America/Chicago',1) RETURNING id`,
	);
	const sending = { kind: "organization", id: String(made.rows[0]!.id), organizationKind: "sending_church" } as const;
	const sender = await account("Sasha Sender", "sender@landing.example.test", "active");
	await admin.insert(t.seat).values({
		id: randomUUID(),
		account_id: sender.accountId,
		organization_id: sending.id,
		role: "owner",
		accepted_at: new Date(),
	});
	const joins: Record<string, unknown> = {};
	for (const engine of ENGINE_NAMES) {
		const seatEmail = `join-${engine}@landing.example.test`;
		const seat = await invite(hana.sessionId, false, {
			workspace: harvest,
			role: "member",
			recipientEmail: seatEmail,
		});
		const resident = await account("Rae Resident", `resident-${engine}@landing.example.test`, "active");
		const personId = randomUUID();
		await admin.insert(t.person).values({
			id: personId,
			tenant_id: sending.id,
			organization_id: sending.id,
			display_name: "Rae Resident",
			source: "other",
			created_at: new Date(),
			state: "live",
		});
		const residency = await invite(sender.sessionId, true, {
			organization: sending,
			personId,
			recipientEmail: resident.email,
		});
		joins[engine] = {
			seat: { link: seat, email: seatEmail, workspace: "Harvest Point" },
			resident: { link: residency, email: resident.email, organization: "Grace Sending Church" },
		};
	}

	const fixture = writeFixture("invitation", env.schema, { origin, password: PASSWORD, landing, joins });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("invitation")));
else throw Error("Usage: invitation-seed.mts up <preview-url> | down");
process.exit(0);
