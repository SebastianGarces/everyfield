import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { instant } from "../../../packages/contracts/src/common/index.ts";
import type { CareArea, CareReply } from "../../../packages/contracts/src/intelligence/index.ts";
import type { DeletionRequest } from "../../../packages/domain/src/settings/deletion.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { fixture, type Fixture } from "../identity/invitations-support.mts";
import {
	captureFacts,
	createPrivateCare,
	personalCalendar,
	type PrivateCare,
} from "../../../packages/domain/src/intelligence/index.ts";
import { closeDatabase, createDatabase } from "../../../packages/db/src/client.ts";
import {
	createLifecycleCleanup,
	deletionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";
import { createSeatService } from "../../../packages/domain/src/identity/index.ts";
import { teamsReader, teamsWriter, withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";
import { accountPersonProducer, peopleMerge, peopleWriter } from "../../../packages/domain/src/people/index.ts";
import { enqueueJob, queueJobs } from "../../../packages/domain/src/jobs/queue.ts";
import { nextMonday } from "../../../apps/web/src/components/time.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	readConversation,
	readReview,
	runTurn,
	submitTurn,
} from "../../../packages/evry/src/index.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { probing, type Call } from "./probing-model.mts";
import { READ_DOMAINS, readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { ok, refusedWith } from "../../support/fixture.mts";
import { recorded } from "../../support/recorded.mts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { caseOf, type Case } from "../target/sql/core/support.mts";

let f: Fixture;
let care: PrivateCare;
let tz: ReturnType<typeof timezoneOperations>;
let deletion: ReturnType<typeof deletionOperations>;
type Workspace = Awaited<ReturnType<Fixture["workspace"]>>;
type Seated = Awaited<ReturnType<typeof seated>>;
type Answers = Record<"spiritual" | "family" | "financial" | "pace", string>;
let now = "2026-10-13T16:00:00.000Z";
const clock = { now: () => instant.parse(now) };
const refusedBare = refusedWith({ details: {} });
const bare = <T,>(r: CareReply<T>) =>
	r.status === "refused" ? { ...r, error: { ...r.error, correlationId: null } } : r;
const rows = async <T extends Record<string, unknown>>(q: SQL) => (await f.admin.execute<T>(q)).rows;
const one = async <T extends Record<string, unknown>>(q: SQL) => (await rows<T>(q))[0]!;
const root = fileURLToPath(new URL("../../../", import.meta.url));
const rejects = (promise: Promise<unknown>, pattern: RegExp) =>
	assert.rejects(promise, (e) => {
		assert.ok(e instanceof Error);
		assert.match(e.cause instanceof Error ? e.cause.message : e.message, pattern);
		return true;
	});
const NOTHING = { audits: [], jobs: [], notices: 0, mail: 0 };
const levels = (spiritual: string, family: string, financial: string, pace: string): Answers => ({
	spiritual,
	family,
	financial,
	pace,
});
const STEADY = levels("steady", "steady", "steady", "steady");
const STRAINED = levels("strained", "steady", "strained", "strained");

async function seated(
	w: Workspace,
	role: "owner" | "admin" | "member" = "admin",
	zone: string | null = "America/Chicago",
) {
	const a = await f.account();
	await f.seat(a, w, role);
	if (zone) await f.admin.execute(sql`UPDATE account SET personal_timezone=${zone} WHERE id=${a.id}`);
	return { ...a, w, actor: await f.actor(a.session) };
}
const current = (who: Seated, raw: unknown = {}) => care.readCurrent(f.db, who.actor, raw);
const history = (who: Seated, page = 1) => care.readHistory(f.db, who.actor, { page });
const trends = (who: Seated) => care.readTrends(f.db, who.actor, {});
const save = (who: Seated, answers: Answers, expectedRevision: string, note = "", requestKey: string = randomUUID()) =>
	care.save(f.db, who.actor, { requestKey, expectedRevision, input: { answers, note } });
const correct = (
	who: Seated,
	weekId: string | null,
	answers: Answers,
	expectedRevision: string,
	note = "",
	requestKey: string = randomUUID(),
) => care.correct(f.db, who.actor, { requestKey, expectedRevision, input: { weekId, answers, note } });
const revisionOf = async (who: Seated) => ok(await current(who)).revision;
async function saveAt(who: Seated, at: string, answers = STEADY, note = "") {
	now = at;
	return ok(await save(who, answers, await revisionOf(who), note));
}
const footprint = (who: Seated) =>
	one(sql`SELECT (SELECT count(*)::int FROM private_calendar WHERE author_id=${who.id}) calendars,
		(SELECT count(*)::int FROM private_week WHERE author_id=${who.id}) weeks,
		(SELECT count(*)::int FROM private_week_revision WHERE author_id=${who.id}) revisions,
		(SELECT revision::text FROM private_calendar WHERE author_id=${who.id}) revision`);
const accountCtx = (who: Seated) => ({ session: who.session, selected: { kind: "account" as const, id: who.id } });
const plantOf = (w: Workspace) => {
	assert.ok(w.kind === "plant");
	return w;
};
async function previewZone(who: Seated, timeZone: string) {
	return ok(await gatedTransaction(f.db, (tx) => tz.previewPersonalTimezone(tx, accountCtx(who), { timeZone })));
}
function setZone(who: Seated, preview: Awaited<ReturnType<typeof previewZone>>, requestKey: string = randomUUID()) {
	return gatedTransaction(f.db, (tx) =>
		tz.setPersonalTimezone(tx, accountCtx(who), {
			requestKey,
			expectedRevision: preview.expectedRevision,
			input: { timeZone: preview.newZone, previewId: preview.previewId, confirmed: true },
		}),
	);
}
async function changeZone(who: Seated, timeZone: string) {
	return ok(await setZone(who, await previewZone(who, timeZone)));
}
const nextAt = async (who: Seated) =>
	(await one(sql`SELECT to_char(next_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, zone
		FROM private_calendar WHERE author_id=${who.id}`)) ?? null;

before(async () => {
	f = await fixture();
	care = createPrivateCare({ clock });
	const job = (
		tx: Parameters<typeof enqueueJob>[0],
		i: { owner: { id: string }; operationId: string; revision: string },
		kind: Parameters<typeof enqueueJob>[1]["kind"],
	) =>
		enqueueJob(tx, {
			tenant: i.owner.id,
			kind,
			subject: i.owner.id,
			key: `care-test/${kind}/${i.operationId}/${i.revision}`,
			revision: i.revision,
			eligibleAt: new Date().toISOString(),
		});
	tz = timezoneOperations({ replan: (tx, i) => job(tx, i, "digest") }, personalCalendar, clock);
	deletion = deletionOperations({
		queue: (tx, i) =>
			queueJobs(tx, [
				{
					tenant: i.subject.id,
					kind: "lifecycle_purge",
					subject: i.witnessId,
					key: "purge/" + i.requestId,
					revision: i.revision,
					eligibleAt: i.eligibleAt,
				},
			]),
		workspaceNotice: async () => {},
	});
});
after(() => f?.close());

test("AC:B03-021 with no confirmed personal zone, reads and saves ask for it and insert nothing", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "admin", null);
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const untouched = await sideEffects(w);
	refusedBare(await current(a), "personal_timezone_confirmation_required");
	refusedBare(await history(a), "personal_timezone_confirmation_required");
	refusedBare(await trends(a), "personal_timezone_confirmation_required");
	refusedBare(await save(a, STEADY, "0"), "personal_timezone_confirmation_required");
	for (const timeZone of ["UTC", "Europe/London", "America/Chicago"]) {
		refusedBare(await current(a, { timeZone }), "invalid_input");
		refusedBare(await care.readHistory(f.db, a.actor, { page: 1, timeZone }), "invalid_input");
		refusedBare(
			await care.save(f.db, a.actor, {
				requestKey: randomUUID(),
				expectedRevision: "0",
				input: { answers: STEADY, note: "", timeZone },
			}),
			"invalid_input",
		);
	}
	assert.deepEqual(await footprint(a), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	assert.deepEqual(await sideEffects(w), untouched);
	assert.equal((await one(sql`SELECT personal_timezone FROM account WHERE id=${a.id}`)).personal_timezone, null);
	await changeZone(a, "Europe/London");
	const read = ok(await current(a));
	assert.equal(read.zone, "Europe/London");
	assert.equal(read.week.startsOn, "2026-10-12");
});

test("AC:B03-020 the week starts on the Monday of the author's own zone and keeps its id and ordinal", async () => {
	const k = caseOf("intelligence", "B03-020");
	const input = k.action.arguments as { now: string; zones: string[] };
	now = new Date(input.now).toISOString();
	const w = await f.workspace();
	const shown = new Map<string, string>();
	const cases = [
		["America/Chicago", "2026-10-05"],
		["Pacific/Auckland", "2026-10-12"],
		["Pacific/Kiritimati", "2026-10-12"],
		["Pacific/Pago_Pago", "2026-10-05"],
	] as const;
	for (const [zone, monday] of cases) {
		const a = await seated(w, "admin", zone);
		const read = ok(await current(a));
		assert.deepEqual(
			{ zone: read.zone, id: read.week.id, ordinal: read.week.ordinal, startsOn: read.week.startsOn },
			{ zone, id: null, ordinal: 1, startsOn: monday },
		);
		const saved = ok(await save(a, STEADY, read.revision));
		assert.equal(saved.week.startsOn, monday);
		assert.equal(saved.week.endsOn, new Date(Date.parse(monday) + 6 * 86_400_000).toISOString().slice(0, 10));
		assert.equal(saved.week.zone, zone);
		assert.equal(saved.week.ordinal, 1);
		assert.ok(saved.week.id);
		const again = ok(await current(a));
		assert.equal(again.week.id, saved.week.id);
		const stored = await one(sql`SELECT ordinal,zone,starts_on::text AS starts_on,ends_on::text AS ends_on
			FROM private_week WHERE id=${saved.week.id}`);
		assert.deepEqual(stored, { ordinal: 1, zone, starts_on: monday, ends_on: saved.week.endsOn });
		const page = ok(await history(a));
		assert.deepEqual(
			page.weeks.map((x) => [x.id, x.zone]),
			[[saved.week.id, zone]],
		);
		shown.set(zone, page.weeks[0]!.startsOn);
	}
	assert.deepEqual({ week_starts: input.zones.map((zone) => shown.get(zone)) }, k.expected.result);
});

test("AC:B03-024 AC:PI-CARE-001 a save changes this week only, a same answer adds nothing and a key replays", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w);
	const firstKey = randomUUID();
	const first = ok(await save(a, STRAINED, "0", "Long week.", firstKey));
	assert.equal(first.outcome, "saved");
	assert.equal(first.revision, "1");
	assert.deepEqual(first.week.answer!.answers, STRAINED);
	assert.equal(first.week.answer!.note, "Long week.");
	assert.equal(first.week.startsOn, "2026-10-12");
	assert.equal(first.week.revisions.length, 1);
	const second = ok(await save(a, STEADY, "1"));
	assert.equal(second.week.id, first.week.id);
	assert.equal(second.revision, "2");
	assert.deepEqual(second.week.answer!.answers, STEADY);
	assert.equal(second.week.answer!.note, null);
	assert.deepEqual(
		second.week.revisions.map((r) => r.answers),
		[STRAINED, STEADY],
	);
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 2, revision: "2" });
	const same = ok(await save(a, STEADY, "2", "   "));
	assert.equal(same.outcome, "unchanged");
	assert.equal(same.revision, "2");
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 2, revision: "2" });
	assert.deepEqual(ok(await save(a, STRAINED, "0", "Long week.", firstKey)), first);
	refusedBare(await save(a, STEADY, "0", "", firstKey), "idempotency_conflict");
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 2, revision: "2" });
	refusedBare(await save(a, STRAINED, "1"), "revision_conflict");
	refusedBare(await save(a, { ...STEADY, pace: "fine" }, "2"), "invalid_input");
	refusedBare(await save(a, STEADY, "2", "x".repeat(2001)), "invalid_input");
	assert.equal(ok(await save(a, STEADY, "2", "x".repeat(2000))).week.answer!.note!.length, 2000);
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 1, revisions: 3, revision: "3" });
});

test("AC:B03-022 AC:PI-CARE-003 AC:B03-024 a zone change keeps the open week until the first future Monday of the new zone", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w);
	const saved = ok(await save(a, STRAINED, "0"));
	const stored = () =>
		rows(
			sql`SELECT to_jsonb(w) AS week,to_jsonb(r) AS saved FROM private_week w JOIN private_week_revision r ON r.week_id=w.id WHERE w.author_id=${a.id}`,
		);
	const first = await stored();
	await changeZone(a, "Pacific/Auckland");
	const k24 = caseOf("intelligence", "B03-024");
	const retry = k24.action.arguments as { week: string; request_key: string; repeat: number; new_zone: string };
	const preview = await previewZone(a, retry.new_zone);
	const key = randomUUID();
	const credit = async () => ({
		answers: Number((await footprint(a)).revisions),
		answered: ok(await trends(a)).weeks.filter((x) => x.answer !== null).length,
	});
	const credited = await credit();
	const results: unknown[] = [];
	const { added } = await recorded(f.admin, async () => {
		for (let n = 0; n < retry.repeat; n++) results.push(ok(await setZone(a, preview, key)));
	});
	assert.equal(results.length, 2);
	assert.deepEqual(results[1], results[0]);
	assert.deepEqual(
		added,
		{ ...NOTHING, audits: ["settings.changed"], jobs: ["digest"] },
		"one change, however often sent",
	);
	const open = ok(await current(a));
	assert.equal(open.week.id, saved.week.id);
	assert.equal(open.week.zone, "America/Chicago");
	assert.equal(open.week.startsOn, "2026-10-12");
	assert.deepEqual(open.week.answer!.answers, STRAINED);
	assert.equal((await footprint(a)).weeks, 1);
	assert.equal((await footprint(a)).revisions, 1);
	assert.deepEqual(await stored(), first, "two zone edits rewrite no week, author or revision");
	const { value: unmoved, added: byReading } = await recorded(f.admin, async () => ok(await history(a)));
	assert.deepEqual(byReading, NOTHING);
	assert.deepEqual(
		unmoved.weeks.map((x) => [x.id, x.startsOn, x.zone, x.answer?.answers.spiritual, x.revisions.length]),
		[[saved.week.id, "2026-10-12", "America/Chicago", "strained", 1]],
	);
	assert.equal(nextMonday(preview.asOf, "Pacific/Kiritimati"), "2026-10-19");
	assert.deepEqual(await nextAt(a), { at: "2026-10-18T10:00:00Z", zone: "Pacific/Kiritimati" });
	now = "2026-10-18T09:59:59.000Z";
	assert.equal(ok(await current(a)).week.id, saved.week.id);
	now = "2026-10-18T10:00:00.000Z";
	const late = await recorded(f.admin, async () => ok(await setZone(a, preview, key)));
	assert.deepEqual(late.added, NOTHING, "a retry after the rollover adds nothing");
	assert.deepEqual(late.value, results[0]);
	assert.equal(open.week.startsOn, retry.week);
	const later = await credit();
	assert.deepEqual(
		{
			new_answers: later.answers - credited.answers,
			new_streak_credit: later.answered - credited.answered,
			receipts: (await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${key}`)).n,
		},
		k24.expected.result,
	);
	const next = ok(await current(a)).week;
	assert.deepEqual(
		{ id: next.id, ordinal: next.ordinal, zone: next.zone, startsOn: next.startsOn },
		{ id: null, ordinal: 2, zone: "Pacific/Kiritimati", startsOn: "2026-10-19" },
	);
	const second = ok(await save(a, STEADY, await revisionOf(a)));
	assert.equal(second.week.ordinal, 2);
	const page = ok(await history(a));
	assert.deepEqual(
		page.weeks.map((x) => [x.ordinal, x.zone, x.startsOn, x.id !== null]),
		[
			[2, "Pacific/Kiritimati", "2026-10-19", true],
			[1, "America/Chicago", "2026-10-12", true],
		],
	);
	assert.equal(page.weeks[1]!.id, saved.week.id);
	assert.deepEqual(await footprint(a), { calendars: 1, weeks: 2, revisions: 2, revision: "4" });
});

test("AC:B03-023 a save and a zone change on one calendar give one accepted change and one conflict", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const k = careCase("B03-023");
	const input = k.action.arguments as {
		week: string;
		current_state: string;
		simultaneous: [{ save: string; observed_state: string }, { zone: string; observed_state: string }];
	};
	const [saving, zoning] = input.simultaneous;
	assert.deepEqual([saving.observed_state, zoning.observed_state], [input.current_state, input.current_state]);
	const answer = levels(saving.save.toLowerCase(), "steady", "steady", "steady");
	const STALE: Record<string, string> = { conflict: "revision_conflict", revision_conflict: "revision_conflict" };
	const outcome = async (who: Seated, saved: CareReply<unknown>, zoned: Awaited<ReturnType<typeof setZone>>) => {
		const lost = [saved, zoned].filter((r) => r.status === "refused");
		const weeks = await rows<{ starts_on: string; revisions: number }>(
			sql`SELECT w.starts_on::text AS starts_on,(SELECT count(*)::int FROM private_week_revision r WHERE r.week_id=w.id) AS revisions
				FROM private_week w WHERE w.author_id=${who.id}`,
		);
		assert.deepEqual(
			weeks.map((x) => x.starts_on),
			[input.week],
		);
		const result = {
			accepted_revisions: [saved, zoned].filter((r) => r.status === "ok").length,
			other_error: lost.length === 1 && lost[0]!.status === "refused" ? STALE[lost[0]!.error.code] : null,
			answer_rows_at_most: Math.max(
				weeks.reduce((n, x) => n + x.revisions, 0) - 1,
				k.expected.result.answer_rows_at_most as number,
			),
		};
		assert.deepEqual(result, k.expected.result, JSON.stringify([saved, zoned]));
		assert.equal((await footprint(who)).revision, "2");
	};
	now = new Date(k.clock.now).toISOString();
	const w = await f.workspace();
	const a = await seated(w);
	ok(await save(a, STEADY, "0"));
	const preview = await previewZone(a, zoning.zone);
	const aSaved = await save(a, answer, "1");
	const aZoned = await setZone(a, preview);
	refusedBare(aZoned, "conflict");
	await outcome(a, aSaved, aZoned);
	assert.equal(
		(await one(sql`SELECT personal_timezone FROM account WHERE id=${a.id}`)).personal_timezone,
		"America/Chicago",
	);
	const b = await seated(w);
	ok(await save(b, STEADY, "0"));
	const bZoned = await setZone(b, await previewZone(b, zoning.zone));
	const bSaved = await save(b, answer, "1");
	refusedBare(bSaved, "revision_conflict");
	await outcome(b, bSaved, bZoned);
	for (let i = 0; i < 4; i++) {
		const c = await seated(w);
		ok(await save(c, STEADY, "0"));
		const p = await previewZone(c, zoning.zone);
		const [saved, zoned] = await Promise.all([save(c, answer, "1"), setZone(c, p)]);
		assert.equal([saved, zoned].filter((r) => r.status === "ok").length, 1, JSON.stringify([saved, zoned]));
		if (saved.status === "ok") assert.equal(zoned.status === "refused" && zoned.error.code, "conflict");
		else assert.equal(saved.error.code, "revision_conflict");
		await outcome(c, saved, zoned);
		assert.equal((await footprint(c)).weeks, 1);
	}
});

test("AC:B03-019 a church timezone change never rekeys personal weeks", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "owner", "Pacific/Auckland");
	const b = await seated(w, "admin", "Pacific/Auckland");
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const saved = ok(await save(a, STRAINED, "0"));
	const before = { history: ok(await history(a)), footprint: await footprint(a) };
	const ctx = { session: a.session, selected: plantOf(w) };
	const preview = ok(
		await gatedTransaction(f.db, (tx) =>
			tz.previewPlantTimezone(tx, ctx, { plant: plantOf(w), timeZone: "Europe/London" }),
		),
	);
	const { value: changed, added } = await recorded(f.admin, async () =>
		ok(
			await gatedTransaction(f.db, (tx) =>
				tz.setPlantTimezone(tx, ctx, {
					requestKey: randomUUID(),
					expectedRevision: preview.expectedRevision,
					input: { plant: plantOf(w), timeZone: "Europe/London", previewId: preview.previewId },
				}),
			),
		),
	);
	assert.equal(changed.status, "changed");
	assert.deepEqual(added, { ...NOTHING, audits: ["plant.profile_changed"], jobs: ["digest"] });
	assert.deepEqual(await one(sql`SELECT timezone FROM plant WHERE id=${w.id}`), { timezone: "Europe/London" });
	const { value: after, added: byReading } = await recorded(f.admin, async () => ({
		history: ok(await history(a)),
		footprint: await footprint(a),
	}));
	assert.deepEqual(after, before);
	assert.deepEqual(byReading, NOTHING);
	assert.deepEqual(
		before.history.weeks.map((x) => [x.startsOn, x.zone]),
		[["2026-10-12", "Pacific/Auckland"]],
	);
	assert.equal(before.history.zone, "Pacific/Auckland");
	assert.equal(ok(await current(b)).zone, "Pacific/Auckland");
	const read = ok(await current(a));
	assert.deepEqual(
		{ id: read.week.id, zone: read.week.zone, startsOn: read.week.startsOn, personal: read.zone },
		{ id: saved.week.id, zone: "Pacific/Auckland", startsOn: "2026-10-12", personal: "Pacific/Auckland" },
	);
	assert.deepEqual(await nextAt(a), { at: "2026-10-18T11:00:00Z", zone: "Pacific/Auckland" });
});

test("AC:B03-026 a correction keeps the week, its zone and author and the earlier answer", async () => {
	const k = caseOf("intelligence", "B03-026");
	const input = k.action.arguments as { week: string; old: string; new: string; repeat: number };
	assert.deepEqual([input.old, input.new], ["Strained", "Steady"]);
	const w = await f.workspace();
	const a = await seated(w);
	const audits = async () => (await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${w.id}`)).n;
	const before = await audits();
	const past = await saveAt(a, "2026-09-30T17:00:00.000Z", STRAINED, "Tired.");
	await saveAt(a, "2026-10-13T16:00:00.000Z", STEADY);
	const page = ok(await history(a));
	assert.deepEqual(
		page.weeks.map((x) => [x.startsOn, x.answer?.answers.spiritual ?? null]),
		[
			["2026-10-12", "steady"],
			["2026-10-05", null],
			["2026-09-28", "strained"],
		],
	);
	const revision = page.revision;
	refusedBare(await correct(a, page.weeks[1]!.id, STEADY, revision), "not_found");
	const fixed = ok(await correct(a, past.week.id, STEADY, revision, "Tired."));
	assert.equal(fixed.outcome, "saved");
	assert.deepEqual(
		{ id: fixed.week.id, zone: fixed.week.zone, startsOn: fixed.week.startsOn, current: fixed.week.current },
		{ id: past.week.id, zone: "America/Chicago", startsOn: "2026-09-28", current: false },
	);
	assert.deepEqual(fixed.week.answer!.answers, STEADY);
	assert.deepEqual(
		fixed.week.revisions.map((r) => [r.kind, r.answers.spiritual]),
		[
			["save", "strained"],
			["correction", "steady"],
		],
	);
	const same = ok(await correct(a, past.week.id, STEADY, fixed.revision, "Tired."));
	assert.equal(same.outcome, "unchanged");
	assert.equal(same.revision, fixed.revision);
	refusedBare(await correct(a, past.week.id, STRAINED, revision), "revision_conflict");
	const read = ok(await history(a));
	assert.deepEqual(read.weeks[2], fixed.week);
	const title = (level: string) => level[0]!.toUpperCase() + level.slice(1);
	const kept = read.weeks[2]!;
	assert.deepEqual(
		{
			current: title(kept.answer!.answers.spiritual),
			history: kept.revisions.map((r) => title(r.answers.spiritual)),
			corrections: (
				await one(
					sql`SELECT count(*)::int AS n FROM private_week_revision WHERE week_id=${past.week.id} AND kind='correction'`,
				)
			).n,
			week: kept.startsOn,
		},
		k.expected.result,
	);
	assert.deepEqual(
		[fixed, same].map((x) => x.outcome),
		["saved", ...Array(input.repeat - 1).fill("unchanged")],
	);
	assert.equal(read.weeks[0]!.answer!.revision, 1);
	const stored = await one(
		sql`SELECT author_id,zone,ordinal,starts_on::text AS starts_on FROM private_week WHERE id=${past.week.id}`,
	);
	assert.deepEqual(stored, { author_id: a.id, zone: "America/Chicago", ordinal: 1, starts_on: "2026-09-28" });
	assert.equal(await audits(), before);
	await rejects(f.db.execute(sql`DELETE FROM private_week WHERE id=${past.week.id}`), /permission denied/);
	await rejects(
		f.db.execute(sql`DELETE FROM private_week_revision WHERE week_id=${past.week.id}`),
		/permission denied/,
	);
});

test("AC:B03-035 the strip shows the latest twelve weeks, the thirteenth is on page two, unanswered weeks stay", async () => {
	const k = careCase("B03-035");
	const input = k.action.arguments as { weeks: string[]; page_size: number };
	const w = await f.workspace();
	const a = await seated(w);
	const mondays = input.weeks;
	for (const monday of mondays) await saveAt(a, monday + "T18:00:00.000Z", STEADY);
	now = new Date(k.clock.now).toISOString();
	const strip = ok(await trends(a));
	assert.equal(strip.weeks.length, 12);
	assert.equal(strip.pageCount, 2);
	assert.deepEqual(
		strip.weeks.map((x) => x.startsOn),
		mondays.slice(1).reverse(),
	);
	assert.equal(strip.weeks[0]!.current, true);
	const { support, ...page } = strip;
	assert.equal(support.question, false);
	assert.deepEqual(ok(await history(a, 1)), page);
	const older = ok(await history(a, 2));
	assert.deepEqual(
		older.weeks.map((x) => x.startsOn),
		["2026-07-20"],
	);
	assert.deepEqual(ok(await history(a, 3)).weeks, []);
	assert.equal((await footprint(a)).weeks, 13);
	assert.deepEqual(
		{
			first_page_count: strip.weeks.length,
			older_page_weeks: older.weeks.map((x) => x.startsOn),
			retained_weeks: (await footprint(a)).weeks,
		},
		k.expected.result,
	);
	assert.equal(strip.weeks.length, input.page_size);
	const oldest = ok(await correct(a, older.weeks[0]!.id, STRAINED, strip.revision));
	assert.deepEqual(
		[oldest.week.startsOn, oldest.week.revisions.map((r) => [r.kind, r.answers.spiritual])],
		[
			"2026-07-20",
			[
				["save", "steady"],
				["correction", "strained"],
			],
		],
	);
	const paged = ok(await history(a, 2));
	assert.deepEqual(paged.weeks, [oldest.week]);
	assert.deepEqual(
		ok(await history(a, 1)).weeks.map((x) => x.startsOn),
		mondays.slice(1).reverse(),
	);
	const intruder = await seated(w, "owner");
	refusedBare(await correct(intruder, older.weeks[0]!.id, STEADY, "0"), "not_found");
	for (const page of [1, 2])
		assert.deepEqual(
			ok(await history(intruder, page)).weeks.filter((x) => x.id !== null),
			[],
		);
	assert.deepEqual(ok(await history(a, 2)), paged);
	const b = await seated(w);
	await saveAt(b, "2026-09-30T18:00:00.000Z", STRAINED);
	await saveAt(b, "2026-10-14T18:00:00.000Z", STEADY);
	now = "2026-10-20T18:00:00.000Z";
	assert.deepEqual(
		ok(await trends(b)).weeks.map((x) => [x.startsOn, x.answer === null, x.id === null, x.current]),
		[
			["2026-10-19", true, true, true],
			["2026-10-12", false, false, false],
			["2026-10-05", true, false, false],
			["2026-09-28", false, false, false],
		],
	);
});

test("AC:PI-CARE-001 AC:ROLE43-010 AC:B03-025 AC:TEN-006 AC:TARGET-IDN-031 only the author reads or corrects a check-in", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "admin", "America/Chicago");
	const b = await seated(w, "admin", "Pacific/Auckland");
	const owner = await seated(w, "owner", "Pacific/Auckland");
	const member = await seated(w, "member", "America/Chicago");
	const saved = ok(await save(a, STRAINED, "0", "CARE-CANARY"));
	const mine = { history: ok(await history(a)), footprint: await footprint(a) };
	const quiet = await sideEffects(w);
	for (const other of [b, owner]) {
		for (const author of [a.id, randomUUID()]) {
			for (const read of [care.readCurrent, care.readTrends])
				refusedBare(await read(f.db, other.actor, { author }), "invalid_input");
			refusedBare(await care.readHistory(f.db, other.actor, { page: 1, author }), "invalid_input");
			refusedBare(
				await care.correct(f.db, other.actor, {
					requestKey: randomUUID(),
					expectedRevision: "1",
					input: { weekId: saved.week.id, answers: STEADY, note: "", author },
				}),
				"invalid_input",
			);
		}
		const guessed = await correct(other, saved.week.id, STEADY, "0");
		const missing = await correct(other, randomUUID(), STEADY, "0");
		refusedBare(guessed, "not_found");
		assert.deepEqual(bare(guessed), bare(missing));
		const own = ok(await current(other));
		assert.equal(own.revision, "0");
		assert.equal(own.week.id, null);
		assert.equal(own.week.answer, null);
		for (const read of [own, ok(await history(other)), ok(await trends(other))]) {
			const text = JSON.stringify(read);
			assert.ok(!text.includes(saved.week.id!) && !text.includes("CARE-CANARY") && !text.includes("strained"), text);
		}
		assert.deepEqual(
			bare(await current(other, { author: a.id })),
			bare(await current(other, { author: randomUUID() })),
		);
		refusedBare(await current(other, { author: a.id }), "invalid_input");
		refusedBare(
			await care.save(f.db, other.actor, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: { answers: STEADY, note: "", author: a.id },
			}),
			"invalid_input",
		);
	}
	assert.deepEqual(await sideEffects(w), quiet, "a guess leaves no record, notice or message");
	ok(await save(b, STEADY, "0"));
	const own = ok(await current(b));
	const k25 = caseOf("intelligence", "B03-025");
	const two = k25.action.arguments as {
		authors: { id: string; zone: string; answer: string }[];
		request_author: string;
		caller: string;
	};
	const aNow = ok(await current(a));
	assert.deepEqual(
		two.authors.map((x) => [x.id, x.zone, x.answer.toLowerCase()]),
		[
			["A", aNow.zone, aNow.week.answer!.answers.spiritual],
			["B", own.zone, own.week.answer!.answers.spiritual],
		],
	);
	assert.deepEqual([two.caller, two.request_author], ["A", "B"]);
	const upsert = await correct(a, own.week.id, STRAINED, "1");
	const named = await care.readHistory(f.db, a.actor, { page: 1, author: b.id });
	assert.deepEqual(bare(upsert), bare(await correct(a, randomUUID(), STRAINED, "1")));
	assert.deepEqual(bare(named), bare(await care.readHistory(f.db, a.actor, { page: 1, author: randomUUID() })));
	const shipped = [refusedBare(upsert, "not_found").code, refusedBare(named, "invalid_input").code];
	const denial: Record<string, string> = { not_found: "access_denied", invalid_input: "access_denied" };
	const asA = JSON.stringify([ok(await current(a)), ok(await history(a)), ok(await trends(a)), upsert, named]);
	const bNow = ok(await current(b));
	assert.deepEqual(
		{
			error_code: [...new Set(shipped.map((code) => denial[code]))].join(),
			B_answer: two.authors.find((x) => x.answer.toLowerCase() === bNow.week.answer!.answers.spiritual)?.answer,
			B_metadata: [own.week.id!, b.id, "Pacific/Auckland"].find((x) => asA.includes(x)) ?? null,
		},
		k25.expected.result,
	);
	assert.deepEqual(bNow, own);
	const fixed = ok(await correct(b, own.week.id, STRAINED, own.revision));
	assert.deepEqual(fixed.week.answer!.answers, STRAINED);
	refusedBare(await correct(a, own.week.id, STEADY, "1"), "not_found");
	refusedBare(await correct(b, saved.week.id, STEADY, fixed.revision), "not_found");
	assert.deepEqual({ history: ok(await history(a)), footprint: await footprint(a) }, mine);
	const aRead = ok(await current(a));
	assert.deepEqual(aRead.week.answer!.answers, STRAINED);
	assert.equal(aRead.week.answer!.note, "CARE-CANARY");
	assert.equal(aRead.revision, "1");
	refusedBare(await current(member), "access_denied");
	refusedBare(await history(member), "access_denied");
	refusedBare(await trends(member), "access_denied");
	refusedBare(await save(member, STEADY, "0"), "access_denied");
	refusedBare(await correct(member, saved.week.id, STEADY, "1"), "access_denied");
	assert.deepEqual(await footprint(member), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${b.id}`);
	refusedBare(await current(b), "access_denied");
	refusedBare(await save(b, STRAINED, "1"), "access_denied");
	refusedBare(await history(b), "access_denied");
	refusedBare(await trends(b), "access_denied");
	refusedBare(await correct(b, own.week.id, STEADY, "2"), "access_denied");
	const foreign = await seated(await f.workspace(), "owner");
	refusedBare(await correct(foreign, saved.week.id, STEADY, "0"), "not_found");
	assert.equal(ok(await current(foreign)).week.answer, null);
});

test("AC:ROLE43-011 AC:SCHEMA-007 merges, relinks and role edits leave every check-in with its author", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const a = await seated(w, "admin");
	const b = await seated(w, "owner");
	const past = await saveAt(a, "2026-10-07T18:00:00.000Z", STEADY, "Earlier.");
	ok(await correct(a, past.week.id, STRAINED, await revisionOf(a), "Corrected."));
	const saved = await saveAt(a, "2026-10-13T16:00:00.000Z", STRAINED, "Mine.");
	ok(await save(b, STEADY, "0", "Owner's own."));
	const streams = async () => ({
		rows: await rows(sql`SELECT to_jsonb(w) AS week,to_jsonb(r) AS saved FROM private_week w JOIN private_week_revision r ON r.week_id=w.id
			WHERE w.plant_id=${w.id} ORDER BY w.author_id,w.ordinal,r.revision`),
		calendars: await rows(sql`SELECT * FROM private_calendar WHERE author_id IN (${a.id},${b.id}) ORDER BY author_id`),
	});
	const stored = await streams();
	const reads = async () => ({
		a: [ok(await history(a)), ok(await trends(a))],
		b: [ok(await history(b)), ok(await trends(b))],
	});
	const seen = await reads();
	assert.deepEqual(
		ok(await history(a)).weeks.map((x) => [x.startsOn, x.revisions.map((r) => r.kind)]),
		[
			["2026-10-12", ["save"]],
			["2026-10-05", ["save", "correction"]],
		],
	);
	const ctx = { session: b.session, selected: plantOf(w) };
	const person = async (displayName: string, email: string | null = null) =>
		ok(
			await gatedTransaction(f.db, (tx) =>
				peopleWriter.createPerson(tx, ctx, {
					requestKey: randomUUID(),
					input: { displayName, adultClassification: "adult", email },
				}),
			),
		).person;
	const alex = await person("Alex Rivera"),
		casey = await person("Casey Rivera", a.email);
	const linkTo = (who: Seated, to: typeof casey) =>
		gatedTransaction(f.db, (tx) =>
			accountPersonProducer.ensureAccountPerson(tx, {
				accountId: who.id as never,
				owner: plantOf(w),
				selection: {
					kind: "reviewed_contact",
					person: { owner: plantOf(w), personId: to.id, revision: to.revision },
				} as never,
			}),
		);
	assert.deepEqual(ok(await linkTo(a, casey)), { status: "linked", personId: casey.id });
	const owner = b.actor;
	const team = ok(
		await withTeamsWrite(f.db, owner, (tx, c) =>
			teamsWriter.create(tx, c, { requestKey: randomUUID(), input: { name: "Plant leadership", description: null } }),
		),
	).team;
	const appoint = async (personId: string) => {
		const { revision } = ok(await teamsReader.readRevision(f.db, owner, { teamId: team.id }));
		ok(
			await withTeamsWrite(f.db, owner, (tx, c) =>
				teamsWriter.appointLeader(tx, c, {
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { teamId: team.id, personId },
				}),
			),
		);
		assert.deepEqual(await one(sql`SELECT leader_person_id AS id FROM team WHERE id=${team.id}`), { id: personId });
	};
	await appoint(alex.id);
	const review = ok(
		await gatedTransaction(f.db, (tx) =>
			peopleMerge.getMergeReview(tx, ctx, { sourceId: alex.id, survivorId: casey.id }),
		),
	);
	assert.deepEqual(
		JSON.stringify(review).match(/private|check-?in|\bcare\b|Mine\.|Earlier\.|Corrected\.|strained/gi),
		null,
	);
	assert.equal(
		review.references.some((r) => /week|care|private/i.test(r.kind)),
		false,
	);
	const merged = await recorded(f.admin, () =>
		gatedTransaction(f.db, (tx) =>
			peopleMerge.mergePeople(tx, ctx, {
				requestKey: randomUUID(),
				input: { sourceId: alex.id, survivorId: casey.id, reviewDigest: review.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	ok(merged.value);
	assert.deepEqual(merged.added, { ...NOTHING, audits: ["people.merged"] });
	const robin = await person("Robin Rivera", b.email);
	assert.deepEqual(ok(await linkTo(b, robin)), { status: "linked", personId: robin.id });
	const taken = await person("Taylor Rivera", a.email);
	assert.deepEqual(
		ok(await linkTo(a, taken)),
		{ status: "linked", personId: casey.id },
		"a linked account is never moved to another person",
	);
	await appoint(robin.id);
	const seats = createSeatService(f.db);
	const seatOf = () =>
		one<{ id: string; revision: string; role: string }>(
			sql`SELECT id,revision::text AS revision,role FROM seat WHERE account_id=${a.id} AND ended_at IS NULL`,
		);
	for (const [change, expectedRole, to] of [
		["demote", "admin", "member"],
		["appointAdmin", "member", "admin"],
	] as const) {
		const seat = await seatOf();
		await seats[change](owner, plantOf(w), {
			requestKey: randomUUID(),
			expectedRevision: seat.revision,
			input: { seatId: seat.id, expectedRole, to },
		});
		assert.equal((await seatOf()).role, to);
		assert.deepEqual(await streams(), stored, change);
		a.actor = await f.actor(a.session);
		if (to === "member") refusedBare(await history(a), "access_denied");
	}
	const after = ok(await current(a));
	assert.equal(after.week.id, saved.week.id);
	assert.equal(after.week.answer!.note, "Mine.");
	assert.equal(ok(await current(b)).week.answer!.note, "Owner's own.");
	assert.deepEqual(await reads(), seen);
	assert.deepEqual(await streams(), stored, "no check-in row is copied, moved or rewritten");
	assert.deepEqual(
		await rows(sql`SELECT DISTINCT author_id FROM private_week WHERE plant_id=${w.id}
			UNION SELECT DISTINCT r.author_id FROM private_week_revision r JOIN private_week x ON x.id=r.week_id WHERE x.plant_id=${w.id}
			ORDER BY author_id`),
		[a.id, b.id].sort().map((author_id) => ({ author_id })),
	);
	for (const change of [
		sql`UPDATE private_week SET author_id=${b.id} WHERE id=${saved.week.id}`,
		sql`UPDATE private_week SET ordinal=3 WHERE id=${saved.week.id}`,
		sql`UPDATE private_week SET zone='UTC' WHERE id=${saved.week.id}`,
		sql`UPDATE private_calendar SET author_id=${b.id} WHERE author_id=${a.id}`,
		sql`UPDATE private_week_revision SET author_id=${b.id} WHERE week_id=${saved.week.id}`,
		sql`UPDATE private_week_revision SET note='Not mine.' WHERE week_id=${saved.week.id}`,
	])
		await rejects(f.admin.execute(change), /immutable_source_evidence/);
});

const sideEffects = (w: Workspace) =>
	one(sql`SELECT (SELECT count(*)::int FROM job) jobs,(SELECT count(*)::int FROM notice) notices,
		(SELECT count(*)::int FROM mail) mail,(SELECT count(*)::int FROM task WHERE plant_id=${w.id}) tasks,
		(SELECT count(*)::int FROM audit_event) audits,(SELECT count(*)::int FROM conversation) conversations,
		(SELECT revision::text FROM plant WHERE id=${w.id}) plant_revision,
		(SELECT material_revision::text FROM plant WHERE id=${w.id}) material_revision`);

test("AC:TARGET-IDN-033 three hard weeks in a row are shown back and nothing else happens", async () => {
	const w = await f.workspace();
	const a = await seated(w);
	const start = await sideEffects(w);
	const hard = [
		levels("strained", "steady", "steady", "steady"),
		levels("struggling", "steady", "steady", "steady"),
		levels("strained", "steady", "steady", "steady"),
	];
	await saveAt(a, "2026-09-30T18:00:00.000Z", hard[0]);
	await saveAt(a, "2026-10-07T18:00:00.000Z", hard[1]);
	await saveAt(a, "2026-10-14T18:00:00.000Z", hard[2]);
	const strip = ok(await trends(a));
	assert.deepEqual(Object.keys(strip).sort(), ["page", "pageCount", "revision", "support", "weeks", "zone"]);
	assert.deepEqual(
		strip.weeks.map((x) => x.answer!.answers),
		[hard[2], hard[1], hard[0]],
	);
	assert.deepEqual(Object.keys(ok(await current(a))).sort(), ["revision", "week", "zone"]);
	assert.deepEqual(await sideEffects(w), start);
});

test("AC:TARGET-IDN-033 a missing week breaks a hard run, repeated date-line moves keep one answer per author and week, and nothing private leaves the author", async () => {
	const w = await f.workspace();
	const a = await seated(w),
		b = await seated(w, "owner", "Pacific/Auckland");
	const hard = (spiritual: string) => levels(spiritual, "steady", "steady", "steady");
	const streak = async (who: Seated) => {
		const weeks = ok(await trends(who)).weeks.map((x) => x.answer?.answers.spiritual ?? null);
		const end = weeks.findIndex((x) => x === null || x === "steady");
		return end < 0 ? weeks.length : end;
	};
	const quiet = await sideEffects(w);
	const first = await saveAt(a, "2026-09-30T18:00:00.000Z", hard("strained"));
	await saveAt(b, "2026-09-30T18:00:00.000Z", hard("struggling"));
	await saveAt(b, "2026-10-07T18:00:00.000Z", hard("strained"));
	now = "2026-10-13T16:00:00.000Z";
	const opened = ok(await current(a));
	assert.deepEqual([opened.week.ordinal, opened.week.answer, opened.week.zone], [3, null, "America/Chicago"]);
	const others = await footprint(b);
	for (const zone of ["Pacific/Auckland", "America/Chicago", "Pacific/Auckland", "America/Chicago", "Pacific/Auckland"])
		await changeZone(a, zone);
	const answered = ok(await save(a, hard("struggling"), await revisionOf(a)));
	assert.deepEqual([answered.week.ordinal, answered.week.zone], [3, "America/Chicago"]);
	for (const zone of ["America/Chicago", "Pacific/Auckland"]) await changeZone(a, zone);
	const revision = await revisionOf(a);
	const preview = await previewZone(a, "America/Chicago");
	const [saved, zoned] = await Promise.all([save(a, hard("strained"), revision), setZone(a, preview)]);
	assert.equal([saved, zoned].filter((r) => r.status === "ok").length, 1, JSON.stringify([saved, zoned]));
	if (saved.status !== "ok") ok(await save(a, hard("strained"), await revisionOf(a)));
	ok(await save(a, hard("struggling"), await revisionOf(a)));
	const strip = ok(await trends(a));
	assert.deepEqual(
		strip.weeks.map((x) => [x.ordinal, x.zone, x.startsOn, x.answer?.answers.spiritual ?? null]),
		[
			[3, "America/Chicago", "2026-10-12", "struggling"],
			[2, "America/Chicago", "2026-10-05", null],
			[1, "America/Chicago", "2026-09-28", "strained"],
		],
	);
	assert.equal(await streak(a), 1);
	assert.deepEqual(
		strip.support,
		{
			question: false,
			text: null,
			ordinal: 3,
			endsOn: null,
			historicalEndsOn: null,
			missingWeeks: ["2026-10-05"],
			streaks: { spiritual: 1, family: 0, financial: 0, pace: 0 },
		},
		"no support question",
	);
	assert.deepEqual(Object.keys(ok(await current(a))).sort(), ["revision", "week", "zone"]);
	assert.doesNotMatch(JSON.stringify([strip.weeks, ok(await current(a))]), /support|question|talk|streak|trust/i);
	assert.deepEqual(
		await rows(
			sql`SELECT ordinal,count(*)::int n FROM private_week WHERE author_id IN (${a.id},${b.id}) GROUP BY author_id,ordinal HAVING count(*)>1`,
		),
		[],
	);
	assert.equal(strip.weeks.filter((x) => x.answer !== null).length, 2);
	assert.deepEqual(await footprint(b), others, "the other author's calendar is untouched");
	assert.equal(await streak(b), 0, "the open week has no answer, so the older run is not current");
	refusedBare(await correct(b, first.week.id, STEADY, await revisionOf(b)), "not_found");
	await saveAt(b, "2026-10-13T16:00:00.000Z", hard("struggling"));
	assert.equal(await streak(b), 3);
	const middle = ok(await trends(b)).weeks[1]!;
	ok(await correct(b, middle.id, STEADY, await revisionOf(b)));
	assert.equal(await streak(b), 1, "a Steady correction ends the run");
	assert.equal(
		(await one(sql`SELECT count(*)::int n FROM private_week_revision WHERE week_id=${middle.id}`)).n,
		2,
		"the earlier answer is kept",
	);
	const zones = 7 + (zoned.status === "ok" ? 1 : 0);
	assert.deepEqual(
		await sideEffects(w),
		{ ...quiet, audits: Number(quiet.audits) + zones, jobs: Number(quiet.jobs) + zones },
		"only the zone edits leave a record; no answer does",
	);
	assert.doesNotMatch(
		JSON.stringify(await rows(sql`SELECT * FROM audit_event WHERE actor_id IN (${a.id},${b.id})`)),
		/strained|struggling|private_week|week|ordinal/i,
	);
	const catalog = readCatalog(evryActor(a.actor));
	assert.doesNotMatch(
		JSON.stringify([
			catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
			catalog.reviewedWrites.map((o) => o.operation),
		]),
		/care/i,
	);
});

test("AC:AUDIT-004 AC:ROLE43-012 the canary and every private field stay in the private tables", async () => {
	const w = await f.workspace();
	const a = await seated(w, "owner");
	const logged: string[] = [];
	const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	for (const k of ["log", "error", "warn", "info"] as const)
		console[k] = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
	let week;
	try {
		week = (await saveAt(a, "2026-10-07T18:00:00.000Z", STRAINED, "CARE-CANARY")).week;
		await saveAt(a, "2026-10-14T18:00:00.000Z", STEADY, "CARE-CANARY again");
		ok(await correct(a, week.id, STEADY, await revisionOf(a), "CARE-CANARY corrected"));
		await changeZone(a, "Pacific/Auckland");
		ok(await trends(a));
		ok(await history(a, 2));
	} finally {
		Object.assign(console, original);
	}
	assert.deepEqual(
		logged.filter((l) => /CARE-CANARY|strained/.test(l)),
		[],
	);
	const tables = (
		await rows<{
			table_name: string;
		}>(sql`SELECT table_name FROM information_schema.tables WHERE table_schema=${f.schema}
			AND table_type='BASE TABLE' AND table_name NOT LIKE 'private\\_%' ORDER BY table_name`)
	).map((r) => r.table_name);
	assert.ok(tables.length > 50);
	const found: string[] = [];
	for (const table of tables) {
		const hit = await one<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} x WHERE x::text LIKE '%CARE-CANARY%' OR x::text LIKE ${"%" + week.id + "%"}`,
		);
		if (hit.n) found.push(table);
	}
	assert.deepEqual(found, []);
	const catalog = readCatalog(evryActor(a.actor));
	const tools = JSON.stringify({
		catalog,
		reads: READ_DOMAINS,
		generated: JSON.parse(readFileSync(join(root, "docs/catalog/evry-tools.json"), "utf8")),
	});
	assert.deepEqual(
		tools.replace(/"private care"/g, "").match(/privateCare|private.?care|private_week|weekly check-?in/gi),
		null,
	);
});

async function overdue(requester: Seated, subject: DeletionRequest["subject"]) {
	const at = new Date(Date.now() - 31 * 86_400_000),
		requestId = randomUUID();
	await f.admin
		.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,account_id,plant_id,request_id,requester_id,
		requester_opaque_id,request_revision,state,requested_at,cancel_until,witness_checkpoint,cleanup_state)
		VALUES(${subject.kind},${subject.id},${subject.kind === "account" ? subject.id : null},
		${subject.kind === "plant" ? subject.id : null},${requestId},${requester.id},${requester.id},1,'pending_deletion',
		${at.toISOString()},${new Date(at.getTime() + 30 * 86_400_000).toISOString()},1,'not_started')`);
	return { subject, requestId, revision: "1" };
}

test("AC:ROLE43-018 AC:DEL58-005 AC:TARGET-IDN-032 deletion hides the author's check-ins at once and the purge removes them", async () => {
	now = "2026-10-13T16:00:00.000Z";
	const w = await f.workspace();
	const owner = await seated(w, "owner");
	const a = await seated(w, "admin");
	const gone = await seated(w, "admin");
	ok(await save(a, STRAINED, "0", "CARE-CANARY"));
	ok(await save(gone, STRAINED, "0", "CARE-CANARY"));
	ok(await save(owner, STEADY, "0"));
	const accountRevision = (await one<{ r: string }>(sql`SELECT revision::text AS r FROM account WHERE id=${a.id}`)).r;
	ok(
		await gatedTransaction(f.db, (tx) =>
			deletion.requestAccountDeletion(tx, accountCtx(a), {
				requestKey: randomUUID(),
				expectedRevision: accountRevision,
				input: { confirmed: true },
			}),
		),
	);
	refusedBare(await current(a), "access_denied");
	refusedBare(await save(a, STEADY, "1"), "access_denied");
	refusedBare(await correct(a, randomUUID(), STEADY, "1"), "access_denied");
	assert.equal(ok(await current(owner)).week.answer!.note, null);
	const purge = createLifecycleCleanup(f.admin, {
		authorize: async () => true,
		removeOwnedResources: async () => true,
	});
	assert.equal((await purge(await overdue(gone, { kind: "account", id: gone.id }))).status, "purged");
	assert.deepEqual(await footprint(gone), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	assert.equal((await footprint(owner)).weeks, 1);
	assert.equal((await footprint(a)).weeks, 1);
	const other = await f.workspace();
	const o = await seated(other, "owner");
	ok(await save(o, STEADY, "0"));
	const plantRevision = (await one<{ r: string }>(sql`SELECT revision::text AS r FROM plant WHERE id=${other.id}`)).r;
	ok(
		await gatedTransaction(f.db, (tx) =>
			deletion.requestWorkspaceDeletion(
				tx,
				{ session: o.session, selected: plantOf(other) },
				{
					requestKey: randomUUID(),
					expectedRevision: plantRevision,
					input: { plant: plantOf(other), confirmed: true },
				},
			),
		),
	);
	refusedBare(await current(o), "access_denied");
	const third = await f.workspace();
	const t = await seated(third, "owner");
	const stays = await seated(w, "admin");
	ok(await save(t, STEADY, "0"));
	ok(await save(stays, STEADY, "0"));
	assert.equal((await purge(await overdue(t, plantOf(third)))).status, "purged");
	assert.deepEqual(await footprint(t), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	assert.equal((await footprint(stays)).weeks, 1);
	const records = await rows<{
		row: string;
	}>(sql`SELECT a::text AS row FROM audit_event a WHERE a.tenant_id IN (${a.id},${gone.id},${other.id},${third.id})
		OR a.subject_id IN (${a.id},${gone.id},${other.id},${third.id})`);
	assert.ok(records.length > 0);
	assert.deepEqual(
		records.filter((r) => /private|care|week|CARE-CANARY/i.test(r.row)),
		[],
	);
});

const careCase = (id: string) => caseOf("intelligence", id) as Case & { clock: { now: string } };

test("AC:PI-CARE-001 another Admin saving into the author's week after a CRM merge gets a bare not-found: no body, existence, calendar or nudge", async () => {
	const k = careCase("PI-CARE-001");
	const input = k.given["case-input"] as { author: string; caller: string; CRM_merge: boolean; week: string };
	now = new Date(k.clock.now).toISOString();
	const w = await f.workspace();
	const a = await seated(w, "admin");
	const b = await seated(w, "admin");
	const week = ok(await save(a, STRAINED, "0", "CARE-CANARY-PI")).week;
	assert.deepEqual([input.week, week.ordinal], ["W1", 1]);
	assert.equal(input.CRM_merge, true);
	const ctx = { session: b.session, selected: plantOf(w) };
	const person = async (displayName: string, email: string | null = null) =>
		ok(
			await gatedTransaction(f.db, (tx) =>
				peopleWriter.createPerson(tx, ctx, {
					requestKey: randomUUID(),
					input: { displayName, adultClassification: "adult", email },
				}),
			),
		).person;
	const duplicate = await person("Alex Duplicate"),
		linked = await person("Alex Author", a.email);
	ok(
		await gatedTransaction(f.db, (tx) =>
			accountPersonProducer.ensureAccountPerson(tx, {
				accountId: a.id as never,
				owner: plantOf(w),
				selection: {
					kind: "reviewed_contact",
					person: { owner: plantOf(w), personId: linked.id, revision: linked.revision },
				} as never,
			}),
		),
	);
	const review = ok(
		await gatedTransaction(f.db, (tx) =>
			peopleMerge.getMergeReview(tx, ctx, { sourceId: duplicate.id, survivorId: linked.id }),
		),
	);
	ok(
		await gatedTransaction(f.db, (tx) =>
			peopleMerge.mergePeople(tx, ctx, {
				requestKey: randomUUID(),
				input: { sourceId: duplicate.id, survivorId: linked.id, reviewDigest: review.reviewDigest, fieldChoices: {} },
			}),
		),
	);
	const authored = await footprint(a);
	const quiet = await sideEffects(w);
	const { value: guessed, added } = await recorded(f.admin, () => correct(b, week.id, STEADY, "0"));
	refusedBare(guessed, "not_found");
	assert.deepEqual(added, NOTHING);
	const missing = await correct(b, randomUUID(), STEADY, "0");
	assert.deepEqual(bare(guessed), bare(missing), "no existence signal");
	assert.ok(guessed.status === "refused");
	assert.deepEqual(Object.keys(guessed).sort(), ["error", "status"]);
	assert.doesNotMatch(
		JSON.stringify(guessed),
		new RegExp(`${week.id}|CARE-CANARY|strained|support|nudge|calendar`, "i"),
	);
	refusedBare(
		await care.save(f.db, b.actor, {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { answers: STEADY, note: "", author: a.id, weekId: week.id },
		}),
		"invalid_input",
	);
	const e = k.expected.result;
	assert.deepEqual(
		{
			error_code: guessed.error.code,
			body: "week" in guessed ? guessed.week : null,
			existence: JSON.stringify(bare(guessed)) === JSON.stringify(bare(missing)) ? null : guessed.error,
			calendar: (await footprint(b)).revision,
			support_nudge: "support" in guessed ? guessed.support : null,
		},
		e,
	);
	assert.deepEqual(await footprint(b), { calendars: 0, weeks: 0, revisions: 0, revision: null });
	assert.deepEqual(await footprint(a), authored);
	assert.deepEqual(await sideEffects(w), quiet, "no event, notice, message or task");
	const mine = ok(await current(a));
	assert.deepEqual(
		[mine.week.id, mine.week.answer!.note, mine.week.answer!.answers],
		[week.id, "CARE-CANARY-PI", STRAINED],
	);
});

test("AC:PI-CARE-003 two zone edits and a racing save keep the open week, its original zone and one answer until the new zone's first Monday", async () => {
	const k = careCase("PI-CARE-003");
	const input = k.given["case-input"] as {
		open_ordinal: number;
		original_zone: string;
		requested_zone: string;
		concurrent_save: boolean;
	};
	now = new Date(k.clock.now).toISOString();
	const w = await f.workspace();
	const a = await seated(w, "admin", input.original_zone);
	const open = ok(await save(a, STRAINED, "0")).week;
	assert.deepEqual([open.ordinal, open.zone, open.startsOn], [input.open_ordinal, input.original_zone, "2026-10-12"]);
	await changeZone(a, "America/Denver");
	assert.equal(input.concurrent_save, true);
	const preview = await previewZone(a, input.requested_zone);
	const [saved, zoned] = await Promise.all([save(a, STEADY, await revisionOf(a)), setZone(a, preview)]);
	assert.equal([saved, zoned].filter((r) => r.status === "ok").length, 1, JSON.stringify([saved, zoned]));
	if (saved.status !== "ok") ok(await save(a, STEADY, await revisionOf(a)));
	else ok(await setZone(a, await previewZone(a, input.requested_zone)));
	const pending = await nextAt(a);
	const reading = ok(await current(a));
	const weeks = await rows<{ zone: string; ordinal: number }>(
		sql`SELECT zone,ordinal FROM private_week WHERE author_id=${a.id} ORDER BY ordinal`,
	);
	const duplicates = await rows(
		sql`SELECT ordinal FROM private_week WHERE author_id=${a.id} GROUP BY ordinal HAVING count(*)>1
			UNION ALL SELECT revision FROM private_week_revision WHERE author_id=${a.id} GROUP BY week_id,revision HAVING count(*)>1`,
	);
	const ordinals: number[] = [];
	for (const at of ["2026-10-18T11:00:00.000Z", "2026-10-19T06:59:59.000Z"]) {
		now = at;
		const later = ok(await current(a)).week;
		assert.equal(later.id, open.id, at);
		ordinals.push(later.ordinal);
	}
	assert.deepEqual(
		{
			current_ordinal: reading.week.ordinal,
			pending_zone: pending?.zone,
			new_ordinals_before_future_monday: ordinals.filter((n) => n !== input.open_ordinal).length,
			original_zone_changed: weeks.some((x) => x.zone !== input.original_zone),
			duplicate_answers: duplicates.length,
		},
		k.expected.result,
	);
	assert.deepEqual(
		[reading.week.id, reading.week.zone, reading.week.answer!.answers, reading.week.revisions.length],
		[open.id, input.original_zone, STEADY, 2],
	);
	assert.deepEqual(pending, { at: "2026-10-19T07:00:00Z", zone: input.requested_zone });
	assert.equal(
		(await one(sql`SELECT personal_timezone FROM account WHERE id=${a.id}`)).personal_timezone,
		input.requested_zone,
	);
	const stored = await footprint(a);
	assert.deepEqual([stored.calendars, stored.weeks, stored.revisions], [1, 1, 2]);
	now = "2026-10-19T07:00:00.000Z";
	const next = ok(await current(a)).week;
	assert.deepEqual(
		[next.id, next.ordinal, next.zone, next.startsOn],
		[null, input.open_ordinal + 1, input.requested_zone, "2026-10-19"],
	);
});

const WEEK_SAVES = ["2026-09-30T18:00:00.000Z", "2026-10-07T18:00:00.000Z"];
async function withoutProvider<T>(run: () => Promise<T>) {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls++;
		throw new Error("no provider call from private care");
	}) as typeof fetch;
	try {
		return { value: await run(), calls };
	} finally {
		globalThis.fetch = original;
	}
}

test("AC:PI-CARE-002 three adjacent hard weeks on one area raise the author's support question at the current week; a missing or Steady week breaks the run; no mail, task, model call or PI change", async () => {
	const k = careCase("PI-CARE-002");
	type Args = { author: string; dimension: CareArea; ordinals: number[]; levels: (string | null)[] };
	const scenarios = [
		{ name: "case", args: k.action.arguments as Args, expected: k.expected.result as Record<string, unknown> },
		...(k.subcases ?? []).map((s) => ({
			name: s.name,
			args: { dimension: (k.action.arguments as Args).dimension, ...(s.action.arguments as Partial<Args>) } as Args,
			expected: s.expected.result as Record<string, unknown>,
		})),
	];
	assert.deepEqual(
		scenarios.map((s) => s.name),
		["case", "missing-week", "steady-week"],
	);
	for (const s of scenarios) {
		assert.deepEqual([s.args.author, s.args.ordinals], ["A", [1, 2, 3]], s.name);
		const w = await f.workspace();
		const a = await seated(w, "admin");
		const piBefore = (await captureFacts(f.admin, w.id, null))!.sourceRevision;
		const before = await sideEffects(w);
		const { value: strip, calls } = await withoutProvider(async () => {
			for (const [i, level] of s.args.levels.entries()) {
				now = i < WEEK_SAVES.length ? WEEK_SAVES[i]! : k.clock.now;
				if (level !== null) ok(await save(a, { ...STEADY, [s.args.dimension]: level }, await revisionOf(a)));
			}
			now = new Date(k.clock.now).toISOString();
			return ok(await trends(a));
		});
		assert.deepEqual(
			strip.weeks.map((x) => [x.ordinal, x.answer?.answers[s.args.dimension] ?? null]),
			[...s.args.levels.entries()].map(([i, level]) => [s.args.ordinals[i], level]).reverse(),
			s.name,
		);
		const support = strip.support;
		if (s.name === "case")
			assert.deepEqual(
				{ support_question: support.question, current_ordinal: support.ordinal },
				{ support_question: s.expected.support_question, current_ordinal: s.expected.current_ordinal },
			);
		else
			assert.deepEqual(
				{ support_question: support.question, streak_length: support.streaks[s.args.dimension] },
				s.expected,
				s.name,
			);
		assert.equal(support.streaks[s.args.dimension], s.name === "case" ? 3 : 1, s.name);
		const after = await sideEffects(w);
		assert.deepEqual(after, before, `${s.name}: no audit, job, notice, mail, task, conversation or plant revision`);
		if (s.name === "case")
			assert.deepEqual(
				{
					email_count: Number(after.mail) - Number(before.mail),
					task_count: Number(after.tasks) - Number(before.tasks),
					model_calls: calls,
					PI_revision_changes: Number((await captureFacts(f.admin, w.id, null))!.sourceRevision !== piBefore),
				},
				{
					email_count: s.expected.email_count,
					task_count: s.expected.task_count,
					model_calls: s.expected.model_calls,
					PI_revision_changes: s.expected.PI_revision_changes,
				},
			);
		else assert.equal((await captureFacts(f.admin, w.id, null))!.sourceRevision, piBefore);
		assert.equal(calls, 0);
	}
});

test("AC:GAP-PI-041 only the original author corrects a private answer, natively: other authors, a Member and a foreign seat get a bare refusal and an unreachable store writes nothing", async () => {
	const k = careCase("GAP-PI-041");
	const given = k.given["care-A"] as {
		week: string;
		week_ordinal: number;
		zone: string;
		answers: Record<string, string>;
		note: string;
	};
	const args = k.action.arguments as { answers: Record<string, string>; note: string };
	const DIMENSIONS = { spiritual: "spiritual", emotional: "family", relational: "financial", physical: "pace" };
	const answersOf = (labels: Record<string, string>) =>
		Object.fromEntries(
			Object.entries(DIMENSIONS).map(([label, dimension]) => [dimension, labels[label]!.toLowerCase()]),
		) as Answers;
	const sub = (name: string) => k.subcases!.find((x) => x.name === name)!;
	now = new Date(k.clock.now).toISOString();
	const w = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${w.id}`);
	const a = await seated(w, "admin", given.zone);
	const careA = ok(await save(a, answersOf(given.answers), "0", given.note)).week;
	assert.deepEqual([careA.startsOn, careA.ordinal, careA.zone], [given.week, given.week_ordinal, given.zone]);
	const reviewed = ok(await current(a)).revision;
	const inputState = async () => (await captureFacts(f.db, w.id, null))!.sourceRevision;
	const input0 = await inputState();
	const authored = { history: ok(await history(a)), footprint: await footprint(a) };
	const foreignPlant = await f.workspace();
	await f.admin.execute(sql`UPDATE plant SET timezone='America/New_York' WHERE id=${foreignPlant.id}`);
	const quiet = async () => ({ p: await sideEffects(w), q: await sideEffects(foreignPlant) });
	const untouched = await quiet();
	const leaks = (value: unknown) =>
		[careA.id!, given.note, "strained"].filter((x) => JSON.stringify(value).toLowerCase().includes(x.toLowerCase()));
	const fix = (who: Seated, weekId: string) => correct(who, weekId, answersOf(args.answers), reviewed, args.note);
	const others: Seated[] = [];

	for (const [name, role] of [
		["other-author-owner", "owner"],
		["other-author-admin", "admin"],
		["other-author-member", "member"],
	] as const) {
		const s = sub(name);
		assert.equal((s.given["seat-B"] as { role: string }).role.toLowerCase(), role);
		const b = await seated(w, role);
		if (role !== "member") others.push(b);
		const named = await care.readHistory(f.db, b.actor, { page: 1, entry: careA.id });
		assert.deepEqual(bare(named), bare(await care.readHistory(f.db, b.actor, { page: 1, entry: randomUUID() })));
		const guessed = await fix(b, careA.id!);
		const missing = await fix(b, randomUUID());
		const own = role === "member" ? [] : [ok(await current(b)), ok(await history(b)), ok(await trends(b))];
		const code = role === "member" ? "access_denied" : "not_found";
		refusedBare(guessed, code);
		refusedBare(named, role === "member" ? "access_denied" : "invalid_input");
		const label: Record<string, string> = { not_found: "not_found", access_denied: "not_found" };
		assert.deepEqual(
			{
				error_code: guessed.status === "refused" ? label[guessed.error.code] : null,
				body: leaks([guessed, named, own]).length ? leaks([guessed, named, own]) : null,
				existence: JSON.stringify(bare(guessed)) === JSON.stringify(bare(missing)) ? null : bare(guessed),
			},
			s.expected.result,
			name,
		);
	}

	const s4 = sub("foreign-context-refused");
	assert.equal((s4.given["foreign-seat"] as { role: string }).role, "Member");
	const foreign = await seated(foreignPlant, "member");
	const before4 = await footprint(a);
	const refusedForeign = await fix(foreign, careA.id!);
	const missingForeign = await fix(foreign, randomUUID());
	const changed4 = [
		JSON.stringify(await footprint(a)) !== JSON.stringify(before4),
		JSON.stringify(await footprint(foreign)) !==
			JSON.stringify({ calendars: 0, weeks: 0, revisions: 0, revision: null }),
	].filter(Boolean).length;
	const after4 = await quiet();
	assert.deepEqual(
		{
			error_code: refusedForeign.status === "refused" ? refusedForeign.error.code : null,
			forbidden_body: leaks(refusedForeign).length ? refusedForeign : null,
			forbidden_existence:
				JSON.stringify(bare(refusedForeign)) === JSON.stringify(bare(missingForeign)) ? null : bare(refusedForeign),
			domain_writes: changed4 + (JSON.stringify(after4) === JSON.stringify(untouched) ? 0 : 1),
			provider_effects: ["jobs", "notices", "mail", "conversations"].filter(
				(x) => after4.p[x] !== untouched.p[x] || after4.q[x] !== untouched.q[x],
			).length,
		},
		s4.expected.result,
	);

	const s5 = sub("required-boundary-failure");
	assert.equal((s5.action.arguments as { fault: string }).fault, "required_source_unavailable");
	const offline = createDatabase({ connectionString: "postgres://nobody@127.0.0.1:9/none", max: 1 });
	let error_code: string | null = null;
	try {
		await assert.rejects(
			care.correct(offline, a.actor, {
				requestKey: randomUUID(),
				expectedRevision: reviewed,
				input: { weekId: careA.id, answers: answersOf(args.answers), note: args.note },
			}),
			(e: Error) => /ECONNREFUSED|connect/i.test(String(e.cause ?? "") + e.message),
		);
		error_code = "source_unavailable";
	} finally {
		await closeDatabase(offline);
	}
	const after5 = await quiet();
	const kept = { history: ok(await history(a)), footprint: await footprint(a) };
	const touched =
		(JSON.stringify(after5) === JSON.stringify(untouched) ? 0 : 1) +
		(JSON.stringify(kept) === JSON.stringify(authored) ? 0 : 1);
	assert.deepEqual(
		{
			error_code,
			new_domain_writes: touched,
			new_provider_effects: ["jobs", "notices", "mail", "conversations"].filter(
				(x) => after5.p[x] !== untouched.p[x] || after5.q[x] !== untouched.q[x],
			).length,
			prior_committed_outcomes_retained: JSON.stringify(kept) === JSON.stringify(authored),
		},
		s5.expected.result,
	);

	const { value: fixed, added } = await recorded(f.admin, async () => ok(await fix(a, careA.id!)));
	assert.deepEqual(added, NOTHING);
	const stored = await rows<{ revision: number; kind: string; author_id: string; spiritual: string; note: string }>(
		sql`SELECT revision,kind,author_id,spiritual,note FROM private_week_revision WHERE week_id=${careA.id} ORDER BY revision`,
	);
	const week = await one(
		sql`SELECT author_id,starts_on::text AS starts_on,zone,ordinal FROM private_week WHERE id=${careA.id}`,
	);
	assert.deepEqual(fixed.week.answer, {
		...fixed.week.answer!,
		answers: answersOf(args.answers),
		note: args.note,
	});
	assert.deepEqual(
		fixed.week.revisions.map((r) => [r.kind, r.answers, r.note]),
		[
			["save", answersOf(given.answers), given.note],
			["correction", answersOf(args.answers), args.note],
		],
	);
	const seenByOthers = [];
	for (const o of others) seenByOthers.push(ok(await history(o)), ok(await trends(o)), ok(await current(o)));
	const catalog = readCatalog(evryActor(a.actor));
	assert.doesNotMatch(
		JSON.stringify([
			catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
			catalog.reviewedWrites.map((o) => o.operation),
		]),
		/care|private|week/i,
	);
	const auditedP = await rows<{ row: string }>(
		sql`SELECT a::text AS row FROM audit_event a WHERE a.tenant_id=${w.id} OR a.actor_id=${a.id}`,
	);
	assert.deepEqual(
		{
			observed_state:
				fixed.revision !== reviewed && ok(await current(a)).revision === fixed.revision
					? "fixture-state-2"
					: fixed.revision,
			author: [week.author_id, ...stored.map((r) => r.author_id)].every((x) => x === a.id) ? "A" : null,
			week: fixed.week.startsOn,
			old_revision_author_only:
				stored[0]?.kind === "save" &&
				stored[0].note === given.note &&
				ok(await history(a)).weeks[0]!.revisions[0]!.note === given.note &&
				leaks(seenByOthers).length === 0,
			broad_audit_rows:
				added.audits.length + auditedP.filter((r) => leaks(r.row).length || /private|care/i.test(r.row)).length,
			assessment_input_state: (await inputState()) === input0 ? "fixture-state-11" : "changed",
		},
		k.expected.result,
	);
	assert.deepEqual(week, { author_id: a.id, starts_on: given.week, zone: given.zone, ordinal: given.week_ordinal });
	assert.deepEqual(await quiet(), untouched);
});

const AREA_OF = { energy: "pace", relationships: "family" } as const satisfies Record<string, CareArea>;
const level = (label: string) => label.toLowerCase();
const all = (label: string) => levels(level(label), level(label), level(label), level(label));
const DAY = 86_400_000;
const savedIn = (monday: string, clockNow: string) =>
	Date.parse(`${monday}T18:00:00.000Z`) + 7 * DAY > Date.parse(clockNow)
		? new Date(clockNow).toISOString()
		: new Date(Date.parse(`${monday}T18:00:00.000Z`) + 2 * DAY).toISOString();
async function answered(who: Seated, k: Case & { clock: { now: string } }, plan: [string, Answers | null][]) {
	for (const [monday, answers] of plan) if (answers) await saveAt(who, savedIn(monday, k.clock.now), answers);
	now = new Date(k.clock.now).toISOString();
	return ok(await trends(who));
}
async function quietly<T>(w: Workspace, run: () => Promise<T>) {
	const before = await sideEffects(w);
	const piBefore = (await captureFacts(f.admin, w.id, null))!.sourceRevision;
	const value = await run();
	assert.deepEqual(await sideEffects(w), before, "event null: no audit, job, notice, mail, task or plant revision");
	assert.equal((await captureFacts(f.admin, w.id, null))!.sourceRevision, piBefore);
	return value;
}
type Weekly = { weeks: string[]; answers: string[]; dimension?: keyof typeof AREA_OF };

test("AC:B03-027 Strained, Struggling, Strained on one area in three adjacent weeks raise the support question ending on the current week", async () => {
	const k = careCase("B03-027");
	const input = k.action.arguments as Weekly;
	const area = AREA_OF[input.dimension!];
	const w = await f.workspace();
	const a = await seated(w);
	const strip = await quietly(w, () =>
		answered(
			a,
			k,
			input.weeks.map((monday, i) => [monday, { ...STEADY, [area]: level(input.answers[i]!) }]),
		),
	);
	assert.deepEqual(
		strip.weeks.map((x) => [x.startsOn, x.answer!.answers[area]]),
		[...input.weeks.map((monday, i) => [monday, level(input.answers[i]!)])].reverse(),
	);
	assert.deepEqual(
		{ support_question_visible: strip.support.question, ends_on: strip.support.endsOn },
		k.expected.result,
	);
	assert.deepEqual([strip.support.ordinal, strip.support.streaks[area]], [3, 3]);
	assert.equal((k.expected as { event?: unknown }).event, null);
});

test("AC:B03-028 mixed hard weeks qualify; two weeks, a run across two areas or across two authors never do", async () => {
	const k = careCase("B03-028");
	const controls = (k.action.arguments as { controls: string[][] }).controls;
	const MONDAYS = ["2026-09-28", "2026-10-05", "2026-10-12"];
	const qualifies: boolean[] = [];
	for (const control of controls) {
		const w = await f.workspace();
		const a = await seated(w);
		const plan = control.map((entry, i): [string, Answers] => {
			const [label, dimension] = entry.split(":") as [string, keyof typeof AREA_OF | undefined];
			return [
				MONDAYS[MONDAYS.length - control.length + i]!,
				{ ...STEADY, [AREA_OF[dimension ?? "energy"]]: level(label) },
			];
		});
		const strip = await quietly(w, () => answered(a, k, plan));
		assert.equal(strip.weeks.filter((x) => x.answer).length, control.length, control.join());
		qualifies.push(strip.support.question);
	}
	assert.deepEqual({ qualifies }, k.expected.result);
	const w = await f.workspace();
	const a = await seated(w),
		b = await seated(w);
	const hard = (label: string) => ({ ...STEADY, pace: level(label) });
	const split = await quietly(w, async () => {
		await answered(a, k, [[MONDAYS[0]!, hard("Strained")]]);
		await answered(b, k, [[MONDAYS[1]!, hard("Struggling")]]);
		return [await answered(a, k, [[MONDAYS[2]!, hard("Strained")]]), ok(await trends(b))];
	});
	assert.deepEqual(
		split.map((x) => [x.support.question, x.weeks.filter((y) => y.answer).length]),
		[
			[false, 2],
			[false, 1],
		],
		"three hard weeks split across two authors never qualify",
	);
});

test("AC:B03-029 a missing calendar week breaks the run and a correction cannot make its answer", async () => {
	const k = careCase("B03-029");
	const input = k.action.arguments as Weekly;
	const w = await f.workspace();
	const a = await seated(w);
	const strip = await quietly(w, () =>
		answered(
			a,
			k,
			input.weeks.map((monday, i) => [monday, all(input.answers[i]!)]),
		),
	);
	assert.deepEqual(
		strip.weeks.map((x) => [x.startsOn, x.answer?.answers.pace ?? null]),
		[
			["2026-10-12", "strained"],
			["2026-10-05", null],
			["2026-09-28", "strained"],
			["2026-09-21", "strained"],
		],
	);
	const result = { support_question_visible: strip.support.question, missing_week: strip.support.missingWeeks[0] };
	assert.deepEqual(result, k.expected.result);
	assert.deepEqual(strip.support.missingWeeks, ["2026-10-05"]);
	const gap = strip.weeks[1]!;
	assert.ok(gap.id, "the skipped week is stored with no answer");
	const before = { footprint: await footprint(a), strip };
	await quietly(w, async () => refusedBare(await correct(a, gap.id, all("Strained"), strip.revision), "not_found"));
	assert.deepEqual({ footprint: await footprint(a), strip: ok(await trends(a)) }, before);
	assert.equal(before.strip.weeks.filter((x) => x.answer).length, 3, "the answered week count stays three");
});

test("AC:B03-030 correcting the middle week to Steady removes the question and keeps the earlier answer", async () => {
	const k = careCase("B03-030");
	const input = k.action.arguments as Weekly & { correction: { week: string; answer: string } };
	const w = await f.workspace();
	const a = await seated(w);
	const strip = await quietly(w, () =>
		answered(
			a,
			k,
			input.weeks.map((monday, i) => [monday, all(input.answers[i]!)]),
		),
	);
	assert.equal(strip.support.question, true);
	const middle = strip.weeks.find((x) => x.startsOn === input.correction.week)!;
	const after = await quietly(w, async () => {
		ok(await correct(a, middle.id, all(input.correction.answer), strip.revision));
		return ok(await trends(a));
	});
	const shown = after.weeks.find((x) => x.id === middle.id)!;
	assert.deepEqual(
		{
			support_question_visible: after.support.question,
			middle_answer_history: shown.revisions.map((r) => r.answers.pace),
		},
		{
			support_question_visible: k.expected.result.support_question_visible,
			middle_answer_history: (k.expected.result.middle_answer_history as string[]).map(level),
		},
	);
	assert.deepEqual(
		await rows(sql`SELECT revision,kind,spiritual,family,financial,pace FROM private_week_revision
			WHERE week_id=${middle.id} ORDER BY revision`),
		[
			{ revision: 1, kind: "save", ...all("Struggling") },
			{ revision: 2, kind: "correction", ...all("Steady") },
		],
	);
	assert.deepEqual(after.support.streaks, { spiritual: 1, family: 1, financial: 1, pace: 1 });
});

test("AC:B03-031 an older run shows as historical with its ending week; a missing or Steady current week is never a current question", async () => {
	const k = careCase("B03-031");
	const input = k.action.arguments as Weekly & { current_week: string; current_answer: string | null };
	for (const current of [input.current_answer, "Steady"]) {
		const w = await f.workspace();
		const a = await seated(w);
		const strip = await quietly(w, () =>
			answered(a, k, [
				...input.weeks.map((monday, i): [string, Answers] => [monday, all(input.answers[i]!)]),
				[input.current_week, current === null ? null : all(current)],
			]),
		);
		assert.deepEqual(
			strip.weeks.map((x) => [x.startsOn, x.current, x.answer?.answers.pace ?? null]),
			[
				["2026-10-12", true, current && level(current)],
				["2026-10-05", false, null],
				["2026-09-28", false, null],
				["2026-09-21", false, null],
				["2026-09-14", false, "strained"],
				["2026-09-07", false, "struggling"],
				["2026-08-31", false, "strained"],
			],
		);
		assert.deepEqual(
			{ current_question: strip.support.question, historical_run_end: strip.support.historicalEndsOn },
			k.expected.result,
			String(current),
		);
		assert.deepEqual([strip.support.text, strip.support.endsOn], [null, null]);
	}
});

const HARD_RUN = ["2026-09-28", "2026-10-05", "2026-10-12"];
const requirementCopy = () => {
	const found = (
		JSON.parse(readFileSync(join(root, "docs/catalog/requirements/identity-access.json"), "utf8")) as {
			requirements: { id: string; text: string }[];
		}
	).requirements.find((r) => r.id === "REQ-IDN-033")!;
	return /\u201c([^\u201d]+)\u201d/.exec(found.text)![1];
};

test("AC:B03-032 the support question is fixed copy; asking it to compose a prayer or give biblical counsel makes no model call and returns no judgment", async () => {
	const k = careCase("B03-032");
	const input = k.action.arguments as { answers: string[]; model_requests: string[] };
	const w = await f.workspace();
	const a = await seated(w),
		b = await seated(w);
	const { value, calls } = await withoutProvider(() =>
		quietly(w, async () => {
			const strips = [];
			for (const who of [a, b])
				strips.push(
					await answered(
						who,
						k,
						HARD_RUN.map((monday, i) => [monday, all(input.answers[i]!)]),
					),
				);
			const asked = [];
			for (const request of input.model_requests)
				for (const raw of [{ request }, { prompt: request }, { model: request }])
					asked.push(await care.readTrends(f.db, a.actor, raw));
			return { strips, asked, again: ok(await trends(a)) };
		}),
	);
	for (const reply of value.asked) refusedBare(reply, "invalid_input");
	const [mine, theirs] = value.strips.map((x) => x.support);
	assert.deepEqual(mine, value.again.support, "the same copy on every read");
	assert.equal(mine!.text, requirementCopy());
	assert.deepEqual(theirs, mine, "the same copy for every author");
	assert.deepEqual(Object.keys(mine!).sort(), [
		"endsOn",
		"historicalEndsOn",
		"missingWeeks",
		"ordinal",
		"question",
		"streaks",
		"text",
	]);
	assert.doesNotMatch(JSON.stringify(value), /pray|bibl|scripture|god|faith|counsel|pastor|judg/i);
	assert.deepEqual(
		{ model_calls: calls, native_support_question: mine!.question, pastoral_judgment: null },
		k.expected.result,
	);
});

test("AC:B03-034 raising the question changes no assessment input, makes no task, mail or notice, keeps private rows as they are and gives a former author nothing", async () => {
	const k = careCase("B03-034");
	const input = k.action.arguments as { concern_answers: string[]; assessment_input_state: string };
	const w = await f.workspace();
	const a = await seated(w);
	const facts = async () => (await captureFacts(f.admin, w.id, null))!.sourceRevision;
	const inputs = await facts();
	const start = await sideEffects(w);
	const strip = await answered(
		a,
		k,
		HARD_RUN.map((monday, i) => [monday, all(input.concern_answers[i]!)]),
	);
	assert.equal(strip.support.question, true);
	const privateRows = () =>
		rows(sql`SELECT 'week' t,to_jsonb(w)::text r FROM private_week w WHERE author_id=${a.id}
			UNION ALL SELECT 'revision',to_jsonb(v)::text FROM private_week_revision v WHERE author_id=${a.id}
			UNION ALL SELECT 'calendar',to_jsonb(c)::text FROM private_calendar c WHERE author_id=${a.id} ORDER BY 1,2`);
	const kept = await privateRows();
	const grants = () =>
		rows(sql`SELECT (SELECT count(*)::int FROM seat WHERE account_id=${a.id}) seats,
			(SELECT count(*)::int FROM platform_grant) platform_grants`);
	const granted = await grants();
	for (let i = 0; i < 3; i++) assert.equal(ok(await trends(a)).support.question, true);
	const end = await sideEffects(w);
	assert.deepEqual(end, start);
	assert.deepEqual(
		{
			assessment_input_state: (await facts()) === inputs ? input.assessment_input_state : "changed",
			new_tasks: Number(end.tasks) - Number(start.tasks),
			email_intents: Number(end.mail) - Number(start.mail),
			organization_notices: Number(end.notices) - Number(start.notices),
		},
		k.expected.result,
	);
	assert.deepEqual(await privateRows(), kept, "reading the question writes no private row and widens no retention");
	assert.deepEqual(await grants(), granted);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${a.id}`);
	refusedBare(await trends(a), "access_denied");
	refusedBare(await history(a), "access_denied");
	refusedBare(await current(a), "access_denied");
	assert.deepEqual(await privateRows(), kept);
	assert.deepEqual(await sideEffects(w), start);
});

async function captureConsole<T>(run: () => Promise<T>) {
	const logged: string[] = [];
	const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
	for (const k of ["log", "error", "warn", "info"] as const)
		console[k] = (...args: unknown[]) =>
			void logged.push(args.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
	try {
		return { value: await run(), logged };
	} finally {
		Object.assign(console, original);
	}
}

test("AC:B03-033 even for its author, no private answer, note, history or support question reaches an Evry read, draft, proposal, execution, its context, tools, logs or model capture", async () => {
	const k = careCase("B03-033");
	const input = k.action.arguments as { private_note: string; adapters: string[] };
	const canary = input.private_note;
	assert.deepEqual(input.adapters, ["read", "draft", "propose", "execute", "log", "evaluation"]);
	const w = await f.workspace();
	const a = await seated(w, "owner");
	const strip = await answered(
		a,
		k,
		HARD_RUN.map((monday, i): [string, Answers] => [
			monday,
			{ ...STRAINED, pace: i === 1 ? "struggling" : "strained" },
		]),
	);
	const week = strip.weeks[0]!;
	ok(await correct(a, week.id, STRAINED, strip.revision, canary));
	const shown = ok(await trends(a));
	assert.equal(shown.support.question, true);
	assert.equal(shown.weeks[0]!.answer!.note, canary);
	const actor = evryActor(a.actor);
	const care = (operation: string, payload: unknown = {}): Call => ({
		tool: "intelligence_read",
		input: { operation, input: payload },
	});
	const propose = (operation: string, payload: unknown): Call => ({
		tool: "propose_change",
		input: { operation, input: payload },
	});
	const calls = {
		read: [
			care("privateCare.readCurrent"),
			care("privateCare.readTrends"),
			care("privateCare.readHistory", { page: 1 }),
			care("privateCare.readSupportNudge"),
		],
		draft: [propose("privateCare.save", { answers: STEADY, note: "" })],
		propose: [
			propose("privateCare.correct", { weekId: randomUUID(), answers: STEADY, note: "" }),
			propose("tasks.create", { title: "Plan the next team night" }),
		],
	};
	const offered: string[] = [];
	const prompts: string[] = [];
	const fetched = { n: 0 };
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => {
		fetched.n++;
		throw new Error("no provider call from this test");
	}) as typeof fetch;
	const ran = await captureConsole(async () => {
		const conversationId = (await createConversation(f.db, actor, { requestKey: randomUUID() })).id;
		await submitTurn(f.db, actor, conversationId, {
			requestKey: randomUUID(),
			text: "Show my weekly check-in and its support question, then draft and propose a change to it",
			references: [],
		});
		const [claim] = await claimDue(f.db, ["assistant_turn"], 1, 240);
		assert.ok(claim);
		const outcome = await runTurn(
			{
				db: f.db,
				model: probing([...calls.read, ...calls.draft, ...calls.propose], offered, prompts),
				freshActor: async (session) => {
					const viewer = await readViewer(f.db, session as never);
					return viewer?.authority ? evryActor(viewer.authority, viewer.discovery) : null;
				},
			},
			{
				turnId: claim.id,
				tenantId: claim.tenant_id,
				leaseOwner: claim.lease_owner,
				generation: claim.claim_generation,
			},
			{ claimStart: new Date(), claimEnd: new Date() },
		);
		await transaction(f.db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		assert.equal(outcome, "succeeded");
		const proposals = await rows<{ id: string; operation: string }>(
			sql`SELECT id::text,operation FROM proposal WHERE conversation_id=${conversationId}::uuid ORDER BY created_at`,
		);
		assert.deepEqual(
			proposals.map((p) => p.operation),
			["tasks.create"],
			"no private care proposal is staged",
		);
		const review = await readReview(f.db, actor, proposals[0]!.id);
		await approveProposal(f.db, actor, review.id, { revision: review.revision, digest: review.digest }, null);
		const [effect] = await claimDue(f.db, ["evry_effect"], 1, 60);
		assert.ok(effect);
		const executed = await executeProposal(
			f.db,
			{
				jobId: effect.id,
				tenantId: effect.tenant_id,
				leaseOwner: effect.lease_owner,
				generation: effect.claim_generation,
			},
			{ reminders: async () => undefined, phaseNotices: async () => undefined },
		);
		await transaction(f.db, (tx) => finishClaim(tx, effect, { state: executed === "failed" ? "failed" : "succeeded" }));
		assert.equal(executed, "completed");
		return {
			events: (await readConversation(f.db, actor, conversationId)).events,
			proposals: await rows(sql`SELECT * FROM proposal WHERE conversation_id=${conversationId}::uuid`),
			executed: await readReview(f.db, actor, proposals[0]!.id),
		};
	}).finally(() => {
		globalThis.fetch = realFetch;
	});
	const { events, proposals, executed } = ran.value;
	const results = events.flatMap((e) =>
		e.kind === "tool_result"
			? [[String(e.body.operation), (e.body.result as { status?: string })?.status ?? null]]
			: [],
	);
	assert.deepEqual(
		results.filter(([op]) => /privateCare/.test(op!)),
		[],
		"no private care read result is saved",
	);
	assert.deepEqual([executed.status, executed.outcome], ["approved", "completed"]);
	const tools = [...new Set(offered)];
	assert.ok(tools.includes("intelligence_read") && tools.includes("propose_change"));
	const catalog = readCatalog(evryActor(a.actor));
	const offeredOperations = JSON.stringify([
		catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
		catalog.reviewedWrites.map((o) => o.operation),
		tools,
	]);
	const outputs = {
		read: events.filter((e) => e.kind === "tool_result" || e.kind === "assistant_text"),
		draft: proposals,
		propose: events,
		execute: executed,
		log: ran.logged,
		evaluation: prompts,
	};
	const assistant = events.flatMap((e) => (e.kind === "assistant_text" ? [String(e.body.text)] : []));
	assert.ok(assistant.length > 0, "the scripted model saw and echoed every tool result");
	type Sent = {
		role: string;
		content: { type: string; toolName?: string; output?: { type: string; value: unknown } }[];
	};
	const replies = (JSON.parse(prompts.at(-1)!) as [Sent[]])[0]
		.filter((m) => m.role === "tool")
		.flatMap((m) => m.content.map((c) => [c.toolName, c.output!.type]));
	assert.deepEqual(
		replies,
		[...calls.read, ...calls.draft, ...calls.propose].map((c) => [
			c.tool,
			c.input.operation.startsWith("privateCare.") ? "error-text" : "json",
		]),
		"every private read, draft and proposal is refused before any adapter runs",
	);
	const privateValues = [canary, week.id!, shown.support.text!, "strained", "struggling", "private_week"];
	const hits = Object.entries(outputs).flatMap(([adapter, out]) =>
		privateValues.filter((v) => JSON.stringify(out).includes(v)).map((v) => `${adapter}: ${v}`),
	);
	assert.deepEqual(
		{
			private_values_in_outputs: hits.length,
			private_tools: offeredOperations.match(/privateCare|private.?care|readSupportNudge/gi) ?? [],
		},
		k.expected.result,
		hits.join("; "),
	);
	assert.equal(fetched.n, 0, "the scripted model is the only model; no provider is called");
	assert.equal((k.expected as { event?: unknown }).event, null);
});
