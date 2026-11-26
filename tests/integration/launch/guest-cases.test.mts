import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
import type { DebriefAnswers, Plan } from "../../../packages/contracts/src/launch/index.ts";
import {
	authorizeLaunchNotices,
	createLaunchReader,
	createLaunchWriter,
} from "../../../packages/domain/src/launch/index.ts";
import { PeopleReadContext, withPeopleWrite } from "../../../packages/domain/src/people/core.ts";
import { peopleMerge } from "../../../packages/domain/src/people/index.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { seatedNotificationService } from "../../../packages/domain/src/jobs/seated-notifications.ts";
import { launchNotices } from "../../../apps/web/src/features/launch/notices.ts";
import { fixture } from "../identity/invitations-support.mts";
import { ok, raced, refused, type Workspace } from "../../support/fixture.mts";
import { failingWrite, recorded, untouched } from "../../support/recorded.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string; zone: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/launch.json", import.meta.url), "utf8"),
) as {
	cases: Case[];
};
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const given = (c: Case, name: string) => c.given[name] ?? assert.fail(`no fixture ${name} in ${c.id}`);
const NOW = new Date(caseOf("LAUNCH46-001").clock.now).toISOString();
const CLOCK = frozenClock(instant.parse(NOW));

let f: Awaited<ReturnType<typeof fixture>>;
let reader: ReturnType<typeof createLaunchReader>;
let writer: ReturnType<typeof createLaunchWriter>;
type Row = Record<string, unknown>;
const rows = async <R extends Row = Row>(q: SQL) => (await f.admin.execute<R>(q)).rows;
const one = async <R extends Row = Row>(q: SQL) => (await rows<R>(q))[0]!;
const key = () => randomUUID();
type Seated = Awaited<ReturnType<typeof seated>>;

async function seated(w: Workspace, role: "owner" | "admin" | "member", email?: string) {
	const a = await f.account("active", email);
	await f.seat(a, w, role);
	return { ...a, actor: await f.actor(a.session) };
}
async function church(planned: string | null, timezone = "America/Chicago") {
	const w = await f.workspace("plant");
	await f.admin.execute(sql`UPDATE plant SET name='Harvest Point', timezone=${timezone} WHERE id=${w.id}`);
	const owner = await seated(w, "owner");
	const admin = await seated(w, "admin");
	const member = await seated(w, "member");
	if (planned) ok(await move(owner, planned, null, "1"));
	return { w, owner, admin, member };
}
const plan = async (who: Seated) => ok(await reader.readPlan(f.db, who.actor)).plan;
const move = (who: Seated, date: string, reason: string | null, expectedRevision: string) =>
	writer.schedule(f.db, who.actor, { requestKey: key(), expectedRevision, input: { date, reason } });
const record = (who: Seated, input: Row, expectedRevision: string) =>
	writer.recordOutcome(f.db, who.actor, {
		requestKey: key(),
		expectedRevision,
		input: { attendance: null, decisions: null, note: null, ...input },
	});
async function launched(L: Row, attendance: number | null = null) {
	const c = await church(String(L.planned_date));
	ok(await record(c.owner, { actualDate: L.actual_date, attendance }, (await plan(c.owner)).revision));
	return c;
}
const guest = (who: Seated, input: Row, requestKey: string = key()) =>
	writer.addGuestAttendance(f.db, who.actor, { requestKey, input });
const BLANK = {
	wentWell: null,
	toChange: null,
	operations: null,
	followUpPlan: null,
	supportNeeded: null,
	missingNames: null,
	missingCount: null,
};
const debrief = (who: Seated, p: Plan, answers: Partial<DebriefAnswers>, submit = true) =>
	writer[submit ? "submitDebrief" : "saveDebriefDraft"](f.db, who.actor, {
		requestKey: key(),
		expectedRevision: p.debrief!.draft?.revision ?? "0",
		input: { draftId: p.debrief!.draft?.id ?? null, answers: { ...BLANK, ...answers } },
	});
async function person(w: { id: string }, name: string, stage = "prospect") {
	const id = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,first_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${w.id},${w.id},${name},${name},'other',${stage},'adult','unknown','1','live',clock_timestamp())`);
	return id;
}
type Footprint = Record<
	| "people"
	| "links"
	| "accounts"
	| "seats"
	| "invitations"
	| "commitments"
	| "tasks"
	| "meetings"
	| "published"
	| "mail"
	| "notices"
	| "phase",
	number
>;
const footprint = (w: { id: string }) =>
	one<Footprint>(sql`SELECT (SELECT count(*)::int FROM person WHERE tenant_id=${w.id}) people,
		(SELECT count(*)::int FROM launch_guest WHERE plant_id=${w.id}) links,
		(SELECT count(*)::int FROM account) accounts,
		(SELECT count(*)::int FROM seat WHERE plant_id=${w.id}) seats,
		(SELECT count(*)::int FROM invitation) invitations,
		(SELECT count(*)::int FROM commitment c JOIN person p ON p.id=c.person_id WHERE p.tenant_id=${w.id}) commitments,
		(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM meeting WHERE plant_id=${w.id}) meetings,
		(SELECT count(*)::int FROM launch_summary WHERE plant_id=${w.id} AND published_at IS NOT NULL) published,
		(SELECT count(*)::int FROM mail WHERE tenant_id=${w.id}) mail,
		(SELECT count(*)::int FROM notice WHERE tenant_id=${w.id}) notices,
		(SELECT phase FROM plant WHERE id=${w.id}) phase`);
const linked = (p: Plan) => p.guests.named!.map((g) => g.personId);
const named = (p: Plan) => p.guests.named!.map((g) => g.displayName);

before(async () => {
	f = await fixture({ clock: new Date(NOW) });
	const mail = createMailService({
		db: f.db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "launch@example.test",
		authorize: authorizeLaunchNotices,
		transport: {
			async send() {
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	reader = createLaunchReader(CLOCK);
	writer = createLaunchWriter({ notices: launchNotices(seatedNotificationService(mail)), clock: CLOCK });
});
after(() => f?.close());

test("AC:LAUNCH46-001 Launch Sunday held on Oct 11 keeps the planned Oct 10 beside it and makes no meeting", async () => {
	const c = caseOf("LAUNCH46-001");
	const L = given(c, "L");
	const ch = await church(String(L.planned_date));
	const before = await footprint(ch.w);
	const { revision } = await plan(ch.owner);
	const { value, added } = await recorded(f.admin, () =>
		record(ch.owner, { actualDate: L.actual_date, attendance: 40 }, revision),
	);
	ok(value);
	assert.deepEqual(added, { audits: ["launch.outcome_recorded"], jobs: [], notices: 0, mail: 0 });
	const read = await recorded(f.admin, () => plan(ch.member));
	assert.deepEqual(read.added, { audits: [], jobs: [], notices: 0, mail: 0 });
	const p = read.value;
	const after = await footprint(ch.w);
	assert.deepEqual(
		{
			actual_date: p.outcome!.actualDate,
			planned_date: p.launch!.targetDate,
			meeting_rows_created: after.meetings - before.meetings,
		},
		c.expected.result,
	);
	assert.equal(p.launch!.status, "completed");
	assert.deepEqual(
		await one(sql`SELECT actual_date::text actual, target_date::text planned FROM launch WHERE plant_id=${ch.w.id}`),
		{ actual: L.actual_date, planned: L.planned_date },
	);
	assert.equal(
		(await one<{ n: number }>(sql`SELECT count(*)::int n FROM meeting WHERE plant_id=${ch.w.id}`)).n,
		0,
		"no public_launch or Vision meeting stands in for Launch Sunday",
	);
	assert.equal(c.expected.event, null);
});

for (const [id, fixtureName, marker] of [
	["B02-023", "launch-inputs", "AC:B02-023 "],
	["LAUNCH46-003", "L", "AC:LAUNCH46-003 "],
] as const)
	test(`${marker}one supplied name makes one real Person with no phone, email, surname, age, account or commitment`, async () => {
		const c = caseOf(id);
		const input = given(c, fixtureName);
		const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" });
		const before = await footprint(ch.w);
		const { value, added } = await recorded(f.admin, () => guest(ch.owner, { displayName: input.name }));
		const p = ok(value).plan;
		assert.deepEqual(added, { audits: ["launch.changed", "people.created"], jobs: [], notices: 0, mail: 0 });
		const [personId] = linked(p);
		const row = await one(sql`SELECT display_name,first_name,last_name,email,phone,linked_account_id,birth_date,
			adult_classification,stage,source,
			(SELECT coalesce(array_agg(k.id),'{}') FROM commitment k WHERE k.person_id=p.id) commitments
			FROM person p WHERE p.id=${personId}`);
		const after = await footprint(ch.w);
		assert.deepEqual(
			{ ...after, people: after.people - 1, links: after.links - 1 },
			before,
			"one Person and one link, nothing else",
		);
		assert.deepEqual(
			[row.birth_date, row.adult_classification, row.stage, row.source],
			[null, "unknown", "attendee", "event"],
		);
		const result =
			id === "B02-023"
				? {
						person_name: row.display_name,
						phone: row.phone,
						email: row.email,
						created_accounts: after.accounts - before.accounts,
						commitments: (row.commitments as string[]).length,
					}
				: {
						name: row.display_name,
						last_name: row.last_name,
						account: row.linked_account_id,
						commitments: row.commitments,
					};
		assert.deepEqual(result, c.expected.result);
		assert.equal(input.phone, null);
		assert.equal(input.email, null);
		assert.equal(c.expected.event, null);
	});

test("AC:B02-024 picking the same-name candidate links its own id; a repeat and a named create under the same key add nobody", async () => {
	const c = caseOf("B02-024");
	const input = given(c, "launch-inputs");
	const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" });
	const alex = await person(ch.w, String(input.name));
	const candidates = ok(await reader.suggestGuests(f.db, ch.owner.actor, String(input.name)));
	assert.deepEqual(
		candidates.map((m) => [m.personId, m.alreadyGuest]),
		[[alex, false]],
	);
	const before = await footprint(ch.w);
	const requestKey = String(input.request_key) + randomUUID().slice(0, 8);
	const saves = [];
	for (let n = 0; n < Number(input.repeat); n++) saves.push(ok(await guest(ch.owner, { personId: alex }, requestKey)));
	assert.deepEqual(
		saves.map((s) => s.outcome),
		["changed", "changed"],
	);
	refused(await guest(ch.owner, { displayName: input.name }, requestKey), "idempotency_conflict");
	const after = await footprint(ch.w);
	const p = await plan(ch.owner);
	assert.deepEqual(
		{
			guest_person: linked(p)[0] === alex ? input.existing_person : linked(p)[0],
			new_people: after.people - before.people,
			guest_links: after.links - before.links,
		},
		c.expected.result,
	);
	assert.deepEqual(
		ok(await reader.suggestGuests(f.db, ch.owner.actor, String(input.name))).map((m) => m.alreadyGuest),
		[true],
	);
	assert.equal(c.expected.event, null);
});

test("AC:B02-025 a submitted Yes with two missing leaves the guest criterion not met beside headcount 40 and 10 named, with no made-up People", async () => {
	const c = caseOf("B02-025");
	const input = given(c, "launch-inputs");
	const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" }, Number(input.headcount));
	for (let i = 1; i <= Number(input.named_guests); i++) ok(await guest(ch.owner, { displayName: `Guest ${i}` }));
	const before = await footprint(ch.w);
	let p = await plan(ch.owner);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "unknown", remaining: null });
	p = ok(
		await debrief(ch.owner, p, {
			missingNames: input.missing_names ? "yes" : "no",
			missingCount: Number(input.missing_count),
		}),
	).plan;
	const shown = await plan(ch.member);
	assert.deepEqual([shown.outcome!.attendance, shown.guests.count], [input.headcount, input.named_guests]);
	assert.equal(shown.evidence.debriefDone.status, "met");
	const after = await footprint(ch.w);
	assert.deepEqual(
		{
			remaining: shown.evidence.guestNamesEntered.remaining,
			guest_criterion: shown.evidence.guestNamesEntered.status,
			fabricated_people: after.people - before.people,
		},
		c.expected.result,
	);
	const no = ok(await debrief(ch.owner, p, { missingNames: "no" })).plan;
	assert.deepEqual(no.evidence.guestNamesEntered, { status: "met", remaining: null });
	assert.deepEqual([no.outcome!.attendance, no.guests.count], [input.headcount, input.named_guests]);
	assert.equal((await footprint(ch.w)).people, before.people);
	assert.equal(c.expected.event, null);
});

test("AC:LAUNCH46-002 a failed guest link leaves no Person; a new name makes one Person and one link and a picked Person makes only a link", async () => {
	const c = caseOf("LAUNCH46-002");
	const L = given(c, "L");
	assert.deepEqual([L.existing_person, L.fault_control], [null, "guest_link_insert"]);
	const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" });
	const start = await footprint(ch.w);
	const failure = await failingWrite(f.admin, { on: "launch_guest", event: "INSERT" }, () =>
		untouched(f.admin, () =>
			guest(ch.owner, { displayName: L.name }).then(
				(r) => assert.fail(`the guest link should fail, got ${JSON.stringify(r)}`),
				(e: unknown) => e,
			),
		),
	);
	assert.match(String((failure as { cause?: unknown }).cause ?? failure), /injected fault/);
	const faulted = await footprint(ch.w);
	const created = ok(await guest(ch.owner, { displayName: L.name })).plan;
	const made = await footprint(ch.w);
	assert.deepEqual(
		{
			created_people: made.people - faulted.people,
			created_links: made.links - faulted.links,
			fault_created_people: faulted.people - start.people,
		},
		c.expected.result,
	);
	assert.equal(
		(
			await one<{ n: number }>(
				sql`SELECT count(*)::int n FROM person WHERE tenant_id=${ch.w.id} AND display_name=${L.name}`,
			)
		).n,
		1,
	);
	const existing = await person(ch.w, "Alex Kim");
	const ready = await footprint(ch.w);
	const picked = ok(await guest(ch.owner, { personId: existing })).plan;
	const after = await footprint(ch.w);
	assert.deepEqual(
		[after.people - ready.people, after.links - ready.links],
		[0, 1],
		"a picked Person gets only a link",
	);
	assert.deepEqual(linked(picked).sort(), [...linked(created), existing].sort());
	const elsewhere = await church(null);
	refused(await guest(ch.owner, { personId: await person(elsewhere.w, "Alex Kim") }), "access_denied");
	assert.equal((await footprint(ch.w)).links, after.links);
	assert.equal(c.expected.event, null);
});

test("AC:LAUNCH46-004 two Alexes stay two; the picked Alex-2 is linked once through a repeat and a concurrent insert", async () => {
	const c = caseOf("LAUNCH46-004");
	const L = given(c, "L");
	const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" });
	const alex1 = await person(ch.w, String(L.name));
	const alex2 = await person(ch.w, String(L.name));
	const label = new Map<string, unknown>([
		[alex1, "Alex-1"],
		[alex2, String(L.selected_existing)],
	]);
	const candidates = ok(await reader.suggestGuests(f.db, ch.owner.actor, String(L.name)));
	assert.deepEqual(candidates.map((m) => m.personId).sort(), [alex1, alex2].sort(), "same name is never merged");
	const before = await footprint(ch.w);
	const keys = [key(), key()];
	const [first, second] = await raced(
		f.admin,
		f.db,
		sql`SELECT 1 FROM launch WHERE plant_id=${ch.w.id} FOR UPDATE`,
		keys.map((k) => () => guest(ch.owner, { personId: alex2 }, k)) as [
			() => ReturnType<typeof guest>,
			() => ReturnType<typeof guest>,
		],
	);
	assert.deepEqual([ok(first).outcome, ok(second).outcome].sort(), ["changed", "noop"]);
	const repeats = [];
	for (let n = 0; n < Number(L.repeat); n++)
		repeats.push(ok(await guest(ch.owner, { personId: alex2 }, keys[0])).outcome);
	assert.deepEqual(repeats, Array(Number(L.repeat)).fill(ok(first).outcome), "a repeat answers as the first did");
	const after = await footprint(ch.w);
	const p = await plan(ch.owner);
	assert.deepEqual(
		{
			person: label.get(linked(p)[0]!),
			new_people: after.people - before.people,
			links: after.links - before.links,
		},
		c.expected.result,
	);
	assert.deepEqual(linked(p), [alex2]);
	assert.equal((await one<{ n: number }>(sql`SELECT count(*)::int n FROM launch_guest WHERE person_id=${alex1}`)).n, 0);
	assert.equal(c.expected.event, null);
});

test("AC:LAUNCH46-005 headcount 100, 20 named guests and 3 reported missing stay separate, with no placeholder People", async () => {
	const c = caseOf("LAUNCH46-005");
	const L = given(c, "L");
	const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" }, Number(L.headcount));
	const before = await footprint(ch.w);
	for (const name of L.named_people as string[]) ok(await guest(ch.owner, { displayName: name }));
	ok(await debrief(ch.owner, await plan(ch.owner), { missingNames: "yes", missingCount: Number(L.reported_missing) }));
	const p = await plan(ch.owner);
	const people = await rows<{ display_name: string }>(
		sql`SELECT display_name FROM person WHERE tenant_id=${ch.w.id} ORDER BY created_at, display_name`,
	);
	const after = await footprint(ch.w);
	assert.deepEqual(
		{
			headcount: p.outcome!.attendance,
			named_count: p.guests.count,
			reported_missing: p.debrief!.submitted!.answers.missingCount,
			placeholder_people: after.people - before.people - (L.named_people as string[]).length,
		},
		c.expected.result,
	);
	assert.deepEqual(people.map((r) => r.display_name).sort(), [...(L.named_people as string[])].sort());
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: L.reported_missing });
	assert.equal(c.expected.event, null);
});

test("AC:LAUNCH46-022 merging guest Alex-2 into Alex-1 leaves one active link, and headcount 40 and missing 3 stay as reported", async () => {
	const c = caseOf("LAUNCH46-022");
	const L = given(c, "L");
	const ch = await launched({ planned_date: "2026-10-10", actual_date: "2026-10-11" }, Number(L.headcount));
	const ids = new Map<string, string>();
	for (const label of L.people as string[]) ids.set(label, await person(ch.w, "Alex Kim"));
	for (const label of L.links as string[]) ok(await guest(ch.owner, { personId: ids.get(label) }));
	ok(await debrief(ch.owner, await plan(ch.owner), { missingNames: "yes", missingCount: Number(L.missing_count) }));
	const survivor = ids.get(String(L.merge_survivor))!;
	const source = [...ids.values()].find((id) => id !== survivor)!;
	const read = <T,>(body: (tx: WriteTx, ctx: PeopleReadContext) => Promise<T>) =>
		gatedTransaction(f.db, (t) => body(t, new PeopleReadContext(ch.owner.actor)));
	const review = ok(
		await read((t, ctx) => peopleMerge.getMergeReview(t, ctx, { sourceId: source, survivorId: survivor })),
	);
	ok(
		await withPeopleWrite(f.db, ch.owner.actor, (t, ctx) =>
			peopleMerge.mergePeople(t, ctx, {
				requestKey: key(),
				input: { sourceId: source, survivorId: survivor, reviewDigest: review.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	const p = await plan(ch.owner);
	const byId = new Map([...ids].map(([label, id]) => [id, label]));
	assert.deepEqual(
		{
			active_links: linked(p).map((id) => byId.get(id)),
			headcount: p.outcome!.attendance,
			missing_count: p.debrief!.submitted!.answers.missingCount,
		},
		c.expected.result,
	);
	assert.equal(p.guests.count, 1);
	assert.deepEqual(p.evidence.guestNamesEntered, { status: "not_met", remaining: L.missing_count });
	assert.equal(
		(await one<{ n: number }>(sql`SELECT count(*)::int n FROM launch_guest WHERE plant_id=${ch.w.id}`)).n,
		(L.links as string[]).length,
		"the merged Person's link stays as history",
	);
	assert.equal(c.expected.event, null);
});

test("AC:CASE-LCH-006 the held date sits apart from the plan, Jamie is one new linked guest, a Yes 3 debrief meets only the debrief, and no summary, task or message follows", async () => {
	const c = caseOf("CASE-LCH-006");
	const input = given(c, "case-input");
	const L = given(c, "L");
	const ch = await church(String(L.planned_date));
	const Q = await church(null, String(given(c, "Q").timezone));
	const casey = await seated(Q.w, "admin", String(given(c, "B").email));
	const alex = await person(ch.w, String(given(c, "Alex").first_name), String(given(c, "Alex").stage));
	const alexRow = sql`SELECT stage,revision::text,display_name FROM person WHERE id=${alex}`;
	const alexBefore = await one(alexRow);
	let p = await plan(ch.owner);
	ok(await move(ch.owner, String(input.planned_date), "Moved up for the school calendar", p.launch!.revision));
	p = await plan(ch.owner);
	assert.deepEqual([p.launch!.status, p.launch!.targetDate, p.today], ["scheduled", input.planned_date, "2026-10-13"]);
	refused(await record(ch.owner, { actualDate: "2026-10-14" }, p.revision), "invalid_outcome");
	const untouchedP = await footprint(ch.w);
	refused(await record(casey, { actualDate: input.actual_date }, p.revision), "not_ready");
	assert.deepEqual(await footprint(ch.w), untouchedP, "another church's Admin acts only on their own launch");
	assert.equal((await plan(casey)).outcome, null);
	refused(await record(ch.owner, { actualDate: input.actual_date }, String(Number(p.revision) - 1)), "conflict");
	const before = await footprint(ch.w);
	p = ok(await record(ch.owner, { actualDate: input.actual_date, attendance: 40 }, p.revision)).plan;
	p = ok(await guest(ch.owner, { displayName: input.new_guest_name })).plan;
	p = ok(
		await debrief(ch.owner, p, {
			wentWell: "Worship",
			missingNames: String(input.debrief_answer).toLowerCase() as "yes",
			missingCount: Number(input.debrief_count),
		}),
	).plan;
	p = ok(
		await writer.saveDebriefSummaryDraft(f.db, ch.owner.actor, {
			requestKey: key(),
			expectedRevision: "0",
			input: { draftId: null, body: "Launch Sunday was held." },
		}),
	).plan;
	const after = await footprint(ch.w);
	assert.deepEqual(
		{
			actual_date: p.outcome!.actualDate,
			people_added: after.people - before.people,
			guest_links_added: after.links - before.links,
			guest_criterion: p.evidence.guestNamesEntered.status,
			debrief_criterion: p.evidence.debriefDone.status,
			summary_published: p.summary!.published.length > 0 || after.published > 0,
			tasks_created: after.tasks - before.tasks,
			messages_sent: after.mail - before.mail + after.notices - before.notices,
		},
		c.expected.result,
	);
	assert.equal(p.launch!.targetDate, input.planned_date, "the planned date stays as it was");
	assert.deepEqual(named(p), [input.new_guest_name]);
	assert.deepEqual(p.evidence.guestNamesEntered.remaining, input.debrief_count);
	assert.deepEqual(await one(alexRow), alexBefore, "Alex is not touched");
	assert.equal(after.phase, before.phase);
	assert.equal(c.expected.event, null);
});
