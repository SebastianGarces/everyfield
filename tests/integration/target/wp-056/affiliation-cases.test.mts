import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { owner } from "../../../../packages/contracts/src/common/index.ts";
import * as Q from "../../../../packages/contracts/src/organizations/index.ts";
import { sql } from "../../../../packages/db/src/query.ts";
import { createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import {
	readHistory,
	readPlantSharing,
	readReportingLocation,
	readSharingDisclosure,
} from "../../../../packages/domain/src/organizations/index.ts";
import {
	getPlant,
	getSendingChurch,
	listPlants,
	listSendingChurches,
	readIntelligence,
	requestIntelligenceRefresh,
} from "../../../../packages/domain/src/oversight/index.ts";
import { interviews, peopleReader, withPeopleWrite } from "../../../../packages/domain/src/people/index.ts";
import {
	evryActor,
	EvryRefusal,
	invokeRead,
	prepareProposal,
	readCatalog,
	READ_DOMAINS,
} from "../../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { harness } from "../../../evry/evals/intelligence-harness.mts";
import { ok, refused } from "../../../support/fixture.mts";
import {
	acceptance,
	activity,
	activeOrganizations,
	as,
	bodies,
	connect,
	endCommand,
	endOnce,
	feedApi,
	invite,
	jobs,
	lead,
	linkNow,
	meeting,
	NO_BODY,
	noticeMail,
	notices,
	one,
	pairOf,
	person,
	rows,
	S,
	share,
	sharing,
	silent,
	task,
	teamRoles,
	world,
	type Identity,
	type Org,
	type World,
} from "./affiliation-world.mts";

after(S.teardown);

const CATEGORIES = ["people", "meetings", "tasks", "ministry_teams", "wiki", "activity", "shared_findings"] as const;
const allChoices = (enabled: boolean) => Object.fromEntries(CATEGORIES.map((c) => [c, enabled]));
const view = async (side: Org, w: World, who: Identity = side.admin) => getPlant(S.runtime, await as(who), w.p.id);
const listed = async (who: Identity) => (await listPlants(S.runtime, await as(who)))?.plants ?? null;
const keysOf = (value: unknown): string[] =>
	Array.isArray(value)
		? value.flatMap(keysOf)
		: value && typeof value === "object"
			? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)])
			: [];
const SECTIONS = ["meetings", "ministryTeams", "people", "tasks", "wiki"];
const noUnsharedFields = (value: object) =>
	assert.deepEqual(
		keysOf(value).filter(
			(k) => k !== "interviewed" && /financ|facilit|care|check.?in|interview|coach|giving|budget|background/i.test(k),
		),
		[],
	);
async function people(who: Identity, w: World) {
	return gatedTransaction(S.runtime, (tx) =>
		peopleReader.listPeople(tx, { session: who.session, selected: w.p } as never, {} as never),
	);
}
const planterSees = async (w: World) => {
	const listed = await people(w.owner, w);
	assert.ok(listed.status === "ok", JSON.stringify(listed));
	return listed.value.items.map((i) => i.displayName).sort();
};

test("AC:AF-022 with no other approved path, ending the last affiliation denies the organization every read at once, including a read it already held", async () => {
	for (const ender of ["owner", "admin"] as const) {
		const w = await world();
		const link = await connect(w, w.S1);
		await activity(w);
		const held = await as(w.S1.admin);
		const before = await bodies(w, w.S1, held);
		assert.equal(before.page!.plant.plantId, w.p.id);
		assert.ok(before.row && before.digest && before.sharing.view === "organization");
		await endOnce(w, w.S1, link, w[ender], []);
		for (const authority of [held, await as(w.S1.admin), await as(w.S1.owner), await as(w.S1.member)])
			assert.deepEqual(await bodies(w, w.S1, authority), NO_BODY);
		assert.deepEqual(await listed(w.S1.owner), []);
	}
});

test("AC:AF-023 ending one affiliation keeps only the surviving organization's own current categories", async () => {
	const w = await world();
	const link = await connect(w, w.S1),
		kept = await connect(w, w.N1);
	await person(w, "Alex Rivera");
	await task(w);
	for (const category of CATEGORIES.filter((c) => c !== "people")) await share(w, w.N1, kept, category, false);
	const survivor = await as(w.N1.admin);
	const held = await as(w.S1.admin);
	const before = await bodies(w, w.N1, survivor);
	assert.ok((await bodies(w, w.S1, held)).page);
	await endOnce(w, w.S1, link, w.admin, [w.N1]);
	assert.deepEqual(await bodies(w, w.S1, held), NO_BODY, "S1 has no access");
	const now = await bodies(w, w.N1, survivor);
	assert.deepEqual(now, before, "N1 keeps exactly what it read");
	assert.deepEqual(
		Object.entries(now.page!.sections)
			.map(([k, s]) => [k, s.status])
			.sort(),
		[
			["meetings", "withheld"],
			["ministryTeams", "withheld"],
			["people", "shared"],
			["tasks", "withheld"],
			["wiki", "withheld"],
		],
	);
	assert.deepEqual([now.digest, now.row!.health], [false, "limited_visibility"]);
});

test("AC:AF-024 ending an affiliation keeps the plant's people, tasks, meetings, seats, Owner and history", async () => {
	const w = await world();
	const link = await connect(w, w.S1);
	await connect(w, w.N1);
	const alex = await person(w, "Alex");
	const t = await task(w);
	const m = await meeting(w, [alex]);
	const owned = async () => ({
		persons: await rows(sql`SELECT * FROM person WHERE plant_id=${w.p.id} ORDER BY id`),
		tasks: await rows(sql`SELECT * FROM task WHERE plant_id=${w.p.id} ORDER BY id`),
		meetings: await rows(sql`SELECT * FROM meeting WHERE plant_id=${w.p.id} ORDER BY id`),
		attendance: await rows(sql`SELECT * FROM participation WHERE plant_id=${w.p.id} ORDER BY id`),
		seats: await rows(sql`SELECT * FROM seat WHERE plant_id=${w.p.id} ORDER BY id`),
		plant: await rows(sql`SELECT * FROM plant WHERE id=${w.p.id}`),
		unrelated: await rows(sql`SELECT id,name,revision FROM organization WHERE id<>${w.S1.o.id} ORDER BY id`),
		history: await rows(sql`SELECT * FROM audit_event WHERE action<>'affiliation.ended' ORDER BY id`),
	});
	const before = await owned();
	assert.deepEqual(
		[before.persons, before.tasks, before.meetings].map((r) => r.map((x) => x.id)),
		[[alex], [t], [m]],
	);
	assert.equal(before.seats.filter((s) => s.account_id === w.owner.account && s.role === "owner").length, 1);
	await endOnce(w, w.S1, link, w.owner, [w.N1]);
	const now = await owned();
	const kept = new Set(before.history.map((e) => e.id));
	assert.deepEqual({ ...now, history: now.history.filter((e) => kept.has(e.id)) }, before);
	assert.deepEqual(await planterSees(w), ["Alex"]);
	const history = (await readHistory(S.runtime, await as(w.owner), { plant: w.p })) as { items: { event: string }[] };
	assert.deepEqual(history.items.map((i) => i.event).sort(), ["approved", "approved", "ended"]);
});

test("AC:AF-025 a mail timeout leaves the ended link ended, its notice retryable and never recorded as delivered", async () => {
	const w = await world();
	const link = await connect(w, w.S1);
	await connect(w, w.N1);
	await endOnce(w, w.S1, link, w.owner, [w.N1]);
	const attempts: string[] = [];
	const failing = noticeMail(async (payload) => {
		attempts.push(payload.to);
		throw new DOMException("The operation timed out", "TimeoutError");
	});
	await failing.plan();
	const ended = async () => (await notices(link)).filter((n) => n.occurrence === "ended");
	const told = [w.owner.account, w.admin.account].sort();
	assert.deepEqual(
		(await ended()).map((n) => [n.recipient, n.mail]),
		told.map((r) => [r, "pending"]),
	);
	const error = console.error;
	console.error = () => {};
	try {
		await failing.deliver();
	} finally {
		console.error = error;
	}
	assert.ok(attempts.includes(w.owner.email) && attempts.includes(w.admin.email));
	const mail = () =>
		rows(sql`SELECT m.state, m.accepted_at, m.provider_message_id, j.state AS job, j.attempt_count < j.max_attempts AS retryable
			FROM mail m JOIN notice n ON n.id=m.notice_id JOIN job j ON j.subject_record_id=m.id
			WHERE n.source_record_id=${link.id} AND split_part(n.logical_key,'/',5)='ended' ORDER BY m.id`);
	assert.deepEqual(
		await mail(),
		told.map(() => ({
			state: "unknown",
			accepted_at: null,
			provider_message_id: null,
			job: "reconcile",
			retryable: true,
		})),
	);
	assert.equal((await linkNow(link)).ended, true);
	assert.deepEqual((await activeOrganizations(w)).orgs, [w.N1.o.id]);
	const sent: string[] = [];
	const working = noticeMail(async (payload) => {
		sent.push(`${payload.to}: ${payload.subject}`);
		return { kind: "accepted", id: randomUUID() };
	});
	await working.deliver();
	await working.deliver();
	const name = `Connection ended: ${await orgName(w.S1)}`;
	assert.deepEqual(
		sent.filter((s) => s.endsWith(name)).sort(),
		[w.owner, w.admin].map((a) => `${a.email}: ${name}`).sort(),
		"the retry delivers each notice once",
	);
	assert.deepEqual(
		(await ended()).map((n) => n.mail),
		["accepted", "accepted"],
	);
});
const orgName = async (side: Org) =>
	(await one<{ name: string }>(sql`SELECT name FROM organization WHERE id=${side.o.id}`)).name;

test("AC:AF-026 a stale, cached or retained read checks the current relationship and category again before it answers", async () => {
	const w = await world();
	const link = await connect(w, w.S1),
		kept = await connect(w, w.N1);
	await person(w, "Alex Rivera");
	const held = { S1: await as(w.S1.admin), N1: await as(w.N1.admin) };
	for (const side of ["S1", "N1"] as const)
		for (let i = 0; i < 2; i++) ok(await requestIntelligenceRefresh(S.runtime, held[side], { runId: randomUUID() }));
	const retained = async (side: "S1" | "N1") => {
		const now = await readIntelligence(S.runtime, held[side], { level: "portfolio", runId: null });
		const past = now!.history.length
			? await readIntelligence(S.runtime, held[side], { level: "portfolio", runId: now!.history.at(-1)!.runId })
			: null;
		return [JSON.stringify(now!.groups).includes(w.p.id), JSON.stringify(past?.groups ?? []).includes(w.p.id)];
	};
	assert.deepEqual(
		[await retained("S1"), await retained("N1")],
		[
			[true, true],
			[true, true],
		],
	);
	assert.equal((await getPlant(S.runtime, held.N1, w.p.id))!.sections.people.status, "shared");
	await share(w, w.N1, kept, "people", false);
	assert.deepEqual((await getPlant(S.runtime, held.N1, w.p.id))!.sections.people, { status: "withheld" });
	await endOnce(w, w.S1, link, w.owner, [w.N1]);
	assert.deepEqual(await bodies(w, w.S1, held.S1), NO_BODY);
	assert.deepEqual(await retained("S1"), [false, false]);
	assert.deepEqual(await retained("N1"), [true, true]);
	const evry = adapters.get("oversight.getPlant")!;
	const asked = await invokeRead(S.runtime, evryActor(held.S1), evry, { plantId: w.p.id });
	assert.deepEqual([asked.status, asked.rows], ["not_found", []]);
});
const adapters = new Map(
	Object.values(READ_DOMAINS)
		.flat()
		.map((a) => [a.operation as string, a as unknown as ReadAdapter<unknown>]),
);

test("AC:AF-027 an organization Admin's acceptance opens the bounded directory, the disclosed defaults and the plant's own notice, and nothing else", async () => {
	const w = await world();
	const other = await connect(w, w.N1);
	const alex = await person(w, "Alex Rivera");
	await teamRoles(w, [alex]);
	const disclosure = await gatedTransaction(S.runtime, (tx) =>
		readSharingDisclosure(tx, w.owner.session, w.p, pairOf(w, w.S1)),
	);
	assert.deepEqual(disclosure, { kind: "first_invitation", organization: w.S1.o, choices: allChoices(true) });
	const quiet = noticeMail(async () => ({ kind: "accepted", id: randomUUID() }));
	await quiet.plan();
	const i = await invite(w, w.S1);
	assert.deepEqual(await bodies(w, w.S1, await as(w.S1.admin)), NO_BODY, "a pending request opens nothing");
	const request = acceptance(i.invitationId);
	await silent(async () => {
		for (const who of [w.owner, w.member, w.S1.member, w.N1.admin, w.N2.owner, w.foreign])
			await assert.rejects(
				S.call("associations.acceptInvitation", who, { ...request, requestKey: randomUUID() }),
				/^Error: unavailable$/,
			);
		await assert.rejects(
			S.call("associations.acceptInvitation", w.S1.admin, {
				...request,
				requestKey: randomUUID(),
				expectedRevision: "99",
			}),
			/^Error: stale_revision$/,
		);
	});
	const seats = async () => (await one<{ n: number }>(sql`SELECT count(*)::int n FROM seat`)).n;
	const seatsBefore = await seats();
	const accepted = Q.acceptedInvitationResult.parse(await S.call("associations.acceptInvitation", w.S1.admin, request));
	assert.ok(accepted.status === "accepted");
	assert.deepEqual(await S.call("associations.acceptInvitation", w.S1.admin, request), accepted);
	assert.deepEqual([accepted.relationship.pair, accepted.relationship.endedAt], [pairOf(w, w.S1), null]);
	assert.equal(await seats(), seatsBefore);
	const link = { ...accepted.relationship };
	assert.deepEqual((await activeOrganizations(w)).orgs, [w.S1.o.id, w.N1.o.id].sort());
	assert.deepEqual(await rows(sql`SELECT action, actor_id FROM audit_event WHERE subject_id=${link.id}`), [
		{ action: "affiliation.approved", actor_id: w.S1.admin.account },
	]);
	assert.deepEqual(await sharing(w, w.S1, w.owner), {
		view: "plant_administration",
		plant: w.p,
		organization: w.S1.o,
		organizationDisplayName: await orgName(w.S1),
		activeAffiliation: true,
		consentRevision: "1",
		choices: allChoices(true),
	});
	const [row] = (await listed(w.S1.admin))!;
	assert.deepEqual(Object.keys(row!).sort(), [
		"city",
		"country",
		"health",
		"leadPlanter",
		"name",
		"path",
		"phase",
		"plantId",
		"provenance",
		"region",
		"stateProvince",
	]);
	const text = JSON.stringify([await bodies(w, w.S1, await as(w.S1.admin)), await listed(w.S1.admin)]);
	for (const secret of [
		"private street",
		"12 Private Lane",
		"@example.test",
		"555-0101",
		"Alex Rivera",
		w.owner.account,
	])
		assert.equal(text.includes(secret), false, secret);
	await quiet.plan();
	const told = await notices(link as never);
	assert.deepEqual(
		told.map((n) => [n.recipient, n.occurrence, n.title, n.body]),
		[w.owner.account, w.admin.account]
			.sort()
			.map((r) => [
				r,
				"approved",
				`Connection approved: ${told[0]!.title.split(": ")[1]}`,
				`${told[0]!.title.split(": ")[1]} is now connected with your church.`,
			]),
	);
	assert.equal(told[0]!.title, `Connection approved: ${await orgName(w.S1)}`);
	assert.equal((await linkNow(other as never)).revision, "1", "the network's link and consent are unchanged");
});

async function twoOrganizations() {
	const w = await world();
	const a = await connect(w, w.S1),
		b = await connect(w, w.N1);
	const holder = await person(w, "Alex Rivera"),
		second = await person(w, "Blake Stone", { stage: "core_group" });
	await teamRoles(w, [holder, second, null, null]);
	await activity(w);
	return { w, a, b, holder };
}
const TEAMS = {
	status: "shared",
	counts: { teams: 1, roles: 4, rolesFilled: 2, trainingAssigned: 0, trainingComplete: 0 },
};

test("AC:AF-028 AC:AF-038 a new link shares the seven approved categories by default, and no finance, facility, private or later column joins them", async () => {
	const { w, a, b } = await twoOrganizations();
	await silent(async () => {
		for (const side of [w.S1, w.N1]) {
			assert.deepEqual((await sharing(w, side, side.admin)) as object, {
				view: "organization",
				plant: w.p,
				organization: side.o,
				organizationDisplayName: await orgName(side),
				activeAffiliation: true,
				availability: allChoices(true),
			});
			for (const who of [side.owner, side.admin, side.member]) {
				const page = (await view(side, w, who))!;
				assert.deepEqual(page.sections.ministryTeams, TEAMS);
				assert.deepEqual(Object.keys(page.sections).sort(), SECTIONS);
				assert.deepEqual(Object.keys(page).sort(), [
					"assessment",
					"launch",
					"plant",
					"sections",
					"summary",
					"timeZone",
				]);
				noUnsharedFields(page);
			}
		}
		for (const who of [w.owner, w.member, w.foreign, w.N2.admin, w.S2.owner])
			assert.equal(await getPlant(S.runtime, await as(who), w.p.id), null);
	});
	const before = [await view(w.S1, w), await view(w.N1, w)];
	await S.db.execute(sql`ALTER TABLE affiliation ADD COLUMN share_finances boolean NOT NULL DEFAULT true,
		ADD COLUMN share_facilities boolean NOT NULL DEFAULT true, ADD COLUMN share_background boolean NOT NULL DEFAULT true`);
	try {
		assert.deepEqual([await view(w.S1, w), await view(w.N1, w)], before, "a new boolean shares nothing");
		assert.deepEqual(((await sharing(w, w.S1, w.owner)) as { choices: object }).choices, allChoices(true));
		await silent(async () => {
			for (const category of [
				"finance",
				"finances",
				"facilities",
				"background",
				"private_care",
				"coach",
				"share_finances",
			])
				await assert.rejects(share(w, w.S1, a, category, true), (e: Error) => e.name === "ZodError");
		});
	} finally {
		await S.db.execute(
			sql`ALTER TABLE affiliation DROP COLUMN share_finances, DROP COLUMN share_facilities, DROP COLUMN share_background`,
		);
	}
	assert.deepEqual([(await linkNow(a)).revision, (await linkNow(b)).revision], ["1", "1"]);
});

test("AC:AF-029 one organization's OFF and another's ON are stored and read apart", async () => {
	const { w, a } = await twoOrganizations();
	await S.db.execute(sql`UPDATE team_role SET responsibility_key='worship' WHERE plant_id=${w.p.id} AND name='Role 2'`);
	await share(w, w.S1, a, "ministry_teams", false);
	assert.deepEqual(
		await rows(sql`SELECT organization_id, share_ministry_teams AS teams, share_activity AS activity, shared_findings AS findings
			FROM affiliation WHERE plant_id=${w.p.id} ORDER BY share_ministry_teams`),
		[
			{ organization_id: w.S1.o.id, teams: false, activity: true, findings: true },
			{ organization_id: w.N1.o.id, teams: true, activity: true, findings: true },
		],
	);
	const s1 = (await view(w.S1, w))!,
		n1 = (await view(w.N1, w))!;
	assert.deepEqual([s1.sections.ministryTeams, n1.sections.ministryTeams], [{ status: "withheld" }, TEAMS]);
	assert.ok(s1.launch.status !== "withheld" && n1.launch.status !== "withheld");
	assert.deepEqual(
		[s1.launch.preparation.unfilledRoles, n1.launch.preparation.unfilledRoles],
		[null, 1],
		"no ministry team count feeds S1's findings either",
	);
	noUnsharedFields(s1);
	noUnsharedFields(n1);
	const evry = adapters.get("oversight.getPlant")!;
	const teams = async (who: Identity) =>
		(await invokeRead(S.runtime, evryActor(await as(who)), evry, { plantId: w.p.id })).rows[0]!.fields.ministryTeams;
	assert.equal(await teams(w.S1.admin), "Not shared");
	assert.notEqual(await teams(w.N1.admin), "Not shared");
	await silent(async () => {
		await view(w.S1, w);
		await view(w.N1, w);
	});
});

test("AC:AF-030 changing one organization's activity choice leaves the other's choices, revision and reads as they were", async () => {
	const { w, a, b } = await twoOrganizations();
	const n1 = await as(w.N1.admin);
	const read = async () => [await bodies(w, w.N1, n1), await sharing(w, w.N1, w.owner), await linkNow(b)];
	const before = await read();
	const input = {
		plant: w.p,
		organization: w.S1.o,
		relationshipId: a.id,
		category: "activity",
		enabled: false,
		expectedConsentRevision: "1",
	};
	await silent(async () => {
		for (const who of [w.member, w.foreign, w.S1.admin, w.N1.owner, w.N2.admin])
			await assert.rejects(S.call("privacy.setSharing", who, S.command(input)), /^Error: unavailable$/);
		for (const stale of [S.command(input, "7"), S.command({ ...input, expectedConsentRevision: "7" })])
			await assert.rejects(S.call("privacy.setSharing", w.admin, stale), /^Error: stale_revision$/);
		await assert.rejects(
			S.call("privacy.setSharing", w.admin, S.command({ ...input, organization: w.N1.o })),
			/^Error: unavailable$/,
		);
	});
	const events = () =>
		rows(
			sql`SELECT action, count(*)::int n FROM audit_event WHERE subject_id IN (${a.id},${b.id}) GROUP BY 1 ORDER BY 1`,
		);
	assert.deepEqual(await events(), [{ action: "affiliation.approved", n: 2 }]);
	const request = S.command(input);
	const saved = await S.call("privacy.setSharing", w.admin, request);
	assert.deepEqual(saved, { status: "committed" });
	await silent(async () => {
		assert.deepEqual(await S.call("privacy.setSharing", w.admin, request), saved);
	});
	assert.deepEqual(
		await events(),
		[
			{ action: "affiliation.approved", n: 2 },
			{ action: "sharing.changed", n: 1 },
		],
		"one recorded outcome and no relationship event",
	);
	assert.deepEqual(((await sharing(w, w.S1, w.owner)) as { choices: object }).choices, {
		...allChoices(true),
		activity: false,
	});
	assert.deepEqual(await read(), before);
	assert.equal(before[0] && (before[0] as { digest: boolean }).digest, true);
	assert.deepEqual((await activeOrganizations(w)).orgs, [w.S1.o.id, w.N1.o.id].sort());
	assert.equal((await bodies(w, w.S1, await as(w.S1.admin))).digest, false);
});

test("AC:AF-031 AC:AF-040 ending a sending church's link leaves the separately approved network's consent, grants and reads intact", async () => {
	for (const ender of ["owner", "admin"] as const) {
		const { w, a, b } = await twoOrganizations();
		await S.db.execute(
			sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${w.S1.o.id},${w.N1.o.id},clock_timestamp(),false,false,false,false,false,false,false)`,
		);
		await share(w, w.N1, b, "tasks", false);
		const n1 = await as(w.N1.admin);
		const before = await bodies(w, w.N1, n1);
		const consent = await sharing(w, w.N1, w.owner);
		assert.deepEqual(before.row!.provenance, { kind: "through", sendingChurches: [await orgName(w.S1)] });
		await endOnce(w, w.S1, a, w[ender], [w.N1]);
		const direct = { provenance: { kind: "direct" } };
		assert.deepEqual(await bodies(w, w.N1, n1), {
			...before,
			row: { ...before.row, ...direct },
			page: { ...before.page, plant: { ...before.page!.plant, ...direct } },
		});
		assert.deepEqual(await sharing(w, w.N1, w.owner), consent);
		assert.equal((await linkNow(b)).ended, false);
		assert.deepEqual(
			(await listSendingChurches(S.runtime, n1))!.churches,
			[{ organizationId: w.S1.o.id, name: await orgName(w.S1), plants: 0 }],
			"the church's own network link is not ended",
		);
		assert.deepEqual(await bodies(w, w.S1, await as(w.S1.admin)), NO_BODY);
	}
});

test("AC:AF-032 AC:AF-033 a notice queued before the end is checked again at dispatch: no active or sharing notice follows an ended link", async () => {
	const told: { to: string; text: string }[] = [];
	const service = noticeMail(async (payload) => {
		told.push({ to: payload.to, text: `${payload.subject} ${payload.text}` });
		return { kind: "accepted", id: randomUUID() };
	});
	await service.plan();
	await service.deliver();
	for (const planned of [false, true]) {
		const { w, a } = await twoOrganizations();
		await share(w, w.S1, a, "wiki", false);
		if (planned) await service.plan();
		assert.equal((await notices(a)).length, planned ? 4 : 0);
		await endOnce(w, w.S1, a, w.owner, [w.N1]);
		await S.db.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${w.admin.account}`);
		const from = told.length;
		await service.plan();
		await service.deliver();
		const mine = told.slice(from).filter((m) => [w.owner.email, w.admin.email].includes(m.to));
		const s1 = await orgName(w.S1);
		const aboutS1 = mine.filter((m) => m.text.includes(s1));
		assert.deepEqual(aboutS1, [
			{ to: w.owner.email, text: `Connection ended: ${s1} Your church's connection with ${s1} has ended.` },
		]);
		const states = await notices(a);
		assert.deepEqual(
			states.filter((n) => n.occurrence !== "ended").map((n) => n.mail),
			planned ? ["cancelled", "cancelled", "cancelled", "cancelled"] : [],
			"no active relationship or sharing notice is sent",
		);
		assert.deepEqual(
			states.filter((n) => n.occurrence === "ended").map((n) => [n.recipient, n.mail]),
			[[w.owner.account, "accepted"]],
			"the Admin whose seat ended is told nothing",
		);
		assert.deepEqual(await jobs(a), [
			["affiliation/approved/1", planned ? "succeeded" : "cancelled", planned ? null : "suppressed"],
			["affiliation/sharing/2", planned ? "succeeded" : "cancelled", planned ? null : "suppressed"],
			["affiliation/ended/3", "succeeded", null],
		]);
		assert.doesNotMatch(JSON.stringify(aboutS1), /wiki|activity|people|findings|category/i);
		assert.equal(
			(
				await rows(
					sql`SELECT 1 FROM notice WHERE source_record_id=${a.id} AND recipient_id IN (${w.member.account},${w.S1.admin.account},${w.N1.admin.account})`,
				)
			).length,
			0,
		);
	}
});

test("AC:AF-034 AC:AF-041 another organization's Owner, Admin or Member, or a tampered organization, plant or relationship, changes and reveals nothing", async () => {
	const { w, a, b } = await twoOrganizations();
	const command = await endCommand(a);
	const tampered = { ...command, input: { ...command.input, pair: { ...a.pair, organization: w.N2.o } } };
	const setInput = {
		plant: w.p,
		organization: w.S1.o,
		relationshipId: a.id,
		category: "activity",
		enabled: false,
		expectedConsentRevision: "1",
	};
	const fresh = <T extends object>(c: T) => ({ ...c, requestKey: randomUUID() });
	const strangers = [w.N2.owner, w.N2.admin, w.N2.member, w.S2.owner, w.S2.admin, w.foreign];
	await silent(async () => {
		for (const who of strangers) {
			for (const request of [command, tampered])
				await assert.rejects(S.call("associations.end", who, fresh(request)), /^Error: unavailable$/);
			for (const input of [setInput, { ...setInput, organization: w.N2.o }])
				await assert.rejects(S.call("privacy.setSharing", who, S.command(input)), /^Error: unavailable$/);
			await assert.rejects(
				S.call("organizations.updateProfile", who, S.command({ organization: w.S1.o, patch: { name: "Taken" } })),
				/^Error: unavailable$/,
			);
			const authority = await as(who);
			for (const organization of [w.S1.o, w.N1.o, w.N2.o, w.S2.o])
				assert.deepEqual(await S.call("privacy.getSharing", who, { plant: w.p, organization }), {
					status: "unavailable",
				});
			assert.deepEqual(await S.call("organizations.getProfile", who, { organization: w.S1.o }), {
				status: "unavailable",
			});
			assert.deepEqual(await readPlantSharing(S.runtime, authority, w.S1.o.id), {});
			assert.deepEqual(
				await gatedTransaction(S.runtime, (tx) =>
					readSharingDisclosure(tx, who.session, who.selected, pairOf(w, w.S1)),
				),
				{ status: "unavailable" },
			);
			assert.deepEqual(await S.call("associations.getHistory", who, { plant: w.p }), { status: "unavailable" });
			assert.equal(await getPlant(S.runtime, authority, w.p.id), null);
			assert.equal(
				await readReportingLocation(S.runtime, authority).then((l) => JSON.stringify(l ?? {}).includes(w.p.id)),
				false,
			);
			refused(
				await feedApi.readOversightDigest(S.runtime, authority, {
					organizationId: w.S1.o.id,
					organizationKind: "sending_church",
					period: "current",
				}),
				"access_denied",
			);
			refused(await people(who, w));
		}
		for (const who of [w.S1.owner, w.S1.admin])
			await assert.rejects(S.call("privacy.setSharing", who, S.command(setInput)), /^Error: unavailable$/);
		await assert.rejects(S.call("associations.end", w.S1.admin, fresh(await endCommand(b))), /^Error: unavailable$/);
		await assert.rejects(S.call("associations.end", w.N1.admin, fresh(tampered)), /^Error: unavailable$/);
		refused(await people(w.S1.owner, w));
	});
	assert.deepEqual([(await linkNow(a)).ended, (await linkNow(b)).ended], [false, false]);
	assert.deepEqual((await activeOrganizations(w)).orgs, [w.S1.o.id, w.N1.o.id].sort());
	assert.deepEqual(
		await S.call("associations.end", w.S1.admin, command),
		{ status: "committed" },
		"an organization Admin ends its own link",
	);
	assert.deepEqual((await activeOrganizations(w)).orgs, [w.N1.o.id]);
});

test("AC:AF-035 AC:ORG55-005 AC:TARGET-IDN-023 private check-ins, interviews and people never reach an organization, and its Admin is not a plant Admin", async () => {
	const { w, holder } = await twoOrganizations();
	await S.db.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${w.owner.account}`);
	const care = createPrivateCare();
	const author = await as(w.owner);
	const week = ok(await care.readCurrent(S.runtime, author, {}));
	ok(
		await care.save(S.runtime, author, {
			requestKey: randomUUID(),
			expectedRevision: week.revision,
			input: {
				answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" },
				note: "CARE-CANARY",
			},
		}),
	);
	const pass = { rating: "pass" };
	ok(
		await withPeopleWrite(S.runtime, author, (tx, c) =>
			interviews.createInterview(tx, c, {
				requestKey: randomUUID(),
				input: {
					personId: holder,
					occurredOn: "2026-10-02",
					maturity: { rating: "pass", notes: "INTERVIEW-CANARY" },
					gifted: pass,
					chemistry: pass,
					rightReasons: pass,
					season: pass,
					result: "qualified",
				},
			}),
		),
	);
	await S.db.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${w.p.id},${w.p.id},${holder},${w.owner.account},'NOTE-CANARY',clock_timestamp(),clock_timestamp())`);
	await silent(async () => {
		for (const who of [w.S1.owner, w.S1.admin, w.S1.member]) {
			const authority = await as(who);
			assert.notEqual(authority.actor.context.owner.kind, "plant");
			const native = [await listPlants(S.runtime, authority), await getPlant(S.runtime, authority, w.p.id)];
			const evry = [];
			for (const operation of ["oversight.listPlants", "oversight.getPlant"])
				evry.push(
					await invokeRead(
						S.runtime,
						evryActor(authority),
						adapters.get(operation)!,
						operation === "oversight.getPlant" ? { plantId: w.p.id } : {},
					),
				);
			const text = JSON.stringify([native, evry.map((e) => e.rows)]);
			for (const secret of [
				"CANARY",
				"strained",
				"Alex Rivera",
				"555-0101",
				"@example.test",
				"12 Private Lane",
				w.owner.account,
			])
				assert.equal(text.includes(secret), false, secret);
			native.forEach((n) => noUnsharedFields(n!));
			refused(await people(who, w));
			refused(
				await gatedTransaction(S.runtime, (tx) =>
					interviews.getInterviews(tx, { session: who.session, selected: w.p } as never, { personId: holder } as never),
				),
			);
			refused(await care.readCurrent(S.runtime, authority, {}), "access_denied");
			for (const operation of ["people.listPeople", "people.getInterviews"])
				await assert.rejects(
					invokeRead(
						S.runtime,
						evryActor(authority),
						adapters.get(operation)!,
						adapters.get(operation)!.input.parse(operation === "people.listPeople" ? {} : { personId: holder }),
					),
					(e) => e instanceof EvryRefusal && e.code === "access_denied",
				);
			await assert.rejects(
				S.call("organizations.correctReportingLocation", who, {
					...S.command({
						plant: w.p,
						locality: { city: "Taken", stateProvince: null, country: null },
						referenceVersionId: randomUUID(),
						regionItemId: null,
					}),
				}),
				/^Error: unavailable$/,
			);
		}
	});
	const runId = randomUUID();
	ok(await requestIntelligenceRefresh(S.runtime, await as(w.N1.admin), { runId }));
	const inputs = JSON.stringify(
		await rows(sql`SELECT to_jsonb(r) r, (SELECT jsonb_agg(to_jsonb(p)) FROM network_intelligence_plant p WHERE p.run_id=r.id) plants
			FROM network_intelligence_run r WHERE r.id=${runId}`),
	);
	assert.ok(inputs.includes(w.p.id));
	const shown = JSON.stringify(
		await readIntelligence(S.runtime, await as(w.N1.admin), { level: "portfolio", runId: null }),
	);
	for (const text of [inputs, shown])
		for (const secret of [
			"CANARY",
			"strained",
			"Alex Rivera",
			"Blake Stone",
			"555-0101",
			"alex.lead@example.test",
			holder,
		])
			assert.equal(text.includes(secret), false, `organization intelligence ${secret}`);
});

test("AC:AF-037 AC:ORG55-004 AC:ORG55-005 AC:TARGET-IDN-023 the directory names the recorded lead, not the Owner, with no contact, account or health word it was not given", async () => {
	const w = await world();
	const a = await connect(w, w.S1);
	await connect(w, w.N1);
	await S.db.execute(
		sql`UPDATE auth_user u SET name='Casey Owner' FROM account c WHERE c.auth_user_id=u.id AND c.id=${w.owner.account}`,
	);
	await share(w, w.S1, a, "shared_findings", false);
	const directory = async () => {
		const native = (await listed(w.S1.admin))!.find((r) => r.plantId === w.p.id)!;
		const page = (await view(w.S1, w))!;
		assert.deepEqual(page.plant, native);
		const asked = await invokeRead(
			S.runtime,
			evryActor(await as(w.S1.admin)),
			adapters.get("oversight.listPlants")!,
			{},
		);
		const row = asked.rows.find((r) => r.id === w.p.id)!;
		const text = JSON.stringify([native, page, row]);
		for (const secret of [
			"Casey Owner",
			"555-0101",
			"alex.lead@example.test",
			"12 Private Lane",
			w.owner.account,
			w.owner.email,
		])
			assert.equal(text.includes(secret), false, secret);
		assert.deepEqual([native.health, row.fields.health], ["limited_visibility", "Not shared"]);
		return native.leadPlanter;
	};
	assert.equal(await directory(), null, "no recorded lead reads as none, never the Owner");
	const alex = await person(w, "Alex Lead");
	const { teamId, roles } = await teamRoles(w, [alex]);
	await lead(w, { teamId, roleId: roles[0]!, personId: alex });
	const seats = () =>
		rows(
			sql`SELECT account_id, role FROM seat WHERE plant_id=${w.p.id} AND ended_at IS NULL ORDER BY role, account_id`,
		);
	const before = await seats();
	await silent(async () => {
		assert.equal(await directory(), "Alex Lead");
		for (const who of [w.S1.owner, w.S1.admin, w.S1.member])
			assert.equal((await listed(who))![0]!.leadPlanter, "Alex Lead");
		assert.equal((await listed(w.N1.admin))![0]!.leadPlanter, "Alex Lead");
		for (const who of [w.owner, w.admin, w.member, w.foreign]) assert.equal(await listed(who), null);
		for (const who of [w.N2.admin, w.S2.owner]) assert.deepEqual(await listed(who), []);
	});
	assert.deepEqual(await seats(), before);
	assert.deepEqual(
		await rows(sql`SELECT account_id FROM seat WHERE plant_id=${w.p.id} AND role='owner' AND ended_at IS NULL`),
		[{ account_id: w.owner.account }],
	);
	assert.deepEqual(await rows(sql`SELECT linked_account_id FROM person WHERE id=${alex}`), [
		{ linked_account_id: null },
	]);
	const second = await person(w, "Second Holder");
	const others = await teamRoles({ p: w.p }, [second]);
	assert.equal(others.roles.length, 1);
	assert.equal(await directory(), "Alex Lead", "another leader is not chosen in the lead's place");
	await S.db.execute(sql`UPDATE team_tenure SET ended_on='2026-02-01' WHERE role_id=${roles[0]!}`);
	assert.equal(await directory(), null, "an empty lead role names no one else");
	await S.db.execute(
		sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${w.p.id},${roles[0]!},${second},'2026-02-02')`,
	);
	assert.equal(await directory(), "Second Holder");
});

test("AC:AF-039 an organization counts a plant and its meeting once when several affiliations lead to it, each from its own link", async () => {
	const { w, a, holder } = await twoOrganizations();
	await S.db.execute(
		sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${w.S1.o.id},${w.N1.o.id},clock_timestamp(),false,false,false,false,false,false,false)`,
	);
	await meeting(w, [holder]);
	const counted = {
		status: "shared",
		counts: { meetings: [{ date: "2026-09-01", attended: 1 }], averageDaysBetween: null, attendedTotal: 1 },
	};
	await silent(async () => {
		for (const side of [w.S1, w.N1]) {
			assert.deepEqual(
				(await listed(side.admin))!.map((r) => r.plantId),
				[w.p.id],
			);
			assert.deepEqual((await view(side, w))!.sections.meetings, counted);
		}
		assert.equal((await listSendingChurches(S.runtime, await as(w.N1.admin)))!.churches[0]!.plants, 1);
	});
	assert.deepEqual((await listed(w.N1.admin))![0]!.provenance, {
		kind: "through",
		sendingChurches: [await orgName(w.S1)],
	});
	ok(await requestIntelligenceRefresh(S.runtime, await as(w.N1.admin), { runId: randomUUID() }));
	const portfolio = (await readIntelligence(S.runtime, await as(w.N1.admin), { level: "portfolio", runId: null }))!;
	assert.deepEqual(
		(portfolio.groups as { rows: { name: string }[] }[]).flatMap((g) => g.rows.map((r) => r.name)),
		[(await listed(w.N1.admin))![0]!.name],
	);
	await share(w, w.S1, a, "meetings", false);
	assert.deepEqual((await view(w.S1, w))!.sections.meetings, { status: "withheld" });
	assert.deepEqual((await view(w.N1, w))!.sections.meetings, counted, "the network's count comes from its own link");
});

test("AC:TARGET-IDN-022 each pair keeps its own seven choices through a joint acceptance, another organization's change and a rejoin; nothing else turns sharing on", async () => {
	const w = await world();
	const invited = [await invite(w, w.S1), await invite(w, w.N1)] as const;
	const [s1] = await Promise.all([
		S.call("associations.acceptInvitation", w.S1.admin, acceptance(invited[0].invitationId)),
		S.call("associations.acceptInvitation", w.N1.admin, acceptance(invited[1].invitationId)),
	]).then((r) =>
		r.map((v) => {
			const value = Q.acceptedInvitationResult.parse(v);
			assert.ok(value.status === "accepted");
			return value.relationship;
		}),
	);
	await share(w, w.S1, s1!, "shared_findings", false);
	const admin = (organization: Org, choices: object, consentRevision: string, name: string) => ({
		view: "plant_administration",
		plant: w.p,
		organization: organization.o,
		organizationDisplayName: name,
		activeAffiliation: true,
		consentRevision,
		choices,
	});
	const mixed = { ...allChoices(true), shared_findings: false };
	const [s1Name, n1Name] = [await orgName(w.S1), await orgName(w.N1)];
	await silent(async () => {
		for (const who of [w.owner, w.admin]) {
			assert.deepEqual(await sharing(w, w.S1, who), admin(w.S1, mixed, "2", s1Name));
			assert.deepEqual(await sharing(w, w.N1, who), admin(w.N1, allChoices(true), "1", n1Name));
		}
		const basic = { plant: w.p, organization: w.S1.o, organizationDisplayName: s1Name, activeAffiliation: true };
		assert.deepEqual(await sharing(w, w.S1, w.member), { view: "plant_member", ...basic });
		for (const who of [w.S1.owner, w.S1.admin, w.S1.member])
			assert.deepEqual(await sharing(w, w.S1, who), { view: "organization", ...basic, availability: mixed });
		for (const who of [w.foreign, w.N1.admin, w.N2.owner])
			assert.deepEqual(await sharing(w, w.S1, who), { status: "unavailable" });
		for (const missing of [w.S2, w.N2])
			assert.deepEqual(await sharing(w, missing, w.owner), { status: "unavailable" }, "no link reads as closed");
		const now = await linkNow(s1 as never);
		for (const category of ["finance", "facilities", "coach", "private_care", "ni_consent", "network_intelligence", ""])
			await assert.rejects(share(w, w.S1, s1 as never, category, true), (e: Error) => e.name === "ZodError");
		assert.deepEqual(await linkNow(s1 as never), now);
	});
	await S.call("associations.end", w.owner, await endCommand(s1 as never));
	const back = await connect(w, w.S1);
	assert.equal(back.id, s1!.id);
	assert.deepEqual((await sharing(w, w.S1, w.owner)) as object, admin(w.S1, mixed, "2", s1Name));
	assert.deepEqual((await sharing(w, w.N1, w.owner)) as object, admin(w.N1, allChoices(true), "1", n1Name));
	await connect(w, w.N2);
	assert.deepEqual((await sharing(w, w.S1, w.owner)) as object, admin(w.S1, mixed, "2", s1Name));
	await share(w, w.S1, s1 as never, "activity", false);
	await share(w, w.S1, s1 as never, "people", false);
	await S.db.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${w.S1.admin.account},'oversight_digest','in_app',true,0),(${w.S1.admin.account},'oversight_digest','email',true,0)`);
	const seen = await bodies(w, w.S1, await as(w.S1.admin));
	assert.deepEqual(
		[seen.digest, seen.page!.sections.people],
		[false, { status: "withheld" }],
		"a push preference shares nothing",
	);
	assert.ok(seen.row, "the basic directory stays");
});

test("AC:TARGET-IDN-024 a network reads only its own sending churches, their same-network plants and its unexpired requests", async () => {
	const w = await world();
	const church = async (side: Org) =>
		S.db.execute(
			sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${w.S1.o.id},${side.o.id},clock_timestamp(),false,false,false,false,false,false,false)`,
		);
	await church(w.N1);
	await connect(w, w.S1);
	await connect(w, w.N1);
	const q = await S.tenant("plant", "Quiet Hollow");
	const other = { ...w, p: q, owner: await S.identity(q) };
	await connect(other, w.S1);
	await connect(other, w.N2);
	const roster = [{ organizationId: w.S1.o.id, name: await orgName(w.S1), plants: 1 }];
	const pair = { kind: "sending_church", subject: w.S2.o, organization: w.N1.o };
	const request = Q.invitationResult.parse(
		await S.call("associations.invite", w.S2.admin, S.command({ pair, recipientEmail: w.N1.admin.email })),
	);
	const sentAgo = (created: string, resent: string | null) =>
		S.db.execute(sql`UPDATE invitation SET created_at=clock_timestamp()-${created}::interval,
			resent_at=${resent === null ? sql`NULL` : sql`clock_timestamp()-${resent}::interval`} WHERE id=${request.invitationId}`);
	for (const [created, resent, pending] of [
		["0 days", null, 1],
		["29 days", null, 1],
		["31 days", null, 0],
		["45 days", "20 days", 1],
		["70 days", "31 days", 0],
	] as const) {
		await sentAgo(created, resent);
		for (const who of [w.N1.owner, w.N1.admin, w.N1.member])
			assert.deepEqual(
				await listSendingChurches(S.runtime, await as(who)),
				{ pendingInvitations: pending, churches: roster },
				`${created} ${resent}`,
			);
	}
	await silent(async () => {
		assert.deepEqual(await listSendingChurches(S.runtime, await as(w.N2.admin)), {
			pendingInvitations: 0,
			churches: [],
		});
		for (const who of [w.S1.owner, w.S1.admin, w.S1.member, w.owner]) {
			assert.equal(await listSendingChurches(S.runtime, await as(who)), null);
			assert.equal(await getSendingChurch(S.runtime, await as(who), w.S1.o.id), null);
		}
		for (const who of [w.N1.admin, w.N1.member]) {
			const authority = await as(who);
			const detail = (await getSendingChurch(S.runtime, authority, w.S1.o.id))!;
			assert.deepEqual(
				detail.plants.map((p) => p.plantId),
				[w.p.id],
			);
			assert.equal(await getPlant(S.runtime, authority, q.id), null);
			for (const id of [w.S2.o.id, w.N2.o.id, w.N1.o.id, randomUUID(), "not-an-id"])
				assert.equal(await getSendingChurch(S.runtime, authority, id), null);
			const text = JSON.stringify([detail, await listSendingChurches(S.runtime, authority), await listed(who)]);
			for (const hidden of ["Quiet Hollow", q.id, w.N2.o.id, await orgName(w.N2)])
				assert.equal(text.includes(hidden), false);
		}
	});
});

test("AC:TARGET-IDN-023 the launch countdown follows each plant's own calendar day", async () => {
	const w = await world();
	const p = await S.tenant("plant", "Early Island");
	const early = { ...w, p, owner: await S.identity(p) };
	await connect(w, w.S1);
	await connect(early, w.S1);
	for (const [plant, zone] of [
		[w.p, "Pacific/Honolulu"],
		[p, "Pacific/Kiritimati"],
	] as const) {
		await S.db.execute(sql`UPDATE plant SET timezone=${zone} WHERE id=${plant.id}`);
		await S.db.execute(
			sql`INSERT INTO launch(plant_id,status,target_date) VALUES(${plant.id},'scheduled','2099-03-14')`,
		);
	}
	const days = async (id: string) => {
		const page = (await getPlant(S.runtime, await as(w.S1.admin), id))!;
		assert.ok(page.launch.status !== "withheld");
		return page.launch.preparation.daysToLaunch!;
	};
	assert.equal((await days(w.p.id)) - (await days(p.id)), 1);
});

const appDirectory = new URL("../../../../apps/web/src/app/", import.meta.url);
const routes = readdirSync(appDirectory, { recursive: true, encoding: "utf8" })
	.filter((f) => /(^|\/)(page\.tsx|route\.ts)$/.test(f))
	.map((f) =>
		f
			.split("/")
			.slice(0, -1)
			.filter((s) => !s.startsWith("(") && !s.startsWith("@")),
	);
const serves = (path: string) => {
	const parts = path.split("/").filter(Boolean);
	return routes.some((route) => {
		const rest = route.findIndex((s) => s.includes("..."));
		const fixed = rest < 0 ? route : route.slice(0, rest);
		return (
			(rest < 0 ? parts.length === fixed.length : parts.length >= fixed.length) &&
			fixed.every((s, i) => s.startsWith("[") || s === parts[i])
		);
	});
};
test("AC:TARGET-IDN-025 no coach page, download, operation, role, sharing category or Evry tool exists, and asking for one grants nothing", async () => {
	const { w, a } = await twoOrganizations();
	const grants = () =>
		one(
			sql`SELECT (SELECT count(*)::int FROM seat) seats, (SELECT md5(string_agg(x::text,'' ORDER BY x.id)) FROM affiliation x) links`,
		);
	const before = await grants();
	for (const path of ["/people", `/people/${randomUUID()}`, "/wiki/any/page", `/network/plants/${randomUUID()}`])
		assert.equal(serves(path), true, path);
	const id = randomUUID();
	for (const path of [
		"/coaches",
		"/coach",
		`/coaches/${id}`,
		`/coaches/${id}/photo`,
		`/coaches/${id}/qualifications`,
		`/coaches/${id}/documents/${id}`,
		"/organization/coaches",
		`/organization/coaches/${id}`,
		"/network/coaches",
		`/network/coaches/${id}`,
		"/api/coaches",
		`/api/coaches/${id}/download`,
		"/api/coaches/assignments",
	])
		assert.equal(serves(path), false, path);
	const catalog = JSON.parse(
		readFileSync(new URL("../../../../docs/catalog/operations.json", import.meta.url), "utf8"),
	) as {
		operations: { id: string }[];
	};
	assert.ok(catalog.operations.some((o) => o.id === "oversight.listPlants"));
	assert.deepEqual(
		catalog.operations.filter((o) => /coach/i.test(o.id)),
		[],
	);
	for (const role of ["admin", "member", "coach"] as const) {
		const attempt = S.db.execute(
			sql`UPDATE seat SET role=${role} WHERE account_id=${w.N2.member.account} AND organization_id=${w.N2.o.id}`,
		);
		if (role === "coach")
			await assert.rejects(attempt, (e: Error & { cause?: { code?: string } }) => e.cause?.code === "23514");
		else await attempt;
	}
	for (const value of [
		{ kind: "coach", id },
		{ kind: "organization", id, organizationKind: "coach" },
	])
		assert.equal(owner.safeParse(value).success, false);
	await assert.rejects(share(w, w.S1, a, "coach", true), (e: Error) => e.name === "ZodError");
	const evry = harness(S.runtime, new Date());
	for (const who of [w.owner, w.admin, w.member, w.S1.admin, w.N1.member]) {
		const actor = evryActor(await as(who));
		const offered = readCatalog(actor);
		const operations = [...offered.domains.flatMap((d) => d.operations), ...offered.reviewedWrites].map(
			(o) => o.operation,
		);
		assert.ok(operations.length);
		assert.deepEqual(
			[...adapters.keys(), ...operations].filter((o) => /coach/i.test(o)),
			[],
		);
		const { reads, proposals, results } = await evry.ask(actor, "Read coach assignment");
		assert.deepEqual([reads, proposals], [[], []]);
		assert.equal(results.includes("Alex Rivera"), false);
		const lease = { turnId: id, tenantId: actor.owner.id, leaseOwner: id, generation: "1" };
		await assert.rejects(
			prepareProposal(S.runtime, actor, lease as never, id, {
				operation: "coaches.readAssignments",
				input: { subject: w.p.id },
			}),
			(e) => e instanceof EvryRefusal,
		);
	}
	assert.deepEqual(await grants(), before);
});
