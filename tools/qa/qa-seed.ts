import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase, type Database } from "../../packages/db/src/client.ts";
import { RequestActor } from "../../packages/domain/src/access/session.ts";
import { communicationWriter, type DeliveryTransport } from "../../packages/domain/src/communication/index.ts";
import { mailAddressHash } from "../../packages/domain/src/communication/delivery.ts";
import type { Instant } from "../../packages/contracts/src/common/time.ts";
import { nativeFromText } from "../../packages/contracts/src/documents/native.ts";
import { documentsWriter } from "../../packages/domain/src/documents/index.ts";
import { createFollowUpWriter } from "../../packages/domain/src/followups/index.ts";
import { createIdentityService, createInvitationService } from "../../packages/domain/src/identity/index.ts";
import { meetingsWriter } from "../../packages/domain/src/meetings/index.ts";
import { createPrivateCare } from "../../packages/domain/src/intelligence/index.ts";
import { createOnboardingProducer } from "../../packages/domain/src/onboarding/index.ts";
import {
	createOrganizationAdapter,
	pipelineWriter,
	programWriter,
	readPipelineBoard,
	readPipelinePersonRecord,
	residentWriter,
	type OrganizationEffects,
} from "../../packages/domain/src/organizations/index.ts";
import { RESIDENCY_TEMPLATE } from "../../packages/contracts/src/organizations/programs.ts";
import { accountPersonProducer, peopleWriter, personFields } from "../../packages/domain/src/people/index.ts";
import { createTaskWriter } from "../../packages/domain/src/tasks/index.ts";
import { teamsWriter } from "../../packages/domain/src/teams/index.ts";
import { receiveMailCallback } from "../../apps/web/src/server/jobs/webhook.ts";
import { FULL_ADDRESS, QA_LOGINS, QA_PASSWORD, QA_ROLES as ROLES, roleUrl, seedRefusal } from "./qa-guard.ts";
import { gatedTransaction } from "../../packages/domain/src/operations/writes.ts";

const CHURCH = "Harvest Point (QA)";
const RIVERSIDE = { name: "Riverside (QA)", city: "Dallas", owner: "Rachel Moss" } as const;
const SHARED = { name: "Ana Lee", label: "ana" } as const;
const ORIGIN = "https://qa-seed.everyfield.invalid";
const GLOBAL = "00000000-0000-0000-0000-000000000000";
const digest = () => randomBytes(32).toString("hex");

const address = (label: string) => `delivered+qa-${label}@resend.dev`;
const PEOPLE: [name: string, stage: string, label: string | null][] = [
	["Maria Santos", "core_group", "maria"],
	["Joao Santos", "core_group", "joao"],
	["James Okafor", "following_up", "james"],
	["Ana Lee", "launch_team", "ana"],
	["Tom Baker", "leader", "tom"],
	["Kim Wu", "attendee", null],
	["Sara Nunez", "interviewed", "sara"],
	["Leo Pratt", "prospect", "leo"],
	["Mia Hall", "prospect", null],
	["David Kim", "attendee", "david"],
];
const TEAMS = ["Worship", "Kids", "Hospitality"];
const TASKS = ["Book the school gym for launch Sunday", "Order welcome cards", "Draft the first-year budget"];
const MEETINGS = ["QA vision meeting", "QA orientation"];
const DOCUMENT = "QA welcome letter";
const MESSAGE = "Welcome to Harvest Point";
const ORGANIZATIONS = [
	{
		kind: "sending_network",
		name: "Harvest Network (QA)",
		login: QA_LOGINS.network,
		person: "Marcus Bell",
		role: "admin",
	},
	{
		kind: "sending_church",
		name: "Grace Church (QA)",
		login: QA_LOGINS.sending,
		person: "Grace Moreno",
		role: "owner",
	},
] as const;

type OrgKind = "sending_church" | "sending_network";
type OrgOwner = { kind: "organization"; id: string; organizationKind: OrgKind };
type Registration = { kind: OrgKind; name: string } | { kind: "discovery" };

type MailKeys = { encryptionKey: Buffer; addressKey: Buffer };

type Ctx = { session: string; selected: { kind: "plant"; id: string } };
type Reply = { status: string; value?: unknown };

function ok(what: string, reply: Reply): unknown {
	if (reply.status !== "ok") throw Error(`${what}: ${JSON.stringify(reply)}`);
	return reply.value;
}

async function rows(db: Database, query: ReturnType<typeof sql>) {
	return (await db.execute(query)).rows as Record<string, unknown>[];
}

async function logins(admin: Database, password: string) {
	const quoted = `'${password.replaceAll("'", "''")}'`;
	for (const [name, grant] of [
		[ROLES.runtime, "everyfield_runtime"],
		[ROLES.auth, "everyfield_auth"],
	] as const) {
		const exists = await rows(admin, sql`SELECT 1 FROM pg_roles WHERE rolname=${name}`);
		await admin.execute(
			sql.raw(
				exists.length
					? `ALTER ROLE ${name} LOGIN PASSWORD ${quoted}`
					: `CREATE ROLE ${name} LOGIN INHERIT PASSWORD ${quoted} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
			),
		);
		await admin.execute(sql.raw(`GRANT ${grant} TO ${name}`));
	}
}

class SeedRefusal extends Error {}

function sharedAddress(env: Readonly<Record<string, string | undefined>>): string {
	const first = (env.QA_TEST_RECIPIENTS ?? "").split(",")[0]!.trim();
	if (!first) return address(SHARED.label);
	if (!FULL_ADDRESS.test(first)) throw new SeedRefusal("QA_TEST_RECIPIENTS must start with one full address.");
	return first;
}

async function seed(env: Readonly<Record<string, string | undefined>>): Promise<string> {
	const refusal = seedRefusal(env);
	if (refusal) throw new SeedRefusal(refusal);
	const password = env.QA_ROLE_PASSWORD;
	if (!password || password.length < 16) throw new SeedRefusal("QA_ROLE_PASSWORD must hold at least 16 characters.");
	const source = env.DATABASE_URL!;
	const admin = createDatabase({ connectionString: source, max: 2 });
	let runtime: ReturnType<typeof createDatabase> | null = null,
		authDb: ReturnType<typeof createDatabase> | null = null;
	try {
		await logins(admin, password);
		runtime = createDatabase({ connectionString: roleUrl(source, ROLES.runtime, password), max: 2 });
		authDb = createDatabase({ connectionString: roleUrl(source, ROLES.auth, password), max: 2 });
		const keys = {
			encryptionKey: Buffer.from(env.IDENTITY_MAIL_KEY!, "hex"),
			addressKey: Buffer.from(env.IDENTITY_ADDRESS_KEY!, "hex"),
		};
		return await fill(admin, runtime, authDb, keys, sharedAddress(env));
	} finally {
		if (runtime) await closeDatabase(runtime);
		if (authDb) await closeDatabase(authDb);
		await closeDatabase(admin);
	}
}

async function fill(
	admin: Database,
	runtime: Database,
	authDb: Database,
	keys: MailKeys,
	shared: string,
): Promise<string> {
	const done: string[] = [];
	let ip = 0;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin: ORIGIN,
		secret: randomBytes(32).toString("hex"),
		trustedIp: () => `127.0.106.${ip}`,
		enqueueMail: async () => "",
		diagnostic: () => {},
	});
	const host = new URL(ORIGIN).host;
	const call = (path: string, body?: unknown) =>
		identity.handle(
			new Request(`${ORIGIN}/api/auth/${path}`, {
				method: "POST",
				headers: { host, origin: ORIGIN, "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
	const accountOf = async (email: string) =>
		(
			await rows(admin, sql`SELECT a.id FROM account a JOIN auth_user u ON u.id=a.auth_user_id WHERE u.email=${email}`)
		)[0]?.id as string | undefined;

	async function account(name: string, email: string, organization?: Registration, active = true): Promise<string> {
		const known = await accountOf(email);
		if (known) return known;
		ip++;
		const r = await call("register", {
			...(organization?.kind === "discovery"
				? { kind: "discovery" }
				: organization
					? { kind: organization.kind, organizationName: organization.name }
					: { kind: "plant_precreation" }),
			name,
			email,
			password: QA_PASSWORD,
			requestKey: randomUUID(),
		});
		if (!r.ok) throw Error(`register ${email}: ${r.status} ${await r.text()}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		if (active)
			await admin.execute(
				sql`UPDATE account SET registration_state='active' WHERE auth_user_id=(SELECT id FROM auth_user WHERE email=${email})`,
			);
		done.push(`login ${email}`);
		return (await accountOf(email))!;
	}

	const owner = await account("Daniel Reyes", QA_LOGINS.owner);
	const adminAccount = await account("Lena Park", QA_LOGINS.admin);
	const member = await account("Ruth Allen", QA_LOGINS.member);
	const overseers = [];
	for (const o of ORGANIZATIONS) overseers.push({ ...o, account: await account(o.person, o.login, o) });
	const spareMember = await account("Owen Price", QA_LOGINS.member2);
	await account("Hannah Cole", QA_LOGINS.signup, undefined, false);
	const triager = await account("Tess Morgan", QA_LOGINS.triage);
	if (
		!(
			await rows(
				admin,
				sql`SELECT 1 FROM platform_grant WHERE account_id=${triager} AND capability='feedback_triage' AND revoked_at IS NULL`,
			)
		).length
	) {
		await admin.execute(sql`INSERT INTO platform_grant(account_id,capability) VALUES(${triager},'feedback_triage')`);
		done.push("feedback triage grant");
	}

	const sessions = new Map<string, string>();
	const sessionOf = async (email: string) => {
		const open = sessions.get(email);
		if (open) return open;
		const signedIn = await call("sign-in/email", { email, password: QA_PASSWORD });
		if (!signedIn.ok) throw Error(`sign in ${email}: ${signedIn.status}`);
		const row = await rows(
			admin,
			sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE u.email=${email}
				ORDER BY s.created_at DESC LIMIT 1`,
		);
		const id = row[0]!.id as string;
		sessions.set(email, id);
		return id;
	};
	const ownerSession = () => sessionOf(QA_LOGINS.owner);

	const noop = async () => {};
	const onboarding = createOnboardingProducer({ relationships: noop, enqueue: noop });
	const write = <T>(run: (tx: never) => Promise<T>) => gatedTransaction(runtime, (tx) => run(tx as never));
	async function church(name: string, city: string, ownerAccount: string, ownerEmail: string, label: string) {
		let id = (await rows(admin, sql`SELECT id FROM plant WHERE name=${name} ORDER BY id LIMIT 1`))[0]?.id as
			string | undefined;
		if (!id) {
			const s = await sessionOf(ownerEmail);
			const created = ok(
				`createPlant ${name}`,
				await write((tx) =>
					onboarding.createPlant(
						tx,
						{ session: s, selected: { kind: "account", id: ownerAccount } } as never,
						{
							requestKey: randomUUID(),
							expectedRevision: "1",
							input: { name, locality: { city }, confirmed: true },
						} as never,
					),
				),
			) as { plant: { id: string } };
			id = created.plant.id;
			done.push(`church${label}`);
		}
		const completed = await rows(admin, sql`SELECT onboarding_completed_at FROM plant WHERE id=${id}`);
		if (!completed[0]!.onboarding_completed_at) {
			const c = { session: await sessionOf(ownerEmail), selected: { kind: "plant", id } };
			const revision = (await rows(admin, sql`SELECT revision::text AS r FROM plant WHERE id=${id}`))[0]!.r as string;
			ok(
				`complete onboarding ${name}`,
				await write((tx) =>
					onboarding.complete(
						tx,
						c as never,
						{ requestKey: randomUUID(), expectedRevision: revision, input: {} } as never,
					),
				),
			);
			done.push(`onboarding${label}`);
		}
		return id;
	}
	const plantId = await church(CHURCH, "Austin", owner, QA_LOGINS.owner, "");
	const plant = { kind: "plant", id: plantId } as const;
	const ctx = async (): Promise<Ctx> => ({ session: await ownerSession(), selected: plant });

	for (const [accountId, role, name, label] of [
		[adminAccount, "admin", "Lena Park", "admin seat"],
		[member, "member", "Ruth Allen", "member seat"],
		[spareMember, "member", "Owen Price", "spare member seat Owen Price"],
	] as const) {
		const seat = await rows(admin, sql`SELECT 1 FROM seat WHERE account_id=${accountId} AND plant_id=${plantId}`);
		if (seat.length) continue;
		await admin.execute(
			sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${accountId},${plantId},${role},clock_timestamp())`,
		);
		await write((tx) =>
			accountPersonProducer.ensureAccountPerson(tx, {
				accountId,
				owner: plant,
				selection: { kind: "create", displayName: name },
			} as never),
		);
		done.push(label);
	}

	const personIn = async (church: string, name: string) =>
		(
			await rows(
				admin,
				sql`SELECT id, revision::text AS revision FROM person WHERE plant_id=${church} AND display_name=${name} AND state='live' LIMIT 1`,
			)
		)[0] as { id: string; revision: string } | undefined;
	const personId = (name: string) => personIn(plantId, name);

	for (const [displayName, stage, label] of PEOPLE) {
		if (await personId(displayName)) continue;
		const c = await ctx();
		const email = displayName === SHARED.name ? shared : label ? address(label) : null;
		ok(
			`create ${displayName}`,
			await write((tx) =>
				peopleWriter.createPerson(
					tx,
					c as never,
					{
						requestKey: randomUUID(),
						input: { displayName, stage, email, source: "other" },
					} as never,
				),
			),
		);
		done.push(`person ${displayName}`);
	}

	const household = async () =>
		(await rows(admin, sql`SELECT id FROM household WHERE plant_id=${plantId} AND name='Santos household'`))[0]?.id as
			string | undefined;
	if (!(await household())) {
		const c = await ctx();
		const maria = (await personId("Maria Santos"))!;
		ok(
			"household",
			await write((tx) =>
				personFields.createHouseholdWithHead(tx, c as never, {
					requestKey: randomUUID(),
					expectedRevision: maria.revision,
					input: { name: "Santos household", city: "Austin", headPersonId: maria.id },
				}),
			),
		);
		done.push("household");
	}
	const joao = (await personId("Joao Santos"))!;
	if (!(await rows(admin, sql`SELECT 1 FROM person WHERE id=${joao.id} AND household_id IS NOT NULL`)).length) {
		const c = await ctx(),
			householdId = (await household())!;
		ok(
			"household spouse",
			await write((tx) =>
				personFields.addToHousehold(tx, c as never, {
					requestKey: randomUUID(),
					expectedRevision: joao.revision,
					input: { householdId, personId: joao.id, role: "spouse" },
				}),
			),
		);
		done.push("household spouse");
	}

	for (const name of TEAMS) {
		if ((await rows(admin, sql`SELECT 1 FROM team WHERE plant_id=${plantId} AND name=${name}`)).length) continue;
		const c = await ctx();
		ok(
			`team ${name}`,
			await write((tx) => teamsWriter.create(tx, c as never, { requestKey: randomUUID(), input: { name } })),
		);
		done.push(`team ${name}`);
	}

	const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
	for (const [index, title] of MEETINGS.entries()) {
		if ((await rows(admin, sql`SELECT 1 FROM meeting WHERE plant_id=${plantId} AND title=${title}`)).length) continue;
		const c = await ctx();
		const guests: string[] = [];
		for (const name of ["Sara Nunez", "Leo Pratt", "James Okafor"]) guests.push((await personId(name))!.id);
		ok(
			`meeting ${title}`,
			await write((tx) =>
				meetingsWriter.schedule(tx, c as never, {
					requestKey: randomUUID(),
					input: { type: index === 0 ? "vision_meeting" : "orientation", title, date, time: "18:30", guests },
				}),
			),
		);
		done.push(`meeting ${title}`);
	}

	const tasks = createTaskWriter({ reminders: async () => {} } as never);
	for (const title of TASKS) {
		if ((await rows(admin, sql`SELECT 1 FROM task WHERE plant_id=${plantId} AND title=${title}`)).length) continue;
		const c = await ctx();
		ok(
			`task ${title}`,
			await write((tx) =>
				tasks.create(tx, c as never, { requestKey: randomUUID(), input: { title, assigneeIds: [adminAccount] } }),
			),
		);
		done.push(`task ${title}`);
	}

	const followups = createFollowUpWriter({ reminders: async () => {} } as never);
	for (const name of ["James Okafor", "Leo Pratt"]) {
		const person = (await personId(name))!;
		const open = await rows(
			admin,
			sql`SELECT 1 FROM task WHERE plant_id=${plantId} AND category='follow_up' AND person_id=${person.id}`,
		);
		if (open.length) continue;
		await admin.execute(
			sql`UPDATE person SET stage='core_group', revision=revision+1 WHERE tenant_id=${plantId} AND linked_account_id=${adminAccount} AND stage<>'core_group'`,
		);
		const c = await ctx();
		ok(
			`follow-up ${name}`,
			await write((tx) =>
				followups.createFollowUp(tx, c as never, {
					requestKey: randomUUID(),
					input: { personId: person.id, assigneeIds: [adminAccount] },
				}),
			),
		);
		done.push(`follow-up ${name}`);
	}

	if (!(await rows(admin, sql`SELECT 1 FROM document WHERE tenant_id=${plantId} AND title=${DOCUMENT}`)).length) {
		const actor = await RequestActor.resolve(runtime, (await ctx()).session as never);
		if (!(actor instanceof RequestActor)) throw Error(`document actor: ${JSON.stringify(actor)}`);
		ok(
			"document",
			await documentsWriter.saveNative(runtime, actor, {
				title: DOCUMENT,
				body: nativeFromText("Welcome to Harvest Point. We meet Sundays at 10 AM at Travis Elementary."),
				expectedRevision: "0",
			}),
		);
		done.push("document");
	}

	if (!(await rows(admin, sql`SELECT 1 FROM communication WHERE plant_id=${plantId} AND subject=${MESSAGE}`)).length) {
		const c = await ctx();
		const maria = (await personId("Maria Santos"))!;
		ok(
			"message",
			await write((tx) =>
				communicationWriter.saveDraft(tx, c as never, {
					requestKey: randomUUID(),
					input: {
						subject: MESSAGE,
						bodyHtml: "<p>Hello {{name}}, thank you for visiting Harvest Point.</p>",
						audience: { groups: [], teamIds: [], personIds: [maria.id] },
					},
				}),
			),
		);
		done.push("message");
	}

	done.push(...(await mailCases(admin, runtime, keys, { plantId, adminAccount, ctx, personId })));

	const proofs = new Map<string, string>();
	const effects: OrganizationEffects = {
		invitation: async (_tx, input) => void proofs.set(input.invitationId, input.proof),
		invalidate: (_tx, input) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
	};
	const organizations = createOrganizationAdapter(effects, { candidates: async () => [] });
	async function organizationRow(kind: OrgKind, name: string, city = "Austin"): Promise<OrgOwner> {
		let id = (
			await rows(admin, sql`SELECT id FROM organization WHERE name=${name} AND kind=${kind} ORDER BY id LIMIT 1`)
		)[0]?.id as string | undefined;
		if (!id) {
			id = randomUUID();
			await admin.execute(
				sql`INSERT INTO organization(id,kind,name,city,timezone,material_revision) VALUES(${id},${kind},${name},${city},'America/Chicago',1)`,
			);
			done.push(name);
		}
		return { kind: "organization", id, organizationKind: kind };
	}
	async function seatRow(accountId: string, orgId: string, role: string, label: string): Promise<string> {
		const seat = await rows(admin, sql`SELECT id FROM seat WHERE account_id=${accountId} AND organization_id=${orgId}`);
		if (seat.length) return seat[0]!.id as string;
		done.push(label);
		return (
			await rows(
				admin,
				sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${accountId},${orgId},${role},clock_timestamp()) RETURNING id`,
			)
		)[0]!.id as string;
	}
	async function relate(
		subject: { kind: "plant"; id: string } | OrgOwner,
		organization: OrgOwner,
		inviter: string,
		recipient: string,
	): Promise<boolean> {
		const column = sql.raw(subject.kind === "plant" ? "plant_id" : "sending_church_id");
		const connected = await rows(
			admin,
			sql`SELECT 1 FROM affiliation WHERE ${column}=${subject.id} AND organization_id=${organization.id} AND ended_at IS NULL`,
		);
		if (connected.length) return false;
		const s = (await sessionOf(inviter)) as never;
		const stale = await rows(
			admin,
			sql`SELECT i.id, i.revision::text AS revision FROM invitation i JOIN relationship_invitation r ON r.invitation_id=i.id
				WHERE r.${column}=${subject.id} AND r.organization_id=${organization.id} AND i.state='pending'`,
		);
		for (const i of stale)
			await gatedTransaction(runtime, (tx) =>
				organizations["associations.revokeInvitation"](
					tx,
					s,
					subject as never,
					{
						requestKey: randomUUID(),
						expectedRevision: i.revision as string,
						input: { invitationId: i.id as string },
					} as never,
				),
			);
		const revision = (
			await rows(
				admin,
				subject.kind === "plant"
					? sql`SELECT revision::text AS r FROM plant WHERE id=${subject.id}`
					: sql`SELECT revision::text AS r FROM organization WHERE id=${subject.id}`,
			)
		)[0]!.r as string;
		const pair =
			subject.kind === "plant"
				? { kind: "plant", subject, organization }
				: { kind: "sending_church", subject, organization };
		const invited = await gatedTransaction(runtime, (tx) =>
			organizations["associations.invite"](
				tx,
				s,
				subject as never,
				{ requestKey: randomUUID(), expectedRevision: revision, input: { pair, recipientEmail: recipient } } as never,
			),
		);
		const answer = (await sessionOf(recipient)) as never;
		await gatedTransaction(runtime, (tx) =>
			organizations["associations.acceptInvitation"](
				tx,
				answer,
				organization as never,
				{
					requestKey: randomUUID(),
					expectedRevision: invited.revision,
					input: { invitationId: invited.invitationId, proof: proofs.get(invited.invitationId)!, decision: "accept" },
				} as never,
			),
		);
		return true;
	}
	for (const o of overseers) {
		const organization = await organizationRow(o.kind, o.name);
		await seatRow(o.account, organization.id, o.role, `${o.name} ${o.role} seat`);
		if (await relate(plant, organization, QA_LOGINS.owner, o.login)) done.push(`connection ${o.name}`);
	}

	const riversideOwner = await account(RIVERSIDE.owner, QA_LOGINS.riverside);
	const riverside = await church(
		RIVERSIDE.name,
		RIVERSIDE.city,
		riversideOwner,
		QA_LOGINS.riverside,
		` ${RIVERSIDE.name}`,
	);
	if (!(await personIn(riverside, SHARED.name))) {
		const c = { session: await sessionOf(QA_LOGINS.riverside), selected: { kind: "plant", id: riverside } };
		ok(
			`create ${SHARED.name} in ${RIVERSIDE.name}`,
			await write((tx) =>
				peopleWriter.createPerson(
					tx,
					c as never,
					{
						requestKey: randomUUID(),
						input: { displayName: SHARED.name, stage: "attendee", email: shared, source: "other" },
					} as never,
				),
			),
		);
		done.push(`person ${SHARED.name} in ${RIVERSIDE.name}`);
	}

	await multiplication({
		admin,
		runtime,
		done,
		account,
		sessionOf,
		organizationRow,
		seatRow,
		relate,
		plant,
		organizations,
	});

	const wikiWritten = await wiki(admin);
	done.push(...(await wikiCases(admin, plantId, owner)));
	if (wikiWritten) done.push("wiki");
	done.push(...(await checkIns(admin, runtime, owner, plantId, ownerSession)));

	for (const id of sessions.values()) await admin.execute(sql`DELETE FROM auth_session WHERE id=${id}`);
	return done.length ? `QA seed wrote: ${done.join(", ")}.` : "QA seed: the branch is already complete.";
}

const GRACE = "Grace Austin (QA)";
const HILL = "Hill Country Network (QA)";
const GRACE_STAFF = [
	{ name: "Dana Brooks", login: QA_LOGINS.graceOwner, role: "owner" },
	{ name: "Luis Ortega", login: QA_LOGINS.graceAdmin, role: "admin" },
	{ name: "Ana Ruiz", login: QA_LOGINS.graceDirector, role: "member" },
	{ name: "Dee Walker", login: QA_LOGINS.graceStaff, role: "member" },
	{ name: "Ben Carter", login: QA_LOGINS.graceMember, role: "member" },
] as const;
const RESIDENT = { name: "Casey Lee", login: QA_LOGINS.resident } as const;
const HILL_OWNER = { name: "Ruth Calder", login: QA_LOGINS.hillOwner } as const;
const PROGRAM = "Church planting residency";
const MILESTONES = {
	group: "Start a small group and raise a replacement",
	vision: "Present your vision to the sending church leadership",
	prospectus: "Write a church planting prospectus",
	preach: "Preach on a Sunday",
} as const;
const PIPELINE_NOTES = [
	{
		by: QA_LOGINS.graceDirector,
		about: "Casey Lee",
		body: "Casey is steady with the youth group. We talked through the Austin plant timeline.",
	},
	{
		by: QA_LOGINS.graceStaff,
		about: "Jordan Reyes",
		body: "Jordan asked about leading a launch team next spring. Follow up after Easter.",
	},
	{
		by: QA_LOGINS.graceOwner,
		about: "Jordan Reyes",
		body: "Jordan's family is open to a move. Revisit at the fall elders meeting.",
	},
] as const;
const FEEDBACK = "Clear outline and a warm close. Next time, slow down in the second point.";
const GOAL = "Send two new churches from Grace Austin by 2028.";
const CONVERSATIONS = [
	{
		by: QA_LOGINS.graceDirector,
		about: "Casey Lee",
		daysAgo: 10,
		note: "Talked through the first months of the residency.",
	},
	{
		by: QA_LOGINS.graceStaff,
		about: "Jordan Reyes",
		daysAgo: 3,
		note: "Coffee with Jordan about the potential leader track.",
	},
] as const;

type Multiplication = {
	admin: Database;
	runtime: Database;
	done: string[];
	account: (name: string, email: string, organization?: Registration) => Promise<string>;
	sessionOf: (email: string) => Promise<string>;
	organizationRow: (kind: OrgKind, name: string, city?: string) => Promise<OrgOwner>;
	seatRow: (accountId: string, orgId: string, role: string, label: string) => Promise<string>;
	relate: (
		subject: { kind: "plant"; id: string } | OrgOwner,
		organization: OrgOwner,
		inviter: string,
		recipient: string,
	) => Promise<boolean>;
	plant: { kind: "plant"; id: string };
	organizations: ReturnType<typeof createOrganizationAdapter>;
};

const shift = (day: string, offset: number) =>
	new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

async function multiplication(m: Multiplication): Promise<void> {
	const { admin, runtime, done } = m;
	const accounts = new Map<string, string>();
	for (const s of GRACE_STAFF)
		accounts.set(s.login, await m.account(s.name, s.login, { kind: "sending_church", name: GRACE }));
	const caseyAccount = await m.account(RESIDENT.name, RESIDENT.login, { kind: "discovery" });
	const ruth = await m.account(HILL_OWNER.name, HILL_OWNER.login, { kind: "sending_network", name: HILL });

	const grace = await m.organizationRow("sending_church", GRACE);
	const seats = new Map<string, string>();
	for (const s of GRACE_STAFF)
		seats.set(s.login, await m.seatRow(accounts.get(s.login)!, grace.id, s.role, `${GRACE} ${s.role} seat ${s.name}`));
	const hill = await m.organizationRow("sending_network", HILL);
	await m.seatRow(ruth, hill.id, "owner", `${HILL} owner seat ${HILL_OWNER.name}`);

	const authority = async (email: string) => {
		const actor = await RequestActor.resolve(runtime, (await m.sessionOf(email)) as never);
		if (!(actor instanceof RequestActor)) throw Error(`actor ${email}: ${JSON.stringify(actor)}`);
		return actor;
	};
	const personOf = async (org: string, name: string) =>
		(
			await rows(
				admin,
				sql`SELECT id FROM person WHERE organization_id=${org} AND plant_id IS NULL AND display_name=${name} AND state='live' LIMIT 1`,
			)
		)[0]?.id as string | undefined;
	const stages = async (email: string) =>
		Object.fromEntries(
			(
				ok("pipeline board", await readPipelineBoard(runtime, await authority(email), {})) as {
					stages: { label: string; id: string }[];
				}
			).stages.map((s) => [s.label, s.id]),
		) as Record<string, string>;
	async function place(org: string, by: string, name: string, email: string, responsible: string | null) {
		const known = await personOf(org, name);
		if (known) return known;
		const personId = randomUUID();
		ok(
			`add ${name}`,
			await pipelineWriter.addPerson(runtime, await authority(by), {
				personId,
				displayName: name,
				email,
				responsibleSeatId: responsible,
				stageId: (await stages(by))["Potential leader"]!,
			}),
		);
		done.push(`pipeline person ${name}`);
		return personId;
	}
	const casey = await place(
		grace.id,
		QA_LOGINS.graceOwner,
		RESIDENT.name,
		RESIDENT.login,
		seats.get(QA_LOGINS.graceDirector)!,
	);
	const jordan = await place(
		grace.id,
		QA_LOGINS.graceOwner,
		"Jordan Reyes",
		address("jordan"),
		seats.get(QA_LOGINS.graceStaff)!,
	);
	await place(hill.id, HILL_OWNER.login, "Morgan Diaz", address("morgan"), null);
	const people: Record<string, string> = { "Casey Lee": casey, "Jordan Reyes": jordan };

	const moved = await rows(
		admin,
		sql`SELECT 1 FROM pipeline_stage_move m JOIN pipeline_person pp ON pp.id=m.pipeline_person_id
			WHERE pp.person_id=${casey} AND m.from_stage_id IS NOT NULL`,
	);
	if (!moved.length) {
		const dana = await authority(QA_LOGINS.graceOwner);
		const record = ok("Casey's record", await readPipelinePersonRecord(runtime, dana, { personId: casey })) as {
			revision: string;
		};
		ok(
			"move Casey",
			await pipelineWriter.movePerson(runtime, dana, {
				personId: casey,
				expectedRevision: record.revision,
				stageId: (await stages(QA_LOGINS.graceOwner)).Resident!,
				reason: "Started the residency with Ana.",
			}),
		);
		done.push(`stage move ${RESIDENT.name}`);
	}

	for (const n of PIPELINE_NOTES) {
		if ((await rows(admin, sql`SELECT 1 FROM person_note WHERE tenant_id=${grace.id} AND body=${n.body}`)).length)
			continue;
		ok(
			`note on ${n.about}`,
			await pipelineWriter.addNote(runtime, await authority(n.by), {
				personId: people[n.about]!,
				noteId: randomUUID(),
				body: n.body,
			}),
		);
		done.push(`note by ${GRACE_STAFF.find((s) => s.login === n.by)!.name} on ${n.about}`);
	}

	const program = async () =>
		(
			await rows(
				admin,
				sql`SELECT id, revision::text AS revision, current_version_id FROM development_program
					WHERE organization_id=${grace.id} AND name=${PROGRAM} LIMIT 1`,
			)
		)[0] as { id: string; revision: string; current_version_id: string | null } | undefined;
	if (!(await program())) {
		ok(
			"residency",
			await programWriter.createProgram(runtime, await authority(QA_LOGINS.graceOwner), {
				programId: randomUUID(),
				kind: "residency",
				name: PROGRAM,
				directorSeatId: seats.get(QA_LOGINS.graceDirector)!,
				plan: {
					rhythm: "monthly",
					expectedMonths: 18,
					stages: RESIDENCY_TEMPLATE.stages,
					milestones: Object.values(MILESTONES).map((title) => ({
						lineage: randomUUID(),
						title,
						description: title === MILESTONES.preach ? "Preach at a Sunday gathering and debrief with Ana." : null,
						handsOn: title === MILESTONES.preach,
					})),
					readings: [],
				},
			}),
		);
		done.push(`program ${PROGRAM}`);
	}
	const draft = (await program())!;
	if (!draft.current_version_id) {
		ok(
			"publish residency",
			await programWriter.publishVersion(runtime, await authority(QA_LOGINS.graceDirector), {
				programId: draft.id,
				expectedRevision: draft.revision,
			}),
		);
		done.push(`published ${PROGRAM}`);
	}
	const published = (await program())!;
	const milestoneId = async (title: string) =>
		(
			await rows(
				admin,
				sql`SELECT id FROM development_milestone WHERE version_id=${published.current_version_id} AND title=${title}`,
			)
		)[0]!.id as string;

	const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
	const enrollmentOf = async () =>
		(
			await rows(
				admin,
				sql`SELECT id FROM development_enrollment WHERE person_id=${casey} AND program_id=${published.id} AND status='active'`,
			)
		)[0]?.id as string | undefined;
	if (!(await enrollmentOf())) {
		const stage = (
			await rows(
				admin,
				sql`SELECT id FROM development_stage WHERE version_id=${published.current_version_id} AND label='Assimilating'`,
			)
		)[0]!.id as string;
		ok(
			"enroll Casey",
			await programWriter.enroll(runtime, await authority(QA_LOGINS.graceOwner), {
				enrollmentId: randomUUID(),
				programId: published.id,
				personId: casey,
				cohort: "2026",
				startedOn: shift(today, -60),
				expectedEndOn: shift(today, 480),
				stageId: stage,
				nextMeetingAt: `${shift(today, 7)}T19:00:00`,
			}),
		);
		done.push(`enrollment ${RESIDENT.name}`);
	}
	const enrollmentId = (await enrollmentOf())!;
	const completion = async (title: string) =>
		(
			await rows(
				admin,
				sql`SELECT c.source, c.confirmed_at IS NOT NULL AS confirmed FROM enrollment_milestone c
					JOIN development_milestone d ON d.id=c.milestone_id WHERE c.enrollment_id=${enrollmentId} AND d.title=${title}`,
			)
		)[0] as { source: string; confirmed: boolean } | undefined;
	const preach = await milestoneId(MILESTONES.preach);
	if (!(await completion(MILESTONES.preach))) {
		ok(
			"record milestone",
			await programWriter.recordMilestone(runtime, await authority(QA_LOGINS.graceDirector), {
				enrollmentId,
				milestoneId: preach,
				completedOn: shift(today, -20),
			}),
		);
		done.push(`milestone ${MILESTONES.preach}`);
	}
	if (
		!(
			await rows(admin, sql`SELECT 1 FROM assignment_feedback WHERE enrollment_id=${enrollmentId} AND body=${FEEDBACK}`)
		).length
	) {
		ok(
			"feedback",
			await programWriter.addFeedback(runtime, await authority(QA_LOGINS.graceDirector), {
				feedbackId: randomUUID(),
				enrollmentId,
				milestoneId: preach,
				body: FEEDBACK,
			}),
		);
		done.push(`feedback on ${MILESTONES.preach}`);
	}

	const linked = sql`SELECT 1 FROM residency_link WHERE account_id=${caseyAccount} AND organization_id=${grace.id} AND ended_at IS NULL`;
	if (!(await rows(admin, linked)).length) {
		const proofs = new Map<string, string>();
		const invitations = createInvitationService({
			db: runtime,
			origin: ORIGIN,
			budgetSecret: randomBytes(32).toString("hex"),
			people: accountPersonProducer,
			addressBlocked: () => sql`false`,
			enqueueMail: async (_tx, mail) => {
				const proof = /#proof=(\S+)/.exec(mail.text)?.[1];
				if (proof) proofs.set(mail.invitationId, decodeURIComponent(proof));
				return "";
			},
		});
		const luis = await authority(QA_LOGINS.graceAdmin);
		for (const i of await rows(
			admin,
			sql`SELECT id, revision::text AS revision FROM invitation WHERE tenant_id=${grace.id} AND purpose='residency_link'
				AND resident_person_id=${casey} AND state='pending'`,
		))
			await invitations.revoke(luis, {
				requestKey: randomUUID(),
				expectedRevision: i.revision,
				input: { invitationId: i.id },
			});
		const revision = (await rows(admin, sql`SELECT revision::text AS r FROM organization WHERE id=${grace.id}`))[0]!
			.r as string;
		const sent = await invitations.inviteResident(luis, {
			requestKey: randomUUID(),
			expectedRevision: revision,
			input: { organization: grace, personId: casey, recipientEmail: RESIDENT.login },
		});
		const invitationId = sent.invitation.invitationId as string;
		await invitations.respondResident(await m.sessionOf(RESIDENT.login), {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: {
				invitationId,
				proof: proofs.get(invitationId)!,
				decision: "accept",
				choices: { shareFoundations: false, shareMilestones: true },
			},
		});
		done.push(`residency link ${RESIDENT.name}`);
	}
	const vision = await milestoneId(MILESTONES.vision);
	if (!(await completion(MILESTONES.vision))) {
		ok(
			"mark milestone",
			await residentWriter.markMilestone(runtime, await authority(RESIDENT.login), {
				enrollmentId,
				milestoneId: vision,
			}),
		);
		done.push(`marked ${MILESTONES.vision}`);
	}
	if (!(await completion(MILESTONES.vision))!.confirmed) {
		ok(
			"confirm milestone",
			await programWriter.confirmMilestone(runtime, await authority(QA_LOGINS.graceDirector), {
				enrollmentId,
				milestoneId: vision,
			}),
		);
		done.push(`confirmed ${MILESTONES.vision}`);
	}

	if (
		!(await rows(admin, sql`SELECT 1 FROM sending_goal WHERE organization_id=${grace.id} AND rationale=${GOAL}`)).length
	) {
		ok(
			"sending goal",
			await pipelineWriter.saveGoal(runtime, await authority(QA_LOGINS.graceOwner), {
				goalId: randomUUID(),
				expectedRevision: null,
				leaderTarget: 4,
				plantTarget: 2,
				targetYear: 2028,
				rationale: GOAL,
				countingFrom: null,
				counts: [],
			}),
		);
		done.push("sending goal");
	}
	for (const c of CONVERSATIONS) {
		if (
			(
				await rows(
					admin,
					sql`SELECT 1 FROM leadership_conversation WHERE organization_id=${grace.id} AND note=${c.note}`,
				)
			).length
		)
			continue;
		ok(
			`conversation with ${c.about}`,
			await pipelineWriter.logConversation(runtime, await authority(c.by), {
				conversationId: randomUUID(),
				personId: people[c.about]!,
				occurredOn: shift(today, -c.daysAgo),
				note: c.note,
			}),
		);
		done.push(`conversation with ${c.about}`);
	}

	if (await m.relate(grace, hill, QA_LOGINS.graceOwner, HILL_OWNER.login)) done.push(`connection ${GRACE} to ${HILL}`);
	const link = (
		await rows(
			admin,
			sql`SELECT f.id, f.revision::text AS revision, coalesce(s.share_pipeline_totals,false) AS shared FROM affiliation f
				LEFT JOIN pipeline_sharing s ON s.relationship_id=f.id
				WHERE f.sending_church_id=${grace.id} AND f.organization_id=${hill.id} AND f.ended_at IS NULL`,
		)
	)[0]! as { id: string; revision: string; shared: boolean };
	if (!link.shared) {
		const s = (await m.sessionOf(QA_LOGINS.graceOwner)) as never;
		await gatedTransaction(runtime, (tx) =>
			m.organizations["pipelineSharing.setConsent"](
				tx,
				s,
				grace as never,
				{
					requestKey: randomUUID(),
					expectedRevision: link.revision,
					input: { relationshipId: link.id, sharePipelineTotals: true },
				} as never,
			),
		);
		done.push(`pipeline totals shared with ${HILL}`);
	}

	if (await m.relate(m.plant, grace, QA_LOGINS.owner, QA_LOGINS.graceOwner)) done.push(`connection ${GRACE}`);
	if (await m.relate(m.plant, hill, QA_LOGINS.owner, HILL_OWNER.login)) done.push(`connection ${HILL}`);
}

const DELIVERY = "QA delivery check";
const DELIVERY_TO = ["Maria Santos", "Sara Nunez", "Leo Pratt"];
const REFUSED = { name: "Leo Pratt", address: address("leo") };
const RESTORE_REASON = "Lena confirmed her inbox works again after the first bounce.";
const BOUNCES = {
	refused: "qa-seed/bounce/refused-recipient",
	adminFirst: "qa-seed/bounce/admin-1",
	adminAgain: "qa-seed/bounce/admin-2",
} as const;

async function bounce(tx: Database, keys: MailKeys, eventKey: string, address: string, daysAgo: number) {
	const event = randomUUID(),
		hash = mailAddressHash(keys.addressKey, address);
	await tx.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,processed_at,safe_payload)
		VALUES(${event}::uuid,${eventKey},${eventKey},'bounced',clock_timestamp()-make_interval(days=>${daysAgo}),
			clock_timestamp()-make_interval(days=>${daysAgo}),${digest()},clock_timestamp()-make_interval(days=>${daysAgo}),
			'{"hard_bounce":true}'::jsonb)`);
	return (
		await rows(
			tx,
			sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
				VALUES(${hash},'hard_bounce',${event}::uuid,clock_timestamp()-make_interval(days=>${daysAgo}))
				ON CONFLICT(address_hash) DO UPDATE SET reason=excluded.reason,source_event_id=excluded.source_event_id,
					suppressed_at=excluded.suppressed_at,cleared_at=NULL,clear_operation_id=NULL,revision=suppression.revision+1
				RETURNING id`,
		)
	)[0]!.id as string;
}

async function mailCases(
	admin: Database,
	runtime: Database,
	keys: MailKeys,
	p: {
		plantId: string;
		adminAccount: string;
		ctx: () => Promise<Ctx>;
		personId: (name: string) => Promise<{ id: string; revision: string } | undefined>;
	},
): Promise<string[]> {
	const done: string[] = [];
	const known = async (eventKey: string) =>
		(await rows(admin, sql`SELECT 1 FROM provider_event WHERE event_key=${eventKey}`)).length > 0;

	if (!(await known(BOUNCES.refused))) {
		await admin.transaction((tx) => bounce(tx as never, keys, BOUNCES.refused, REFUSED.address, 10));
		done.push(`suppressed address of ${REFUSED.name}`);
	}

	const message = async () =>
		(
			await rows(
				admin,
				sql`SELECT id, revision::text AS revision FROM communication WHERE plant_id=${p.plantId} AND subject=${DELIVERY}
					ORDER BY created_at LIMIT 1`,
			)
		)[0] as { id: string; revision: string } | undefined;
	if (!(await message())) {
		const c = await p.ctx();
		const personIds: string[] = [];
		for (const name of DELIVERY_TO) personIds.push((await p.personId(name))!.id);
		ok(
			"delivery message",
			await gatedTransaction(runtime, (tx) =>
				communicationWriter.saveDraft(tx as never, c as never, {
					requestKey: randomUUID(),
					input: {
						subject: DELIVERY,
						bodyHtml: "<p>Hello {{name}}, this is a short note to check that our church email reaches you.</p>",
						audience: { groups: [], teamIds: [], personIds },
					},
				}),
			),
		);
		const draft = (await message())!;
		const at = new Date(Math.ceil((Date.now() + 60_000) / 60_000) * 60_000).toISOString();
		ok(
			"schedule delivery message",
			await gatedTransaction(runtime, (tx) =>
				communicationWriter.scheduleReviewed(tx as never, c as never, {
					requestKey: randomUUID(),
					expectedRevision: draft.revision,
					input: { communicationId: draft.id, scheduledAt: at },
				}),
			),
		);
		const scheduled = (await message())!;
		const actor = await RequestActor.resolve(runtime, c.session as never);
		if (!(actor instanceof RequestActor)) throw Error(`delivery actor: ${JSON.stringify(actor)}`);
		const accepting: DeliveryTransport = {
			paused: false,
			send: async (batch) => ({ outcome: "ids", ids: batch.messages.map(() => `qa-seed-${randomUUID()}`) }),
			cancel: async (ids) => ids.map(() => ({ outcome: "unknown" })),
			reschedule: async (ids) => ids.map(() => ({ outcome: "unknown" })),
		};
		const result = ok(
			"send delivery message",
			await communicationWriter.sendReviewed(
				runtime,
				actor,
				{ requestKey: randomUUID(), expectedRevision: scheduled.revision, input: { communicationId: scheduled.id } },
				accepting,
				{ ...keys, from: "qa-seed@everyfield.invalid", origin: ORIGIN },
			),
		) as { acceptedCount: number; rejectedCount: number };
		if (result.acceptedCount !== DELIVERY_TO.length - 1 || result.rejectedCount !== 1)
			throw Error(`send delivery message: ${JSON.stringify(result)}`);
		const accepted = await rows(
			admin,
			sql`SELECT provider_message_id AS id FROM mail WHERE tenant_id=${p.plantId} AND purpose='communication'
				AND logical_key LIKE ${`communication/${scheduled.id}/%`} AND state='accepted' AND provider_message_id IS NOT NULL`,
		);
		const secret = `whsec_${randomBytes(32).toString("base64")}`;
		for (const row of accepted) {
			const raw = JSON.stringify({
				type: "email.delivered",
				created_at: new Date().toISOString(),
				data: { email_id: row.id as string },
			});
			const id = `qa-seed-${randomUUID()}`,
				stamp = String(Math.floor(Date.now() / 1000));
			const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
				.update(`${id}.${stamp}.${raw}`)
				.digest("base64");
			const received = await receiveMailCallback(
				runtime,
				new Request(`${ORIGIN}/api/webhooks/mail`, {
					method: "POST",
					headers: { "svix-id": id, "svix-timestamp": stamp, "svix-signature": `v1,${signature}` },
					body: raw,
				}),
				secret,
			);
			if (received.result !== "applied") throw Error(`delivered callback: ${JSON.stringify(received)}`);
		}
		done.push(`message ${DELIVERY}`);
	}

	if (!(await known(BOUNCES.adminFirst))) {
		await admin.transaction(async (tx) => {
			const db = tx as never as Database;
			const suppression = await bounce(db, keys, BOUNCES.adminFirst, QA_LOGINS.admin, 30);
			const restore = randomUUID();
			await db.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,reason,event_key,metadata,occurred_at,recorded_at)
				VALUES(${restore}::uuid,${p.plantId}::uuid,${p.adminAccount}::uuid,'mail.reconciled','suppression_clear','record',
					${suppression}::uuid,${RESTORE_REASON},${"suppress/qa-seed-admin-restore"},'{}'::jsonb,
					clock_timestamp()-interval '21 days',clock_timestamp()-interval '21 days')`);
			await db.execute(sql`UPDATE suppression SET cleared_at=clock_timestamp()-interval '21 days',clear_operation_id=${restore}::uuid,
				revision=revision+1 WHERE id=${suppression}::uuid`);
			await bounce(db, keys, BOUNCES.adminAgain, QA_LOGINS.admin, 6);
		});
		done.push("suppressed admin address", "past restore of the admin address");
	}
	return done;
}

const [S, T, X] = ["steady", "strained", "struggling"] as const;
const CHECK_INS: [spiritual: string, family: string, financial: string, pace: string, note: string][] = [
	[S, S, S, S, "First check-in after the core group meeting."],
	[S, T, S, S, ""],
	[S, S, T, S, ""],
	[T, S, S, T, ""],
	[S, S, S, S, ""],
	[S, T, S, S, ""],
	[S, S, T, S, "Budget talk with the sending church went well."],
	[T, S, S, S, ""],
	[S, S, S, T, ""],
	[S, T, S, S, ""],
	[S, S, T, T, "Launch planning took most evenings."],
	[T, S, S, X, "Too many nights out. Sleep is short."],
	[S, T, S, T, "Still busy. Took one evening off."],
];
const ZONE = "America/New_York";

async function checkIns(
	admin: Database,
	runtime: Database,
	owner: string,
	plantId: string,
	ownerSession: () => Promise<string>,
): Promise<string[]> {
	const done: string[] = [];
	const zoned = await rows(
		admin,
		sql`UPDATE account SET personal_timezone=${ZONE} WHERE id=${owner} AND personal_timezone IS NULL RETURNING 1`,
	);
	if (zoned.length) done.push("owner timezone");
	const calendar = sql`SELECT 1 FROM private_calendar WHERE author_id=${owner} AND plant_id=${plantId}`;
	if ((await rows(admin, calendar)).length) return done;
	const n = CHECK_INS.length;
	const times = (
		await rows(
			admin,
			sql`SELECT to_char(((date_trunc('week', statement_timestamp() AT TIME ZONE a.personal_timezone)
				- make_interval(weeks => k) + interval '2 days 19 hours') AT TIME ZONE a.personal_timezone) AT TIME ZONE 'UTC',
				'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
				FROM account a, generate_series(${n}::int, 1, -1) k WHERE a.id=${owner} ORDER BY k DESC`,
		)
	).map((r) => r.at as string);
	let now = "";
	const care = createPrivateCare({ clock: { now: () => now as Instant } });
	const actor = await RequestActor.resolve(runtime, (await ownerSession()) as never);
	if (!(actor instanceof RequestActor)) throw Error(`check-in actor: ${JSON.stringify(actor)}`);
	await gatedTransaction(runtime, async (tx) => {
		for (const [index, [spiritual, family, financial, pace, note]] of CHECK_INS.entries()) {
			now = times[index]!;
			ok(
				`check-in week ${index + 1}`,
				await care.save(tx, actor, {
					requestKey: randomUUID(),
					expectedRevision: String(index),
					input: { answers: { spiritual, family, financial, pace }, note },
				}),
			);
		}
	});
	done.push(`${n} check-in weeks`);
	return done;
}

async function wiki(admin: Database): Promise<boolean> {
	if ((await rows(admin, sql`SELECT 1 FROM reference_activation LIMIT 1`)).length) return false;
	const release = randomUUID(),
		section = randomUUID();
	const corpus = JSON.parse(
		readFileSync(new URL("../../docs/reference/bootstrap/global-seed-payload.json", import.meta.url), "utf8"),
	) as { articles: { slug: string; title: string; content: string }[] };
	await admin.transaction(async (tx) => {
		await tx.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/start',${GLOBAL})`,
		);
		await tx.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
			VALUES(${release},${"qa-" + release},'memory://qa-seed',${digest()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${digest()},'v','profile',1,${GLOBAL},0)`);
		for (const [position, article] of corpus.articles.slice(0, 3).entries()) {
			const id = randomUUID();
			await tx.execute(
				sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},'article',${article.slug},${GLOBAL})`,
			);
			await tx.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
				VALUES(${randomUUID()},${id},${GLOBAL},${release},1,${article.title},${article.slug},${article.title},${article.content},'safe_mdx',1,${position + 1},${digest()},clock_timestamp(),true,1,${section},NULL,ARRAY[]::text[])`);
			await tx.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
				VALUES(${randomUUID()},${id},${release},1,${"wiki/" + article.slug},${digest()},'QA seed')`);
		}
		await tx.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
			VALUES(${randomUUID()},${release},1,clock_timestamp(),'qa-seed','qa seed',0)`);
	});
	return true;
}

const SOURCES = [
	{ kind: "sending_church", name: "Grace Fellowship (QA)", version: "church version", acceptedDaysAgo: 30 },
	{ kind: "sending_network", name: "Harvest Network (QA)", version: "network version", acceptedDaysAgo: 20 },
] as const;
const ORDER_CHURCHES = ["Grace Fellowship (QA)", "Grace Church (QA)"] as const;
const copyBody = (version: string, name: string) =>
	JSON.stringify({
		format: "everyfield-editor-v1",
		blocks: [
			{ type: "paragraph", children: [{ type: "text", text: `This is the ${version} from ${name}.`, marks: [] }] },
		],
	});

const REVISED = "**Revised for QA:** this is the second revision of the article. It changed after you read the first.";

async function starterArticles(admin: Database) {
	const found = await rows(
		admin,
		sql`SELECT r.article_id, min(r.position) AS position, min(r.slug) AS slug
			FROM article_revision r JOIN reference_item i ON i.id = r.section_id
			WHERE r.tenant_id = ${GLOBAL}::uuid AND r.content_type = 'safe_mdx' AND r.published_at IS NOT NULL
				AND r.release_id = (SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1)
			GROUP BY r.article_id ORDER BY 2, 3, 1 LIMIT 3`,
	);
	if (found.length < 3)
		throw Error(
			`wiki: the active release has ${found.length} published global articles; articles A, B and C need three`,
		);
	return found.map((row) => row.article_id as string) as [string, string, string];
}

async function globalRevision(admin: Database, articleId: string) {
	return (
		await rows(
			admin,
			sql`SELECT * FROM article_revision
				WHERE article_id = ${articleId}::uuid AND tenant_id = ${GLOBAL}::uuid AND published_at IS NOT NULL
					AND release_id = (SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1)
					AND body NOT LIKE ${REVISED + "%"}
				ORDER BY revision_number DESC LIMIT 1`,
		)
	)[0]!;
}

async function publishCopy(
	admin: Database,
	orgId: string,
	articleId: string,
	base: Record<string, unknown>,
	version: string,
	name: string,
): Promise<boolean> {
	const copied = await rows(
		admin,
		sql`SELECT 1 FROM article_editor_state WHERE organization_id=${orgId} AND article_id=${articleId}`,
	);
	if (copied.length) return false;
	const revisionId = randomUUID();
	const body = copyBody(version, name);
	await admin.transaction(async (tx) => {
		await tx.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,upstream_revision_id,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
			SELECT ${revisionId}::uuid,article_id,${orgId}::uuid,NULL,1,id,${`${String(base.title)} (${name})`},slug,excerpt,${body},'safe_nodes',phase,position,${digest()},clock_timestamp(),true,1,section_id,parent_article_id,related_slugs
			FROM article_revision WHERE id=${base.id as string}::uuid`);
		await tx.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,based_on_upstream_id,revision)
			VALUES(${randomUUID()},${orgId},${articleId},'published',${revisionId},${base.id as string},1)`);
	});
	return true;
}

async function wikiCases(admin: Database, plantId: string, owner: string): Promise<string[]> {
	const done: string[] = [];
	const [articleA, articleB, articleC] = await starterArticles(admin);
	const base = await globalRevision(admin, articleA);
	let copies = false;
	for (const source of SOURCES) {
		let orgId = (
			await rows(admin, sql`SELECT id FROM organization WHERE kind=${source.kind} AND name=${source.name} LIMIT 1`)
		)[0]?.id as string | undefined;
		if (!orgId) {
			orgId = randomUUID();
			await admin.execute(
				sql`INSERT INTO organization(id,kind,name,city,timezone,material_revision) VALUES(${orgId},${source.kind},${source.name},'Austin','America/Chicago',1)`,
			);
			done.push(`${source.kind.replace("_", " ")} ${source.name}`);
		}
		const linked = await rows(
			admin,
			sql`SELECT 1 FROM affiliation WHERE plant_id=${plantId} AND organization_id=${orgId} AND ended_at IS NULL`,
		);
		if (!linked.length) {
			await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${randomUUID()},${plantId},${orgId},clock_timestamp()-(${source.acceptedDaysAgo} || ' days')::interval,false,false,false,false,true,false,false)`);
			done.push(`affiliation with ${source.name}`);
		}
		if (await publishCopy(admin, orgId, articleA, base, source.version, source.name)) copies = true;
	}
	if (copies) done.push(`wiki copies of ${String(base.title)}`);

	const first = await globalRevision(admin, articleB);
	const revised = await rows(
		admin,
		sql`SELECT 1 FROM article_revision WHERE article_id=${articleB} AND tenant_id=${GLOBAL}::uuid AND release_id=${first.release_id as string}::uuid AND body LIKE ${REVISED + "%"}`,
	);
	if (!revised.length) {
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,upstream_revision_id,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
			SELECT ${randomUUID()}::uuid,article_id,tenant_id,release_id,
				(SELECT max(revision_number)+1 FROM article_revision WHERE article_id=${articleB} AND tenant_id=${GLOBAL}::uuid AND release_id=${first.release_id as string}::uuid),
				NULL,${`${String(first.title)} (revised)`},slug,excerpt,${`${REVISED}\n\n${String(first.body)}`},content_type,phase,position,${digest()},clock_timestamp(),true,
				(SELECT max(meaningful_sequence)+1 FROM article_revision WHERE article_id=${articleB} AND tenant_id=${GLOBAL}::uuid AND release_id=${first.release_id as string}::uuid),
				section_id,parent_article_id,related_slugs
			FROM article_revision WHERE id=${first.id as string}::uuid`);
		done.push(`wiki revision of ${String(first.title)}`);
	}
	if (!(await rows(admin, sql`SELECT 1 FROM reading WHERE account_id=${owner} AND article_id=${articleB}`)).length) {
		await admin.execute(sql`INSERT INTO reading(id,account_id,article_id,last_revision_id,plant_context_id,observed_fraction,last_viewed_at,completed_at,completed_revision_id,completed_fraction,policy_version,last_read_meaningful_sequence,bookmarked,revision)
			VALUES(${randomUUID()},${owner},${articleB},${first.id as string},${plantId},1,clock_timestamp()-interval '7 days',clock_timestamp()-interval '7 days',${first.id as string},1,'wiki-reading-v1',${first.meaningful_sequence as string},false,1)`);
		done.push("wiki reading");
	}

	const third = await globalRevision(admin, articleC);
	let ordered = false;
	for (const name of ORDER_CHURCHES) {
		const orgId = (
			await rows(admin, sql`SELECT id FROM organization WHERE kind='sending_church' AND name=${name} LIMIT 1`)
		)[0]!.id as string;
		if (await publishCopy(admin, orgId, articleC, third, "church version", name)) ordered = true;
	}
	if (ordered) done.push(`wiki church versions of ${String(third.title)}`);
	return done;
}

if (import.meta.main) {
	try {
		console.log(await seed(process.env));
	} catch (error) {
		console.error(error instanceof SeedRefusal ? `QA seed refused: ${error.message}` : `QA seed failed: ${error}`);
		process.exitCode = error instanceof SeedRefusal ? 2 : 1;
	}
}
