import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { eq } from "../../../packages/db/src/query.ts";
import type { Workspace } from "../../support/fixture.mts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { testDatabase } from "../../support/test-database.mts";
import { seeds } from "../../support/fixture.mts";
import {
	createInvitationService,
	createSeatService,
	authorizeInvitationMail,
	createIdentityService,
} from "../../../packages/domain/src/identity/index.ts";
import { accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { addressSuppressed, createMailService, type MailTransport } from "../../../packages/domain/src/jobs/mail.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { refuse } from "../../../packages/domain/src/identity/invitation-core.ts";
import { sessionId } from "../../../packages/contracts/src/common/index.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
export const key = randomUUID;
export async function fixture({
	lockTimeout = "0",
	mailKeys = null,
}: { lockTimeout?: string; mailKeys?: { addressKey: Buffer; encryptionKey: Buffer } | null } = {}) {
	const database = await testDatabase({ prefix: "wp008", max: 8 });
	const { admin, schema } = database;
	const db = database.connect("runtime", { options: `-c lock_timeout=${lockTimeout}` });
	const runtimeUrl = database.logins.runtime.url;
	const effects: { text: string; to: string; key: string }[] = [];
	let mailFault = false;
	let relay: MailTransport | null = null;
	const addressKey = mailKeys?.addressKey ?? randomBytes(32);
	const hash = (address: string) => createHmac("sha256", addressKey).update(address).digest("hex");
	const mail = createMailService({
		db,
		addressKey,
		encryptionKey: mailKeys?.encryptionKey ?? randomBytes(32),
		from: "invitations@example.test",
		authorize: (tx, m) => authorizeInvitationMail(tx, m, hash),
		transport: {
			async send(payload, key, signal) {
				effects.push({ text: payload.text, to: payload.to, key });
				return relay ? relay.send(payload, key, signal) : { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	async function actor(session: string) {
		const a = await gatedTransaction(db, (tx) => RequestActor.resolve(tx, sessionId.parse(session)));
		if (!(a instanceof RequestActor)) refuse();
		return a;
	}
	const invitations = createInvitationService({
		db,
		origin: "http://invitation.example.test",
		budgetSecret: randomBytes(32).toString("hex"),
		people: accountPersonProducer,
		addressBlocked: (email) => addressSuppressed(hash(email.trim().toLowerCase())),
		enqueueMail: async (tx, m, command) => {
			if (mailFault) throw Error("synthetic_outbox_failure");
			if (m.owner.kind === "global") throw Error("invitation mail has no global owner");
			return mail.append(
				tx,
				{
					owner: m.owner,
					purpose: m.purpose,
					logicalKey: m.logicalKey,
					recipient: m.recipientAccountId,
					address: m.recipientEmail,
					content: { subject: m.subject, text: m.text },
					operation: m.operationId,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				command.writes,
			);
		},
	});
	const identitySecret = randomBytes(32).toString("hex");
	function native(mode: "open" | "invitation_only" | "closed" = "open") {
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
		const call = (path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) =>
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
		for (let claims = await claimDue(db, ["mail"], 100); claims.length; claims = await claimDue(db, ["mail"], 100))
			for (const claim of claims) await mail.dispatch(claim);
	}
	async function proof(invitationId: string) {
		const [i] = await admin
			.select({ revision: t.invitation.revision })
			.from(t.invitation)
			.where(eq(t.invitation.id, invitationId));
		if (!i) throw Error("No invitation " + invitationId);
		const [request] = await admin
			.select({ provider_key: t.mail_request.provider_key })
			.from(t.mail)
			.innerJoin(t.mail_request_member, eq(t.mail_request_member.mail_id, t.mail.id))
			.innerJoin(t.mail_request, eq(t.mail_request.id, t.mail_request_member.request_id))
			.where(eq(t.mail.logical_key, `invitation/${invitationId}/${i.revision}`));
		await dispatch();
		const row = effects.findLast((e) => e.key === request?.provider_key);
		if (!row) throw Error("No dispatched invitation");
		const [, token] = row.text.match(/http:\/\/invitation\.example\.test\/invitation#proof=([^\s]+)/) ?? [];
		if (!token) throw Error("Missing invitation proof");
		return decodeURIComponent(token);
	}

	const seed = seeds(admin);
	async function account(state = "active", address = key() + "@example.test") {
		const a = await seed.actor(null, "owner", {
			email: address,
			user: { name: "Synthetic person" },
			account: { registration_state: state },
		});
		return { id: a.id, user: a.user, session: a.session, email: address };
	}
	async function workspace(kind: "plant" | "sending_church" | "sending_network" = "plant"): Promise<Workspace> {
		if (kind === "plant") return seed.plant({ name: "Synthetic plant", timezone: "UTC" });
		return seed.organization(kind, { name: "Synthetic organization" });
	}
	async function seat(a: { id: string }, w: Workspace, role: "owner" | "admin" | "member" = "owner") {
		return seed.seat(a, w, role);
	}
	async function resident(w: Workspace) {
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
	async function setup(kind: "plant" | "sending_church" | "sending_network" = "plant") {
		const w = await workspace(kind),
			sender = await account(),
			recipient = await account("pending_domain");
		await seat(sender, w);
		return { w, sender, recipient };
	}
	async function invitation(s: Awaited<ReturnType<typeof setup>>, residentId?: string) {
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
		runtimeUrl: runtimeUrl.href,
		invitations,
		seats: createSeatService(db),
		mail,
		effects,
		dispatch,
		addressHash: hash,
		proof,
		account,
		workspace,
		seat,
		resident,
		setup,
		invitation,
		setMailFault(v: boolean) {
			mailFault = v;
		},
		setTransport(transport: MailTransport | null) {
			relay = transport;
		},
		async close() {
			await database.close();
		},
	};
}

export const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};
