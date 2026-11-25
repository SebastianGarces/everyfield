import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as C from "../../../../packages/contracts/src/oversight/index.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { createAssessments } from "../../../../packages/domain/src/intelligence/index.ts";
import {
	getSendingChurch,
	listSendingChurches,
	readIntelligence,
	requestIntelligenceRefresh,
	submitIntelligenceFeedback,
} from "../../../../packages/domain/src/oversight/index.ts";
import { invokeRead, readCatalog, type EvryActor } from "../../../../packages/evry/src/index.ts";
import {
	listOverseenChurches,
	readIntelligenceHistory,
	readOverseenChurch,
	readOverseenPlant,
} from "../../../../packages/evry/src/adapters/oversight/reads/index.ts";
import { ok } from "../../../support/fixture.mts";
import { intelligenceChurch, type IntelligenceChurch } from "../../evals/intelligence-church.mts";
import { completed, refusedAs, reviews } from "../review-support.mts";

type Who = "director" | "networkMember" | "otherDirector" | "owner";
let ch: IntelligenceChurch;
let r: ReturnType<typeof reviews>;
const actors = {} as Record<Who | "church", EvryActor>;
const churches: Record<string, { id: string }> = {};
let harvest: string, hill: string;

before(async () => {
	ch = await intelligenceChurch("evryovsa");
	r = reviews(ch.db);
	harvest = ch.plants["Harvest Point"]!.id;
	hill = ch.plants["Hill Country Church"]!.id;
	for (const [name, network, ended] of [
		["Grace Austin", ch.network.id, false],
		["Ended Church", ch.network.id, true],
		["Foreign Church", null, false],
	] as const) {
		const church = await ch.database.organization("sending_church", { name, timezone: "America/Chicago" });
		churches[name] = church;
		const org = network ?? (await foreignNetwork());
		await ch.admin
			.execute(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,ended_at,share_people,
			share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${church.id},${org},clock_timestamp()-interval '2 days',${ended ? sql`clock_timestamp()` : sql`NULL`},
				false,false,false,false,false,false,false)`);
		for (const plant of [harvest, hill])
			await ch.admin
				.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
				share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${plant},${church.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	}
	const churchOwner = await ch.database.actor(churches["Grace Austin"] as never, "owner");
	actors.church = await r.actorOf(churchOwner.session);
	for (const who of ["director", "networkMember", "otherDirector", "owner"] as const)
		actors[who] = await r.actorOf(ch.seats[who].session);
});
after(() => ch?.database.close());

const foreignNetwork = async () =>
	String((await ch.one(sql`SELECT id FROM organization WHERE name='Prairie Network'`)).id);
const authority = async (who: Who = "director") =>
	(await RequestActor.resolve(ch.db, ch.seats[who].session as never)) as RequestActor;
const read = (adapter: unknown, who: keyof typeof actors = "director", input: unknown = {}) =>
	invokeRead(ch.db, actors[who], adapter as never, input);
const view = async (level: C.Level, runId: string | null = null) =>
	(await readIntelligence(ch.db, await authority(), { level, runId }))!;
const contributions = async (runId: string) =>
	ch.rows(sql`SELECT plant_id,launched,days_to_launch,unfilled_roles,outstanding_training,region_item_id,state_province,country,
		overdue_followups,unowned_followups,growth_days,required_training FROM network_intelligence_plant WHERE run_id=${runId}
		ORDER BY plant_id`);
const assessmentJobs = async () =>
	Number((await ch.one(sql`SELECT count(*)::int AS n FROM job WHERE kind='assessment'`)).n);

test("AC:TARGET-IDN-024 a network seat's sending churches are its roster: current links, plant counts and the pending invitation; no other seat is offered the tool", async () => {
	const invitation = randomUUID();
	await ch.admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,
		revision) VALUES(${invitation},${churches["Foreign Church"]!.id},'church_network','x@example.test',
		${randomUUID()},'pending',clock_timestamp(),1)`);
	await ch.admin.execute(sql`INSERT INTO relationship_invitation(invitation_id,sending_church_id,organization_id,
		inviter_description,subject_revision) VALUES(${invitation},${churches["Foreign Church"]!.id},${ch.network.id},'Foreign Church',1)`);
	for (const who of ["director", "networkMember"] as const) {
		const roster = (await listSendingChurches(ch.db, await authority(who)))!;
		const got = await read(listOverseenChurches, who);
		assert.deepEqual(
			got.rows.map((x) => [x.id, x.label, x.fields.plants]),
			roster.churches.map((c) => [c.organizationId, c.name, c.plants]),
		);
		assert.deepEqual(
			got.rows.map((x) => [x.label, x.fields.plants, x.fields.href]),
			[["Grace Austin", 2, `/network/sending-churches/${churches["Grace Austin"]!.id}`]],
		);
		assert.deepEqual([got.facts?.pendingInvitations, roster.pendingInvitations], [1, 1]);
	}
	for (const who of ["church", "owner"] as const) {
		const offered = readCatalog(actors[who]).domains.flatMap((d) => d.operations.map((o) => o.operation));
		for (const adapter of [listOverseenChurches, readOverseenChurch]) {
			assert.ok(!offered.includes(adapter.operation), `${who} ${adapter.operation}`);
			await assert.rejects(read(adapter, who, { churchId: churches["Grace Austin"]!.id }), { code: "access_denied" });
		}
	}
});

test("AC:TARGET-IDN-024 one sending church's plants read as its page shows them, Not shared where a plant shares nothing; an ended or foreign church is not found", async () => {
	const page = (await getSendingChurch(ch.db, await authority(), churches["Grace Austin"]!.id))!;
	const got = await read(readOverseenChurch, "director", { churchId: churches["Grace Austin"]!.id });
	assert.equal(got.facts?.church, page.name);
	assert.deepEqual(
		got.rows.map((x) => [x.id, x.label, x.fields.phase, x.fields.leadPlanter, x.fields.linked]),
		page.plants.map((p) => [p.plantId, p.name, p.phase, p.leadPlanter, "Through Grace Austin"]),
	);
	const row = (id: string) => got.rows.find((x) => x.id === id)!.fields;
	assert.deepEqual([row(harvest).health, row(harvest).findings], ["Watch", "Shared"]);
	assert.equal(page.plants.find((p) => p.plantId === harvest)!.health, "watch");
	assert.deepEqual([row(hill).health, row(hill).findings], ["Not shared", "Not shared"]);
	assert.equal(page.plants.find((p) => p.plantId === hill)!.health, "limited_visibility");
	for (const id of [churches["Ended Church"]!.id, churches["Foreign Church"]!.id, randomUUID()]) {
		const reply = await read(readOverseenChurch, "director", { churchId: id });
		assert.deepEqual([reply.status, reply.rows], ["not_found", []]);
	}
	const text = JSON.stringify(got);
	for (const name of await ch.names()) assert.ok(!text.includes(name), name);
});

test("AC:NI-010 a Network Intelligence refresh runs once, as the page's Refresh does, and queues no plant's assessment", async () => {
	const op = "organizationIntelligence.requestRefresh";
	const before = await view("portfolio");
	const jobs = await assessmentJobs();
	const card = await r.prepare(actors.director, op, {});
	assert.deepEqual(
		[card.review.target?.label, card.review.changes[0]?.field, card.review.changes[0]?.after],
		["Network Intelligence", "networkIntelligence", "A new run, from what plants share now"],
	);
	assert.equal((await view("portfolio")).history.length, before.history.length, "nothing runs before approval");
	completed(await r.approve(actors.director, card));
	assert.equal(await r.replayed(actors.director, card), true);
	const after = await view("portfolio");
	assert.equal(after.history.length, before.history.length + 1, "a replayed approval makes no second run");
	const native = randomUUID();
	await requestIntelligenceRefresh(ch.db as never, await authority(), { runId: native });
	assert.deepEqual(await contributions(after.history[0]!.runId), await contributions(native));

	const plant = await r.prepare(actors.director, op, { plantId: harvest });
	assert.deepEqual(plant.review.notes, [
		"This refreshes Network Intelligence, not Harvest Point's own assessment. Only Harvest Point can ask for its own assessment.",
		"Earlier runs stay as they are.",
	]);
	completed(await r.approve(actors.director, plant));
	assert.equal((await view("portfolio")).history.length, before.history.length + 3);
	assert.equal(await assessmentJobs(), jobs, "no plant assessment is asked for");
	await r.refuses(actors.networkMember, op, {}, "access_denied");
	await r.refuses(actors.owner, op, {}, "access_denied");
	await r.refuses(actors.otherDirector, op, { plantId: harvest }, "not_found");
});

test("INV-evry-ni-feedback: a pattern's rating is saved as the page saves it; unchanged, foreign and unreadable patterns are refused", async () => {
	const op = "organizationIntelligence.submitFeedback";
	const history = await read(readIntelligenceHistory, "director", { level: "state", place: "Texas" });
	const row = history.rows.find((x) => x.fields.row === "pattern")!;
	const runId = String(history.facts!.runId);
	const patternKey = String(row.fields.patternKey);
	assert.equal(row.fields.yourRating, null);
	const rating = async () =>
		(await view("state")).groups.flatMap((g) => g.patterns).find((p) => p.key === patternKey)!.rating;
	const input = { runId, patternKey, rating: "useful" };
	const first = await r.prepare(actors.director, op, input);
	assert.equal(first.review.target?.label, row.label);
	assert.deepEqual(first.review.changes, [{ field: "rating", before: null, after: "Useful" }]);
	assert.equal(await rating(), null);
	completed(await r.approve(actors.director, first));
	assert.equal(await rating(), "useful");
	await r.refusedCard(actors.director, op, input, "You already rated this pattern that way, so nothing would change.");
	const changed = await r.prepare(actors.director, op, { ...input, rating: "not_useful" });
	assert.deepEqual(changed.review.changes, [{ field: "rating", before: "Useful", after: "Not useful" }]);
	completed(await r.approve(actors.director, changed));
	const saved = async (where = sql`true`) =>
		ch.rows(sql`SELECT account_id,pattern_key,rating FROM network_intelligence_feedback WHERE ${where}`);
	const viaEvry = await saved();
	await submitIntelligenceFeedback(ch.db as never, await authority(), { ...input, rating: "not_useful" });
	assert.deepEqual(await saved(), viaEvry, "the page's own save changes nothing more");

	await r.refuses(actors.director, op, { ...input, runId: randomUUID() }, "not_found");
	await r.refuses(actors.director, op, { ...input, patternKey: "NIR-03:state:US:OK" }, "not_found");
	await r.refuses(actors.otherDirector, op, input, "not_found");
	await r.refuses(actors.networkMember, op, input, "access_denied");
	const lost = await r.prepare(actors.director, op, input);
	await ch.admin.execute(
		sql`UPDATE affiliation SET shared_findings=false WHERE plant_id=${harvest} AND organization_id=${ch.network.id}`,
	);
	refusedAs(await r.approve(actors.director, lost), "access_denied");
	await r.refuses(actors.director, op, input, "not_found");
	await ch.admin.execute(
		sql`UPDATE affiliation SET shared_findings=true WHERE plant_id=${harvest} AND organization_id=${ch.network.id}`,
	);
	assert.deepEqual(await saved(), viaEvry);
});

test("INV-privacy: how a plant changed is answered from released material only: no unreleased run, no assessment words, Not shared where it shares none", async () => {
	const plant = async (id: string) => (await read(readOverseenPlant, "director", { plantId: id })).rows[0]!.fields;
	const history = async () => {
		const all = await read(readIntelligenceHistory, "director", { level: "portfolio" });
		const runs = all.rows.filter((x) => x.fields.row === "run");
		return Promise.all(runs.map((x) => read(readIntelligenceHistory, "director", { level: "portfolio", runId: x.id })));
	};
	const released = [await plant(harvest), await history()];
	const assessments = createAssessments();
	ok(await assessments.requestRefresh(ch.db, ch.plants["Harvest Point"]!.actor, { requestId: randomUUID() }));
	const unreleased = await ch.runJob(ch.plants["Harvest Point"]!);
	const run = unreleased.current!;
	assert.deepEqual(
		[await plant(harvest), await history()],
		released,
		"a newer run the planter hasn't opened changes nothing",
	);
	const text = JSON.stringify(released);
	for (const words of [run.summary, run.focus.title, run.focus.body, ...run.supporting.map((p) => p.body), run.runId])
		assert.ok(!text.includes(words), words);
	const hidden = await plant(hill);
	assert.deepEqual([hidden.health, hidden.concerns], ["Not shared", "Not shared"]);
	for (const name of await ch.names()) assert.ok(!text.includes(name), name);
	const offered = readCatalog(actors.director).domains.flatMap((d) => d.operations.map((o) => String(o.operation)));
	assert.ok(!offered.some((op) => op.startsWith("intelligence.")), "no plant assessment read is offered");
});
