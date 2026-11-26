import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { frozenClock, instant } from "../../../packages/contracts/src/common/time.ts";
import type { PlantFacts } from "../../../packages/contracts/src/intelligence/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	createAssessmentJob,
	captureFacts,
	createAssessments,
	createFacts,
	createPrivateCare,
	runAssessmentBatch,
} from "../../../packages/domain/src/intelligence/index.ts";
import { createLaunchReader } from "../../../packages/domain/src/launch/index.ts";
import { followUpReader } from "../../../packages/domain/src/followups/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	commitments,
	peopleMerge,
	peopleReader,
	peopleWriter,
	recordCorrections,
	withPeopleWrite,
} from "../../../packages/domain/src/people/index.ts";
import { readIntelligence, requestIntelligenceRefresh } from "../../../packages/domain/src/oversight/index.ts";
import { readCatalog, readinessOf } from "../../../packages/domain/src/phases/index.ts";
import { evryActor, invokeRead, READ_DOMAINS } from "../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../packages/evry/src/catalog/types.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { ok, raced, refused } from "../../support/fixture.mts";
import { faulted, untouched } from "../../support/recorded.mts";
import { pinSchemaClock } from "../../support/test-database.mts";
import { caseOf, type Case } from "../target/sql/core/support.mts";
import { CANARY, church, ZONE, type Church, type ChurchPlant } from "./assessment-church.mts";

type Json = Record<string, unknown>;
type Card = { kind: "core_group" | "launch_team"; occurred_on: string | null; recorded_at?: string; active: boolean };
type Given = {
	fixture_type: string;
	plant?: string;
	classification?: "adult" | "child" | null;
	commitments?: Card[];
	household?: string;
	account?: string;
	stage?: string;
	role?: string;
	date_of_birth?: string | null;
	person?: string;
	kind?: string;
	effective_date?: string;
	recorded_at?: string;
	reason?: string;
	roles?: string[];
};
const K = (id: string) => caseOf("intelligence", id) as Case & { clock: { now: string; zone: string } };
const givenOf = (k: Case) => k.given as unknown as Record<string, Given>;
const expectedOf = (k: Case) => k.expected.result as Json;
const AS_OF = new Date(K("CA001").clock.now).toISOString();
const SESSION_ENDS = (givenOf(K("CA001"))["session-A"] as unknown as { expires_at: string }).expires_at;
const SETUP = "2026-08-01T16:00:00.000Z";
const TODAY = "2026-10-13";
const facts = createFacts({ clock: frozenClock(instant.parse(AS_OF)) });

let c: Church;
before(async () => {
	c = await church("adultcases", { clock: new Date(AS_OF) });
	await c.release("methodology-2026.10");
});
after(() => c?.database.close());

const at = (when: string) => pinSchemaClock(c.admin, c.database.schema, new Date(when));
type Seat = { id: string; actor: RequestActor; ctx: { session: string; selected: { kind: "plant"; id: string } } };
type Plant = ChurchPlant & { a: Seat; people: Map<string, string> };
let plants = 0;
async function plantOf(options: Parameters<Church["plant"]>[1] = {}): Promise<Plant> {
	await at(SETUP);
	const p = await c.plant(`Case Plant ${++plants}`, options);
	const account = await c.database.actor(p, "admin", { account: { personal_timezone: ZONE } });
	await c.admin.execute(
		sql`UPDATE auth_session SET expires_at=${SESSION_ENDS}::timestamptz WHERE id=${account.session}`,
	);
	await at(AS_OF);
	const actor = (await RequestActor.resolve(c.db, account.session)) as RequestActor;
	return {
		...p,
		a: { id: account.id, actor, ctx: { session: account.session, selected: { kind: "plant", id: p.id } } },
		people: new Map(),
	};
}
const write = <T,>(p: Plant, body: (t: WriteTx, ctx: Seat["ctx"]) => Promise<T>) =>
	withPeopleWrite(c.db, p.a.actor, (t, ctx) => body(t as never, ctx as never) as never) as Promise<T>;
const revisionOf = async (table: string, id: string) =>
	(await c.one<{ r: string }>(sql`SELECT revision::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`)).r;

async function card(p: Plant, personId: string, k: Card) {
	assert.ok(k.occurred_on);
	const recorded = k.recorded_at && k.recorded_at.slice(0, 10) >= k.occurred_on ? k.recorded_at : null;
	if (recorded) await at(recorded);
	try {
		return ok(
			await write(p, (t, ctx) =>
				commitments.createCommitment(t, ctx as never, {
					requestKey: randomUUID(),
					input: { personId, kind: k.kind, occurredOn: k.occurred_on },
				}),
			),
		);
	} finally {
		if (recorded) await at(AS_OF);
	}
}
async function person(p: Plant, label: string, g: Given) {
	const input: Json = { displayName: `Person ${label}` };
	if (g.classification) input.adultClassification = g.classification;
	if (g.date_of_birth) input.birthDate = g.date_of_birth;
	if (g.stage) input.stage = g.stage;
	const created = ok(
		await write(p, (t, ctx) => peopleWriter.createPerson(t, ctx as never, { requestKey: randomUUID(), input })),
	).person as { id: string };
	p.people.set(label, created.id);
	for (const k of g.commitments ?? []) await card(p, created.id, k);
	return created.id;
}
async function lifecycle(p: Plant, e: Given) {
	const personId = p.people.get(e.person!)!;
	const operation = e.kind === "withdrawn" ? "withdrawCommitment" : "reactivateCommitment";
	if (e.recorded_at) await at(e.recorded_at);
	try {
		const revision = await revisionOf("person", personId);
		return ok(
			await write(p, (t, ctx) =>
				commitments[operation](t, ctx as never, {
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId, effectiveOn: e.effective_date!, reason: e.reason ?? null },
				}),
			),
		);
	} finally {
		if (e.recorded_at) await at(AS_OF);
	}
}
async function seed(k: Case, options: Parameters<Church["plant"]>[1] = {}) {
	const p = await plantOf(options);
	const given = givenOf(k);
	for (const [label, g] of Object.entries(given))
		if (g.fixture_type === "person" && (g.plant ?? "P") === "P") await person(p, label, g);
	for (const g of Object.values(given)) if (g.fixture_type === "commitment_event") await lifecycle(p, g);
	return p;
}

const held = async (p: Plant, personId: string) =>
	ok(await write(p, (t, ctx) => commitments.getCommitments(t, ctx as never, { personId })));
async function newAdultsOn(p: Plant, r: PlantFacts, on: string) {
	let n = 0;
	for (const e of r.committedAdults.evidence) {
		const first = (await held(p, e.person.id)).firstAcquisition;
		if (first.status === "known" && first.occurredOn === on) n++;
	}
	return n;
}
async function readOf(p: Plant) {
	return ok(await untouched(c.admin, () => facts.readFacts(c.db, p.a.actor, {})));
}
async function adults(p: Plant, r: PlantFacts) {
	const a = r.committedAdults;
	const { phase } = await c.one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${p.id}`);
	return {
		committedCount: a.known,
		classificationNeededCount: a.needsClassifying.length,
		cohortEvidenceStatus: a.exact === null ? "partial" : "complete",
		exactCommittedAdultCount: a.exact,
		committed_adults: r.criteria.committed_adults,
		last_acquisition: r.growth.lastAcquiredOn,
		phase: `Phase${phase}`,
		days_since_acquisition: r.growth.daysSince,
		growth_trajectory: r.criteria.growth_trajectory,
		net_count_delta: r.growth.current - r.growth.prior,
		stalled: r.growth.status === "stalled",
		as_of: r.asOf,
		new_adults_today: await newAdultsOn(p, r, r.today),
		new_adults_on_2026_10_09: await newAdultsOn(p, r, "2026-10-09"),
	} as Json;
}
const moment = (v: unknown) => (typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? new Date(v).toISOString() : v);
function matches(got: Json, expected: Json, id: string) {
	for (const key of Object.keys(expected)) assert.ok(key in got, `${id} maps ${key}`);
	const shown = Object.fromEntries(Object.keys(expected).map((key) => [key, moment(got[key])]));
	assert.deepEqual(shown, Object.fromEntries(Object.entries(expected).map(([key, v]) => [key, moment(v)])), id);
}

async function caseRead(k: Case, p: Plant) {
	const r = await readOf(p);
	assert.equal(r.asOf, AS_OF, k.id);
	matches(await adults(p, r), expectedOf(k), k.id);
	return r;
}
async function role(p: Plant, personId: string, name: string, key: string | null = null) {
	const team = randomUUID(),
		r = randomUUID(),
		tenure = randomUUID();
	for (const [id, kind] of [
		[team, "team"],
		[r, "team_role"],
		[tenure, "team_tenure"],
	])
		await c.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${p.id})`);
	await c.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${team},${p.id},${name},'active',1)`,
	);
	await c.admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,responsibility_key)
		VALUES(${r},${p.id},${team},${name},true,1,${key})`);
	await c.admin.execute(sql`INSERT INTO team_tenure(id,plant_id,role_id,person_id,started_on)
		VALUES(${tenure},${p.id},${r},${personId},'2026-10-01')`);
	return tenure;
}
const cardsOf = async (personId: string) =>
	(await c.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM commitment WHERE person_id=${personId}`)).n;

test("AC:CA001 AC:CA002 AC:CA003 AC:CA006 one adult counts once across cards and teams, a household multiplies nothing, a known child never counts and no birth date is needed", async () => {
	const k1 = K("CA001");
	const p1 = await seed(k1);
	const alex = p1.people.get("adult-01")!;
	const roles = givenOf(k1)["team-roles"]!.roles!;
	for (const name of roles) await role(p1, alex, name, name === "worship" ? "worship" : null);
	const r1 = await caseRead(k1, p1);
	assert.deepEqual(
		r1.committedAdults.evidence.map((e) => [e.person.id, e.kinds, e.committedSince, e.adultFrom]),
		[[alex, ["core_group", "launch_team"], "2026-10-08", "recorded"]],
	);
	assert.equal(await cardsOf(alex), 3, "ministry memberships add no commitment");

	const k2 = K("CA002");
	const p2 = await seed(k2);
	const home = randomUUID();
	await c.admin.execute(sql`INSERT INTO household(id,plant_id,name) VALUES(${home},${p2.id},'H')`);
	for (const [label, position] of [
		["adult-01", "head"],
		["adult-02", "child"],
	] as const)
		await c.admin.execute(
			sql`UPDATE person SET household_id=${home},household_role=${position} WHERE id=${p2.people.get(label)!}`,
		);
	const r2 = await caseRead(k2, p2);
	assert.deepEqual(
		r2.committedAdults.evidence.map((e) => e.person.id).sort(),
		[p2.people.get("adult-01"), p2.people.get("adult-02")].sort(),
	);

	const k3 = K("CA003");
	const p3 = await seed(k3);
	await role(p3, p3.people.get("adult-01")!, "Children", "children");
	const r3 = await caseRead(k3, p3);
	assert.deepEqual([r3.committedAdults.children, r3.committedAdults.evidence], [1, []]);

	const k6 = K("CA006");
	const p6 = await seed(k6);
	const { birth_date } = await c.one<{ birth_date: string | null }>(
		sql`SELECT birth_date FROM person WHERE id=${p6.people.get("adult-01")!}`,
	);
	assert.equal(birth_date, null);
	const r6 = await caseRead(k6, p6);
	assert.deepEqual(r6.committedAdults.evidence[0]?.adultFrom, "recorded");
});

test("AC:CA004 AC:CA005 29 or 30 known adults with one unclassified candidate read partial, Unknown below 30 and Met at 30, and the other cluster indicators keep their own evidence", async () => {
	for (const id of ["CA004", "CA005"]) {
		const k = K(id);
		const p = await seed(k);
		const r = await caseRead(k, p);
		assert.deepEqual(r.committedAdults.needsClassifying, [
			{ id: p.people.get("unclassified-01"), name: "Person unclassified-01" },
		]);
		assert.deepEqual(
			[r.criteria.financial_base, r.criteria.worship_leader, r.criteria.geographic_area],
			["unknown", "unknown", undefined],
			id,
		);
	}
});

test("AC:CA007 an Owner's linked person at an advanced stage on a leading team counts only once an actual commitment exists", async () => {
	const k = K("CA007");
	const p = await seed(k);
	const g = givenOf(k)["adult-01"]!;
	const id = p.people.get("adult-01")!;
	await c.admin.execute(sql`UPDATE person SET linked_account_id=${p.a.id} WHERE id=${id}`);
	await role(p, id, g.role!);
	const r = await caseRead(k, p);
	assert.deepEqual(await c.one(sql`SELECT stage,linked_account_id::text AS account FROM person WHERE id=${id}`), {
		stage: g.stage,
		account: p.a.id,
	});
	assert.equal(r.committedAdults.needsClassifying.length, 0);
	const revision = await revisionOf("person", id);
	ok(
		await write(p, (t, ctx) =>
			peopleWriter.recordAdultClassification(t, ctx as never, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { personId: id, classification: "adult", occurredOn: TODAY, reason: "Adult" },
			}),
		),
	);
	await card(p, id, { kind: "core_group", occurred_on: TODAY, active: true });
	const linked = (await readOf(p)).committedAdults;
	assert.deepEqual([linked.known, linked.exact, linked.evidence.map((e) => e.person.id)], [1, 1, [id]]);
});

test("AC:CA008 AC:CA009 AC:CA019 a dated withdrawal lowers the size, keeps the first acquisition and its history, an old card cannot undo it, and a later reactivation restores the adult without a new one", async () => {
	for (const id of ["CA008", "CA019"]) {
		const k = K(id);
		const p = await seed(k);
		const adult = p.people.get("adult-01")!;
		const w = givenOf(k).withdrawal!;
		await caseRead(k, p);
		const h = await held(p, adult);
		assert.deepEqual([h.current.state, h.current.effectiveOn], ["withdrawn", w.effective_date], id);
		assert.deepEqual(h.firstAcquisition.status === "known" && h.firstAcquisition.occurredOn, "2026-10-08", id);
		assert.deepEqual(
			await c.one(sql`SELECT kind,effective_on::text AS on,actor_id::text AS actor,
				to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI') AS at FROM commitment_change WHERE person_id=${adult}`),
			{ kind: "withdrawn", on: w.effective_date, actor: p.a.id, at: w.recorded_at!.slice(0, 16) },
			id,
		);
		assert.deepEqual(
			await c.one(sql`SELECT reason FROM audit_event WHERE subject_id=${adult} AND action='people.updated'
				ORDER BY occurred_at DESC LIMIT 1`),
			{ reason: w.reason },
			id,
		);
		await card(p, adult, { kind: "core_group", occurred_on: "2026-10-10", active: true });
		assert.equal((await held(p, adult)).current.state, "withdrawn", id);
		await caseRead(k, p);
	}

	const k9 = K("CA009");
	const p9 = await seed(k9);
	await caseRead(k9, p9);
	const back = await held(p9, p9.people.get("adult-01")!);
	assert.deepEqual(
		[back.current.state, back.firstAcquisition.status === "known" && back.firstAcquisition.occurredOn],
		["active", "2026-10-08"],
	);
});

test("AC:CA019 correcting the invalid October 8 card away recomputes the clock with history, and an older adult who rejoins is not a new acquisition", async () => {
	const p = await plantOf();
	const wrong = await person(p, "invalid", { fixture_type: "person", classification: "adult" });
	const invalid = await card(p, wrong, { kind: "core_group", occurred_on: "2026-10-08", active: true });
	const older = await person(p, "older", {
		fixture_type: "person",
		classification: "adult",
		commitments: [{ kind: "core_group", occurred_on: "2026-09-01", active: true }],
	});
	await lifecycle(p, {
		fixture_type: "commitment_event",
		person: "older",
		kind: "withdrawn",
		effective_date: "2026-10-05",
	});
	await lifecycle(p, { fixture_type: "commitment_event", person: "older", kind: "reactivated", effective_date: TODAY });
	const before = await readOf(p);
	assert.deepEqual(
		[before.growth.lastAcquiredOn, before.growth.daysSince, before.committedAdults.known],
		["2026-10-08", 5, 2],
	);
	ok(
		await write(p, (t, ctx) =>
			commitments.correctCommitmentLifecycle(t, ctx as never, {
				requestKey: randomUUID(),
				expectedRevision: invalid.commitment.revision,
				input: { commitmentId: invalid.commitment.id, correction: { action: "void" }, reason: "Invalid card" },
			}),
		),
	);
	const r = await readOf(p);
	assert.deepEqual(
		[r.committedAdults.known, r.growth.lastAcquiredOn, r.growth.daysSince, await newAdultsOn(p, r, TODAY)],
		[1, "2026-09-01", 42, 0],
	);
	const rejoined = await held(p, older);
	assert.deepEqual(
		[rejoined.current.state, rejoined.firstAcquisition.status === "known" && rejoined.firstAcquisition.occurredOn],
		["active", "2026-09-01"],
	);
	assert.deepEqual(
		r.committedAdults.evidence.map((e) => e.person.id),
		[older],
	);
	const { voided_at } = await c.one<{ voided_at: unknown }>(
		sql`SELECT voided_at FROM commitment WHERE id=${invalid.commitment.id}`,
	);
	assert.ok(voided_at, "the invalid card is kept, voided");
	assert.equal(
		(
			await c.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${wrong}
				AND action='people.corrected' AND reason='Invalid card'`)
		).n,
		1,
	);
});

test("AC:CA010 AC:CA011 AC:CA012 a repeat card, team move or edit keeps the first date, a genuine new adult today reads zero days, and late entry is not late occurrence", async () => {
	const k10 = K("CA010");
	const p10 = await seed(k10);
	const id = p10.people.get("adult-01")!;
	const first = await caseRead(k10, p10);
	const moved = await role(p10, id, "Hospitality");
	await c.admin.execute(sql`UPDATE team_tenure SET ended_on=${TODAY} WHERE id=${moved}`);
	await role(p10, id, "Greeters");
	const revision = await revisionOf("person", id);
	ok(
		await write(p10, (t, ctx) =>
			peopleWriter.updatePerson(t, ctx as never, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { personId: id, patch: { displayName: "Person adult-01 edited" } },
			}),
		),
	);
	const again = await caseRead(k10, p10);
	assert.deepEqual([again.growth, again.committedAdults.known], [first.growth, first.committedAdults.known]);

	const k11 = K("CA011");
	const r11 = await caseRead(k11, await seed(k11));
	assert.deepEqual([r11.growth.status, r11.criteria.growth_trajectory], ["on_track", "met"]);

	const k12 = K("CA012");
	const p12 = await seed(k12);
	await caseRead(k12, p12);
	const g = givenOf(k12)["adult-01"]!.commitments![0]!;
	const [item] = (await held(p12, p12.people.get("adult-01")!)).items;
	assert.deepEqual([item?.occurredOn, item?.recordedAt.slice(0, 16)], [g.occurred_on, g.recorded_at!.slice(0, 16)]);
});

const criterionOf = async (p: Plant, db: Pick<typeof c.db, "execute"> = c.db) => {
	const reply = await facts.readFacts(db, p.a.actor, {}).then(
		(r) => r,
		() => null,
	);
	const r = reply?.status === "ok" ? reply.value : null;
	return {
		count: r ? r.committedAdults.known : null,
		exact: r ? r.committedAdults.exact : null,
		criterion: r ? r.criteria.committed_adults : "unknown",
	};
};

test("AC:CA015 a complete empty cohort is exactly zero and Not met, thirty unresolved candidates leave it Unknown, and a failed source read gives no count", async () => {
	const k = K("CA015");
	const variants = (
		givenOf(k).controls as unknown as {
			variants: { name: string; rows: { id: string; classification: null; active_commitment: boolean }[] | null }[];
		}
	).variants;
	const got: Json = {};
	for (const v of variants) {
		const p = await plantOf();
		for (const row of v.rows ?? [])
			await person(p, row.id, {
				fixture_type: "person",
				classification: row.classification,
				commitments: row.active_commitment ? [{ kind: "core_group", occurred_on: "2026-10-08", active: true }] : [],
			});
		const unavailable = {
			execute: () => Promise.reject(new Error("source read failed")),
		} as unknown as Pick<typeof c.db, "execute">;
		got[v.name] = await criterionOf(p, v.rows === null ? unavailable : c.db);
		if (v.rows === null) assert.equal((await criterionOf(p)).count, 0, "the same plant reads when its source is up");
	}
	assert.deepEqual(got, expectedOf(k));
});

test("AC:CA016 a commitment whose occurrence is after the frozen as-of date keeps the size but leaves growth Unknown, never zero days", async () => {
	const k = K("CA016");
	const p = await plantOf();
	const g = givenOf(k)["adult-01"]!;
	const id = await person(p, "adult-01", { ...g, commitments: [] });
	await at("2026-10-14T16:00:00.000Z");
	await card(p, id, { kind: "core_group", occurred_on: "2026-10-14", active: true });
	await at(AS_OF);
	const r = await caseRead(k, p);
	assert.deepEqual([r.growth.status, await newAdultsOn(p, r, TODAY)], ["unknown", 0]);
});

test("AC:CA017 growth is on track at 20 days, slowed from 21 and stalled only at 28, and a newer unresolved candidate leaves timing Unknown", async () => {
	const k = K("CA017");
	const dates = (givenOf(k).controls as unknown as { dates: string[] }).dates;
	const got = {
		days: [] as unknown[],
		growth_trajectory: [] as unknown[],
		slowed: [] as unknown[],
		stalled: [] as unknown[],
	};
	let last: Plant | null = null;
	for (const on of dates) {
		const p = await plantOf();
		await person(p, "adult-01", {
			fixture_type: "person",
			classification: "adult",
			commitments: [{ kind: "core_group", occurred_on: on, active: true }],
		});
		const r = await readOf(p);
		got.days.push(r.growth.daysSince);
		got.growth_trajectory.push(r.criteria.growth_trajectory);
		got.slowed.push(r.growth.status === "slowed" || r.growth.status === "stalled");
		got.stalled.push(r.growth.status === "stalled");
		last = p;
	}
	assert.deepEqual(got, expectedOf(k));
	await person(last!, "unclassified", {
		fixture_type: "person",
		classification: null,
		commitments: [{ kind: "core_group", occurred_on: "2026-10-01", active: true }],
	});
	const r = await readOf(last!);
	assert.deepEqual([r.growth.status, r.criteria.growth_trajectory, r.growth.daysSince], ["unknown", "unknown", 28]);
});

test("AC:CA018 a new adult yesterday and an older adult read a flat window comparison without a stalled clock", async () => {
	const k = K("CA018");
	const p = await seed(k);
	const r = await caseRead(k, p);
	assert.deepEqual([r.growth.current, r.growth.prior, r.growth.status], [1, 1, "on_track"]);
});

test("AC:CA020 a person and commitment of another plant, a deleted person and a cross-plant card never enter the cohort", async () => {
	const k = K("CA020");
	const q = givenOf(k).Q!;
	const Q = await plantOf();
	await c.admin.execute(
		sql`UPDATE plant SET timezone=${(q as unknown as { timezone: string }).timezone} WHERE id=${Q.id}`,
	);
	const foreign = await person(Q, "adult-01", givenOf(k)["adult-01"]!);
	const p = await seed(k);
	const gone = await person(p, "deleted", {
		fixture_type: "person",
		classification: "adult",
		commitments: [{ kind: "core_group", occurred_on: "2026-10-08", active: true }],
	});
	const review = ok(
		await write(p, (t, ctx) => peopleReader.getStatusWarnings(t, ctx as never, { personId: gone as never })),
	);
	const revision = await revisionOf("person", gone);
	ok(
		await write(p, (t, ctx) =>
			peopleWriter.retirePerson(
				t,
				ctx as never,
				{
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId: gone, reason: "Deleted", reviewRevision: review.reviewRevision, handoffs: [] },
				},
				async () => undefined as never,
			),
		),
	);
	const crossed = await write(p, (t, ctx) =>
		commitments.createCommitment(t, ctx as never, {
			requestKey: randomUUID(),
			input: { personId: foreign, kind: "core_group", occurredOn: "2026-10-08" },
		}),
	);
	assert.equal(crossed.status, "refused");
	const r = await readOf(p);
	const ids = [
		...r.committedAdults.evidence.map((e) => e.person.id),
		...r.committedAdults.needsClassifying.map((x) => x.id),
	];
	matches(
		{ ...(await adults(p, r)), foreign_person_included: (ids as string[]).includes(foreign) },
		expectedOf(k),
		k.id,
	);
	assert.equal((await readOf(Q)).committedAdults.known, 1, "the person still counts in their own plant");
});

const assessments = createAssessments({ clock: frozenClock(instant.parse(AS_OF)) });
const job = createAssessmentJob({ clock: frozenClock(instant.parse(AS_OF)) });
type Snapshot = { id: string; facts: unknown; source_revision: string; outcome: string };
async function snapshot(p: Plant) {
	const requestId = randomUUID();
	ok(await assessments.requestRefresh(c.db, p.a.actor, { requestId }));
	await runAssessmentBatch(job, c.db, scriptedAssessmentDrafter(), 20);
	const run = await c.one<Snapshot>(sql`SELECT id,facts,source_revision,outcome,reason FROM assessment_run
		WHERE plant_id=${p.id} AND demand_key=${"manual/" + requestId}`);
	assert.equal(run.outcome, "published", JSON.stringify(run));
	return run;
}
async function unchanged(p: Plant, run: Snapshot) {
	assert.deepEqual(
		await c.one(sql`SELECT id,facts,source_revision,outcome,reason FROM assessment_run WHERE id=${run.id}`),
		run,
		"the old snapshot is not rewritten",
	);
	assert.equal(
		ok(await facts.readFactsSinceRun(c.db, p.a.actor, {})).outOfDateRunId,
		run.id,
		"the snapshot is out of date",
	);
}
const care = createPrivateCare();
async function checkIn(p: Plant) {
	const current = ok(await care.readCurrent(c.db, p.a.actor, {}));
	const struggling = { spiritual: "struggling", family: "struggling", financial: "struggling", pace: "struggling" };
	ok(
		await care.save(c.db, p.a.actor, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: { answers: struggling, note: CANARY + "-care" },
		}),
	);
}
const stageOf = async (id: string) =>
	(await c.one<{ stage: string }>(sql`SELECT stage FROM person WHERE id=${id}`)).stage;

test("AC:CA013 correcting the first occurrence from September 20 to September 1 recomputes the clock and keeps old, new, actor, reason and recorded time", async () => {
	const k = K("CA013");
	const p = await seed(k);
	const id = p.people.get("adult-01")!;
	const args = k.action.arguments as { occurrence_date: string; reason: string };
	const [cardBefore] = (await held(p, id)).items;
	assert.ok(cardBefore);
	const stage = await stageOf(id);
	const run = await snapshot(p);
	ok(
		await write(p, (t, ctx) =>
			commitments.correctCommitmentLifecycle(t, ctx as never, {
				requestKey: randomUUID(),
				expectedRevision: cardBefore.revision,
				input: {
					commitmentId: cardBefore.id,
					correction: { action: "correct", occurredOn: args.occurrence_date },
					reason: args.reason,
				},
			}),
		),
	);
	const [cardAfter] = (await held(p, id)).items;
	const history = ok(
		await gatedTransaction(c.db, (t) => recordCorrections.listRecordCorrections(t, p.a.ctx as never, { personId: id })),
	);
	const state = {
		occurrence_date: cardAfter?.occurredOn,
		history: history.items.flatMap((i) =>
			i.changes.map((x) => ({
				old: x.old,
				new: x.new,
				actor: i.actor.kind === "current_account" && i.actor.accountId === p.a.id ? "A" : i.actor,
			})),
		),
	};
	assert.deepEqual(state, k.expected.state);
	assert.deepEqual(
		[history.items[0]?.reason, history.items[0]?.changes[0]?.field, cardAfter?.recordedAt],
		[args.reason, "occurredOn", cardBefore.recordedAt],
	);
	await caseRead(k, p);
	assert.equal(await stageOf(id), stage, "no recruitment-stage effect is replayed");
	await unchanged(p, run);
});

test("AC:CA014 classifying an unknown person as an adult counts their recorded first commitment, never the classification day", async () => {
	const k = K("CA014");
	const p = await seed(k);
	const id = p.people.get("adult-01")!;
	const args = k.action.arguments as { classification: "adult"; occurred_on: string; reason: string };
	const before = await readOf(p);
	assert.deepEqual([before.committedAdults.known, before.committedAdults.needsClassifying.length], [0, 1]);
	const run = await snapshot(p);
	const revision = await revisionOf("person", id);
	const done = ok(
		await write(p, (t, ctx) =>
			peopleWriter.correctAdultClassification(t, ctx as never, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { personId: id, classification: args.classification, occurredOn: args.occurred_on, reason: args.reason },
			}),
		),
	) as { person: { adultClassification: string } };
	assert.deepEqual({ classification: done.person.adultClassification }, k.expected.state);
	await caseRead(k, p);
	assert.deepEqual(
		await c.one(sql`SELECT reason,before_value->>'adult_classification' AS old,after_value->>'adult_classification' AS new
			FROM audit_event WHERE subject_id=${id} AND action='people.corrected'`),
		{ reason: args.reason, old: "unknown", new: "adult" },
	);
	await unchanged(p, run);
});

test("AC:CA021 a withdrawal needs the reviewed state: a failed audit changes nothing, a changed state is refused, another plant is refused, concurrent sends settle once and a retry is idempotent", async () => {
	const k = K("CA021");
	const p = await seed(k);
	const other = await plantOf();
	const id = p.people.get("adult-01")!;
	const args = k.action.arguments as { effective_date: string; repeat: number };
	const run = await snapshot(p);
	const send = (expectedRevision: string, requestKey: string = randomUUID(), on: Plant = p) =>
		write(on, (t, ctx) =>
			commitments.withdrawCommitment(t, ctx as never, {
				requestKey,
				expectedRevision,
				input: { personId: id, effectiveOn: args.effective_date, reason: "Person withdrew" },
			}),
		);
	const changes = async () =>
		(await c.one<{ n: number }>(sql`SELECT count(*)::int AS n FROM commitment_change WHERE person_id=${id}`)).n;
	const reviewed = await revisionOf("person", id);
	const before = await readOf(p);
	const requestKey = randomUUID();
	let faults = 0;
	const errors: string[] = [];
	for (let attempt = 1; attempt <= args.repeat; attempt++) {
		if (attempt === 1) {
			await faulted(c.admin, "audit_event", () => send(reviewed, requestKey));
			faults++;
			assert.deepEqual(await readOf(p), before, "a failed audit leaves the facts as they were");
			ok(
				await write(p, (t, ctx) =>
					peopleWriter.updatePerson(t, ctx as never, {
						requestKey: randomUUID(),
						expectedRevision: reviewed,
						input: { personId: id, patch: { displayName: "Person adult-01 renamed" } },
					}),
				),
			);
		} else {
			const r = await untouched(c.admin, () => send(reviewed, requestKey));
			errors.push(refused(r, "conflict").code);
		}
	}
	const { phase } = await c.one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${p.id}`);
	matches(
		{
			successful_count: await changes(),
			fault_count: faults,
			stale_error: errors.map((e) => (e === "conflict" ? "revision_conflict" : e))[0],
			phase: `Phase${phase}`,
			stage: await stageOf(id),
			recorded_outcome_count: (await cardsOf(id)) + (await changes()),
		},
		expectedOf(k),
		k.id,
	);
	assert.equal((await readOf(p)).committedAdults.known, 1);

	const crossed = await untouched(c.admin, () => send(reviewed, randomUUID(), other));
	assert.equal(crossed.status, "refused");

	const fresh = await revisionOf("person", id);
	const [k1, k2] = [randomUUID(), randomUUID()];
	const settled = await raced(c.admin, c.db, sql`SELECT FROM person WHERE id=${id} FOR UPDATE`, [
		() => send(fresh, k1),
		() => send(fresh, k2),
	]);
	assert.deepEqual(settled.map((r) => r.status).sort(), ["ok", "refused"]);
	const winner = settled[0].status === "ok" ? k1 : k2;
	const loser = settled.find((r) => r.status === "refused")!;
	refused(loser, "conflict");
	const won = settled.find((r) => r.status === "ok")!;
	assert.deepEqual(await untouched(c.admin, () => send(fresh, winner)), won);
	assert.equal(await changes(), 1);
	const r = await readOf(p);
	assert.deepEqual(
		[r.committedAdults.known, r.growth.lastAcquiredOn, await stageOf(id), phase],
		[0, "2026-10-08", "leader", 1],
	);
	await unchanged(p, run);
});

test("AC:CA022 a reviewed merge counts the survivor once with the earliest card, never resurrects a withdrawal, and similar names are not merged automatically", async () => {
	const k = K("CA022");
	const p = await seed(k);
	const survivor = p.people.get("adult-01")!;
	const duplicate = p.people.get("duplicate")!;
	for (const [personId, email] of [
		[survivor, "alex@example.test"],
		[duplicate, "Alex@Example.test"],
	]) {
		const revision = await revisionOf("person", personId!);
		ok(
			await write(p, (t, ctx) =>
				peopleWriter.updatePerson(t, ctx as never, {
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId, patch: { displayName: "Alex Rivera", email } },
				}),
			),
		);
	}
	const before = await readOf(p);
	assert.equal(before.committedAdults.known, 2, "two people with one name stay two until merged");
	const run = await snapshot(p);
	const merge = async (sourceId: string, survivorId: string) => {
		const review = ok(
			await gatedTransaction(c.db, (t) => peopleMerge.getMergeReview(t, p.a.ctx as never, { sourceId, survivorId })),
		);
		return ok(
			await write(p, (t, ctx) =>
				peopleMerge.mergePeople(t, ctx as never, {
					requestKey: randomUUID(),
					input: { sourceId, survivorId, reviewDigest: review.reviewDigest, fieldChoices: {} },
				}),
			),
		);
	};
	await merge(duplicate, survivor);
	const r = await readOf(p);
	const evidence = r.committedAdults.evidence;
	matches(
		{
			...(await adults(p, r)),
			survivor: evidence.length === 1 && evidence[0]!.person.id === survivor ? "adult-01" : null,
			count: evidence.length,
		},
		expectedOf(k),
		k.id,
	);
	assert.deepEqual(
		(await c.rows<{ person_id: string }>(sql`SELECT DISTINCT person_id FROM commitment WHERE plant_id=${p.id}`)).map(
			(x) => x.person_id,
		),
		[survivor],
	);
	const first = (await held(p, survivor)).firstAcquisition;
	assert.deepEqual(first.status === "known" && first.occurredOn, "2026-09-01");
	assert.equal((await c.one<{ state: string }>(sql`SELECT state FROM person WHERE id=${duplicate}`)).state, "merged");
	await unchanged(p, run);

	const left = await person(p, "withdrawn", {
		fixture_type: "person",
		classification: "adult",
		commitments: [{ kind: "core_group", occurred_on: "2026-09-10", active: true }],
	});
	await lifecycle(p, {
		fixture_type: "commitment_event",
		person: "withdrawn",
		kind: "withdrawn",
		effective_date: "2026-10-01",
	});
	const old = await person(p, "old signature", {
		fixture_type: "person",
		classification: "adult",
		commitments: [{ kind: "core_group", occurred_on: "2026-08-01", active: true }],
	});
	await merge(old, left);
	const after = await readOf(p);
	assert.equal((await held(p, left)).current.state, "withdrawn");
	assert.deepEqual([after.committedAdults.known, after.growth.lastAcquiredOn], [1, "2026-09-01"]);
});

test("AC:CA023 an old snapshot of raw signatures stays readable as it was and never becomes a verified adult count", async () => {
	const k = K("CA023");
	const p = await seed(k);
	const r0 = givenOf(k).R0 as unknown as { facts: Json; formula_version: number; available_at: string };
	const run = await snapshot(p);
	await c.admin.transaction(async (tx) => {
		await tx.execute(sql`SET LOCAL session_replication_role = replica`);
		await tx.execute(sql`UPDATE assessment_run SET facts=${JSON.stringify(r0.facts)}::jsonb,
			formula_version=${String(r0.formula_version)},available_at=${r0.available_at}::timestamptz WHERE id=${run.id}`);
	});
	const historical = ok(await assessments.readRun(c.db, p.a.actor, { runId: run.id }));
	const mass = historical.lenses.find((l) => l.key === "critical_mass")!;
	const counted = mass.evidence.find((e) => e.key.startsWith("committedAdults."));
	const cited = await assessments.resolveCitation(c.db, p.a.actor, { runId: run.id, key: "committedAdults.atLeast" });
	assert.ok(cited.status !== "ok" || cited.value.status !== "verified", JSON.stringify(cited));
	const current = await readOf(p);
	const stored = await c.one<{ facts: Json }>(sql`SELECT facts FROM assessment_run WHERE id=${run.id}`);
	matches(
		{
			historical_facts: stored.facts,
			verified_adult_count: counted?.value ?? null,
			classification: mass.quality,
		},
		expectedOf(k),
		k.id,
	);
	assert.equal(ok(await facts.readFactsSinceRun(c.db, p.a.actor, {})).outOfDateRunId, null);
	assert.deepEqual([current.committedAdults.known, current.committedAdults.exact], [1, 1]);
});

test("AC:CA024 the native read, Evry and the network read share one cohort, as-of and input state, and the network sees no person rows or check-ins", async () => {
	const k = K("CA024");
	await at(SETUP);
	const network = await c.network("Adult Case Network");
	await c.admin.execute(
		sql`UPDATE auth_session SET expires_at=${SESSION_ENDS}::timestamptz WHERE id=${network.director.session}`,
	);
	await at(AS_OF);
	const director = (await RequestActor.resolve(c.db, network.director.session)) as RequestActor;
	const p = await seed(k, { network });
	await checkIn(p);
	const r = await readOf(p);
	const captured = await captureFacts(c.db, p.id, AS_OF);
	const sameInput = captured?.sourceRevision === r.sourceRevision;
	const adapter = Object.values(READ_DOMAINS)
		.flat()
		.find((a) => a.operation === "intelligence.readCommittedAdultCohort") as ReadAdapter<unknown>;
	const evry = await untouched(c.admin, () => invokeRead(c.db, evryActor(p.a.actor), adapter, adapter.input.parse({})));
	const ids = [...p.people.values()];
	const networkRead = async () => {
		const runId = randomUUID();
		ok(await requestIntelligenceRefresh(c.db, director, { runId }));
		const view = (await untouched(c.admin, () => readIntelligence(c.db, director, { level: "portfolio", runId })))!;
		const stored = await c.one<{ growth_days: number | null }>(
			sql`SELECT growth_days FROM network_intelligence_plant WHERE run_id=${runId} AND plant_id=${p.id}`,
		);
		return { text: JSON.stringify(view), growth: stored.growth_days };
	};
	const withheld = await networkRead();
	await c.admin.execute(sql`UPDATE affiliation SET share_people=true WHERE id=${p.affiliation}`);
	const shared = await networkRead();
	const texts = [JSON.stringify(r), JSON.stringify(evry), withheld.text, shared.text];
	matches(
		{
			...(await adults(p, r)),
			assessment_input_state: sameInput
				? (givenOf(k).P as unknown as { assessment_input_state: string }).assessment_input_state
				: null,
			organization_person_rows: [withheld.text, shared.text].some(
				(t) => ids.some((id) => t.includes(id)) || t.includes("Person adult-"),
			)
				? "shown"
				: null,
			private_care: texts.some((t) => t.includes(CANARY) || t.includes("struggling")) ? "shown" : null,
		},
		expectedOf(k),
		k.id,
	);
	assert.deepEqual(evry.facts, {
		known: r.committedAdults.known,
		exact: r.committedAdults.exact,
		needsClassifying: r.committedAdults.needsClassifying.length,
		childrenNotCounted: r.committedAdults.children,
		target: 30,
		criterion: "met",
		measuredOn: (evry.facts as Json).measuredOn,
		counts: (evry.facts as Json).counts,
		screen: (evry.facts as Json).screen,
	});
	assert.equal(evry.rows[0]?.fields.known, 30);
	assert.deepEqual([withheld.growth, shared.growth], [null, r.growth.daysSince]);
});

test("AC:CA025 thirty committed adults alone clear no readiness cluster and change no phase while finances, leadership and geography stay Unknown", async () => {
	const k = K("CA025");
	const p = await seed(k);
	const plantBefore = await c.one(sql`SELECT phase,revision::text AS revision FROM plant WHERE id=${p.id}`);
	const r = await readOf(p);
	const catalog = await readCatalog();
	const cluster = catalog.phases.find((x) => x.criteria.some((y) => y.key === "committed_adults"))!;
	const readiness = readinessOf(cluster, r.criteria);
	const status = (key: string) => readiness.criteria.find((x) => x.key === key)?.status;
	const unresolved = ["financial_base", "worship_leader", "geographic_area"].filter((key) => status(key) === "unknown");
	matches(
		{
			...(await adults(p, r)),
			readiness: readiness.ready ? "ready" : unresolved.length ? "unknown" : readiness.verdict,
			phase_changed:
				JSON.stringify(await c.one(sql`SELECT phase,revision::text AS revision FROM plant WHERE id=${p.id}`)) !==
				JSON.stringify(plantBefore),
		},
		expectedOf(k),
		k.id,
	);
	assert.deepEqual(
		[status("committed_adults"), unresolved, readiness.ready, readiness.humanTransitionAllowed],
		["met", ["financial_base", "worship_leader", "geographic_area"], false, true],
	);
});

const record = (id: string, kind: string, plantId: string) =>
	c.admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${id},${kind},${plantId}) ON CONFLICT DO NOTHING`);
async function heldMeeting(p: Plant, at: string) {
	const id = randomUUID();
	await record(id, "meeting", p.id);
	await c.admin
		.execute(sql`INSERT INTO meeting(id,plant_id,type,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision,actual_occurrence_at,vision_number)
		VALUES(${id},${p.id},'vision_meeting',(${at}::timestamptz AT TIME ZONE ${ZONE})::date,'09:00',${ZONE},${at}::timestamptz,
		'r1','completed',1,${at}::timestamptz,(SELECT coalesce(max(vision_number),0)+1 FROM meeting WHERE plant_id=${p.id}))`);
	return id;
}
async function followUpAt(
	p: Plant,
	meetingId: string,
	personId: string,
	origin: string,
	status: string,
	completed: string | null = null,
) {
	const id = randomUUID(),
		taskId = randomUUID();
	await record(id, "obligation", p.id);
	await record(taskId, "task", p.id);
	await c.admin.execute(sql`INSERT INTO obligation(id,plant_id,meeting_id,person_id,kind,origin_at,origin_date,timezone,
		formula_version,due_date) VALUES(${id},${p.id},${meetingId},${personId},'follow_up',${origin}::timestamptz,
		(${origin}::timestamptz AT TIME ZONE ${ZONE})::date,${ZONE},'f1',(${origin}::timestamptz AT TIME ZONE ${ZONE})::date+2)`);
	await c.admin
		.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,obligation_id,
		person_id,completed_at) VALUES(${taskId},${p.id},'Follow up','follow_up','medium',${status},${origin}::timestamptz,'undated',
		${id},${personId},${status === "complete" ? completed : null}::timestamptz)`);
	return { id, taskId };
}
async function outcomeAt(
	p: Plant,
	personId: string,
	kind: string,
	occurred: string,
	on: { id: string; taskId: string } | null = null,
) {
	const id = randomUUID();
	await record(id, "contact_outcome", p.id);
	await c.admin.execute(sql`INSERT INTO contact_outcome(id,plant_id,person_id,task_id,obligation_id,outcome,occurred_at,
		recorded_at,completes_task) VALUES(${id},${p.id},${personId},${on?.taskId ?? null},${on?.id ?? null},${kind},
		${occurred}::timestamptz,${occurred}::timestamptz,${on !== null})`);
}
const lastContact = async (p: Plant, personId: string) =>
	ok(
		await gatedTransaction(c.db, (t) =>
			followUpReader.listContactHistory(t, p.a.actor, { personId, limit: 25, page: 1 }),
		),
	).lastConfirmedContactAt;

test("AC:PI-TASK-CONTACT-001 an administrative completion within 48 hours is a task success, never a contact, and a waived task leaves the ratio", async () => {
	const k = K("PI-TASK-CONTACT-001");
	const v = <T,>(name: string) => (givenOf(k)[name] as unknown as { value: T }).value;
	const readAt = createFacts({ clock: frozenClock(instant.parse(v<string>("asOf"))) });
	for (const variant of [
		{ outcome: v<string>("typedHumanOutcome"), expected: expectedOf(k) },
		...(k.subcases ?? []).map((s) => ({
			outcome: s.action.arguments.outcome as string,
			expected: s.expected.result as Json,
		})),
	]) {
		const p = await plantOf();
		const P = await person(p, "P", { fixture_type: "person", classification: "adult" });
		const Q = await person(p, "Q", { fixture_type: "person", classification: "adult" });
		await outcomeAt(p, P, "contacted", v<string>("PersonPPreviousContact"));
		assert.equal(v<string | null>("PersonQPreviousContact"), null);
		const meeting = await heldMeeting(p, "2026-10-12T14:00:00Z");
		const waived = variant.outcome === "no_longer_needed";
		const task = await followUpAt(
			p,
			meeting,
			P,
			v<string>("originStart"),
			waived ? "no_longer_needed" : "complete",
			v<string>("actualSuccessfulTaskCompletion"),
		);
		await outcomeAt(p, P, variant.outcome, v<string>("actualSuccessfulTaskCompletion"), task);
		if (v<boolean>("providerAcceptedReceipt")) {
			const communication = randomUUID();
			const at = v<string>("actualSuccessfulTaskCompletion");
			await c.admin
				.execute(sql`INSERT INTO communication (id,plant_id,author_id,revision,state,subject,body_html,body_text,
				audience,created_at) VALUES(${communication},${p.id},${p.a.id},1,'reviewed','Hello','<p>Hello</p>','Hello',
				'{"groups":[],"teamIds":[],"personIds":[]}',${at})`);
			await c.admin.execute(sql`INSERT INTO mail (id,tenant_id,recipient_person_id,purpose,communication_id,logical_key,
				payload_hash,audience_hash,state,created_at,accepted_at,sent_at) VALUES(gen_random_uuid(),${p.id},${Q},
				'communication',${communication},${"communication/" + communication},'payload','audience','sent',${at},${at},${at})`);
		}
		const contactedBefore = (
			await c.one<{ n: number }>(
				sql`SELECT count(*)::int AS n FROM contact_outcome WHERE plant_id=${p.id} AND outcome='contacted'`,
			)
		).n;
		const f = ok(await untouched(c.admin, () => readAt.readFacts(c.db, p.a.actor, {}))).followUps;
		const contactedAfter = (
			await c.one<{ n: number }>(
				sql`SELECT count(*)::int AS n FROM contact_outcome WHERE plant_id=${p.id} AND outcome='contacted'`,
			)
		).n;
		const got: Json = {
			task_successes: f.onTime,
			task_denominator: f.measured,
			elapsed48HourTaskCompletionRate: f.measured ? f.onTime / f.measured : null,
			contacted_outcomes_added: f.contacted + (contactedAfter - contactedBefore),
			P_contact: await lastContact(p, P),
			Q_contact: await lastContact(p, Q),
		};
		matches(got, variant.expected, `${k.id} ${variant.outcome}`);
		if (waived) assert.equal(f.noLongerNeeded, 1);
	}
});

test("AC:PI-PURPOSE-001 retained interviews, 4 C's scores, notes and a private check-in reach the facts and the model only as a count and a date", async () => {
	const k = K("PI-PURPOSE-001");
	const input = givenOf(k)["case-input"] as unknown as {
		human_four_cs: [number, number, number, number];
		human_interview_result: string;
		note: string;
		interview_date: string;
		recorded_count: number;
		private_care_present: boolean;
	};
	const p = await plantOf();
	const who = await person(p, "interviewed", {
		fixture_type: "person",
		classification: "adult",
		commitments: [{ kind: "core_group", occurred_on: "2026-10-08", active: true }],
	});
	const interview = randomUUID(),
		four = randomUUID();
	await record(interview, "interview", p.id);
	await record(four, "four_cs", p.id);
	await c.admin
		.execute(sql`INSERT INTO interview(id,plant_id,person_id,interviewed_on,recorded_at,maturity,gifted,chemistry,
		right_reasons,season,maturity_notes,result) VALUES(${interview},${p.id},${who},${input.interview_date},clock_timestamp(),
		'pass','pass','pass','pass','pass',${input.note},${input.human_interview_result})`);
	const [committed, compelled, contagious, courageous] = input.human_four_cs;
	await c.admin
		.execute(sql`INSERT INTO four_cs(id,plant_id,person_id,assessed_on,recorded_at,committed,compelled,contagious,
		courageous,committed_notes) VALUES(${four},${p.id},${who},${input.interview_date},clock_timestamp(),${committed},
		${compelled},${contagious},${courageous},${input.note})`);
	const before = await readOf(p);
	if (input.private_care_present) await checkIn(p);
	const r = await readOf(p);
	const run = await snapshot(p);
	const { model_input } = await c.one<{ model_input: Json }>(
		sql`SELECT model_input FROM assessment_run WHERE id=${run.id}`,
	);
	const texts = [JSON.stringify(r), JSON.stringify(model_input)];
	const shown = (needle: string) => (texts.some((t) => t.includes(needle)) ? needle : null);
	const scored = texts.some((t) => /"(compelled|contagious|courageous)"\s*:/.test(t));
	matches(
		{
			recorded_human_interview_count: r.humanRecords.interviews.count,
			latest_interview_occurrence_date: r.humanRecords.interviews.latestOn,
			human_scores: scored ? input.human_four_cs : null,
			human_judgment: shown(`"${input.human_interview_result}"`),
			notes: shown(input.note),
			private_care: shown(CANARY) ?? shown("struggling"),
			private_care_existence: r.sourceRevision === before.sourceRevision ? null : "changed",
		},
		expectedOf(k),
		k.id,
	);
	assert.equal(input.recorded_count, r.humanRecords.interviews.count);
	const interviews = (model_input as { facts: { key: string; value: unknown }[] }).facts.filter((f) =>
		f.key.startsWith("humanRecords.interviews"),
	);
	assert.deepEqual(
		interviews.map((f) => [f.key, f.value]),
		[
			["humanRecords.interviews", 1],
			["humanRecords.interviewsLatestOn", input.interview_date],
		],
	);
});

test("AC:PI-PHASE6-001 in phase 6 a measured Vision follow-up rate and named launch guests read as measured while the post-launch rate with no approved origin stays absent, never zero", async () => {
	const k = K("PI-PHASE6-001");
	const v = <T,>(name: string) => (givenOf(k)[name] as unknown as { value: T }).value;
	const p = await plantOf({ phase: v<number>("phase") });
	const guest = async (label: string) => person(p, label, { fixture_type: "person", classification: "adult" });
	const contact = await guest("contact");
	const meeting = await heldMeeting(p, "2026-10-10T14:00:00Z");
	const task = await followUpAt(p, meeting, contact, "2026-10-10T16:00:00Z", "complete", "2026-10-11T10:00:00Z");
	await outcomeAt(p, contact, "contacted", "2026-10-11T10:00:00Z", task);
	await c.admin
		.execute(sql`INSERT INTO launch(plant_id,status,target_date,actual_date,outcome_recorded_at,outcome_recorded_by)
		VALUES(${p.id},'completed','2026-09-27','2026-09-27','2026-09-28T16:00:00Z',${p.a.id})`);
	for (let i = 0; i < v<number>("LaunchNamedGuests"); i++) {
		const id = await guest(`launch guest ${i + 1}`);
		await c.admin.execute(
			sql`INSERT INTO launch_guest(plant_id,person_id,recorded_by) VALUES(${p.id},${id},${p.a.id})`,
		);
	}
	assert.equal(v<null>("approved_postlaunch_origin"), null);
	const r = await readOf(p);
	const { plan } = ok(await createLaunchReader(frozenClock(instant.parse(AS_OF))).readPlan(c.db, p.a.actor));
	const adapter = Object.values(READ_DOMAINS)
		.flat()
		.find((a) => a.operation === "intelligence.readExitCriteria") as ReadAdapter<unknown>;
	const exit = await invokeRead(c.db, evryActor(p.a.actor), adapter, adapter.input.parse({}));
	const { phase } = await c.one<{ phase: number }>(sql`SELECT phase FROM plant WHERE id=${p.id}`);
	const rate = r.followUps.measured ? r.followUps.onTime / r.followUps.measured : null;
	assert.deepEqual([rate, plan.guests.count], [v<number>("Vision48hCompletionRate"), v<number>("LaunchNamedGuests")]);
	const postlaunch = exit.rows.filter((row) => row.kind !== "phase");
	matches({ phase, unknown_is_zero: postlaunch.length > 0 }, expectedOf(k), k.id);
	assert.deepEqual(
		exit.rows.map((row) => [row.kind, row.id]),
		[["phase", "6"]],
	);
});
