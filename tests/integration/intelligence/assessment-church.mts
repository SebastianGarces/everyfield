import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createPrivateCare } from "../../../packages/domain/src/intelligence/index.ts";
import { requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/intelligence.ts";
import { commitments, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { fixture, ok } from "../../support/fixture.mts";

export const GLOBAL = "00000000-0000-0000-0000-000000000000";
export const ZONE = "America/Chicago";
export const CANARY = "canary-7f3a";
const hash = () => randomBytes(32).toString("hex");

export const METHODOLOGY = [
	[
		"core-group-commitment",
		1,
		"How a core group forms.\n## Building commitment\nA core group grows as adults make a written commitment to the plant. Invite people who keep coming to Vision meetings to commit.",
	],
	[
		"ministry-leaders",
		1,
		"Leaders carry the launch.\n## Filling ministry responsibilities\nEvery ministry responsibility needs a leader before launch: worship, children, assimilation and the rest.",
	],
	[
		"vision-meeting-rhythm",
		null,
		"Vision meetings keep momentum.\n## Keeping the rhythm\nHold a Vision meeting every two weeks so new people can hear the vision and commit.",
	],
	[
		"training-and-preparation",
		3,
		"Training prepares the team.\n## Required training\nIn Training and Preparation every team member finishes the required training for their ministry.",
	],
] as const;

export async function church(prefix: string, { cleanup = false } = {}) {
	const database = await fixture({
		prefix,
		max: 6,
		...(cleanup ? { roles: { runtime: ["runtime"] as const, cleanup: ["cleanup"] as const } } : {}),
	});
	const { admin } = database;
	const db = database.pools.runtime;
	const care = createPrivateCare();
	const rows = async (q: ReturnType<typeof sql>) => (await admin.execute(q)).rows as Record<string, any>[];
	const one = async (q: ReturnType<typeof sql>) => (await rows(q))[0]!;
	const today = (await one(sql`SELECT (clock_timestamp() AT TIME ZONE ${ZONE})::date::text AS d`)).d as string;
	const day = (n: number) => new Date(Date.parse(today + "T12:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
	const record = (id: string, kind: string, tenant: string) =>
		admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${tenant}) ON CONFLICT DO NOTHING`);
	const section = randomUUID();
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','framework/methodology',${GLOBAL})`,
	);
	const articles: Record<string, string> = {};
	for (const [slug] of METHODOLOGY) {
		articles[slug] = randomUUID();
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${articles[slug]},'article',${slug},${GLOBAL})`,
		);
	}
	let activations = 0;

	async function release(key: string, edit: (body: string) => string = (b) => b) {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,
			validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
			VALUES(${id},${key},'memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',
			${hash()},'v','none',1,${GLOBAL},0)`);
		const revisions: Record<string, string> = {};
		for (const [slug, phase, body] of METHODOLOGY) {
			const number =
				Number((await one(sql`SELECT count(*)::int AS n FROM article_revision WHERE article_id=${articles[slug]}`)).n) +
				1;
			revisions[slug] = randomUUID();
			await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,
				excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
				VALUES(${revisions[slug]},${articles[slug]},${GLOBAL},${id},${number},${slug.replaceAll("-", " ")},${slug},${slug},
				${edit(body)},'safe_mdx',${phase},1,${hash()},clock_timestamp(),true,${number},${section})`);
		}
		await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,
			reason,expected_prior_number) VALUES(${randomUUID()},${id},${++activations},clock_timestamp(),'synthetic','test',
			${activations - 1})`);
		return { id, key, revisions };
	}
	async function activate(releaseId: string) {
		await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,
			reason,expected_prior_number) VALUES(${randomUUID()},${releaseId},${++activations},clock_timestamp(),'synthetic',
			'rollback',${activations - 1})`);
	}

	async function network(name = "Hill Country Network") {
		const org = await database.organization("sending_network", { name, timezone: ZONE });
		const article = randomUUID();
		const revision = randomUUID();
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${article},'article','network/follow-up',${org.id})`,
		);
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,revision_number,title,slug,excerpt,body,
			content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${revision},${article},${org.id},1,'Our follow-up practice','network/follow-up','Follow-up',
			${"How this network follows up.\n## Following up with guests\nCall every guest within two days of their first visit; a network coach can help you follow up."},
			'safe_nodes',null,1,${hash()},clock_timestamp(),true,1,${section})`);
		await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
			VALUES(${randomUUID()},${org.id},${article},'published',${revision},1)`);
		const director = await database.actor(org, "admin");
		return { ...org, article, revision, director };
	}

	async function plant(name: string, { phase = 1, network: org }: { phase?: number; network?: { id: string } } = {}) {
		const w = await database.plant({ name, timezone: ZONE, phase });
		const owner = await database.actor(w, "owner");
		await admin.execute(sql`UPDATE account SET personal_timezone=${ZONE} WHERE id=${owner.id}`);
		let affiliation: string | null = null;
		if (org) {
			affiliation = randomUUID();
			await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,
				share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${affiliation},${w.id},${org.id},clock_timestamp()-interval '1 day',false,false,false,false,true,false,true)`);
		}
		const actor = (await RequestActor.resolve(db, owner.session as never)) as RequestActor;
		const ctx = { session: owner.session, selected: { kind: "plant", id: w.id } };
		return { ...w, name, owner, actor, ctx, affiliation };
	}
	type Plant = Awaited<ReturnType<typeof plant>>;

	async function person(
		p: Plant,
		displayName: string,
		input: Record<string, unknown> = { adultClassification: "adult" },
	) {
		return ok(
			await db.transaction((t) =>
				peopleWriter.createPerson(
					t as never,
					p.ctx as never,
					{
						requestKey: randomUUID(),
						input: { displayName, ...input },
					} as never,
				),
			),
		).person as { id: string };
	}
	async function committed(p: Plant, name: string, daysAgo = 60, input?: Record<string, unknown>) {
		const who = await person(p, name, input);
		ok(
			await db.transaction((t) =>
				commitments.createCommitment(
					t as never,
					p.ctx as never,
					{
						requestKey: randomUUID(),
						input: { personId: who.id, kind: "core_group", occurredOn: day(-daysAgo) },
					} as never,
				),
			),
		);
		return who;
	}
	async function vision(p: Plant, daysAgo: number, people: { id: string }[]) {
		const id = randomUUID();
		await record(id, "meeting", p.id);
		const on = day(-daysAgo);
		const at = `${on}T18:00:00-06:00`;
		await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,
			status,attendance_revision,actual_occurrence_at,vision_number)
			VALUES(${id},${p.id},'vision_meeting',${on},'18:00',${ZONE},${at}::timestamptz,'r1','completed',1,${at}::timestamptz,
			(SELECT coalesce(max(vision_number),0)+1 FROM meeting WHERE plant_id=${p.id}))`);
		for (const who of people) {
			const pa = randomUUID();
			await record(pa, "participation", p.id);
			await admin.execute(sql`INSERT INTO participation(id,plant_id,meeting_id,person_id,roster_member,presence)
				VALUES(${pa},${p.id},${id},${who.id},true,'attended')`);
		}
		return id;
	}
	async function humanRecords(p: Plant, who: { id: string }, daysAgo: number) {
		const i = randomUUID(),
			f = randomUUID();
		await record(i, "interview", p.id);
		await record(f, "four_cs", p.id);
		await admin.execute(sql`INSERT INTO interview(id,plant_id,person_id,interviewed_on,recorded_at,maturity,gifted,chemistry,
			right_reasons,season,maturity_notes,result) VALUES(${i},${p.id},${who.id},${day(-daysAgo)},clock_timestamp(),'concern',
			'pass','pass','pass','fail',${CANARY + "-interview"},'not_qualified')`);
		await admin.execute(sql`INSERT INTO four_cs(id,plant_id,person_id,assessed_on,recorded_at,committed,compelled,contagious,
			courageous,committed_notes) VALUES(${f},${p.id},${who.id},${day(-daysAgo)},clock_timestamp(),2,3,1,4,${CANARY + "-4cs"})`);
	}
	async function checkIn(p: Plant) {
		const current = ok(await care.readCurrent(db, p.actor, {}));
		const struggling = { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" };
		ok(
			await care.save(db, p.actor, {
				requestKey: randomUUID(),
				expectedRevision: current.revision,
				input: { answers: struggling, note: CANARY + "-care" },
			}),
		);
	}
	async function role(p: Plant, key: string, holder: { id: string } | null) {
		const team = randomUUID(),
			r = randomUUID();
		await record(team, "team", p.id);
		await record(r, "team_role", p.id);
		await admin.execute(
			sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${p.id},${key},'active',1)`,
		);
		await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,responsibility_key)
			VALUES(${r},${p.id},${team},${key + " lead"},true,1,${key})`);
		if (holder) {
			const t = randomUUID();
			await record(t, "team_tenure", p.id);
			await admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on)
				VALUES(${t},${p.id},${r},${holder.id},${day(-10)})`);
		}
	}

	async function harvest(name = "Harvest Point", options: { network?: { id: string } } = {}) {
		const p = await plant(name, options);
		const adults = [];
		for (let i = 0; i < 30; i++)
			adults.push(await committed(p, `Adult ${String(i + 1).padStart(2, "0")}`, i === 0 ? 5 : 60));
		await vision(p, 4, adults.slice(0, 18));
		await humanRecords(p, adults[1]!, 40);
		await humanRecords(p, adults[2]!, 10);
		await checkIn(p);
		await role(p, "worship", adults[3]!);
		await role(p, "children", adults[4]!);
		return p;
	}
	async function portfolio(name: string, publish: (p: Plant) => Promise<unknown>) {
		const s1 = await database.organization("sending_network", { name: `${name} Network`, timezone: ZONE });
		const seat = await database.actor(s1, "admin");
		const director = (await RequestActor.resolve(db, seat.session as never)) as RequestActor;
		const p = await harvest(`${name} P`, { network: s1 });
		const q = await harvest(`${name} Q`, { network: s1 });
		for (const x of [p, q])
			await admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
				share_ministry_teams=true WHERE id=${x.affiliation}`);

		const seated = async (w: { id: string }, account: { id: string; session: string }) => ({
			...account,
			seatId: (await one(sql`SELECT id FROM seat WHERE account_id=${account.id} AND plant_id=${w.id}`)).id as string,
			actor: (await RequestActor.resolve(db, account.session as never)) as RequestActor,
			ctx: { session: account.session, selected: { kind: "plant", id: w.id } },
		});
		const a = await seated(p, await database.actor(p, "admin", { account: { personal_timezone: ZONE } }));
		const contact = await person({ ...p, ctx: a.ctx }, "Alex Contact");
		const meeting = await vision(p, 3, [contact]);
		await admin.execute(sql`UPDATE meeting SET creator_id=${a.id} WHERE id=${meeting}`);
		const program = (await one(sql`INSERT INTO training_program(plant_id,name,required) VALUES(${p.id},'Safe kids',true)
			RETURNING id,version`)) as { id: string; version: number };
		await admin.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
			VALUES(${p.id},${program.id},${contact.id},${program.version},'active',${day(-2)})`);
		const credit = (
			await one(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on,
			verifier_account_id) VALUES(${p.id},${contact.id},${program.id},'earned',${program.version},${day(-1)},${a.id})
			RETURNING id`)
		).id as string;
		await admin.execute(sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${p.id},'scheduled',${day(90)})`);
		const milestone = (
			await one(sql`INSERT INTO launch_milestone(plant_id,title,area,position,template_key,completed_at,
			completed_by) VALUES(${p.id},'Book the venue','operations',0,'venue',clock_timestamp(),${a.id}) RETURNING id`)
		).id as string;
		const current = ok(await care.readCurrent(db, a.actor, {}));
		const strained = { spiritual: "strained", family: "strained", financial: "strained", pace: "strained" };
		ok(
			await care.save(db, a.actor, {
				requestKey: randomUUID(),
				expectedRevision: current.revision,
				input: { answers: strained, note: CANARY + "-alex-care" },
			}),
		);

		const seatB = await seated(p, await database.actor(p, "admin"));
		const leader = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id) VALUES(${leader},${p.id},${p.id},'Casey Leader',
			${randomUUID() + "@example.test"},'other','leader','adult','unknown','1','live',clock_timestamp(),${seatB.id})`);
		const obligation = randomUUID(),
			task = randomUUID();
		await record(obligation, "obligation", p.id);
		await record(task, "task", p.id);
		await admin.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
			formula_version,due_date) VALUES(${obligation},${p.id},${meeting},${contact.id},'follow_up',
			clock_timestamp()-interval '72 hours',${day(-3)},${ZONE},'f1',${day(-1)})`);
		await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,
			person_id) VALUES(${task},${p.id},'Call Alex Contact','follow_up','medium','not_started',
			clock_timestamp()-interval '72 hours','undated',${obligation},${contact.id})`);
		await admin.execute(
			sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${p.id},${task},${seatB.id})`,
		);
		const b = await database.actor(q, "admin");

		await publish(p);
		await publish(q);
		const runId = randomUUID();
		ok(await requestIntelligenceRefresh(db, director, { runId }));
		return {
			s1,
			director,
			p,
			q,
			a,
			b,
			seatB: { ...seatB, leader, task },
			records: { contact: contact.id, meeting, credit, milestone },
			runId,
		};
	}
	async function unknownCount(name = "Mueller Fellowship") {
		const p = await plant(name);
		const adults = [];
		for (let i = 0; i < 29; i++) adults.push(await committed(p, `Adult ${i + 1}`, 60));
		await committed(p, "Sam Unclassified", 30, {});
		await vision(p, 6, adults.slice(0, 10));
		return p;
	}
	async function phaseThree(name = "Oak Cliff Church") {
		const p = await plant(name, { phase: 3 });
		const adults = [];
		for (let i = 0; i < 12; i++) adults.push(await committed(p, `Adult ${i + 1}`, 60));
		await vision(p, 9, adults.slice(0, 8));
		return p;
	}

	return {
		database,
		admin,
		db,
		rows,
		one,
		today,
		day,
		release,
		activate,
		network,
		plant,
		person,
		committed,
		harvest,
		portfolio,
		unknownCount,
		phaseThree,
	};
}
export type Church = Awaited<ReturnType<typeof church>>;
