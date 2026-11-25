import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import * as c from "../../../packages/contracts/src/intelligence/index.ts";
import {
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { installGeographyRelease } from "../../../packages/domain/src/organizations/index.ts";
import { requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/index.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok } from "../../support/fixture.mts";
import { CANARY, church, type Church } from "../../integration/intelligence/assessment-church.mts";

export const TODAY = new Date("2026-10-13T15:00:00Z");
export { CANARY };
export const FOLLOW_UP = "Finish guest follow-up from the Vision meeting";
const PRAYER = "Set a regular prayer rhythm";

const jobAt = (at: string) => createAssessmentJob({ clock: { now: () => at as never } });
const assessments = createAssessments();
const drafter = () =>
	scriptedAssessmentDrafter({
		script: (draft) => ({
			...draft,
			summary: `This looks at your launch progress in Phase 1. The main thing to look at now: ${FOLLOW_UP.toLowerCase()}.`,
			focus: {
				title: FOLLOW_UP,
				body: "Follow-up timing isn't measured yet. You might finish calling the guests from your last Vision meeting.",
				urgency: "watch",
				citations: ["followUps.status", "vision.lastHeldOn"],
			},
			supporting: [
				{
					title: PRAYER,
					body: "No prayer rhythm is recorded yet. You might ask your team when to meet to pray.",
					urgency: "watch",
					citations: ["attestations.prayer_rhythm_established"],
				},
				draft.supporting[1],
			],
		}),
	});

export async function intelligenceChurch(prefix: string, roles?: NonNullable<Parameters<typeof church>[1]>["roles"]) {
	const ch = await church(prefix, { clock: TODAY, max: 10, roles });
	try {
		return await seed(ch);
	} catch (error) {
		await ch.database.close();
		throw error;
	}
}

async function seed(ch: Church) {
	await ch.release("methodology-2026.10");
	const { admin, db } = ch;
	const job = async () =>
		jobAt(
			String(
				(
					await ch.one(
						sql`SELECT to_char((clock_timestamp()+interval '1 millisecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`,
					)
				).t,
			),
		);
	const resolve = async (session: string) => (await RequestActor.resolve(db, session as never)) as RequestActor;

	const cedar = await ch.plant("Cedar Creek Church");
	const adults = [];
	for (let i = 0; i < 28; i++)
		adults.push(await ch.committed(cedar, `Cedar Adult ${String(i + 1).padStart(2, "0")}`, i === 0 ? 5 : 60));
	const unclassified = [
		await ch.committed(cedar, "Jordan Unclassified", 30, {}),
		await ch.committed(cedar, "Riley Unclassified", 30, {}),
	];
	for (let i = 0; i < 10; i++)
		await ch.person(cedar, `Core Stage ${i + 1}`, { adultClassification: "adult", stage: "core_group" });
	await ch.vision(cedar, 4, adults.slice(0, 12));
	await ch.role(cedar, "worship", adults[3]!);
	await ch.role(cedar, "children", adults[4]!);
	await ch.checkIn(cedar);
	const admin1 = await ch.database.actor(cedar, "admin");
	const member = await ch.database.actor(cedar, "member");

	async function publish() {
		await assessments.requestRefresh(db, cedar.actor, { requestId: randomUUID() });
		return runJob();
	}
	async function runJob(plant: { id: string; name: string; actor: RequestActor } = cedar) {
		await runAssessmentBatch(await job(), db, drafter(), 20);
		const view = ok(await assessments.readAssessment(db, plant.actor, {})) as c.AssessmentView;
		if (!view.current || view.newest) {
			const runs = await ch.rows(sql`SELECT outcome,reason,drafts->-1->'violations' AS v FROM assessment_run
				WHERE plant_id=${plant.id} ORDER BY captured_at DESC LIMIT 1`);
			throw new Error(`${plant.name}'s assessment did not publish: ${JSON.stringify(runs)}`);
		}
		return view;
	}
	await publish();
	async function classify() {
		for (const p of unclassified)
			await admin.execute(sql`UPDATE person SET adult_classification='adult' WHERE id=${p.id}`);
	}

	await installGeographyRelease(admin);
	const network = await ch.database.organization("sending_network", {
		name: "North Texas Network",
		timezone: "America/Chicago",
	});
	const director = await ch.database.actor(network, "admin");
	const networkMember = await ch.database.actor(network, "member");
	const plants: Record<string, Awaited<ReturnType<Church["plant"]>>> = {};
	const PLANTS = [
		["Harvest Point", "Fort Worth", "TX", true],
		["Redeemer Church", "Dallas", "TX", true],
		["Grace Tulsa", "Tulsa", "OK", true],
		["Hill Country Church", "Austin", "TX", false],
	] as const;
	for (const [name, city, state, shares] of PLANTS) {
		const p = await ch.plant(name, { network });
		plants[name] = p;
		await admin.execute(sql`UPDATE plant SET city=${city},state_province=${state},country='US' WHERE id=${p.id}`);
		await admin.execute(sql`UPDATE affiliation SET share_people=${shares},share_meetings=${shares},share_tasks=${shares},
			share_ministry_teams=${shares},shared_findings=${shares} WHERE id=${p.affiliation}`);
		for (let i = 0; i < 3; i++)
			await ch.committed(p, `${name.split(" ")[0]} Person ${i + 1}`, name === "Grace Tulsa" ? 5 : 60);
	}
	await admin.execute(sql`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,reference_version_id,
		committed_at,effective_at)
		SELECT ${plants["Harvest Point"]!.id}::uuid,'Fort Worth','TX','US',i.id,v.id,clock_timestamp(),clock_timestamp()
		FROM reference_item i, reference_version v JOIN reference_item d ON d.id=v.item_id AND d.kind='geography_dataset'
		WHERE i.kind='geography_region' AND i.canonical_key='omb-23-01/19100'`);
	for (const [name, days] of [
		["Harvest Point", 20],
		["Hill Country Church", 10],
	] as const)
		await admin.execute(sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${plants[name]!.id},'scheduled',
			${ch.day(days)}::date)`);
	await admin.execute(sql`INSERT INTO launch_summary(plant_id,version,body,saved_at,published_at)
		VALUES(${plants["Harvest Point"]!.id},1,'Our venue is booked and the launch team meets every week.',
			clock_timestamp(),clock_timestamp())`);
	await admin.execute(sql`INSERT INTO launch_summary(plant_id,version,body,saved_at)
		VALUES(${plants["Hill Country Church"]!.id},1,'HILL-DRAFT unpublished summary words.',clock_timestamp())`);
	const harvest = plants["Harvest Point"]!;
	await assessments.requestRefresh(db, harvest.actor, { requestId: randomUUID() });
	const released = await runJob(harvest);
	ok(await assessments.markAssessmentSeen(db, harvest.actor, { runId: released.current!.runId }));
	const directorAuthority = await resolve(director.session);
	async function refreshNetwork() {
		const reply = await requestIntelligenceRefresh(db as never, directorAuthority, { runId: randomUUID() });
		if ((reply as { status?: string }).status === "refused") throw new Error("network refresh refused");
	}
	await refreshNetwork();
	async function redeemerGrows() {
		await ch.committed(plants["Redeemer Church"]!, "Redeemer Person 4", 2);
		await refreshNetwork();
	}
	async function harvestRegionCorrected() {
		await admin.execute(sql`INSERT INTO plant_geography(plant_id,city,state_province,country,region_item_id,
			reference_version_id,committed_at,effective_at,supersedes_id)
			SELECT g.plant_id,'Round Rock','TX','US',i.id,g.reference_version_id,clock_timestamp(),clock_timestamp(),g.id
			FROM plant_geography g, reference_item i WHERE g.plant_id=${plants["Harvest Point"]!.id}
			AND i.kind='geography_region' AND i.canonical_key='omb-23-01/12420'`);
		await refreshNetwork();
	}
	async function meetingHeld(
		plantName: string,
		{ daysAgo, came, finalized }: { daysAgo: number; came: number; finalized: boolean },
	) {
		const p = plants[plantName]!;
		const people = await ch.rows(
			sql`SELECT id FROM person WHERE plant_id=${p.id} AND state='live' ORDER BY display_name LIMIT ${came}`,
		);
		const id = await ch.vision(
			p,
			daysAgo,
			people.map((r) => ({ id: String(r.id) })),
		);
		if (finalized) await finalizeMeeting(id);
		return id;
	}
	const finalizeMeeting = (id: string) =>
		admin.execute(sql`UPDATE meeting SET finalized_at=clock_timestamp() WHERE id=${id}`);
	async function meetingsHeld() {
		await meetingHeld("Harvest Point", { daysAgo: 24, came: 3, finalized: true });
		await meetingHeld("Harvest Point", { daysAgo: 17, came: 2, finalized: true });
		await meetingHeld("Harvest Point", { daysAgo: 10, came: 1, finalized: false });
		await meetingHeld("Redeemer Church", { daysAgo: 17, came: 2, finalized: false });
		await meetingHeld("Redeemer Church", { daysAgo: 10, came: 1, finalized: false });
	}
	const otherNetwork = await ch.database.organization("sending_network", {
		name: "Prairie Network",
		timezone: "America/Chicago",
	});
	const otherDirector = await ch.database.actor(otherNetwork, "admin");
	async function churchLinked() {
		const church = await ch.database.organization("sending_church", {
			name: "Grace Austin",
			timezone: "America/Chicago",
		});
		const none = sql`false,false,false,false,false,false,false`;
		const shares = sql`share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings`;
		await admin.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,${shares})
			VALUES(${church.id},${network.id},clock_timestamp(),${none})`);
		for (const name of ["Harvest Point", "Hill Country Church"])
			await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,${shares})
				VALUES(${plants[name]!.id},${church.id},clock_timestamp(),${none})`);
	}
	const names = async () =>
		(
			await ch.rows(
				sql`SELECT display_name FROM person WHERE plant_id=ANY(${sql.param(Object.values(plants).map((p) => p.id))}::uuid[])`,
			)
		).map((r) => String(r.display_name));

	return {
		...ch,
		cedar,
		seats: {
			owner: cedar.owner,
			admin: admin1,
			member,
			director,
			networkMember,
			otherDirector,
		},
		plants,
		network,
		publish,
		runJob,
		classify,
		redeemerGrows,
		harvestRegionCorrected,
		meetingHeld,
		finalizeMeeting,
		meetingsHeld,
		churchLinked,
		names,
	};
}
export type IntelligenceChurch = Awaited<ReturnType<typeof seed>>;
