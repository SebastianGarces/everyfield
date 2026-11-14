// Seeds the organization oversight example (WP-047a) on the shared tests/ui seed environment (tests/ui/seed-env.mts):
// Hill Country Network with Owner, Admin and Member seats; Grace Austin, its sending church, with an Owner seat;
// Cedar Park Church, a sending church with an Owner seat and no plants; Gulf Coast Network with one plant of its own;
// and four plants linked to Hill Country: Harvest Point (Round Rock, TX) and Eastside Commons (Austin, TX) also through
// Grace Austin, Mueller Fellowship (Austin, TX) and Oak Cliff Church (Dallas, TX). WP-047b adds health, Launch and
// Regions: counting from today in each plant's time zone, Eastside is 10 days from Launch Sunday with its Worship
// responsibility filled and training done, Harvest Point 30 days out with its Children's responsibility unfilled,
// Oak Cliff 20 days out with one required training not done, and Mueller does not share Plant Intelligence findings.
// Harvest Point has published a launch summary (and holds a newer draft); Harvest Point and Eastside chose the Austin
// metro area and Oak Cliff the Dallas one, from the installed OMB 23-01 list. T-372 adds follow-ups, first-time
// committed adults and required training for Network Intelligence's NIR-04 to NIR-06 (seedRules), and a run from before
// those rules. Accounts sign up through the identity
// service, plants are created through the onboarding producer and every link is a real request and approval through
// the organizations adapter. Organizations and their seats are raw rows, because no public write creates them.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/oversight/seed.mts up <preview-url>
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/oversight/seed.mts down
//
// `up` writes every seat's session cookie, the plant and organization ids and one Harvest Point person id to
// $OVERSIGHT_UI_FIXTURE (default /tmp/everyfield-oversight-ui.json). Every account's password is in PASSWORD below.
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createIdentityService } from "../../../packages/domain/src/identity/index.ts";
import { createOnboardingProducer } from "../../../packages/domain/src/onboarding/index.ts";
import {
	createOrganizationAdapter,
	geographyReference,
	installGeographyRelease,
} from "../../../packages/domain/src/organizations/index.ts";
import { SEED } from "../../../packages/domain/src/launch/catalog.ts";
import { peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { randomUUID } from "node:crypto";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const PASSWORD = "Oversight-preview-pass-1";
type Owner = { kind: "plant"; id: string } | { kind: "organization"; id: string; organizationKind: OrgKind };
type OrgKind = "sending_church" | "sending_network";
type Account = { cookie: string; accountId: string; sessionId: string; email: string };

type Database = Awaited<ReturnType<typeof openSeedEnvironment>>["admin"];
/**
 * The example's accounts, organizations, plants, links and records in the schema `admin` and `runtime` are pinned to,
 * signed in for `origin` with `secret`. `address(n)` is the n-th sign-up address. Returns the fixture data.
 */
export async function seedOversight(env: {
	admin: Database;
	runtime: Database;
	authDb: Database;
	secret: string;
	origin: string;
	address: (n: number) => string;
}) {
	const { admin, runtime, authDb, secret, origin } = env;
	let ip = 1;
	const identity = createIdentityService({
		db: runtime,
		authDb,
		admissionDb: runtime,
		scheduleDelivery: () => {},
		origin,
		secret,
		trustedIp: () => env.address(ip),
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
	const tag = randomUUID().slice(0, 8);

	/** A signed-in active account. `kind` is the registration kind; organization accounts name their organization. */
	async function account(name: string, kind: "plant_precreation" | OrgKind, organizationName?: string) {
		ip++;
		const email = `${name.toLowerCase().replace(/\W+/g, ".")}.${tag}@oversight-preview.example.test`;
		const r = await call("register", {
			kind,
			name,
			email,
			password: PASSWORD,
			requestKey: randomUUID(),
			...(organizationName ? { organizationName } : {}),
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

	/** An organization row and its seats, raw: no public write creates either. */
	async function organization(name: string, kind: OrgKind, seats: [Account, "owner" | "admin" | "member"][]) {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO organization(id,kind,name,timezone,material_revision)
			VALUES(${id},${kind},${name},'America/Chicago',1)`);
		for (const [a, role] of seats)
			await admin.execute(sql`INSERT INTO seat(account_id,organization_id,role,accepted_at)
				VALUES(${a.accountId},${id},${role},clock_timestamp())`);
		return { kind: "organization", id, organizationKind: kind } as const;
	}

	const noop = async () => {};
	const onboarding = createOnboardingProducer({ invalidate: noop, notice: noop, enqueue: noop } as never);
	const ctx = (a: Account, selected: Owner | { kind: "account"; id: string }) =>
		({ session: a.sessionId, selected }) as never;
	const ok = <T,>(r: { status: string; value?: unknown }, what: string) => {
		if (r.status !== "ok") throw Error(`${what}: ${JSON.stringify(r)}`);
		return r.value as T;
	};
	const revision = async (plant: Owner) =>
		String((await admin.execute(sql`SELECT revision FROM plant WHERE id=${plant.id}`)).rows[0]!.revision);

	/** A plant created by its owner through onboarding, at `phase`, optionally answering the lead question yes. */
	async function plant(
		owner: Account,
		name: string,
		city: string,
		state: string,
		opts: { phase: number; lead: boolean; launch?: string },
	) {
		const created = ok<{ plant: { kind: "plant"; id: string } }>(
			await runtime.transaction((tx) =>
				onboarding.createPlant(tx, ctx(owner, { kind: "account", id: owner.accountId }), {
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { name, locality: { city, stateProvince: state, country: "US" }, confirmed: true },
				} as never),
			),
			`createPlant ${name}`,
		);
		const p = created.plant;
		if (opts.lead)
			ok(
				await runtime.transaction(async (tx) =>
					onboarding.answerLead(tx, ctx(owner, p), {
						requestKey: randomUUID(),
						expectedRevision: await revision(p),
						input: {
							answer: "yes",
							assignment: {
								kind: "minimal_role",
								roleName: "Lead planter",
								container: { kind: "minimal", name: "Leadership" },
							},
						},
					} as never),
				),
				`answerLead ${name}`,
			);
		await admin.execute(sql`UPDATE plant SET phase=${opts.phase}, street='4100 Private Street' WHERE id=${p.id}`);
		if (opts.launch)
			await admin.execute(
				sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${p.id},${opts.launch},'scheduled')`,
			);
		return p;
	}

	async function person(owner: Account, p: Owner, displayName: string, stage: string) {
		const r = await runtime.transaction((tx) =>
			peopleWriter.createPerson(tx as never, ctx(owner, p), {
				requestKey: randomUUID(),
				input: {
					displayName,
					stage,
					email: `${displayName.toLowerCase().replace(/\W+/g, ".")}@example.test`,
					source: "other",
				},
			} as never),
		);
		return ok<{ person: { id: string } }>(r as never, `person ${displayName}`).person.id;
	}

	// The organizations adapter as the production mount runs it, with the request proof kept here instead of mailed.
	const proofs = new Map<string, string>();
	const api = createOrganizationAdapter(
		{
			async invitation(_tx, v) {
				proofs.set(v.invitationId, v.proof);
			},
			// As the production mount: ending or changing a link stops queued digest work that read the old grant.
			invalidate: (_tx, v) =>
				sql`UPDATE job SET state='superseded',claim_generation=claim_generation+1,lease_owner=NULL,lease_until=NULL,
				revision=revision+1,finished_at=clock_timestamp() WHERE subject_record_id=${v.sourceId} AND kind='digest'
				AND state IN ('ready','retry_wait','claimed')`,
		},
		geographyReference,
	);
	const write = (a: Account, selected: Owner, name: string, expectedRevision: string, input: unknown) =>
		runtime.transaction(async (tx) => {
			if (!(await RequestActor.claimWrite(tx, a.sessionId as never, selected as never))) throw Error("unavailable");
			return (api as never as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]!(
				tx,
				a.sessionId,
				selected,
				{ requestKey: randomUUID(), expectedRevision, input },
			);
		});
	const subjectRevision = async (s: Owner) =>
		String(
			(
				await admin.execute(
					s.kind === "plant"
						? sql`SELECT revision FROM plant WHERE id=${s.id}`
						: sql`SELECT revision FROM organization WHERE id=${s.id}`,
				)
			).rows[0]!.revision,
		);
	/**
	 * `subject` asks `org` to connect, addressed to `orgOwner` (an Owner or Admin there), who approves; then the subject
	 * turns off every category not in `shared`. An address takes three requests in 30 days. Returns the relationship id.
	 */
	async function link(
		subject: Owner,
		subjectOwner: Account,
		org: Owner & { kind: "organization" },
		orgOwner: Account,
		shared: string[] | "all" = "all",
	) {
		const pair =
			subject.kind === "plant"
				? { kind: "plant", subject, organization: org }
				: { kind: "sending_church", subject, organization: org };
		const invited = (await write(subjectOwner, subject, "associations.invite", await subjectRevision(subject), {
			pair,
			recipientEmail: orgOwner.email,
		})) as { invitationId: string };
		const accepted = (await write(orgOwner, org, "associations.acceptInvitation", "1", {
			invitationId: invited.invitationId,
			proof: proofs.get(invited.invitationId),
			decision: "accept",
		})) as { status: string; relationship: { id: string } };
		if (accepted.status !== "accepted") throw Error(`accept: ${JSON.stringify(accepted)}`);
		const id = accepted.relationship.id;
		if (shared !== "all" && subject.kind === "plant")
			for (const category of ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "shared_findings"]) {
				if (shared.includes(category)) continue;
				const [now] = (
					await admin.execute(
						sql`SELECT revision::text AS revision, consent_revision::text AS consent FROM affiliation WHERE id=${id}`,
					)
				).rows as { revision: string; consent: string }[];
				await write(subjectOwner, subject, "privacy.setSharing", now!.revision, {
					plant: subject,
					organization: org,
					relationshipId: id,
					category,
					enabled: false,
					expectedConsentRevision: now!.consent,
				});
			}
		return id;
	}

	// Seats.
	const ruth = await account("Ruth Alvarez", "sending_network", "Hill Country Network");
	const sam = await account("Sam Ortega", "sending_network", "Hill Country Network");
	const lee = await account("Lee Park", "sending_network", "Hill Country Network");
	const paul = await account("Paul Grant", "sending_church", "Grace Austin");
	const ann = await account("Ann Cho", "sending_church", "Cedar Park Church");
	const gulfOwner = await account("Tess Moreau", "sending_network", "Gulf Coast Network");
	const network = await organization(`Hill Country Network`, "sending_network", [
		[ruth, "owner"],
		[sam, "admin"],
		[lee, "member"],
	]);
	const grace = await organization("Grace Austin", "sending_church", [[paul, "owner"]]);
	const cedar = await organization("Cedar Park Church", "sending_church", [[ann, "owner"]]);
	const gulf = await organization("Gulf Coast Network", "sending_network", [[gulfOwner, "owner"]]);

	// Plants. Dana owns Harvest Point; Marcus holds its lead planter role now.
	const dana = await account("Dana Ortiz", "plant_precreation");
	const priya = await account("Priya Shah", "plant_precreation");
	const ben = await account("Ben Ortiz", "plant_precreation");
	const grace2 = await account("Grace Kim", "plant_precreation");
	const remy = await account("Remy Fontenot", "plant_precreation");
	const hp = await plant(dana, "Harvest Point", "Round Rock", "TX", { phase: 3, lead: true, launch: "2027-03-14" });
	const ec = await plant(priya, "Eastside Commons", "Austin", "TX", { phase: 4, lead: true, launch: "2027-01-24" });
	const mf = await plant(ben, "Mueller Fellowship", "Austin", "TX", { phase: 1, lead: true });
	const oc = await plant(grace2, "Oak Cliff Church", "Dallas", "TX", { phase: 2, lead: false, launch: "2027-09-12" });
	const bayou = await plant(remy, "Bayou Church", "Houston", "TX", { phase: 1, lead: true });

	// Harvest Point's people: Marcus takes over the lead planter role from Dana; one person serves on two teams.
	const marcus = await person(dana, hp, "Marcus Hill", "leader");
	const hpPeople = [marcus];
	for (const [n, stage] of [
		["Maria Santos", "core_group"],
		["James Okafor", "core_group"],
		["Ana Lee", "launch_team"],
		["Tom Baker", "attendee"],
		["Kim Wu", "prospect"],
		["Rosa Bennett", "following_up"],
		["Eli Park", "interviewed"],
	] as const)
		hpPeople.push(await person(dana, hp, n, stage));
	// Contact details the oversight pages must never show.
	await admin.execute(sql`UPDATE person SET phone='512-555-0142', street='12 Private Lane' WHERE id=${marcus}`);
	await admin.execute(sql`UPDATE team_tenure SET ended_on=current_date WHERE plant_id=${hp.id} AND ended_on IS NULL`);
	await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
		SELECT ${hp.id}, (s.lead->'assignment'->>'roleId')::uuid, ${marcus}, current_date FROM onboarding_setup s
		WHERE s.plant_id=${hp.id}`);
	for (const [team, role] of [
		["Kids", "Kids helper"],
		["Worship", "Vocals"],
	]) {
		const t = await admin.execute(
			sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${hp.id},${team},'active',1) RETURNING id`,
		);
		const r = await admin.execute(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order)
			VALUES(${hp.id},${t.rows[0]!.id},${role},false,0) RETURNING id`);
		await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
			VALUES(${hp.id},${r.rows[0]!.id},${hpPeople[1]},current_date)`);
	}
	// Twelve open top-level tasks (two overdue), checklist rows on one, two waived, one cancelled and one complete.
	const task = async (status = "not_started", extra: { due?: string; parent?: string; deleted?: boolean } = {}) => {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,
			parent_id,deleted_at,completed_at) VALUES(${id},${hp.id},${`Launch prep ${id.slice(0, 4)}`},'general','medium',
			${status},clock_timestamp(),${extra.due ? "date_only" : "undated"},${extra.due ?? null},${extra.parent ?? null},
			${extra.deleted ? sql`clock_timestamp()` : null},${status === "complete" ? sql`clock_timestamp()` : null})`);
		return id;
	};
	for (let i = 0; i < 10; i++) await task();
	const parent = await task("in_progress", { due: "2026-10-01" });
	await task("blocked", { due: "2026-10-15" });
	for (let i = 0; i < 4; i++) await task("not_started", { parent });
	await task("no_longer_needed");
	await task("no_longer_needed");
	await task("not_started", { deleted: true });
	await task("complete");

	// Eastside Commons shares everything with Hill Country: meetings, teams, training and Wiki reading.
	const ecPeople: string[] = [];
	for (const [n, stage] of [
		["Jo Rivera", "core_group"],
		["Sam Lee", "core_group"],
		["Ava Chen", "launch_team"],
		["Noah Diaz", "attendee"],
		["Lia Ford", "leader"],
	] as const)
		ecPeople.push(await person(priya, ec, n, stage));
	for (const [i, date] of [
		"2026-08-04",
		"2026-08-18",
		"2026-09-01",
		"2026-09-15",
		"2026-09-29",
		"2026-10-13",
	].entries()) {
		const m = randomUUID();
		await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,
			resolver_version,status,attendance_revision,finalized_at) VALUES(${m},${ec.id},'vision_meeting','Vision night',
			${date},'18:00','America/Chicago',${date + "T23:00:00Z"},'1','completed',1,clock_timestamp())`);
		for (const who of ecPeople.slice(0, 2 + (i % 4)))
			await admin.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence)
				VALUES(${ec.id},${m},${who},true,'attended')`);
	}
	const ecTeam = await admin.execute(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${ec.id},'Hospitality','active',1) RETURNING id`,
	);
	for (const [role, holder] of [
		["Greeter lead", ecPeople[0]],
		["Coffee", null],
	] as const) {
		const r = await admin.execute(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order)
			VALUES(${ec.id},${ecTeam.rows[0]!.id},${role},false,0) RETURNING id`);
		if (holder)
			await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
				VALUES(${ec.id},${r.rows[0]!.id},${holder},current_date)`);
	}
	const program = await admin.execute(
		sql`INSERT INTO training_program(plant_id,name,required) VALUES(${ec.id},'Safe kids',true) RETURNING id, version`,
	);
	const { id: programId, version } = program.rows[0] as { id: string; version: number };
	for (const who of ecPeople.slice(0, 3))
		await admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
			VALUES(${ec.id},${programId},${who},${version},'active',current_date)`);
	await admin.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
		VALUES(${ec.id},${ecPeople[0]},${programId},'earned',${version},current_date)`);
	const GLOBAL = "00000000-0000-0000-0000-000000000000";
	const [section, release, article, articleRevision] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
	const hash = () => randomUUID().replaceAll("-", "").repeat(2);
	await admin.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES
		(${section},'section',${`framework/oversight-${tag}`},${GLOBAL}),(${article},'article',${`oversight-${tag}`},${GLOBAL})`);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,
		validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"oversight-" + release},'memory://oversight',${hash()},'validated',clock_timestamp(),clock_timestamp(),
		'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,
		body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
		VALUES(${articleRevision},${article},${GLOBAL},${release},1,'Oversight seed article',${`oversight-${tag}`},'About it',
		'Opening line.','safe_mdx',1,1,${hash()},clock_timestamp(),true,1,${section},ARRAY[]::text[])`);
	for (const [reader, done] of [
		[priya, true],
		[dana, false],
	] as const)
		await admin.execute(sql`INSERT INTO reading(account_id,article_id,plant_context_id,observed_fraction,completed_at,
			completed_revision_id,policy_version,last_read_meaningful_sequence,bookmarked)
			VALUES(${reader.accountId},${article},${ec.id},0.6,${done ? sql`clock_timestamp()` : null},
			${done ? articleRevision : null},'v1',0,false)`);

	// Links. Harvest Point and Oak Cliff share People, Meetings, Tasks, Ministry teams and findings with Hill Country; Grace
	// Austin sees everything. Westlake is linked to Grace Austin and Gulf Coast only.
	const westlakeOwner = await account("Wes Hale", "plant_precreation");
	const westlake = await plant(westlakeOwner, "Westlake Church", "Austin", "TX", { phase: 1, lead: false });
	await link(grace, paul, network, ruth);
	await link(hp, dana, network, ruth, ["people", "tasks", "meetings", "ministry_teams", "shared_findings"]);
	await link(hp, dana, grace, paul);
	await link(ec, priya, network, ruth);
	await link(ec, priya, grace, paul);
	await link(mf, ben, network, sam, ["people"]);
	await link(oc, grace2, network, sam, ["people", "meetings", "tasks", "ministry_teams", "shared_findings"]);
	await link(bayou, remy, gulf, gulfOwner);
	await link(westlake, westlakeOwner, grace, paul);
	await link(westlake, westlakeOwner, gulf, gulfOwner);
	// Cedar Park asked Hill Country to connect: one request is waiting, one expired.
	for (const [age, email] of [
		["1 day", `requests.${tag}@oversight-preview.example.test`],
		["31 days", `old.requests.${tag}@oversight-preview.example.test`],
	]) {
		const invitation = randomUUID();
		await admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,revision)
			VALUES(${invitation},${cedar.id},'church_network',${email},${randomUUID()},'pending',clock_timestamp() - ${age}::interval,1)`);
		await admin.execute(sql`INSERT INTO relationship_invitation(invitation_id,sending_church_id,organization_id,
			inviter_description,subject_revision) VALUES(${invitation},${cedar.id},${network.id},'Cedar Park Church',1)`);
	}

	// A Member seat of Harvest Point, who reads the church settings' Region but cannot change it.
	const mia = await account("Mia Torres", "plant_precreation");
	await admin.execute(sql`INSERT INTO seat(account_id,plant_id,role,accepted_at)
		VALUES(${mia.accountId},${hp.id},'member',clock_timestamp())`);
	await seedLaunch();
	await seedRules();

	/** WP-047b: Launch Sunday, responsibilities, training, a published summary and reporting Regions. */
	async function seedLaunch() {
		await installGeographyRelease(admin);
		// Launch Sunday `days` from today in the plant's own time zone; the directory dates above are replaced.
		const launchIn = async (p: Owner, days: number) => {
			await admin.execute(sql`INSERT INTO launch(plant_id,status,target_date)
				SELECT ${p.id},'scheduled',(clock_timestamp() AT TIME ZONE pl.timezone)::date + ${days}::int FROM plant pl
				WHERE pl.id=${p.id} ON CONFLICT (plant_id) DO UPDATE SET status='scheduled', target_date=excluded.target_date`);
			for (const [i, m] of SEED.entries())
				await admin.execute(sql`INSERT INTO launch_milestone(plant_id,title,area,position,template_key,completed_at)
					VALUES(${p.id},${m.title},${m.area},${i},${m.key},${p.id === hp.id && i < 4 ? sql`clock_timestamp()` : null})
					ON CONFLICT DO NOTHING`);
		};
		await launchIn(ec, 10);
		await launchIn(hp, 30);
		await launchIn(oc, 20);
		await launchIn(mf, 5);
		/** A role on its own ministry carrying a Playbook responsibility, held by `holder` when given. */
		const responsibility = async (p: Owner, team: string, key: string, holder: string | null) => {
			const t = await admin.execute(
				sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${p.id},${team},'active',2) RETURNING id`,
			);
			const r = await admin.execute(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order,
				responsibility_key) VALUES(${p.id},${t.rows[0]!.id},${team + " lead"},true,0,${key}) RETURNING id`);
			if (holder)
				await admin.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
					VALUES(${p.id},${r.rows[0]!.id},${holder},current_date)`);
		};
		await responsibility(ec, "Sunday worship", "worship", ecPeople[1]!);
		// Eastside's required training is done by everyone it is assigned to.
		for (const who of ecPeople.slice(1, 3))
			await admin.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
				VALUES(${ec.id},${who},${programId},'earned',${version},current_date)`);
		await responsibility(hp, "Sunday worship", "worship", hpPeople[2]!);
		await responsibility(hp, "Children's ministry", "children", null);
		const olive = await person(grace2, oc, "Olive Grant", "launch_team");
		await responsibility(oc, "Sunday worship", "worship", olive);
		const g = await admin.execute(
			sql`INSERT INTO training_program(plant_id,name,required) VALUES(${oc.id},'Safe kids',true) RETURNING id, version`,
		);
		await admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
			VALUES(${oc.id},${g.rows[0]!.id},${olive},${g.rows[0]!.version},'active',current_date)`);
		await admin.execute(sql`INSERT INTO launch_summary(plant_id,version,body,saved_at,published_at) VALUES
			(${hp.id},1,${"Our preview service drew 140 people. Thank you for praying with us as we head into Launch Sunday."},
			clock_timestamp(),clock_timestamp()),
			(${hp.id},2,${"Draft: guests Jane Doe and Carl Ruiz came with the Bensons."},clock_timestamp(),NULL)`);
		for (const [p, city, code] of [
			[hp, "Round Rock", "12420"],
			[ec, "Austin", "12420"],
			[oc, "Dallas", "19100"],
		] as const)
			await admin.execute(sql`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,
				reference_version_id,committed_at,effective_at)
				SELECT ${p.id},${city},'TX','US',i.id,v.id,clock_timestamp(),clock_timestamp()
				FROM reference_item i, reference_version v JOIN reference_item d ON d.id=v.item_id
				WHERE i.kind='geography_region' AND i.canonical_key=${"omb-23-01/" + code}
				AND d.kind='geography_dataset' AND d.canonical_key='omb-23-01'`);
	}

	/**
	 * T-372: the evidence of Network Intelligence's NIR-04 to NIR-06, plus one run as T-303 stored it, a day old. Harvest
	 * Point has 2 overdue follow-ups (1 with no owner), its newest first-time committed adult signed 24 days ago and 3
	 * saved required trainings with 1 complete; Oak Cliff has 3 overdue (2 with no owner), 26 days and 4 with 2 complete.
	 */
	async function seedRules() {
		const day = (p: Owner, days: number) =>
			sql`(SELECT (clock_timestamp() AT TIME ZONE timezone)::date + ${days}::int FROM plant WHERE id=${p.id})`;
		/** The church Owner as a live, committed Person linked to their account, so they may own follow-ups. */
		const ownerPerson = async (p: Owner, a: Account, name: string) => {
			await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
				commitment_state,pipeline_position,state,created_at,linked_account_id)
				SELECT ${randomUUID()},${p.id},${p.id},${name},'other','leader','adult','unknown','1','live',clock_timestamp(),
				${a.accountId} WHERE NOT EXISTS(SELECT FROM person WHERE tenant_id=${p.id} AND linked_account_id=${a.accountId})`);
			await admin.execute(
				sql`UPDATE person SET stage='leader' WHERE tenant_id=${p.id} AND linked_account_id=${a.accountId}`,
			);
		};
		const followUps = async (p: Owner, owner: Account, about: string, due: [number, boolean][]) => {
			for (const [days, owned] of due) {
				const id = randomUUID();
				await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,
					due_date,person_id) VALUES(${id},${p.id},'Call after the Vision meeting','follow_up','medium','not_started',
					clock_timestamp(),'date_only',${day(p, days)},${about})`);
				if (owned)
					await admin.execute(
						sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${p.id},${id},${owner.accountId})`,
					);
			}
		};
		const adult = async (p: Owner, owner: Account, name: string, days: number) => {
			const id = await person(owner, p, name, "launch_team");
			await admin.execute(sql`UPDATE person SET adult_classification='adult' WHERE id=${id}`);
			await admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at)
				VALUES(${randomUUID()},${p.id},${id},'launch_team',${day(p, -days)},clock_timestamp())`);
			return id;
		};
		const training = async (p: Owner, people: string[], complete: number) => {
			const g = await admin.execute(sql`INSERT INTO training_program(plant_id,name,required)
				VALUES(${p.id},'Child safety',true) RETURNING id, version`);
			const { id, version } = g.rows[0] as { id: string; version: number };
			for (const [i, who] of people.entries()) {
				await admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
					VALUES(${p.id},${id},${who},${version},'active',current_date)`);
				if (i < complete)
					await admin.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
						VALUES(${p.id},${who},${id},'earned',${version},current_date)`);
			}
		};
		await ownerPerson(hp, dana, "Dana Ortiz");
		await followUps(hp, dana, hpPeople[6]!, [
			[-3, false],
			[-1, true],
			[2, false],
		]);
		const hpAdults = [await adult(hp, dana, "Nina Brooks", 60), await adult(hp, dana, "Owen Price", 24)];
		await training(hp, [...hpAdults, hpPeople[1]!], 1);

		await ownerPerson(oc, grace2, "Grace Kim");
		const guest = await person(grace2, oc, "Luis Romero", "following_up");
		await followUps(oc, grace2, guest, [
			[-2, false],
			[-6, false],
			[-1, true],
		]);
		const withdrawn = await adult(oc, grace2, "Hana Mori", 26);
		await admin.execute(sql`INSERT INTO commitment_change(id,plant_id,person_id,kind,effective_on)
			VALUES(${randomUUID()},${oc.id},${withdrawn},'withdrawn',${day(oc, -3)})`);
		const ocAdults = [withdrawn, await adult(oc, grace2, "Ivy Chen", 70)];
		// Olive's Safe kids stays outstanding; Child safety adds 3 more, 2 complete.
		await training(oc, [...ocAdults, guest], 2);

		// A run from before these rules: preparation counts and location only, so NIR-04 to NIR-06 read Unknown.
		const run = randomUUID();
		await admin.execute(sql`INSERT INTO network_intelligence_run(id,organization_id,rubric_version,ran_at)
			VALUES(${run},${network.id},'everyfield-network/v1',clock_timestamp()-interval '1 day')`);
		await admin.execute(sql`INSERT INTO network_intelligence_plant(run_id,plant_id,launched,days_to_launch,unfilled_roles,
			outstanding_training,region_item_id,state_province,country)
			SELECT ${run},g.plant_id,false,x.days,x.unfilled,x.training,g.region_item_id,'TX','US' FROM plant_geography g
			JOIN (VALUES (${hp.id}::uuid,29,1,0),(${ec.id}::uuid,11,0,0),(${oc.id}::uuid,21,0,1)) x(plant,days,unfilled,training)
			ON x.plant=g.plant_id`);
	}

	const seat = (a: Account) => ({ cookie: a.cookie, accountId: a.accountId, email: a.email });
	return {
		origin,
		password: PASSWORD,
		seats: {
			networkOwner: seat(ruth),
			networkAdmin: seat(sam),
			networkMember: seat(lee),
			graceOwner: seat(paul),
			cedarOwner: seat(ann),
			harvestPointOwner: seat(dana),
			eastsideOwner: seat(priya),
			harvestPointMember: seat(mia),
		},
		organizations: { network: network.id, grace: grace.id, cedar: cedar.id, gulf: gulf.id },
		plants: {
			harvestPoint: hp.id,
			eastside: ec.id,
			mueller: mf.id,
			oakCliff: oc.id,
			bayou: bayou.id,
			westlake: westlake.id,
		},
		harvestPointPerson: marcus,
	};
}

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	const data = await seedOversight({ ...env, origin, address: (n) => env.loopback("oversight", n) });
	const fixture = writeFixture("oversight", env.schema, data);
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, fixture }));
}

const [action, arg] = process.argv.slice(2);
if (action === "up" && arg) await up(arg.replace(/\/$/, ""));
else if (action === "down") console.log(JSON.stringify(await dropSeed("oversight")));
else if (action !== undefined) throw Error("Usage: seed.mts up <preview-url> | down");
