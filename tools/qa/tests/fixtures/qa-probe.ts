// OPS-126: what each QA login sees on a seeded QA database, through the same domain reads the screens use. qa.test.ts
// runs it with tsx and the react-server condition, because the domain code is server-only, and asserts on its JSON.
// The mail reads use the keys the seed got, as the preview does.
//
//   DATABASE_URL=<admin URL> QA_ROLE_PASSWORD=<role password> IDENTITY_MAIL_KEY=<key> IDENTITY_ADDRESS_KEY=<key> \
//     node --conditions=react-server --import tsx qa-probe.ts
import { randomBytes } from "node:crypto";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase } from "../../../../packages/db/src/client.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { createIdentityService } from "../../../../packages/domain/src/identity/index.ts";
import { createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import { idsIn, namesFor, readHistory } from "../../../../packages/domain/src/organizations/index.ts";
import { peopleReader, readPersonPage } from "../../../../packages/domain/src/people/index.ts";
import { QA_LOGINS, QA_PASSWORD, QA_ROLES, roleUrl } from "../../qa-guard.ts";

const ORIGIN = "https://qa-probe.everyfield.invalid";
const source = process.env.DATABASE_URL!,
	password = process.env.QA_ROLE_PASSWORD!;
const admin = createDatabase({ connectionString: source, max: 2 });
const runtime = createDatabase({ connectionString: roleUrl(source, QA_ROLES.runtime, password), max: 2 });
const authDb = createDatabase({ connectionString: roleUrl(source, QA_ROLES.auth, password), max: 2 });
let ip = 0;
const identity = createIdentityService({
	db: runtime,
	authDb,
	admissionDb: runtime,
	scheduleDelivery: () => {},
	origin: ORIGIN,
	secret: randomBytes(32).toString("hex"),
	trustedIp: () => `127.0.126.${++ip}`,
	enqueueMail: async () => {},
	diagnostic: () => {},
});
const host = new URL(ORIGIN).host;
const call = (path: string, body?: unknown, cookie?: string) =>
	identity.handle(
		new Request(`${ORIGIN}/api/auth/${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers: { host, origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);

const mailKeys = {
	encryptionKey: Buffer.from(process.env.IDENTITY_MAIL_KEY!, "hex"),
	addressKey: Buffer.from(process.env.IDENTITY_ADDRESS_KEY!, "hex"),
	from: "qa-probe@everyfield.invalid",
	origin: ORIGIN,
};

/** Sign in as a person does and read the session the cookie names, before any actor check. */
async function signInOnly(email: string) {
	const r = await call("sign-in/email", { email, password: QA_PASSWORD });
	const signedIn = (await r.json()) as { status: string };
	const cookie = r.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const session = (await (await call("get-session", undefined, cookie)).json()) as {
		status: string;
		sessionId: string;
		accountId: string;
	};
	return { signedIn: signedIn.status, session };
}

/** Sign in as a person does, then resolve the actor the session selects. */
async function signIn(email: string) {
	const { signedIn, session } = await signInOnly(email);
	const authority = await RequestActor.resolve(runtime, session.sessionId as never);
	if (!(authority instanceof RequestActor)) throw Error(`actor ${email}: ${JSON.stringify(authority)}`);
	return { signedIn, session, authority };
}

/** A refusal without its correlation id, so the test can compare it exactly. */
const bare = (reply: unknown) => {
	const r = reply as { status: string; error?: { correlationId?: string } };
	return r.status === "refused" && r.error ? { ...r, error: { ...r.error, correlationId: null } } : r;
};

const plant = (await admin.execute(sql`SELECT id FROM plant WHERE name='Harvest Point (QA)'`)).rows[0]!.id as string;
const danielPerson = (
	await admin.execute(sql`SELECT p.id FROM person p JOIN account a ON a.id=p.linked_account_id
		JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=${QA_LOGINS.owner} AND p.plant_id=${plant}`)
).rows[0]!.id as string;
const care = createPrivateCare();
const out: Record<string, unknown> = {};
try {
	const owner = await signIn(QA_LOGINS.owner);
	out.owner = {
		selected: owner.authority.actor.context.owner,
		checkIn: await care.readCurrent(runtime, owner.authority),
		history: await care.readHistory(runtime, owner.authority, { page: 1 }),
	};
	// The 2026-11-04 cases: the delivery message as the Owner opens it, the Admin's own address, the two new logins.
	const delivery = (await admin.execute(sql`SELECT id FROM communication WHERE subject='QA delivery check'`)).rows[0]!
		.id as string;
	out.delivery = await runtime.transaction(async (tx) => ({
		totals: await communicationWriter.getDeliveryTotals(tx as never, owner.authority, { communicationId: delivery }),
		recipients: await communicationWriter.listHistoryRecipients(
			tx as never,
			owner.authority,
			{ communicationId: delivery },
			mailKeys,
		),
	}));
	const lena = await signIn(QA_LOGINS.admin);
	out.address = await communicationWriter.listForSelf(runtime, lena.authority, { address: QA_LOGINS.admin }, mailKeys);
	const owen = await signIn(QA_LOGINS.member2);
	out.member2 = { signedIn: owen.signedIn, session: owen.session.status, context: owen.authority.actor.context };
	const signup = await signInOnly(QA_LOGINS.signup);
	out.signup = {
		signedIn: signup.signedIn,
		session: signup.session.status,
		actor: await RequestActor.resolve(runtime, signup.session.sessionId as never),
	};
	for (const login of ["network", "sending"] as const) {
		const who = await signIn(QA_LOGINS[login]);
		const context = who.authority.actor.context;
		const selected = context.owner;
		// The two reads /settings/sharing makes for this viewer (apps/web/src/features/organizations/routes.tsx).
		const viewer = {
			kind: selected.kind === "organization" ? selected.organizationKind : selected.kind,
			session: who.session.sessionId,
			accountId: who.session.accountId,
			selected,
			canManage: context.kind === "seat" && context.role !== "member",
		} as never;
		const history = await readHistory(runtime, who.authority, { organization: selected });
		const names = history.status === "available" ? await namesFor(runtime, viewer, idsIn(history as never)) : null;
		const plantCtx = { session: who.session.sessionId, selected: { kind: "plant", id: plant } } as never;
		out[login] = {
			signedIn: who.signedIn,
			session: who.session.status,
			context: { kind: context.kind, role: "role" in context ? context.role : null, owner: selected },
			connections:
				history.status === "available"
					? history.activeRelationships.map((r) => ({
							kind: r.pair.kind,
							subject: "subject" in r.pair ? names![r.pair.subject.id] : null,
							organization: names![r.pair.organization.id],
						}))
					: history,
			// Planter-private data: the check-in reads for this actor, and the church's people reads.
			care: {
				current: bare(await care.readCurrent(runtime, who.authority)),
				history: bare(await care.readHistory(runtime, who.authority, { page: 1 })),
				trends: bare(await care.readTrends(runtime, who.authority)),
			},
			people: {
				list: bare(await runtime.transaction((tx) => peopleReader.listPeople(tx as never, plantCtx, { page: 1 }))),
				person: bare(
					await runtime.transaction((tx) => peopleReader.getPerson(tx as never, plantCtx, { personId: danielPerson })),
				),
				page: bare(await readPersonPage(runtime, plantCtx, { personId: danielPerson }, 10)),
			},
		};
	}
	console.log(JSON.stringify(out));
} finally {
	await closeDatabase(runtime);
	await closeDatabase(authDb);
	await closeDatabase(admin);
}
