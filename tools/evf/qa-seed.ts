// OPS-106: the QA seed. It fills one QA Neon branch with a test church that Nora can sign in to and exercise every
// planter flow on: three logins (owner, admin, member), people, a household, teams, meetings, tasks, follow-ups, a
// document, a draft message and, when the branch has none, a published wiki. It writes through the domain writers,
// the same code the screens call, except where noted. Every address is delivered+<label>@resend.dev, so a real send
// reaches no real person.
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
import { createOnboardingProducer } from "../../packages/domain/src/onboarding/index.ts";
import { accountPersonProducer, peopleWriter, personFields } from "../../packages/domain/src/people/index.ts";
import { createTaskWriter } from "../../packages/domain/src/tasks/index.ts";
import { teamsWriter } from "../../packages/domain/src/teams/index.ts";
import { QA_LOGINS, QA_PASSWORD, seedRefusal } from "./qa-guard.ts";

export const CHURCH = "Harvest Point (QA)";
const ROLES = { runtime: "evf_qa_runtime", auth: "evf_qa_auth" } as const;
const ORIGIN = "https://qa-seed.everyfield.invalid";

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

type Ctx = { session: string; selected: { kind: "plant"; id: string } };
type Reply = { status: string; value?: unknown };

function ok<T extends Reply>(what: string, reply: T): NonNullable<T["value"]> & Record<string, never> {
	if (reply.status !== "ok") throw Error(`${what}: ${JSON.stringify(reply)}`);
	return reply.value as never;
}

async function rows(db: Database, query: ReturnType<typeof sql>) {
	return (await db.execute(query)).rows as Record<string, unknown>[];
}

/** The two app logins, created or given the supplied password. Names are fixed, so a rerun adds none. */
async function logins(admin: Database, password: string) {
	for (const [name, grant] of [
		[ROLES.runtime, "everyfield_runtime"],
		[ROLES.auth, "everyfield_auth"],
	] as const) {
		const quoted = `'${password.replaceAll("'", "''")}'`;
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

function roleUrl(source: string, role: string, password: string) {
	const u = new URL(source);
	u.username = role;
	u.password = password;
	return u.href;
}

export async function seed(env: Readonly<Record<string, string | undefined>>): Promise<string> {
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

export class SeedRefusal extends Error {}

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

	async function account(name: string, email: string): Promise<string> {
		const known = await accountOf(email);
		if (known) return known;
		ip++;
		const r = await call("register", {
			kind: "plant_precreation",
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

	// One session for the owner, opened only when some part is missing. A complete branch gets no new session.
	let session: string | null = null;
	const ownerSession = async () => {
		if (session) return session;
		const signedIn = await call("sign-in/email", { email: QA_LOGINS.owner, password: QA_PASSWORD });
		if (!signedIn.ok) throw Error(`sign in owner: ${signedIn.status}`);
		const row = await rows(
			admin,
			sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE u.email=${QA_LOGINS.owner}
				ORDER BY s.created_at DESC LIMIT 1`,
		);
		session = row[0]!.id as string;
		return session;
	};

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

	if (await wiki(admin)) done.push("wiki");

	if (session) await admin.execute(sql`DELETE FROM auth_session WHERE id=${session}`);
	return done.length ? `QA seed wrote: ${done.join(", ")}.` : "QA seed: the branch is already complete.";
}

/**
 * A branch made off the development database carries its published wiki. A branch with no active release (a fresh
 * test database) gets a small one with three articles. No wiki writer publishes a release, so the seed writes the
 * rows the wiki reader uses, as the People UI seed does.
 */
async function wiki(admin: Database): Promise<boolean> {
	if ((await rows(admin, sql`SELECT 1 FROM reference_activation LIMIT 1`)).length) return false;
	const GLOBAL = "00000000-0000-0000-0000-000000000000";
	const digest = () => randomBytes(32).toString("hex");
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

if (import.meta.main) {
	try {
		console.log(await seed(process.env));
	} catch (error) {
		// A refusal names the rule; any other failure names the step. Neither prints a connection string.
		console.error(error instanceof SeedRefusal ? `QA seed refused: ${error.message}` : `QA seed failed: ${error}`);
		process.exitCode = error instanceof SeedRefusal ? 2 : 1;
	}
}
