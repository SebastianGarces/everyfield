import "../../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { instant } from "../../../../packages/contracts/src/common/index.ts";
import type { CareReply } from "../../../../packages/contracts/src/intelligence/index.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { createPrivateCare, personalCalendar } from "../../../../packages/domain/src/intelligence/index.ts";
import { timezoneOperations } from "../../../../packages/domain/src/settings/index.ts";
import { enqueueJob } from "../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { ok, refusedWith } from "../../../support/fixture.mts";
import { fixture, type Fixture } from "../../identity/invitations-support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "SCHEMA-007") ?? assert.fail("no SCHEMA-007");
const entry = c.given["care-A"]!;
const LEVEL: Record<string, string> = { Strained: "strained", Struggling: "struggling" };

let f: Fixture;
let now = c.clock.now;
const care = createPrivateCare({ clock: { now: () => instant.parse(now) } });
const tz = timezoneOperations(
	{
		replan: (tx, i) =>
			enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "digest",
				subject: i.owner.id,
				key: `care-case/digest/${i.operationId}/${i.revision}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			}),
	},
	personalCalendar,
	{ now: () => instant.parse(now) },
);
before(async () => {
	f = await fixture({ clock: new Date(c.clock.now) });
});
after(() => f?.close());

const refusedBare = refusedWith({ details: {} });
const bare = <T,>(r: CareReply<T>) =>
	r.status === "refused" ? { ...r, error: { ...r.error, correlationId: null } } : r;
const rows = async (q: SQL) => (await f.admin.execute(q)).rows;
const one = async (q: SQL) => (await rows(q))[0]!;
const answers = (level: string) => ({ spiritual: level, family: "steady", financial: "steady", pace: "steady" });

test("AC:SCHEMA-007 a check-in keeps its original author, ordinal and zone, another Admin sees neither its body nor that it exists, a missing middle week ends a mixed run, and repeated zone edits leave one pending transition", async () => {
	const w = await f.workspace();
	const seated = async (role: "admin" | "owner", zone: string) => {
		const a = await f.account();
		await f.seat(a, w, role);
		await f.admin.execute(sql`UPDATE account SET personal_timezone=${zone} WHERE id=${a.id}`);
		return { ...a, actor: await f.actor(a.session) };
	};
	const A = await seated("admin", String(entry.zone));
	const B = await seated("admin", "Pacific/Auckland");
	type Who = typeof A;
	const revisionOf = async (who: Who) => ok(await care.readCurrent(f.db, who.actor, {})).revision;
	const save = async (who: Who, level: string) =>
		care.save(f.db, who.actor, {
			requestKey: randomUUID(),
			expectedRevision: await revisionOf(who),
			input: { answers: answers(level), note: String(entry.note ?? "CARE-CANARY-SCHEMA-007") },
		});
	const ctx = (who: Who) => ({ session: who.session, selected: { kind: "account" as const, id: who.id } });
	const preview = async (who: Who, timeZone: string) =>
		ok(await gatedTransaction(f.db, (tx) => tz.previewPersonalTimezone(tx, ctx(who), { timeZone })));
	const setZone = (who: Who, p: Awaited<ReturnType<typeof preview>>) =>
		gatedTransaction(f.db, (tx) =>
			tz.setPersonalTimezone(tx, ctx(who), {
				requestKey: randomUUID(),
				expectedRevision: p.expectedRevision,
				input: { timeZone: p.newZone, previewId: p.previewId, confirmed: true },
			}),
		);

	const levels = (entry.answers as (string | null)[]).map((x) => (x ? LEVEL[x]! : null));
	const first = ok(await save(A, levels[0]!));
	assert.deepEqual(
		[first.week.ordinal, first.week.startsOn, first.week.zone],
		[entry.ordinal, entry.start, entry.zone],
	);
	now = "2026-10-27T16:00:00.000Z";
	for (const zone of ["Pacific/Auckland", "America/Chicago", "Pacific/Auckland"])
		ok(await setZone(A, await preview(A, zone)));
	const revision = await revisionOf(A);
	const race = await preview(A, "Pacific/Kiritimati");
	const [answered, zoned] = await Promise.all([
		care.save(f.db, A.actor, {
			requestKey: randomUUID(),
			expectedRevision: revision,
			input: { answers: answers(levels[2]!), note: "" },
		}),
		setZone(A, race),
	]);
	assert.equal([answered, zoned].filter((r) => r.status === "ok").length, 1, JSON.stringify([answered, zoned]));
	if (answered.status !== "ok") ok(await save(A, levels[2]!));
	const strip = ok(await care.readTrends(f.db, A.actor, {}));
	assert.deepEqual(
		strip.weeks.map((x) => [x.ordinal, x.zone, x.answer?.answers.spiritual ?? null]),
		[
			[3, entry.zone, levels[2]],
			[2, entry.zone, levels[1]],
			[1, entry.zone, levels[0]],
		],
	);
	const run = strip.weeks.findIndex((x) => x.answer === null || x.answer.answers.spiritual === "steady");
	const calendar = await rows(sql`SELECT c.zone,c.next_at,
		(SELECT zone FROM private_week w WHERE w.author_id=c.author_id ORDER BY ordinal DESC LIMIT 1) AS open_zone
		FROM private_calendar c WHERE c.author_id=${A.id}`);
	assert.equal(calendar.length, 1);
	assert.notEqual(calendar[0]!.zone, calendar[0]!.open_zone);

	const stored = async () =>
		rows(sql`SELECT to_jsonb(w) AS week,(SELECT json_agg(r ORDER BY r.revision) FROM private_week_revision r WHERE r.week_id=w.id) AS revisions
			FROM private_week w WHERE w.author_id=${A.id} ORDER BY w.ordinal`);
	const before = await stored();
	const guessed = await care.correct(f.db, B.actor, {
		requestKey: randomUUID(),
		expectedRevision: "0",
		input: { weekId: first.week.id, answers: answers("steady"), note: "" },
	});
	const missing = await care.correct(f.db, B.actor, {
		requestKey: randomUUID(),
		expectedRevision: "0",
		input: { weekId: randomUUID(), answers: answers("steady"), note: "" },
	});
	refusedBare(guessed, "not_found");
	assert.deepEqual(bare(guessed), bare(missing));
	for (const author of [A.id, randomUUID()]) {
		refusedBare(await care.readCurrent(f.db, B.actor, { author }), "invalid_input");
		refusedBare(await care.readHistory(f.db, B.actor, { page: 1, author }), "invalid_input");
		refusedBare(
			await care.correct(f.db, B.actor, {
				requestKey: randomUUID(),
				expectedRevision: "1",
				input: {
					weekId: first.week.id,
					answers: answers("steady"),
					note: "",
					author,
					ordinal: c.action.arguments.attempted_ordinal,
				},
			}),
			"invalid_input",
		);
	}
	const historyOfB = ok(await care.readHistory(f.db, B.actor, { page: 1 }));
	const seenByB = [
		ok(await care.readCurrent(f.db, B.actor, {})),
		historyOfB,
		ok(await care.readTrends(f.db, B.actor, {})),
	];
	const text = JSON.stringify(seenByB);
	const body = text.includes(String(entry.note ?? "CARE-CANARY")) || text.includes("strained") ? text : null;
	const existence =
		[first.week.id, A.id].some((id) => text.includes(id!)) || historyOfB.weeks.some((x) => x.id !== null) ? text : null;

	const immutable = async (change: SQL) => {
		try {
			await f.admin.execute(change);
			return false;
		} catch (e) {
			assert.match(String((e as Error).cause ?? e), /immutable_source_evidence/);
			return true;
		}
	};
	const authorFrozen = [
		await immutable(sql`UPDATE private_week SET author_id=${B.id} WHERE id=${first.week.id}`),
		await immutable(sql`UPDATE private_week_revision SET author_id=${B.id} WHERE week_id=${first.week.id}`),
		await immutable(sql`UPDATE private_calendar SET author_id=${B.id} WHERE author_id=${A.id}`),
	].every(Boolean);
	const ordinalFrozen = await immutable(
		sql`UPDATE private_week SET ordinal=${Number(c.action.arguments.attempted_ordinal)} WHERE id=${first.week.id}`,
	);
	assert.equal(await immutable(sql`UPDATE private_week SET zone='UTC' WHERE id=${first.week.id}`), true);
	await assert.rejects(
		f.admin.execute(sql`INSERT INTO private_week(author_id,plant_id,ordinal,zone,starts_on,ends_on,starts_at)
			VALUES(${B.id},${w.id},9,'America/Chicago','2026-12-07','2026-12-13','2026-12-07T06:00:00Z')`),
		(e: Error) => /private_week_fk_0|foreign key/.test(String(e.cause ?? e)),
	);
	const triggers = await rows(sql`SELECT c.relname AS t,pg_get_triggerdef(g.oid) AS def FROM pg_trigger g
		JOIN pg_class c ON c.oid=g.tgrelid WHERE c.relname IN ('private_week','private_week_revision','private_calendar')
		AND NOT g.tgisinternal ORDER BY 1`);
	for (const [table, fields] of [
		["private_calendar", ["author_id", "plant_id"]],
		["private_week", ["author_id", "ordinal", "zone", "starts_on"]],
		["private_week_revision", ["author_id"]],
	] as const) {
		const def = String(triggers.find((t) => t.t === table)?.def);
		for (const field of fields) assert.match(def, new RegExp(`freeze_fields\\('[^']*\\b${field}\\b`), table);
	}
	assert.deepEqual(await stored(), before);
	const original = await one(sql`SELECT zone FROM private_week WHERE id=${first.week.id}`);

	assert.deepEqual(
		{
			author_immutable: authorFrozen,
			ordinal_immutable: ordinalFrozen,
			original_zone: original.zone,
			other_author_body: body,
			other_author_existence: existence,
			mixed_streak: run < 0 ? strip.weeks.length : run,
			pending_zone_transitions: calendar.filter((x) => x.zone !== x.open_zone).length,
		},
		c.expected.result,
	);
	assert.equal(c.expected.event, null);
});
