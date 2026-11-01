// Seeds a People preview on the shared development database (WP-011/ui). It opens the shared tests/ui seed environment
// (tests/ui/seed-env.mts: one isolated schema, login roles and apps/web/.env.local per worktree), signs up real accounts
// through the identity service, creates a church through the onboarding producer and adds people through the People
// producer, the same code the screens call.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/people/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/people/seed.mts down
//
// `up` writes the session cookies and IDs the browser tests need to $PEOPLE_UI_FIXTURE (default
// /tmp/everyfield-people-ui.json). `down` deletes it and drops the shared schema when no other seed still uses it.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import { peopleWriter, accountPersonProducer } from "../../../packages/domain/src/people/index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

// The task reminder port of a stage change or retirement. These people hold no dated, assigned task, so a replan
// here would be a bug.
const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

const PASSWORD = "People-preview-pass-1";

/** The WP-034/ui fixture article: the five diagram types, a plain fence and a malformed diagram that shows as code. */
const DIAGRAM_ARTICLE = [
	"## How a guest becomes a member",
	"Most guests take the same four steps. The diagram shows them in order.",
	"```diagram flow",
	"title: How a guest becomes a member",
	"loop: Each new guest starts again at the first visit",
	"- First visit | Greeted at the door and given a welcome card | Week 1",
	"- Connect card | A personal follow-up within 48 hours",
	"- Newcomers lunch | Meet the pastor and two team leaders | Month 1",
	"- Membership class",
	"```",
	"## The launch phases",
	"```diagram stages",
	"title: Six phases from vision to launch",
	"- Discovery | Pray, study the community and write the vision",
	"- Core group | Gather the first committed believers",
	"- Launch team | Turn the core group into ministry teams",
	"- Training | Rehearse every Sunday role",
	"- Pre-launch | Preview services and invitations",
	"- Launch Sunday | The first public service | Week 0",
	"```",
	"## The weekly rhythm",
	"```diagram cycle",
	"title: The weekly ministry rhythm",
	"loop: Every week",
	"- Plan | Set the order of service",
	"- Invite | Each member invites one person",
	"- Gather | Sunday worship",
	"- Follow up | Call every first-time guest",
	"```",
	"## Who leads whom",
	"```diagram hierarchy",
	"title: Leadership structure",
	"- Lead pastor | Vision and preaching",
	"  - Ministry director | Sunday teams",
	"    - Team leader | Hospitality",
	"      - Volunteer | Greeter",
	"    - Team leader | Kids",
	"  - Small group coach | Weekday groups",
	"    - Small group leader",
	"```",
	"## The first year",
	"```diagram timeline",
	"title: The first year after launch",
	"- Launch Sunday | The first public service | Week 0",
	"- First guest follow-up | Every card answered | Week 1",
	"- Membership class | | Month 2",
	"- First baptism service | Celebrate new believers | Month 6",
	"- Anniversary | Share the story of the year | Month 12",
	"```",
	"## A plain code block",
	"```text",
	"Cash total:        $________",
	"                   ---------",
	"- this dash line stays text",
	"```",
	"## A broken diagram",
	"```diagram flow",
	"title: This block has a fault",
	"- One | two | three | four",
	"```",
].join("\n");

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const { admin, runtime, authDb, secret } = env;
	// Registration admission is limited per address; each seeded account signs up from its own loopback address.
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.loopback("people", ip),
		// Verification mail is skipped: the seed marks the address verified directly below.
		enqueueMail: async () => {},
		diagnostic: () => {},
	});
	const host = new URL(origin).host;
	const call = async (path: string, body?: unknown, cookie?: string) =>
		identity.handle(
			new Request(`${origin}/api/auth/${path}`, {
				method: body === undefined ? "GET" : "POST",
				headers: { host, origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		);
	const cookieOf = (r: Response) =>
		r.headers
			.getSetCookie()
			.map((v) => v.split(";")[0])
			.join("; ");

	async function account(name: string, email: string) {
		ip++;
		const r = await call("register", {
			kind: "plant_precreation",
			name,
			email,
			password: PASSWORD,
			requestKey: randomUUID(),
		});
		if (!r.ok) throw Error(`register ${email}: ${r.status} ${await r.text()}`);
		await admin.execute(sql`UPDATE auth_user SET email_verified=true WHERE email=${email}`);
		await admin.execute(
			sql`UPDATE account SET registration_state='active' WHERE auth_user_id=(SELECT id FROM auth_user WHERE email=${email})`,
		);
		const signedIn = await call("sign-in/email", { email, password: PASSWORD });
		if (!signedIn.ok) throw Error(`sign in ${email}: ${signedIn.status}`);
		const cookie = cookieOf(signedIn);
		const session = (await (await call("get-session", undefined, cookie)).json()) as {
			status: string;
			accountId: string;
			sessionId: string;
		};
		if (session.status !== "active") throw Error(`session ${email}: ${session.status}`);
		return { cookie, accountId: session.accountId, sessionId: session.sessionId, email };
	}

	const owner = await account("Daniel Reyes", "owner@people-preview.example.test");
	const member = await account("Ruth Allen", "member@people-preview.example.test");
	const seatless = await account("Sam Lee", "seatless@people-preview.example.test");
	// Settings flows change their own password or ask for deletion and restore it, so they sign in with these through
	// the form and leave every other seeded session alone (tests/ui/settings/account-flows.test.mjs).
	const settings = [
		await account("Lena Park", "settings-password@people-preview.example.test"),
		await account("Omar Haddad", "settings-deletion@people-preview.example.test"),
	];
	// An Owner of a sending church: an organization seat, which has no plant People list.
	const organizer = await account("Grace Moreno", "church@people-preview.example.test");
	const organization = randomUUID();
	await admin.execute(
		sql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${organization},'sending_church','Grace Church','UTC',1)`,
	);
	await admin.execute(
		sql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${organizer.accountId},${organization},'owner',clock_timestamp())`,
	);

	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop });
	const created = await runtime.transaction((tx) =>
		onboarding.createPlant(
			tx,
			{
				session: owner.sessionId,
				selected: { kind: "account", id: owner.accountId },
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

	// Two churches with no households and one person each, one per browser engine, so the zero-household path
	// (WP-012/ui F10) never depends on another test's households. The test removes any household it makes.
	const empty: Record<string, { cookie: string; person: string }> = {};
	for (const engine of ["chromium", "webkit"]) {
		const who = await account(`Nora ${engine}`, `empty-${engine}@people-preview.example.test`);
		const made = await runtime.transaction((tx) =>
			onboarding.createPlant(
				tx,
				{ session: who.sessionId, selected: { kind: "account", id: who.accountId } } as never,
				{
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { name: `Empty Church ${engine}`, locality: { city: "Austin" }, confirmed: true },
				} as never,
			),
		);
		if (made.status !== "ok") throw Error("createPlant empty: " + JSON.stringify(made));
		const emptyPlant = (made.value as { plant: { kind: "plant"; id: string } }).plant;
		const pia = await runtime.transaction((tx) =>
			peopleWriter.createPerson(
				tx as never,
				{ session: who.sessionId, selected: emptyPlant } as never,
				{
					requestKey: randomUUID(),
					input: { displayName: "Pia Rivera", stage: "prospect", email: null, source: "other" },
				} as never,
			),
		);
		if (pia.status !== "ok") throw Error("create Pia: " + JSON.stringify(pia));
		empty[engine] = { cookie: who.cookie, person: pia.value.person.id };
	}

	// The Member seat. Seat acceptance belongs to WP-008; the seed writes the accepted seat and links its person.
	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${member.accountId},${plant.id},'member',clock_timestamp())`,
	);
	await runtime.transaction((tx) =>
		accountPersonProducer.ensureAccountPerson(tx, {
			accountId: member.accountId,
			owner: plant,
			selection: { kind: "create", displayName: "Ruth Allen" },
		} as never),
	);

	const ctx = { session: owner.sessionId, selected: plant } as never;
	const write = <T,>(run: (tx: unknown) => Promise<T>) => runtime.transaction((tx) => run(tx));
	const people: Record<string, { id: string; revision: string }> = {};
	const names: [string, string, string | null][] = [
		["Maria Santos", "interviewed", "maria@example.test"],
		["James Okafor", "following_up", "james@example.test"],
		["Ana Lee", "core_group", "ana@example.test"],
		["Tom Baker", "leader", null],
		["Kim Wu", "attendee", null],
		["Rosa Bennett", "launch_team", "rosa@example.test"],
		["Eli Park", "prospect", null],
		["Sara Nunez", "prospect", "sara@example.test"],
		["Leo Pratt", "attendee", null],
		["Mia Hall", "following_up", null],
		["David Kim", "interviewed", null],
	];
	for (let i = 0; names.length < 30; i++) names.push([`Guest ${String(i + 1).padStart(2, "0")}`, "prospect", null]);
	for (const [displayName, stage, email] of names) {
		const r = await write((tx) =>
			peopleWriter.createPerson(tx as never, ctx, {
				requestKey: randomUUID(),
				input: { displayName, stage, email, source: displayName === "Maria Santos" ? "vision_meeting" : "other" },
			} as never),
		);
		if (r.status !== "ok") throw Error(`create ${displayName}: ` + JSON.stringify(r));
		people[displayName] = { id: r.value.person.id, revision: r.value.person.revision };
	}
	const maria = people["Maria Santos"]!;
	const note = await write((tx) =>
		peopleWriter.addNote(tx as never, ctx, {
			requestKey: randomUUID(),
			expectedRevision: maria.revision,
			input: { personId: maria.id, body: "Wants to lead worship one Sunday a month after the baby comes." },
		} as never),
	);
	if (note.status !== "ok") throw Error("note: " + JSON.stringify(note));

	// A retired person, through the producer.
	const kim = people["Kim Wu"]!;
	const review = await admin.execute(sql`SELECT material_revision::text AS r FROM plant WHERE id=${plant.id}`);
	const retired = await write((tx) =>
		peopleWriter.retirePerson(
			tx as never,
			ctx,
			{
				requestKey: randomUUID(),
				expectedRevision: kim.revision,
				input: { personId: kim.id, reason: "Moved away", reviewRevision: review.rows[0]!.r, handoffs: [] },
			} as never,
			noReminders,
		),
	);
	if (retired.status !== "ok") throw Error("retire: " + JSON.stringify(retired));

	// A merged source. Merge belongs to WP-015 and has no producer yet; the seed writes the state it will produce.
	const merged = people[names.at(-1)![0]]!;
	await admin.execute(
		sql`UPDATE person SET state='merged', retired_at=clock_timestamp(), merged_into_person_id=${people["Eli Park"]!.id}, revision=revision+1 WHERE id=${merged.id}`,
	);

	// Follow-up duties for the pipeline badges. Tasks belong to WP-024; the seed writes two open parent tasks.
	await admin.execute(sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,due_date,person_id)
		VALUES (${plant.id},'Call James','follow_up','medium','not_started',clock_timestamp(),'date_only',(current_date - 3)::date,${people["James Okafor"]!.id}),
		       (${plant.id},'Invite Mia','follow_up','medium','not_started',clock_timestamp(),'undated',NULL,${people["Mia Hall"]!.id})`);

	// A minimal published wiki (WP-034/ui search proof). The starter snapshot is not installed in this schema, so the
	// seed writes one active release with three global articles, the rows the wiki producer reads.
	const GLOBAL = "00000000-0000-0000-0000-000000000000";
	const digest = () => randomBytes(32).toString("hex");
	const release = randomUUID();
	const sectionId = randomUUID();
	// A second section puts the launch checklists in the "Reference" sidenav group, so one Previous card crosses groups.
	const referenceSectionId = randomUUID();
	for (const [id, key] of [
		[sectionId, "framework/start"],
		[referenceSectionId, "reference/checklists"],
	] as const)
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},'section',${key},${GLOBAL})`,
		);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"release-" + release},'memory://ui-seed',${digest()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${digest()},'v','profile',1,${GLOBAL},0)`);
	const articles: [string, string, string, number][] = [
		[
			"Financial planning for a plant",
			"financial-planning",
			"Build a monthly budget before the first public gathering. Financial discipline protects the planter and the core group.",
			1,
		],
		[
			"Raising support",
			"raising-support",
			"Support raising is a relationship task. Share the vision, ask for a commitment and report back on how each financial gift was used.",
			2,
		],
		[
			"Choosing a meeting place",
			"meeting-place",
			"Visit three venues, compare cost and walk the neighborhood before you sign a lease.",
			1,
		],
	];
	// A reading-length article (Discovery) and enough short ones to make the sidenav taller than its column.
	const long = Array.from(
		{ length: 14 },
		(_, n) =>
			`## Section ${n + 1}\n\n${"Plan the work, name an owner and review it each month. ".repeat(14)}\n\n### Detail ${n + 1}\n\n${"Keep each step small and write down what you decided. ".repeat(10)}`,
	).join("\n\n");
	articles.unshift(["Setting up your website", "website-setup", long, 0], ["Team handbook", "team-handbook", long, 0]);
	articles.push(["Volunteer guide", "volunteer-guide", long, 0]);
	// WP-034/ui diagram blocks: one article with each diagram type, one plain fence and one malformed diagram, and two
	// real articles from the app's bootstrap corpus whose fences are text (phase 2, after Raising support).
	articles.push(["Diagram blocks", "diagram-blocks", DIAGRAM_ARTICLE, 2]);
	const corpus = JSON.parse(
		readFileSync(new URL("../../../docs/reference/bootstrap/global-seed-payload.json", import.meta.url), "utf8"),
	) as { articles: { slug: string; title: string; content: string }[] };
	for (const slug of [
		"administrative/financial/counting-procedures",
		"launch-sunday/partner-organization-coordination",
	]) {
		const row = corpus.articles.find((article) => article.slug === slug)!;
		articles.push([row.title, slug, row.content, 2]);
	}
	for (let n = 1; n <= 22; n += 1)
		articles.push([`Launch checklist ${n}`, `launch-checklist-${n}`, `Checklist ${n} for the launch team.`, 3]);
	for (const [position, [title, slug, body, phase]] of articles.entries()) {
		const id = randomUUID();
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},'article',${slug},${GLOBAL})`,
		);
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
			VALUES(${randomUUID()},${id},${GLOBAL},${release},1,${title},${slug},${title},${body},'safe_mdx',${phase},${position + 1},${digest()},clock_timestamp(),true,1,${slug.startsWith("launch-checklist-") ? referenceSectionId : sectionId},NULL,ARRAY[]::text[])`);
		await admin.execute(sql`INSERT INTO reference_version(id,item_id,release_id,version_number,artifact_path,content_hash,source_credit)
			VALUES(${randomUUID()},${id},${release},1,${"wiki/" + slug},${digest()},${position === 0 ? `docs/reference/bootstrap/global-seed-payload.json@${digest()}` : "UI seed"})`);
	}
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(${randomUUID()},${release},1,clock_timestamp(),'ui-seed','ui seed',0)`);

	const fixture = writeFixture("people", env.schema, {
		origin,
		plant: plant.id,
		empty,
		owner: { cookie: owner.cookie, accountId: owner.accountId },
		member: { cookie: member.cookie, accountId: member.accountId },
		seatless: { cookie: seatless.cookie },
		settings: { password: PASSWORD, emails: settings.map((a) => a.email) },
		organization: { cookie: organizer.cookie },
		people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.id])),
	});
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("people")));
else throw Error("Usage: seed.mts up <preview-url> | down");
