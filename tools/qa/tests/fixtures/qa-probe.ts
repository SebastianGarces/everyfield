import { randomBytes } from "node:crypto";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase } from "../../../../packages/db/src/client.ts";
import { liveAccess, RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { createIdentityService } from "../../../../packages/domain/src/identity/index.ts";
import { createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import {
	createOrganizationAdapter,
	idsIn,
	namesFor,
	readEnrollment,
	readHistory,
	readMyResidency,
	readPipelineBoard,
	readPipelineGoals,
	readPipelinePersonRecord,
	type Viewer,
} from "../../../../packages/domain/src/organizations/index.ts";
import { peopleReader, readPersonPage } from "../../../../packages/domain/src/people/index.ts";
import { QA_LOGINS, QA_PASSWORD, QA_ROLES, roleUrl } from "../../qa-guard.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";

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
	enqueueMail: async () => "",
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

async function signIn(email: string) {
	const { signedIn, session } = await signInOnly(email);
	const authority = await RequestActor.resolve(runtime, session.sessionId as never);
	if (!(authority instanceof RequestActor)) throw Error(`actor ${email}: ${JSON.stringify(authority)}`);
	return { signedIn, session, authority };
}

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
	const delivery = (await admin.execute(sql`SELECT id FROM communication WHERE subject='QA delivery check'`)).rows[0]!
		.id as string;
	out.delivery = await gatedTransaction(runtime, async (tx) => ({
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
		const viewer: Viewer = {
			kind: selected.kind === "organization" ? selected.organizationKind : selected.kind,
			session: who.session.sessionId as Viewer["session"],
			accountId: who.session.accountId,
			selected,
			canManage: context.kind === "seat" && context.role !== "member",
			access: liveAccess(who.authority),
		};
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
			care: {
				current: bare(await care.readCurrent(runtime, who.authority)),
				history: bare(await care.readHistory(runtime, who.authority, { page: 1 })),
				trends: bare(await care.readTrends(runtime, who.authority)),
			},
			people: {
				list: bare(
					await gatedTransaction(runtime, (tx) => peopleReader.listPeople(tx as never, plantCtx, { page: 1 } as never)),
				),
				person: bare(
					await gatedTransaction(runtime, (tx) =>
						peopleReader.getPerson(tx as never, plantCtx, { personId: danielPerson } as never),
					),
				),
				page: bare(await readPersonPage(runtime, plantCtx, { personId: danielPerson }, 10)),
			},
		};
	}
	const personNamed = async (name: string) =>
		(await admin.execute(sql`SELECT id FROM person WHERE display_name=${name} AND plant_id IS NULL`)).rows[0]!
			.id as string;
	const pipelinePeople = {
		casey: await personNamed("Casey Lee"),
		jordan: await personNamed("Jordan Reyes"),
		morgan: await personNamed("Morgan Diaz"),
	};
	const enrollmentId = (
		await admin.execute(sql`SELECT id FROM development_enrollment WHERE person_id=${pipelinePeople.casey}`)
	).rows[0]!.id as string;
	type Read = { status: string; value?: any; refusal?: unknown };
	const value = (r: Read, pick: (v: any) => unknown) => (r.status === "ok" ? pick(r.value) : { refused: r.refusal });
	for (const login of [
		"graceOwner",
		"graceAdmin",
		"graceDirector",
		"graceStaff",
		"graceMember",
		"hillOwner",
	] as const) {
		const who = await signIn(QA_LOGINS[login]);
		const context = who.authority.actor.context;
		const owner = context.owner;
		const organization =
			owner.kind === "organization"
				? ((await admin.execute(sql`SELECT name FROM organization WHERE id=${owner.id}`)).rows[0]!.name as string)
				: null;
		const records: Record<string, unknown> = {};
		for (const [key, personId] of Object.entries(pipelinePeople))
			records[key] = value((await readPipelinePersonRecord(runtime, who.authority, { personId })) as Read, (v) => ({
				notes: v.notes.flatMap((n: { state: string; body?: string }) => (n.state === "current" ? [n.body] : [])),
				conversations: v.conversations.length,
				residency: v.residency.status,
			}));
		out[login] = {
			signedIn: who.signedIn,
			session: who.session.status,
			context: { kind: context.kind, role: "role" in context ? context.role : null, organization },
			board: value((await readPipelineBoard(runtime, who.authority, {})) as Read, (v) => ({
				audience: v.audience,
				count: v.stages.reduce((n: number, s: { count: number }) => n + s.count, 0),
				people: v.stages.flatMap((s: { people: { name: string }[] }) => s.people.map((p) => p.name)).sort(),
			})),
			goals: value((await readPipelineGoals(runtime, who.authority)) as Read, (v) => ({
				goals: v.goals.map((g: { rationale: string }) => g.rationale),
				conversations: v.conversations.months.reduce((n: number, m: { count: number }) => n + m.count, 0),
			})),
			records,
			enrollment: value((await readEnrollment(runtime, who.authority, { enrollmentId })) as Read, (v) => ({
				resident: v.resident,
				milestones: v.milestones.map(
					(m: { title: string; completion: { source: string; confirmer: string } | null }) => [
						m.title,
						m.completion && { source: m.completion.source, confirmer: m.completion.confirmer },
					],
				),
			})),
		};
	}
	const casey = await signIn(QA_LOGINS.resident);
	const residency = (await readMyResidency(runtime, casey.authority)) as Read;
	out.resident = {
		signedIn: casey.signedIn,
		session: casey.session.status,
		context: { kind: casey.authority.actor.context.kind, owner: casey.authority.actor.context.owner.kind },
		residency: value(residency, (v) =>
			v.status !== "linked"
				? { status: v.status }
				: {
						status: v.status,
						organizationName: v.organizationName,
						sharing: v.sharing,
						milestones: v.enrollments[0].milestones.map(
							(m: {
								title: string;
								completion: { source: string; confirmedOn: string | null } | null;
								feedback: { body: string }[];
							}) => [
								m.title,
								m.completion && { source: m.completion.source, confirmed: m.completion.confirmedOn !== null },
								m.feedback.map((f) => f.body),
							],
						),
					},
		),
		board: value((await readPipelineBoard(runtime, casey.authority, {})) as Read, () => "read"),
	};
	const riley = await signIn(QA_LOGINS.endedResident);
	out.endedResident = {
		signedIn: riley.signedIn,
		session: riley.session.status,
		context: { kind: riley.authority.actor.context.kind, owner: riley.authority.actor.context.owner.kind },
		residency: value((await readMyResidency(runtime, riley.authority)) as Read, (v) => v),
		board: value((await readPipelineBoard(runtime, riley.authority, {})) as Read, () => "read"),
		goals: value((await readPipelineGoals(runtime, riley.authority)) as Read, () => "read"),
	};
	const adapter = createOrganizationAdapter(
		{ invitation: async () => {}, invalidate: () => sql`SELECT 1` },
		{ candidates: async () => [] },
	);
	const ruth = await signIn(QA_LOGINS.hillOwner);
	const hill = ruth.authority.actor.context.owner;
	(out.hillOwner as Record<string, unknown>).aggregate = await gatedTransaction(runtime, (tx) =>
		adapter["pipelineSharing.checkAggregateAccess"](
			tx as never,
			ruth.session.sessionId as never,
			hill as never,
			{
				network: hill,
			} as never,
		),
	);
	const daniel = await signIn(QA_LOGINS.owner);
	(out.owner as Record<string, unknown>).pipeline = {
		board: value((await readPipelineBoard(runtime, daniel.authority, {})) as Read, () => "read"),
		goals: value((await readPipelineGoals(runtime, daniel.authority)) as Read, () => "read"),
		casey: value(
			(await readPipelinePersonRecord(runtime, daniel.authority, { personId: pipelinePeople.casey })) as Read,
			() => "read",
		),
		enrollment: value((await readEnrollment(runtime, daniel.authority, { enrollmentId })) as Read, () => "read"),
		residency: value((await readMyResidency(runtime, daniel.authority)) as Read, (v) => v.status),
	};
	console.log(JSON.stringify(out));
} finally {
	await closeDatabase(runtime);
	await closeDatabase(authDb);
	await closeDatabase(admin);
}
