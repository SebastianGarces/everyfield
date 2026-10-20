import {RequestActor} from "../../../packages/domain/src/access/session.ts";
import {sessionId as writeSessionId} from "../../../packages/contracts/src/common/index.ts";
// Seeds an invitation preview on the shared development database (WP-008/ui). It creates an isolated schema with its own
// login roles, applies every migration, signs up real accounts through the identity service, creates a church through
// the onboarding producer and an organization with a pipeline person, then sends real invitations through the WP-008
// invitation service. The invitation mail goes through the real outbox; a capturing transport reads each link.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/identity/invitation-seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/identity/invitation-seed.mts down
//
// `up` writes apps/web/.env.local in this worktree (git-ignored, mode 0600) so the preview's identity mount uses the
// schema, and writes the accounts and invitation links the browser test needs to $INVITATION_UI_FIXTURE (default
// /tmp/everyfield-invitation-ui.json). `down` drops the schema and roles and deletes both files. It refuses any database
// host other than the shared development database.
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import {
	authorizeInvitationMail,
	createIdentityService,
	createInvitationService,
} from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENV_FILE = fileURLToPath(new URL("../../../apps/web/.env.local", import.meta.url));
const FIXTURE = process.env.INVITATION_UI_FIXTURE ?? "/tmp/everyfield-invitation-ui.json";
const PASSWORD = "Invite-preview-pass-1";
const ENGINES = ["chromium", "webkit"] as const;

function adminUrl() {
	const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
	if (
		source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" ||
		process.env.NODE_ENV === "production"
	)
		throw Error("Approved shared development database required");
	source.searchParams.set("sslmode", "verify-full");
	return source;
}

async function up(origin: string) {
	if (!/^https?:\/\/[a-z0-9.-]+\.localhost(:\d+)?$/.test(origin)) throw Error("Give the local preview URL");
	const source = adminUrl();
	const schema = "wp008ui_" + randomUUID().replaceAll("-", "").slice(0, 16),
		role = "wp008ui_" + randomBytes(6).toString("hex"),
		authRole = role + "_auth",
		password = randomBytes(24).toString("hex");
	const options = `-c search_path=${schema},pg_catalog,pg_temp`;
	writeFileSync(FIXTURE, JSON.stringify({ schema, role, authRole }), { mode: 0o600 });
	const admin = createDatabase({ connectionString: source.href, max: 3, options });
	await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
	await migrate(admin, schema);
	for (const [name, grant] of [
		[role, "everyfield_runtime"],
		[authRole, "everyfield_auth"],
	] as const) {
		await admin.execute(
			sql.raw(
				`CREATE ROLE ${name} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(sql.raw(`GRANT ${grant} TO ${name}`));
	}
	const url = (name: string) => {
		const u = new URL(source);
		u.username = name;
		u.password = password;
		return u;
	};
	const runtime = createDatabase({ connectionString: url(role).href, max: 4, options });
	const authDb = createDatabase({ connectionString: url(authRole).href, max: 3, options });
	const secret = randomBytes(32).toString("hex"),
		mailKey = randomBytes(32),
		addressKey = randomBytes(32);
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
		enqueueMail: (tx, m,command) => {
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
            },command.writes);
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
		trustedIp: () => `127.0.0.${ip}`,
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

	const settings = (name: string) => {
		const u = url(name);
		u.searchParams.set("options", options);
		return u.href;
	};
	writeFileSync(
		ENV_FILE,
		[
			`IDENTITY_DATABASE_URL=${settings(role)}`,
			`IDENTITY_AUTH_DATABASE_URL=${settings(authRole)}`,
			`IDENTITY_ORIGIN=${origin}`,
			`IDENTITY_SECRET=${secret}`,
			`IDENTITY_MAIL_KEY=${mailKey.toString("hex")}`,
			`IDENTITY_ADDRESS_KEY=${addressKey.toString("hex")}`,
			`IDENTITY_MAIL_FROM=security@example.test`,
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	writeFileSync(FIXTURE, JSON.stringify({ schema, role, authRole, origin, password: PASSWORD, flows }, null, "\t"), {
		mode: 0o600,
	});
	await closeDatabase(runtime);
	await closeDatabase(authDb);
	await closeDatabase(admin);
	console.log(JSON.stringify({ schema, fixture: FIXTURE, env: ENV_FILE }));
}

async function down() {
	const state = JSON.parse(readFileSync(FIXTURE, "utf8")) as { schema: string; role: string; authRole: string };
	if (!/^wp008ui_[a-f0-9]+$/.test(state.schema)) throw Error("Not an invitation seed schema");
	const admin = createDatabase({ connectionString: adminUrl().href, max: 1 });
	try {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${state.schema} CASCADE`));
		for (const r of [state.role, state.authRole])
			if (/^wp008ui_[a-f0-9]+(_auth)?$/.test(r)) await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${r}`));
	} finally {
		await closeDatabase(admin);
	}
	rmSync(ENV_FILE, { force: true });
	rmSync(FIXTURE, { force: true });
	console.log(JSON.stringify({ dropped: state.schema }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") await down();
else throw Error("Usage: invitation-seed.mts up <preview-url> | down");
process.exit(0);

async function verifiedWriteActor(session:string){return runtime.transaction(async tx=>{const actor=await RequestActor.resolve(tx,writeSessionId.parse(session));if(!(actor instanceof RequestActor))throw Error('verified_actor_required');return actor;});}
