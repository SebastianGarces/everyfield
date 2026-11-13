// Organization oversight reads (WP-047a): the plant directory, one plant's sharing sections and a network's
// sending-church roster, as a sending church or network seat reads them. Every link, choice and count is set up as
// the Hill Country example: network N with sending church S (Grace Austin) and plants HP, EC, MF and OC, plus a second
// network N2 with its own plants.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import * as S from "../organizations/support.mts";
import { RequestActor } from "../../../packages/domain/src/access/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
} from "../../../packages/domain/src/oversight/index.ts";

const ALL = ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "findings"] as const;
type Category = (typeof ALL)[number];
const COLUMN: Record<Category, string> = {
	people: "share_people",
	meetings: "share_meetings",
	tasks: "share_tasks",
	ministry_teams: "share_ministry_teams",
	wiki: "share_wiki",
	activity: "share_activity",
	findings: "shared_findings",
};
type Owner = Awaited<ReturnType<typeof S.tenant>>;

/** An active link from `subject` (a plant or sending church) to `org`, sharing exactly `shared`. */
async function link(subject: Owner, org: Owner, shared: readonly Category[] = []) {
	const column = subject.kind === "plant" ? "plant_id" : "sending_church_id";
	const r = await S.db.execute(sql`INSERT INTO affiliation(${sql.raw(column)},organization_id,accepted_at,${sql.raw(
		ALL.map((c) => COLUMN[c]).join(","),
	)}) VALUES(${subject.id},${org.id},clock_timestamp(),${sql.join(
		ALL.map((c) => sql`${shared.includes(c)}`),
		sql`,`,
	)}) RETURNING id`);
	return r.rows[0]!.id as string;
}
async function plant(name: string, city: string, state = "TX") {
	const p = await S.tenant("plant", name);
	await S.db.execute(sql`UPDATE plant SET city=${city}, state_province=${state}, country='US' WHERE id=${p.id}`);
	return p;
}
async function person(p: Owner, name: string, stage = "core_group") {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,phone,street,source,stage,
		adult_classification,commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${p.id},${p.id},${name},${name.replace(/\W/g, "").toLowerCase() + "@example.test"},'555-0100',
		'12 Private Lane','other',${stage},'unknown','unknown','1','live',clock_timestamp())`);
	return id;
}
async function team(p: Owner, name: string) {
	const r = await S.db.execute(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${p.id},${name},'active',0) RETURNING id`,
	);
	return r.rows[0]!.id as string;
}
async function role(p: Owner, teamId: string, name: string, holders: string[] = []) {
	const r = await S.db.execute(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order)
		VALUES(${p.id},${teamId},${name},true,0) RETURNING id`);
	const id = r.rows[0]!.id as string;
	for (const h of holders)
		await S.db.execute(sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on)
			VALUES(${p.id},${id},${h},'2026-01-01')`);
	return id;
}
/** The onboarding lead answer, recording `roleId` as the plant's lead role. */
async function leadRole(p: Owner, ownerAccount: string, roleId: string, teamId: string, personId: string) {
	const op = await S.db.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_id)
		VALUES(${p.id},${ownerAccount},'identity.domain_accepted','create',${p.id}) RETURNING id`);
	const lead = { answer: "yes", assignment: { teamId, roleId, personId }, savedAt: "2026-01-01T00:00:00.000Z" };
	await S.db.execute(sql`INSERT INTO onboarding_setup(plant_id,account_id,creation_operation_id,lead,journey,launch,people_step)
		VALUES(${p.id},${ownerAccount},${op.rows[0]!.id},${JSON.stringify(lead)}::jsonb,'{"status":"pending"}'::jsonb,
		'{"status":"pending"}'::jsonb,'pending')`);
}
async function task(p: Owner, fields: { status?: string; parent?: string; due?: string; deleted?: boolean } = {}) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date,parent_id,deleted_at,completed_at)
		VALUES(${id},${p.id},'Task','general','medium',${fields.status ?? "not_started"},clock_timestamp(),
		${fields.due ? "date_only" : "undated"},${fields.due ?? null},${fields.parent ?? null},
		${fields.deleted ? sql`clock_timestamp()` : null},${fields.status === "complete" ? sql`clock_timestamp()` : null})`);
	return id;
}
async function meeting(p: Owner, date: string, attended: string[], finalized = true) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision,finalized_at) VALUES(${id},${p.id},'vision_meeting','Vision night',${date},'18:00',
		'America/Chicago',${date + "T23:00:00Z"},'1','completed',1,${finalized ? sql`clock_timestamp()` : null})`);
	for (const who of attended)
		await S.db.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence)
			VALUES(${p.id},${id},${who},true,'attended')`);
}
const as = async (actor: { session: string }) => RequestActor.resolve(S.runtime, actor.session as never) as never;

let N: Owner, N2: Owner, GA: Owner, S2: Owner, HP: Owner, EC: Owner, MF: Owner, OC: Owner, Q2: Owner, R: Owner;
let networkOwner, networkAdmin, networkMember, graceOwner, emptyChurchOwner, hpOwner;
let hpToN: string, hpToGA: string;
let dana: string, marcus: string, two: string;

before(async () => {
	N = await S.tenant("sending_network", "Hill Country Network");
	N2 = await S.tenant("sending_network", "Gulf Coast Network");
	GA = await S.tenant("sending_church", "Grace Austin");
	S2 = await S.tenant("sending_church", "Cedar Park Church");
	HP = await plant("Harvest Point", "Round Rock");
	EC = await plant("Eastside Commons", "Austin");
	MF = await plant("Mueller Fellowship", "Austin");
	OC = await plant("Oak Cliff Church", "Dallas");
	Q2 = await plant("Bayou Church", "Houston");
	R = await plant("Westlake Church", "Austin");
	networkOwner = await S.identity(N, "owner");
	networkAdmin = await S.identity(N, "admin");
	networkMember = await S.identity(N, "member");
	graceOwner = await S.identity(GA, "owner");
	emptyChurchOwner = await S.identity(S2, "owner");
	hpOwner = await S.identity(HP, "owner");

	// Harvest Point shares People and Tasks, and Meetings with none held, with the network; not Ministry teams.
	hpToN = await link(HP, N, ["people", "tasks", "meetings"]);
	hpToGA = await link(HP, GA, ALL);
	await link(EC, N);
	await link(EC, GA);
	await link(MF, N);
	await link(OC, N);
	await link(GA, N);
	await link(Q2, N2, ALL);
	// Westlake is linked to Grace Austin and another network, never to Hill Country.
	await link(R, GA);
	await link(R, N2);

	// Dana owns Harvest Point; the lead role the onboarding answer recorded is held by Marcus now.
	dana = await person(HP, "Dana Ortiz", "leader");
	marcus = await person(HP, "Marcus Hill", "leader");
	const leadership = await team(HP, "Leadership");
	const lead = await role(HP, leadership, "Lead planter", [marcus]);
	await leadRole(HP, hpOwner.account, lead, leadership, dana);
	// One person on two teams is still one person.
	two = await person(HP, "Two Teams", "core_group");
	await role(HP, await team(HP, "Kids"), "Kids helper", [two]);
	await role(HP, await team(HP, "Worship"), "Vocals", [two]);
	await person(HP, "Prospect One", "prospect");
	await person(HP, "Launch Two", "launch_team");

	// Twelve open top-level tasks, two overdue; plus checklist rows, two waived, one cancelled and one complete.
	for (let i = 0; i < 10; i++) await task(HP);
	const parent = await task(HP, { due: "2026-01-02" });
	await task(HP, { due: "2026-01-03", status: "blocked" });
	for (let i = 0; i < 3; i++) await task(HP, { parent });
	for (let i = 0; i < 2; i++) await task(HP, { status: "no_longer_needed" });
	await task(HP, { deleted: true });
	await task(HP, { status: "complete" });

	// Eastside Commons recorded a lead role that no one holds now, and Oak Cliff has no lead answer at all.
	const ecOwner = await S.identity(EC, "owner");
	const priya = await person(EC, "Priya Shah");
	const ecTeam = await team(EC, "Leadership");
	await leadRole(EC, ecOwner.account, await role(EC, ecTeam, "Lead planter"), ecTeam, priya);
});
after(async () => {
	await S.teardown();
});

test("AC:TARGET-IDN-023 AC:ORG55-004 AC:ORG55-005 AC:AF-039 the directory lists only own linked plants, once, with the lead and no contacts", async () => {
	const rows = await listPlants(S.runtime, await as(networkAdmin));
	assert.deepEqual(rows, [
		{
			plantId: EC.id,
			name: "Eastside Commons",
			city: "Austin",
			stateProvince: "TX",
			country: "US",
			phase: 1,
			launchDate: null,
			provenance: { kind: "through", sendingChurches: ["Grace Austin"] },
			leadPlanter: null,
		},
		{
			plantId: HP.id,
			name: "Harvest Point",
			city: "Round Rock",
			stateProvince: "TX",
			country: "US",
			phase: 1,
			launchDate: null,
			provenance: { kind: "through", sendingChurches: ["Grace Austin"] },
			leadPlanter: "Marcus Hill",
		},
		{
			plantId: MF.id,
			name: "Mueller Fellowship",
			city: "Austin",
			stateProvince: "TX",
			country: "US",
			phase: 1,
			launchDate: null,
			provenance: { kind: "direct" },
			leadPlanter: null,
		},
		{
			plantId: OC.id,
			name: "Oak Cliff Church",
			city: "Dallas",
			stateProvince: "TX",
			country: "US",
			phase: 1,
			launchDate: null,
			provenance: { kind: "direct" },
			leadPlanter: null,
		},
	]);
	// No street, email, phone or the Owner's name in anything the directory returns.
	const text = JSON.stringify(rows);
	for (const secret of ["private street", "12 Private Lane", "@example.test", "555-0100", "Dana"])
		assert.equal(text.includes(secret), false, secret);
	// The Member reads the same directory; a plant seat and a foreign network read none of it.
	assert.deepEqual(await listPlants(S.runtime, await as(networkMember)), rows);
	assert.equal(await listPlants(S.runtime, await as(hpOwner)), null);
	// A sending church sees its own directly linked plants.
	assert.deepEqual(
		(await listPlants(S.runtime, await as(graceOwner)))!.map((r) => [r.name, r.provenance.kind]),
		[
			["Eastside Commons", "direct"],
			["Harvest Point", "direct"],
			["Westlake Church", "direct"],
		],
	);
	// A launch date appears once the plant sets one.
	await S.db.execute(sql`INSERT INTO launch(plant_id,target_date,status) VALUES(${OC.id},'2027-03-14','scheduled')`);
	const oc = (await listPlants(S.runtime, await as(networkOwner)))!.find((r) => r.plantId === OC.id);
	assert.equal(oc!.launchDate, "2027-03-14");
});

test("AC:TARGET-IDN-023 AC:AF-028 AC:AF-035 Harvest Point's sections: shared counts, shared but empty and not shared", async () => {
	const view = await getPlant(S.runtime, await as(networkAdmin), HP.id);
	assert.deepEqual(view!.sections, {
		people: {
			status: "shared",
			counts: {
				total: 5,
				byStage: {
					prospect: 1,
					attendee: 0,
					following_up: 0,
					interviewed: 0,
					core_group: 1,
					launch_team: 1,
					leader: 2,
				},
			},
		},
		tasks: { status: "shared", counts: { open: 12, overdue: 2 } },
		meetings: { status: "empty" },
		ministryTeams: { status: "withheld" },
		wiki: { status: "withheld" },
	});
	assert.equal(view!.plant.leadPlanter, "Marcus Hill");
	const text = JSON.stringify(view);
	for (const secret of ["private street", "12 Private Lane", "@example.test", "555-0100", "Dana", "Two Teams"])
		assert.equal(text.includes(secret), false, secret);
});

test("AC:TARGET-IDN-023 Grace Austin reads every section: meetings, teams, training and Wiki reading counts", async () => {
	await meeting(HP, "2026-09-01", [dana, marcus, two]);
	await meeting(HP, "2026-09-15", [marcus, two]);
	await meeting(HP, "2026-09-29", [marcus], false);
	// Required training: two assignments, one complete.
	const program = await S.db.execute(sql`INSERT INTO training_program(plant_id,name,required) VALUES(${HP.id},'Safe kids',true) RETURNING id, version`);
	const { id: programId, version } = program.rows[0] as { id: string; version: number };
	for (const who of [marcus, two])
		await S.db.execute(sql`INSERT INTO training_assignment(plant_id,program_id,person_id,version,state,effective_on)
			VALUES(${HP.id},${programId},${who},${version},'active','2026-01-01')`);
	await S.db.execute(sql`INSERT INTO training_credit(plant_id,person_id,program_id,kind,version,earned_on)
		VALUES(${HP.id},${marcus},${programId},'earned',${version},'2026-02-01')`);
	// Two Wiki reads in this plant's context, one finished and one in progress, of a global article as the reference
	// import stores it (tests/integration/writes/requests.mjs).
	const GLOBAL = "00000000-0000-0000-0000-000000000000";
	const [section, release, article, revision] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
	const hash = () => randomUUID().replaceAll("-", "").repeat(2);
	await S.db.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES
		(${section},'section','framework/oversight',${GLOBAL}),(${article},'article','oversight-read',${GLOBAL})`);
	await S.db.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,
		approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"release-" + release},'memory://oversight',${hash()},'validated',clock_timestamp(),clock_timestamp(),
		'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	await S.db.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,
		content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
		VALUES(${revision},${article},${GLOBAL},${release},1,'Oversight read','oversight-read','About it','Opening line.',
		'safe_mdx',1,1,${hash()},clock_timestamp(),true,1,${section},ARRAY[]::text[])`);
	for (const [account, done] of [
		[hpOwner.account, true],
		[graceOwner.account, false],
	] as const)
		await S.db.execute(sql`INSERT INTO reading(account_id,article_id,plant_context_id,observed_fraction,completed_at,
			completed_revision_id,policy_version,last_read_meaningful_sequence,bookmarked)
			VALUES(${account},${article},${HP.id},0.5,${done ? sql`clock_timestamp()` : null},${done ? revision : null},'v1',0,false)`);

	const view = await getPlant(S.runtime, await as(graceOwner), HP.id);
	assert.deepEqual(view!.sections.meetings, {
		status: "shared",
		counts: {
			meetings: [
				{ date: "2026-09-01", attended: 3 },
				{ date: "2026-09-15", attended: 2 },
				{ date: "2026-09-29", attended: null },
			],
			averageDaysBetween: 14,
			attendedTotal: 5,
		},
	});
	assert.deepEqual(view!.sections.ministryTeams, {
		status: "shared",
		counts: { teams: 3, roles: 3, rolesFilled: 3, trainingAssigned: 2, trainingComplete: 1 },
	});
	assert.deepEqual(view!.sections.wiki, { status: "shared", counts: { finished: 1, inProgress: 1 } });
	// The same plant's network view keeps its own choices.
	const network = await getPlant(S.runtime, await as(networkAdmin), HP.id);
	assert.equal(network!.sections.ministryTeams.status, "withheld");
	assert.equal(network!.sections.meetings.status, "shared");
});

test("AC:TARGET-IDN-023 a section whose read fails says unavailable while the others load", async () => {
	await S.db.execute(sql.raw(`ALTER TABLE ${S.schema}.reading RENAME TO reading_moved`));
	try {
		const failed: string[] = [];
		const view = await getPlant(S.runtime, await as(graceOwner), HP.id, (section) => failed.push(section));
		assert.deepEqual(view!.sections.wiki, { status: "unavailable" });
		assert.deepEqual(failed, ["wiki"]);
		assert.equal(view!.sections.people.status, "shared");
		assert.equal(view!.sections.tasks.status, "shared");
	} finally {
		await S.db.execute(sql.raw(`ALTER TABLE ${S.schema}.reading_moved RENAME TO reading`));
	}
});

test("AC:AF-029 AC:AF-030 AC:AF-031 AC:AF-040 AC:ORG55-003 turning People off or ending a link changes only that organization's view", async () => {
	const turnOff = S.command({
		plant: HP,
		organization: N,
		relationshipId: hpToN,
		category: "people",
		enabled: false,
		expectedConsentRevision: "1",
	});
	await S.call("privacy.setSharing", hpOwner, turnOff);
	const network = await getPlant(S.runtime, await as(networkAdmin), HP.id);
	assert.deepEqual(network!.sections.people, { status: "withheld" });
	assert.equal(JSON.stringify(network).includes('"total"'), false);
	const grace = await getPlant(S.runtime, await as(graceOwner), HP.id);
	assert.equal(grace!.sections.people.status, "shared");

	// Harvest Point ends its link with Grace Austin: gone for Grace Austin, still there for the network.
	await S.call(
		"associations.end",
		hpOwner,
		S.command({
			relationshipId: hpToGA,
			pair: { kind: "plant", subject: HP, organization: GA },
			confirmed: true,
			reason: null,
		}),
	);
	assert.equal(await getPlant(S.runtime, await as(graceOwner), HP.id), null);
	assert.deepEqual(
		(await listPlants(S.runtime, await as(graceOwner)))!.map((r) => r.name),
		["Eastside Commons", "Westlake Church"],
	);
	const still = (await listPlants(S.runtime, await as(networkAdmin)))!.find((r) => r.plantId === HP.id);
	assert.deepEqual(still!.provenance, { kind: "direct" });
	assert.notEqual(await getPlant(S.runtime, await as(networkAdmin), HP.id), null);
});

test("AC:AF-035 AC:AF-041 AC:SEC-04 an unlinked plant reads exactly like one that does not exist", async () => {
	const admin = await as(networkAdmin);
	for (const id of [Q2.id, R.id, randomUUID(), "not-an-id"]) assert.equal(await getPlant(S.runtime, admin, id), null);
	// A plant's own seat cannot use the oversight reads for its own plant.
	assert.equal(await getPlant(S.runtime, await as(hpOwner), HP.id), null);
});

test("AC:TARGET-IDN-024 the network's roster: linked sending churches, unexpired pending requests and shared plants", async () => {
	// Cedar Park asked to connect twice: one request is waiting, one expired.
	for (const [age, email] of [
		["1 day", "network@example.test"],
		["31 days", "old-network@example.test"],
	]) {
		const invitation = randomUUID();
		await S.db.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,revision)
			VALUES(${invitation},${S2.id},'church_network',${email},${randomUUID()},'pending',
			clock_timestamp() - ${age}::interval,1)`);
		await S.db.execute(sql`INSERT INTO relationship_invitation(invitation_id,sending_church_id,organization_id,inviter_description,subject_revision)
			VALUES(${invitation},${S2.id},${N.id},'Cedar Park Church',1)`);
	}
	const roster = await listSendingChurches(S.runtime, await as(networkMember));
	assert.deepEqual(roster, {
		churches: [{ organizationId: GA.id, name: "Grace Austin", plants: 1 }],
		pendingInvitations: 1,
	});
	const grace = await getSendingChurch(S.runtime, await as(networkAdmin), GA.id);
	assert.deepEqual(
		grace!.plants.map((p) => p.name),
		["Eastside Commons"],
	);
	assert.equal(grace!.name, "Grace Austin");
	// Not linked to the network, not a sending church, or a sending church seat asking: not found.
	assert.equal(await getSendingChurch(S.runtime, await as(networkAdmin), S2.id), null);
	assert.equal(await getSendingChurch(S.runtime, await as(networkAdmin), HP.id), null);
	assert.equal(await listSendingChurches(S.runtime, await as(graceOwner)), null);
	assert.equal(await getSendingChurch(S.runtime, await as(graceOwner), GA.id), null);
	// The sending church with no linked plants reads an empty directory.
	assert.deepEqual(await listPlants(S.runtime, await as(emptyChurchOwner)), []);
});
