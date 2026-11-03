// OPS-106: the QA seed. It fills one QA Neon branch with a test church that Nora can sign in to and exercise every
// planter flow on: three logins (owner, admin, member), people, a household, teams, meetings, tasks, follow-ups, a
// document, a draft message and, when the branch has none, a published wiki. OPS-126 adds the overseeing side: a
// network with an Admin login and a sending church with a director login, each connected to the church through the
// organization invitation and acceptance commands. OPS-127 adds a second sending church that shares the wiki, church
// and network copies of one article and a revised article the owner has read. It writes through the domain writers,
// the same code the screens call, except where noted. The owner also gets 13 answered past check-in weeks (OPS-125).
// Every address is delivered+<label>@resend.dev, so a real send reaches no real person.
//
// Idempotent: each part first looks for its own rows by a fixed name and is skipped when they are there. A second run
// on a complete branch signs nobody in and writes nothing.
//
//   DATABASE_URL=<QA branch owner URL> QA_ROLE_PASSWORD=<new login password> \
//     node --conditions=react-server --import tsx tools/evf/qa-seed.ts
//
// It refuses production, the shared development branch, NODE_ENV=production and a missing DATABASE_URL before it
// opens any connection (qa-guard.ts). QA_ROLE_PASSWORD sets the password of the two app logins it creates on the
// branch, evf_qa_runtime and evf_qa_auth. It prints no connection string or password.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../packages/db/node_modules/drizzle-orm/index.js";
import { closeDatabase, createDatabase, type Database } from "../../packages/db/src/client.ts";
import { RequestActor } from "../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../packages/domain/src/communication/index.ts";
import { documentsWriter } from "../../packages/domain/src/documents/index.ts";
import { createFollowUpWriter } from "../../packages/domain/src/followups/index.ts";
import { createIdentityService } from "../../packages/domain/src/identity/index.ts";
import { meetingsWriter } from "../../packages/domain/src/meetings/index.ts";
import { createPrivateCare } from "../../packages/domain/src/intelligence/index.ts";
import { createOnboardingProducer } from "../../packages/domain/src/onboarding/index.ts";
import { createOrganizationAdapter, type OrganizationEffects } from "../../packages/domain/src/organizations/index.ts";
import { accountPersonProducer, peopleWriter, personFields } from "../../packages/domain/src/people/index.ts";
import { createTaskWriter } from "../../packages/domain/src/tasks/index.ts";
import { teamsWriter } from "../../packages/domain/src/teams/index.ts";
import { queueJobs } from "../../apps/web/src/server/jobs/queue.ts";
import { QA_LOGINS, QA_PASSWORD, QA_ROLES as ROLES, roleUrl, seedRefusal } from "./qa-guard.ts";

const CHURCH = "Harvest Point (QA)";
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
/** The two overseeing organizations (OPS-126): each login's seat role and the name it registers with. */
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

type Ctx = { session: string; selected: { kind: "plant"; id: string } };
type Reply = { status: string; value?: unknown };

function ok(what: string, reply: Reply): unknown {
	if (reply.status !== "ok") throw Error(`${what}: ${JSON.stringify(reply)}`);
	return reply.value;
}

async function rows(db: Database, query: ReturnType<typeof sql>) {
	return (await db.execute(query)).rows as Record<string, unknown>[];
}

/** The two app logins, created or given the supplied password. Names are fixed, so a rerun adds none. */
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

async function seed(env: Readonly<Record<string, string | undefined>>): Promise<string> {
	const refusal = seedRefusal(env);
	if (refusal) throw new SeedRefusal(refusal);
	const password = env.QA_ROLE_PASSWORD;
	if (!password || password.length < 16) throw new SeedRefusal("QA_ROLE_PASSWORD must hold at least 16 characters.");
	const source = env.DATABASE_URL!;
	const admin = createDatabase({ connectionString: source, max: 2 });
	let runtime: Database | null = null,
		authDb: Database | null = null;
	try {
		await logins(admin, password);
		runtime = createDatabase({ connectionString: roleUrl(source, ROLES.runtime, password), max: 2 });
		authDb = createDatabase({ connectionString: roleUrl(source, ROLES.auth, password), max: 2 });
		return await fill(admin, runtime, authDb);
	} finally {
		if (runtime) await closeDatabase(runtime);
		if (authDb) await closeDatabase(authDb);
		await closeDatabase(admin);
	}
}

async function fill(admin: Database, runtime: Database, authDb: Database): Promise<string> {
	const done: string[] = [];
	// Registration admission is limited per address, so each account registers from its own loopback address.
	let ip = 0;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin: ORIGIN,
		secret: randomBytes(32).toString("hex"),
		trustedIp: () => `127.0.106.${ip}`,
		// Verification mail is skipped: the seed marks each QA address verified below.
		enqueueMail: async () => {},
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

	/** A verified, active account. An organization login registers as its organization kind, as the sign-up page does. */
	async function account(name: string, email: string, organization?: (typeof ORGANIZATIONS)[number]): Promise<string> {
		const known = await accountOf(email);
		if (known) return known;
		ip++;
		const r = await call("register", {
			...(organization
				? { kind: organization.kind, organizationName: organization.name }
				: { kind: "plant_precreation" }),
			name,
			email,
			password: QA_PASSWORD,
			requestKey: randomUUID(),
		});
		if (!r.ok) throw Error(`register ${email}: ${r.status} ${await r.text()}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
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

	// One session for each login the seed acts as, opened only when some part is missing. A complete branch gets none.
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

	// The church, created by the owner through onboarding and marked complete, so every login lands on it.
	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop });
	let plantId = (await rows(admin, sql`SELECT id FROM plant WHERE name=${CHURCH} ORDER BY id LIMIT 1`))[0]?.id as
		string | undefined;
	if (!plantId) {
		const s = await ownerSession();
		const created = ok(
			"createPlant",
			await runtime.transaction((tx) =>
				onboarding.createPlant(
					tx,
					{ session: s, selected: { kind: "account", id: owner } } as never,
					{
						requestKey: randomUUID(),
						expectedRevision: "1",
						input: { name: CHURCH, locality: { city: "Austin" }, confirmed: true },
					} as never,
				),
			),
		) as { plant: { id: string } };
		plantId = created.plant.id;
		done.push("church");
	}
	const plant = { kind: "plant", id: plantId } as const;
	const ctx = async (): Promise<Ctx> => ({ session: await ownerSession(), selected: plant });
	const write = <T>(run: (tx: never) => Promise<T>) => runtime.transaction((tx) => run(tx as never));

	const completed = await rows(admin, sql`SELECT onboarding_completed_at FROM plant WHERE id=${plantId}`);
	if (!completed[0]!.onboarding_completed_at) {
		const c = await ctx();
		const revision = (await rows(admin, sql`SELECT revision::text AS r FROM plant WHERE id=${plantId}`))[0]!
			.r as string;
		ok(
			"complete onboarding",
			await write((tx) =>
				onboarding.complete(tx, c as never, { requestKey: randomUUID(), expectedRevision: revision, input: {} }),
			),
		);
		done.push("onboarding");
	}

	// Admin and Member seats. Seat acceptance belongs to invitations; the seed writes the accepted seat, as the
	// People UI seed does, and links a Person to each account.
	for (const [accountId, role, name] of [
		[adminAccount, "admin", "Lena Park"],
		[member, "member", "Ruth Allen"],
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
		done.push(`${role} seat`);
	}

	const personId = async (name: string) =>
		(
			await rows(
				admin,
				sql`SELECT id, revision::text AS revision FROM person WHERE plant_id=${plantId} AND display_name=${name} AND state='live' LIMIT 1`,
			)
		)[0] as { id: string; revision: string } | undefined;

	for (const [displayName, stage, label] of PEOPLE) {
		if (await personId(displayName)) continue;
		const c = await ctx();
		ok(
			`create ${displayName}`,
			await write((tx) =>
				peopleWriter.createPerson(
					tx,
					c as never,
					{
						requestKey: randomUUID(),
						input: { displayName, stage, email: label ? address(label) : null, source: "other" },
					} as never,
				),
			),
		);
		done.push(`person ${displayName}`);
	}

	// One household: Maria as head, Joao as spouse. Each step checks its own row, so a rerun finishes a half-made one.
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
		const guests = [];
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

	// Follow-ups for two people. Owners need a seat and a committed Person, so the admin's Person joins the core group.
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
				body: "Welcome to Harvest Point. We meet Sundays at 10 AM at Travis Elementary.",
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

	// The overseeing side (OPS-126). No writer creates an organization or its first seat yet, so the seed writes those
	// rows, as the Attestations UI seed does. The connection goes through the organization commands: the Owner invites
	// each organization from the church, and the organization's login accepts with the proof the invitation mail carries.
	// Acceptance applies the build's own sharing defaults; the seed changes none of them.
	const proofs = new Map<string, string>();
	const effects: OrganizationEffects = {
		// The seed keeps the proof instead of mailing it, as it skips verification mail.
		invitation: async (_tx, input) => void proofs.set(input.invitationId, input.proof),
		// The app's own effects (apps/web/src/server/organizations): the coarse notice job and the stale-work supersede.
		notice: (tx, input) =>
			queueJobs(tx, [
				{
					tenant: input.pair.kind === "plant" ? input.pair.subject.id : input.pair.organization.id,
					kind: "notification",
					subject: input.relationshipId,
					key: `${input.kind}/${input.eventId}`,
					revision: input.revision,
					eligibleAt: new Date().toISOString(),
				},
			]),
		invalidate: (_tx, input) =>
			sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${input.sourceId} AND kind IN ('assessment','digest') AND state IN ('ready','retry_wait','claimed')`,
	};
	const organizations = createOrganizationAdapter(effects, { candidates: async () => [] });
	for (const o of overseers) {
		let orgId = (
			await rows(admin, sql`SELECT id FROM organization WHERE name=${o.name} AND kind=${o.kind} ORDER BY id LIMIT 1`)
		)[0]?.id as string | undefined;
		if (!orgId) {
			orgId = randomUUID();
			await admin.execute(
				sql`INSERT INTO organization(id,kind,name,city,timezone,material_revision) VALUES(${orgId},${o.kind},${o.name},'Austin','America/Chicago',1)`,
			);
			done.push(o.name);
		}
		if (
			!(await rows(admin, sql`SELECT 1 FROM seat WHERE account_id=${o.account} AND organization_id=${orgId}`)).length
		) {
			await admin.execute(
				sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${o.account},${orgId},${o.role},clock_timestamp())`,
			);
			done.push(`${o.name} ${o.role} seat`);
		}
		const connected = await rows(
			admin,
			sql`SELECT 1 FROM affiliation WHERE plant_id=${plantId} AND organization_id=${orgId} AND ended_at IS NULL`,
		);
		if (connected.length) continue;
		const organization = { kind: "organization", id: orgId, organizationKind: o.kind } as const;
		const s = (await ownerSession()) as never;
		// A run that stopped between the request and its answer lost the proof: withdraw that request, then ask again.
		const stale = await rows(
			admin,
			sql`SELECT i.id, i.revision::text AS revision FROM invitation i JOIN relationship_invitation r ON r.invitation_id=i.id
				WHERE r.plant_id=${plantId} AND r.organization_id=${orgId} AND i.state='pending'`,
		);
		for (const i of stale)
			await runtime.transaction((tx) =>
				organizations["associations.revokeInvitation"](tx, s, plant, {
					requestKey: randomUUID(),
					expectedRevision: i.revision as string,
					input: { invitationId: i.id as string },
				} as never),
			);
		const revision = (await rows(admin, sql`SELECT revision::text AS r FROM plant WHERE id=${plantId}`))[0]!
			.r as string;
		const invited = await runtime.transaction((tx) =>
			organizations["associations.invite"](tx, s, plant, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { pair: { kind: "plant", subject: plant, organization }, recipientEmail: o.login },
			} as never),
		);
		const answer = (await sessionOf(o.login)) as never;
		await runtime.transaction((tx) =>
			organizations["associations.acceptInvitation"](tx, answer, organization, {
				requestKey: randomUUID(),
				expectedRevision: invited.revision,
				input: { invitationId: invited.invitationId, proof: proofs.get(invited.invitationId)!, decision: "accept" },
			} as never),
		);
		done.push(`connection ${o.name}`);
	}

	// After the overseers: on a fresh branch the OPS-126 connection to Harvest Network (QA) comes first, so the wiki
	// cases find it and add only their copy.
	const wikiWritten = await wiki(admin);
	done.push(...(await wikiCases(admin, plantId, owner)));
	// Before the check-in weeks: the OPS-106 test expects "wiki, owner timezone, 13 check-in weeks.".
	if (wikiWritten) done.push("wiki");
	done.push(...(await checkIns(admin, runtime, owner, plantId, ownerSession)));

	for (const id of sessions.values()) await admin.execute(sql`DELETE FROM auth_session WHERE id=${id}`);
	return done.length ? `QA seed wrote: ${done.join(", ")}.` : "QA seed: the branch is already complete.";
}

// The owner's 13 past check-in weeks, oldest first: spiritual, family, financial, pace and an optional note. Pace ends
// in a run of 3 Strained or Struggling weeks after a Steady one; no other dimension has 3 non-Steady weeks in a row.
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

/**
 * The owner's personal timezone, when it has none, and its past check-in weeks, when it has no check-in calendar in the
 * church. Each week is a save through the private-care writer with the clock set to Wednesday 19:00 of that week, so the
 * weeks, ordinals, revisions and calendar are the rows a planter's own saves make. The saves share one transaction, so
 * a failed run leaves no part of the history.
 */
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
	const care = createPrivateCare({ clock: { now: () => now } });
	const actor = await RequestActor.resolve(runtime, (await ownerSession()) as never);
	if (!(actor instanceof RequestActor)) throw Error(`check-in actor: ${JSON.stringify(actor)}`);
	await runtime.transaction(async (tx) => {
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

/**
 * A branch made off the development database carries its published wiki. A branch with no active release (a fresh
 * test database) gets a small one with three articles. No wiki writer publishes a release, so the seed writes the
 * rows the wiki reader uses, as the People UI seed does.
 */
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

/** OPS-127: the organizations that share the wiki with the test church, each with its copy of article A. */
const SOURCES = [
	{ kind: "sending_church", name: "Grace Fellowship (QA)", version: "church version", acceptedDaysAgo: 30 },
	{ kind: "sending_network", name: "Harvest Network (QA)", version: "network version", acceptedDaysAgo: 20 },
] as const;
/** A copy's body in the Wiki editor's document format (safe_nodes). Its line names the source. */
const copyBody = (version: string, name: string) =>
	JSON.stringify({
		format: "everyfield-editor-v1",
		blocks: [
			{ type: "paragraph", children: [{ type: "text", text: `This is the ${version} from ${name}.`, marks: [] }] },
		],
	});

/** The first line of article B's second revision. The seed finds its own revision by it. */
const REVISED = "**Revised for QA:** this is the second revision of the article. It changed after you read the first.";

/**
 * Articles A and B: the first and second published global article in the active release, by position and then slug.
 * The same rule on a fresh database and on a branch of development, so a rerun finds the same two.
 */
async function starterArticles(admin: Database) {
	const found = await rows(
		admin,
		sql`SELECT r.article_id, min(r.position) AS position, min(r.slug) AS slug
			FROM article_revision r JOIN reference_item i ON i.id = r.section_id
			WHERE r.tenant_id = ${GLOBAL}::uuid AND r.content_type = 'safe_mdx' AND r.published_at IS NOT NULL
				AND r.release_id = (SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1)
			GROUP BY r.article_id ORDER BY 2, 3, 1 LIMIT 2`,
	);
	if (found.length < 2) throw Error("wiki: the active release has fewer than two published articles");
	return found.map((row) => row.article_id as string) as [string, string];
}

/** The newest published global revision of an article in the active release, other than the seed's own revision. */
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

/**
 * OPS-127: the reader cases Nora tests. The church and network share the wiki with the test church; each publishes its
 * own copy of article A, so the church copy wins over the network copy and the global article. Article B gets a second,
 * meaningful global revision, and the owner has finished the first, so the reader shows "Updated since you read it".
 * No writer creates organizations or publishes a release, so the seed writes these rows directly. Each part looks for
 * its own rows first.
 */
async function wikiCases(admin: Database, plantId: string, owner: string): Promise<string[]> {
	const done: string[] = [];
	const [articleA, articleB] = await starterArticles(admin);
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
		const copied = await rows(
			admin,
			sql`SELECT 1 FROM article_editor_state WHERE organization_id=${orgId} AND article_id=${articleA}`,
		);
		if (copied.length) continue;
		const revisionId = randomUUID();
		const body = copyBody(source.version, source.name);
		await admin.transaction(async (tx) => {
			await tx.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,upstream_revision_id,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
				SELECT ${revisionId}::uuid,article_id,${orgId}::uuid,NULL,1,id,${`${String(base.title)} (${source.name})`},slug,excerpt,${body},'safe_nodes',phase,position,${digest()},clock_timestamp(),true,1,section_id,parent_article_id,related_slugs
				FROM article_revision WHERE id=${base.id as string}::uuid`);
			await tx.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,based_on_upstream_id,revision)
				VALUES(${randomUUID()},${orgId},${articleA},'published',${revisionId},${base.id as string},1)`);
		});
		copies = true;
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
	// The owner finished the first revision a week ago. Without this reading the reader says nothing about the change.
	if (!(await rows(admin, sql`SELECT 1 FROM reading WHERE account_id=${owner} AND article_id=${articleB}`)).length) {
		await admin.execute(sql`INSERT INTO reading(id,account_id,article_id,last_revision_id,plant_context_id,observed_fraction,last_viewed_at,completed_at,completed_revision_id,completed_fraction,policy_version,last_read_meaningful_sequence,bookmarked,revision)
			VALUES(${randomUUID()},${owner},${articleB},${first.id as string},${plantId},1,clock_timestamp()-interval '7 days',clock_timestamp()-interval '7 days',${first.id as string},1,'wiki-reading-v1',${first.meaningful_sequence as string},false,1)`);
		done.push("wiki reading");
	}
	return done;
}

if (import.meta.main) {
	try {
		console.log(await seed(process.env));
	} catch (error) {
		// A refusal names the rule; any other failure names the step. Neither prints a connection string.
		console.error(error instanceof SeedRefusal ? `QA seed refused: ${error.message}` : `QA seed failed: ${error}`);
		process.exitCode = error instanceof SeedRefusal ? 2 : 1;
	}
}
