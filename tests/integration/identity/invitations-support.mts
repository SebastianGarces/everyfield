import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { createDatabase, closeDatabase } from "../../../packages/db/src/client.ts";
import { sql, eq } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { migrate } from "../../../packages/db/src/schema/migrate.ts";
import {
	createInvitationService,
	createSeatService,
	authorizeInvitationMail,
	createIdentityService,
} from "../../../packages/domain/src/identity/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import {RequestActor} from "../../../packages/domain/src/access/session.ts";
import {refuse} from "../../../packages/domain/src/identity/invitation-core.ts";
import {sessionId} from "../../../packages/contracts/src/common/index.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
export const key = randomUUID;
export async function fixture({ lockTimeout = "0" } = {}) {
	const source = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
	const ci =
		process.env.CI === "true" &&
		process.env.EARLY_ACCESS_TEST_DATABASE === "1" &&
		["localhost", "127.0.0.1"].includes(source.hostname) &&
		source.pathname === "/everyfield_ci";
	if (
		(!ci && source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech") ||
		process.env.NODE_ENV === "production"
	)
		throw Error("Approved development or disposable CI database required");
	if (!ci) source.searchParams.set("sslmode", "verify-full");
	const schema = "wp008_" + key().replaceAll("-", ""),
		role = "wp008_" + randomBytes(8).toString("hex"),
		options = `-c search_path=${schema},pg_catalog,pg_temp`;
	const admin = createDatabase({ connectionString: source.href, options, max: 8 });
	let db;
	const effects = [];
	let mailFault = false;
	const addressKey = randomBytes(32);
	try {
		await admin.execute(sql.raw(`CREATE SCHEMA ${schema}`));
		await migrate(admin, schema);
		const password = randomBytes(32).toString("hex");
		await admin.execute(
			sql.raw(
				`CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(sql.raw(`GRANT everyfield_runtime TO ${role}`));
		const runtime = new URL(source);
		runtime.username = role;
		runtime.password = password;
		db = createDatabase({
			connectionString: runtime.href,
			options: options + ` -c lock_timeout=${lockTimeout}`,
			max: 8,
		});
	} catch {
		await admin.execute(sql.raw(`DROP SCHEMA IF EXISTS ${schema} CASCADE`));
		await admin.execute(sql.raw(`DROP ROLE IF EXISTS ${role}`));
		await closeDatabase(admin);
		throw Error("Invitation fixture setup failed");
	}
	const hash = (address) => createHmac("sha256", addressKey).update(address).digest("hex");
	const mail = createMailService({
		db,
		addressKey,
		encryptionKey: randomBytes(32),
		from: "invitations@example.test",
		authorize: (tx, m) => authorizeInvitationMail(tx, m, hash),
		transport: {
			async send(payload, key) {
				effects.push({ text: payload.text, to: payload.to, key });
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	async function actor(session:string){const a=await db.transaction(tx=>RequestActor.resolve(tx,sessionId.parse(session)));if(!(a instanceof RequestActor))refuse();return a;}
	const invitations = createInvitationService({
		db,
		origin: "http://invitation.example.test",
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		enqueueMail: async (tx,m,command) => {
			if (mailFault) throw Error("synthetic_outbox_failure");
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
	const identitySecret = randomBytes(32).toString("hex");
	function native(mode = "open") {
		const service = createIdentityService({
			db,
			authDb: admin,
			admissionDb: db,
			origin: "http://invitation.example.test",
			secret: identitySecret,
			registrationMode: mode,
			invitations,
			scheduleDelivery: () => {},
			trustedIp: (request) => request.headers.get("x-test-ip") ?? "127.0.0.1",
			enqueueMail: async () => {
				throw Error("Not part of invitation registration");
			},
			diagnostic: () => {},
		});
		const call = (path, body, cookie, headers = {}) =>
			service.handle(
				new Request("http://invitation.example.test/api/auth/" + path, {
					method: body === undefined ? "GET" : "POST",
					headers: {
						host: "invitation.example.test",
						origin: "http://invitation.example.test",
						"content-type": "application/json",
						...(cookie ? { cookie } : {}),
						...headers,
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
			);
		return Object.assign(call, { auth: service.auth });
	}
	async function dispatch() {
		for (const claim of await claimDue(db, ["mail"], 100)) await mail.dispatch(claim);
	}
	async function proof(invitationId) {
		const [i] = await admin
			.select({ revision: t.invitation.revision })
			.from(t.invitation)
			.where(eq(t.invitation.id, invitationId));
		const [request] = await admin
			.select({ provider_key: t.mail_request.provider_key })
			.from(t.mail)
			.innerJoin(t.mail_request_member, eq(t.mail_request_member.mail_id, t.mail.id))
			.innerJoin(t.mail_request, eq(t.mail_request.id, t.mail_request_member.request_id))
			.where(eq(t.mail.logical_key, `invitation/${invitationId}/${i.revision}`));
		await dispatch();
		const row = effects.findLast((e) => e.key === request?.provider_key);
		if (!row) throw Error("No dispatched invitation");
		const m = row.text.match(/http:\/\/invitation\.example\.test\/invitation#proof=([^\s]+)/);
		if (!m) throw Error("Missing invitation proof");
		return decodeURIComponent(m[1]);
	}

	async function account(state = "active", address = key() + "@example.test") {
		const id = key(),
			user = key(),
			session = key();
		await admin
			.insert(t.auth_user)
			.values({ id: user, name: "Synthetic person", email: address, email_verified: true });
		await admin
			.insert(t.account)
			.values({ id, auth_user_id: user, registration_state: state, registration_kind: "discovery" });
		await admin.insert(t.auth_session).values({
			id: session,
			user_id: user,
			token: randomBytes(32).toString("hex"),
			expires_at: new Date(Date.now() + 86400000),
		});
		return { id, user, session, email: address };
	}
	async function workspace(kind = "plant") {
		const id = key();
		if (kind === "plant")
			await admin.insert(t.plant).values({
				id,
				name: "Synthetic plant",
				timezone: "UTC",
				warning_days: 7,
				alert_days: 14,
				digest_weekday: 1,
				digest_hour: 8,
				phase: 1,
				material_revision: "1",
			});
		else
			await admin
				.insert(t.organization)
				.values({ id, kind, name: "Synthetic organization", timezone: "UTC", material_revision: "1" });
		return kind === "plant" ? { kind: "plant", id } : { kind: "organization", id, organizationKind: kind };
	}
	async function seat(a, w, role = "owner") {
		const id = key();
		await admin.insert(t.seat).values({
			id,
			account_id: a.id,
			plant_id: w.kind === "plant" ? w.id : null,
			organization_id: w.kind === "organization" ? w.id : null,
			role,
			accepted_at: new Date(),
		});
		return id;
	}
	async function resident(w) {
		const id = key();
		await admin.insert(t.person).values({
			id,
			tenant_id: w.id,
			organization_id: w.id,
			display_name: "Synthetic resident",
			source: "other",
			created_at: new Date(),
			state: "live",
		});
		return id;
	}
	async function setup(kind = "plant") {
		const w = await workspace(kind),
			sender = await account(),
			recipient = await account("pending_domain");
		await seat(sender, w);
		return { w, sender, recipient };
	}
	async function invitation(s, residentId) {
		const command = {
			requestKey: key(),
			expectedRevision: "1",
			input: residentId
				? { organization: s.w, personId: residentId, recipientEmail: s.recipient.email }
				: { workspace: s.w, role: "member", recipientEmail: s.recipient.email },
		};
		const result = await (residentId
			? invitations.inviteResident(await actor(s.sender.session), command)
			: invitations.invite(await actor(s.sender.session), command));
		const token = await proof(result.invitation.invitationId);
		return {
			result,
			proof: token,
			command,
			claim: {
				requestKey: key(),
				expectedRevision: "1",
				input: { invitationId: result.invitation.invitationId, proof: token },
			},
		};
	}
	return {
		actor,
		schema,
		native,
		admin,
		db,
		invitations,
		seats: createSeatService(db),
		mail,
		effects,
		dispatch,
		proof,
		account,
		workspace,
		seat,
		resident,
		setup,
		invitation,
		setMailFault(v) {
			mailFault = v;
		},
		async close() {
			await closeDatabase(db);
			await admin.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
			await admin.execute(sql.raw(`DROP ROLE ${role}`));
			await closeDatabase(admin);
		},
	};
}
