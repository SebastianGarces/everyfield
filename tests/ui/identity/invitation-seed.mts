// Seeds an invitation preview on the shared development database (WP-008/ui). It opens the shared tests/ui seed
// environment (tests/ui/seed-env.mts: one isolated schema, login roles and apps/web/.env.local per worktree), signs up
// real accounts through the identity service, creates a church through the onboarding producer and an organization with
// a pipeline person, then sends real invitations through the WP-008 invitation service. The invitation mail goes through
// the real outbox; a capturing transport reads each link.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/identity/invitation-seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/identity/invitation-seed.mts down
//
// `up` writes the accounts and invitation links the browser test needs to $INVITATION_UI_FIXTURE (default
// /tmp/everyfield-invitation-ui.json). `down` deletes it and drops the shared schema when no other seed still uses it.
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import {
	authorizeInvitationMail,
	createIdentityService,
	createInvitationService,
} from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { createHmac, randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const PASSWORD = "Invite-preview-pass-1";
const ENGINES = ["chromium", "webkit"] as const;

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const { admin, runtime, authDb, secret, mailKey, addressKey } = env;
 async function verifiedWriteActor(value:string){const actor=await runtime.transaction(tx=>RequestActor.resolve(tx,sessionId.parse(value)));if(!(actor instanceof RequestActor))throw Error('unavailable');return actor;}
	const sent: { to: string; text: string }[] = [];
	const mail = createMailService({
		db: runtime,
		encryptionKey: mailKey,
		addressKey,
		from: "security@example.test",
		authorize: (tx, m) =>
			authorizeInvitationMail(tx, m, (a) => createHmac("sha256", addressKey).update(a).digest("hex")),
		transport: {
			async send(payload) {
				sent.push({ to: payload.to, text: payload.text });
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	// The same settings the preview's invitation mount derives from this environment file.
	const invitations = createInvitationService({
		db: runtime,
		origin,
		budgetSecret: createHmac("sha256", secret).update("invitation-budget").digest("hex"),
		people: accountPersonProducer,
		enqueueMail: (tx, m, command) => {
			if (m.owner.kind === "global") throw Error("unavailable");
			return mail.append(tx, {
				owner: m.owner,
				purpose: m.purpose,
				logicalKey: m.logicalKey,
				recipient: m.recipientAccountId,
				address: m.recipientEmail,
				content: { subject: m.subject, text: m.text },
				operation: m.operationId,
				notice: null,
				eligibleAt: new Date().toISOString(),
			}, command.writes);
		},
	});
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
	// A verified account. `active` accounts already belong somewhere; `pending_domain` ones have not finished sign-up.
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
	const owner = await account("Daniel Reyes", "daniel@harvest.example.test", "active");
	const grace = await account("Grace Moreno", "grace@gracechurch.example.test", "active");
	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop });
	const created = await runtime.transaction((tx) =>
		onboarding.createPlant(
			tx,
			{
				session: owner.sessionId,
				selected: { kind: "account", id: owner.accountId },
				purpose: "native",
				origin: { kind: "native" },
			} as never,
			{
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { name: "Harvest Point", locality: { city: "Austin" }, confirmed: true },
			} as never,
		),
	);
	if (created.status !== "ok") throw Error("createPlant: " + JSON.stringify(created));
	const plant = (created.value as { plant: { kind: "plant"; id: string } }).plant;
	const org = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${org},'sending_church','Grace Church','America/New_York',1)`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${grace.accountId},${org},'owner',clock_timestamp())`,
	);
	const organization = { kind: "organization" as const, id: org, organizationKind: "sending_church" as const };

	async function linkFor(email: string) {
		for (const claim of await claimDue(runtime, ["mail"], 100)) await mail.dispatch(claim);
		const text = sent.findLast((m) => m.to === email)?.text ?? "";
		const link = text.match(/https?:\/\/\S+\/invitation#proof=\S+/)?.[0];
		if (!link) throw Error(`No invitation link for ${email}`);
		return link;
	}
	const revision = async (table: "plant" | "organization", id: string) =>
		String((await admin.execute(sql.raw(`SELECT revision::text AS r FROM ${table} WHERE id='${id}'`))).rows[0]!.r);

	const flows: Record<string, unknown> = {};
	for (const engine of ENGINES) {
		// A Member invitation to an existing account that never finished sign-up (REQ-IDN-017 first seat).
		const memberName = `Ruth ${engine === "chromium" ? "Chromium" : "Webkit"}`;
		const member = await account(memberName, `ruth.${engine}@harvest.example.test`, "pending_domain");
		await invitations.invite(await verifiedWriteActor(owner.sessionId), {
			requestKey: randomUUID(),
			expectedRevision: await revision("plant", plant.id),
			input: { workspace: plant, role: "member", recipientEmail: member.email },
		});
		// A residency invitation for a pipeline person, to an account with no seat (REQ-MUL-004).
		const resident = await account("Rhea Stone", `rhea.${engine}@resident.example.test`, "active");
		const person = randomUUID();
		await admin.execute(
			sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,created_at,state) VALUES(${person},${org},${org},'Rhea Stone','other',clock_timestamp(),'live')`,
		);
		await invitations.inviteResident(await verifiedWriteActor(grace.sessionId), {
			requestKey: randomUUID(),
			expectedRevision: await revision("organization", org),
			input: { organization, personId: person, recipientEmail: resident.email },
		});
		flows[engine] = {
			member: { name: memberName, email: member.email, link: await linkFor(member.email) },
			resident: { email: resident.email, link: await linkFor(resident.email) },
		};
	}

	const fixture = writeFixture("invitation", env.schema, { origin, password: PASSWORD, flows });
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("invitation")));
else throw Error("Usage: invitation-seed.mts up <preview-url> | down");
process.exit(0);
