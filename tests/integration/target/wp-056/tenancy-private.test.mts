import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { evryActor } from "../../../../packages/evry/src/context/actor.ts";
import { READ_DOMAINS, readCatalog } from "../../../../packages/evry/src/catalog/catalog.ts";
import { ok, refusedWith } from "../../../support/fixture.mts";
import { caseOf } from "../sql/core/support.mts";
import { CARE_NOTE, KINDS, randomIds, settled, VIEWERS, world, type Ids, type World } from "./private-support.mts";

const OWN_NOTE = "ownadmincarenote";
const bare = refusedWith({ details: {} });
let w: World;
let operator: RequestActor;

before(async () => {
	w = await world("tenancy_private");
	await w.actions.writeCare();
	await w.actions.writeCare("admin", OWN_NOTE);
	const seat = await w.c.database.actor(null, "owner");
	for (const capability of ["recovery_operator", "assessment_operator", "feedback_triage"])
		await w.admin.execute(sql`INSERT INTO platform_grant(account_id,capability) VALUES(${seat.id},${capability})`);
	const found = await RequestActor.resolve(w.db, seat.session);
	assert.ok(found instanceof RequestActor);
	operator = found;
});
after(() => w?.close());

const marked = (value: unknown) => {
	const text = JSON.stringify(value ?? null);
	return { body: text.includes(CARE_NOTE), week: text.includes(w.ids.week) };
};

test("AC:TEN-006 another Owner or Admin of the plant, its Members, the sending church, another church, a platform operator and Evry never read the author's check-in, its week, history or existence", async () => {
	const c = caseOf("schema", "TEN-006");
	assert.deepEqual(c.given["behavior-inputs"], {
		fixture_type: "behavior_inputs",
		caller: "A",
		requested_private_author: "B",
	});
	const A = w.who.admin;
	const B = w.who.author;
	const authorId = B.actor.accountId;
	const own = ok(await w.care.readCurrent(w.db, B, {}));
	assert.equal(own.week.answer!.note, CARE_NOTE);
	assert.equal(own.week.id, w.ids.week);

	const forged = { author: authorId };
	bare(await w.care.readCurrent(w.db, A, forged), "invalid_input");
	bare(await w.care.readHistory(w.db, A, { page: 1, ...forged }), "invalid_input");
	bare(await w.care.readTrends(w.db, A, forged), "invalid_input");
	const current = ok(await w.care.readCurrent(w.db, A, {}));
	const history = ok(await w.care.readHistory(w.db, A, { page: 1 }));
	const trends = ok(await w.care.readTrends(w.db, A, {}));
	assert.equal(current.week.answer!.note, OWN_NOTE);
	assert.notEqual(current.week.id, w.ids.week);
	const correct = (weekId: string) =>
		w.care.correct(w.db, A, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				weekId,
				answers: { spiritual: "steady", family: "steady", financial: "steady", pace: "steady" },
				note: "",
			},
		});
	const guessed = await correct(w.ids.week);
	bare(guessed, "not_found");
	const strip = (r: typeof guessed) =>
		r.status === "refused" ? { ...r, error: { ...r.error, correlationId: null } } : r;
	assert.deepEqual(strip(guessed), strip(await correct(randomUUID())));
	const seen = [current, history, trends].map(marked);
	assert.deepEqual(
		{
			private_body: seen.some((s) => s.body) ? CARE_NOTE : null,
			private_week: marked(current).week ? w.ids.week : null,
			private_history: marked(history).body || marked(history).week ? history : null,
		},
		c.expected.result,
	);
	assert.deepEqual(seen, [
		{ body: false, week: false },
		{ body: false, week: false },
		{ body: false, week: false },
	]);
	assert.equal(ok(await w.care.readCurrent(w.db, B, {})).week.answer!.note, CARE_NOTE, "the guess changed nothing");

	for (const v of ["member", "lead", "director", "staff"] as const) {
		bare(await w.care.readCurrent(w.db, w.who[v], {}), "access_denied");
		bare(await w.care.readCurrent(w.db, w.who[v], forged), "access_denied");
		bare(await w.care.readHistory(w.db, w.who[v], { page: 1 }), "access_denied");
		bare(await w.care.readTrends(w.db, w.who[v], {}), "access_denied");
	}
	const elsewhere = w.who.foreign;
	bare(await w.care.readCurrent(w.db, elsewhere, forged), "invalid_input");
	const elsewhereNow = ok(await w.care.readCurrent(w.db, elsewhere, {}));
	const outside = [
		elsewhereNow,
		ok(await w.care.readHistory(w.db, elsewhere, { page: 1 })),
		ok(await w.care.readTrends(w.db, elsewhere, {})),
	];
	assert.equal(elsewhereNow.week.answer, null);
	assert.deepEqual(
		outside.map(marked),
		seen.map(() => ({ body: false, week: false })),
	);
	for (const read of [
		w.care.readCurrent(w.db, operator, {}),
		w.care.readCurrent(w.db, operator, forged),
		w.care.readHistory(w.db, operator, { page: 1 }),
		w.care.readTrends(w.db, operator, {}),
	])
		bare(await read, "access_denied");

	const leaks: string[] = [];
	for (const v of VIEWERS.filter((x) => x !== "author"))
		for (const kind of KINDS) {
			const routes = await w.read(v, kind, w.ids);
			for (const [route, value] of Object.entries(routes)) {
				const m = marked(value);
				if (m.body || m.week) leaks.push(`${v} ${kind} ${route}`);
			}
		}
	assert.deepEqual(leaks, [], "no route, notification, digest, export, summary or Evry read discloses the check-in");
	const missing: Ids = { ...w.ids, week: randomIds().week };
	for (const kind of KINDS)
		assert.deepEqual(
			settled(await w.read("admin", kind, w.ids), w.ids),
			settled(await w.read("admin", kind, missing), missing),
			`the author's week and a week that never existed answer A the same on ${kind}`,
		);

	const tools = JSON.stringify({
		catalog: [B, A, operator].map((who) => readCatalog(evryActor(who))),
		reads: READ_DOMAINS,
		generated: JSON.parse(
			readFileSync(new URL("../../../../docs/catalog/evry-tools.json", import.meta.url), "utf8"),
		) as unknown,
	});
	assert.deepEqual(
		tools.replace(/"private care"/g, "").match(/privateCare|private.?care|private_week|weekly check-?in/gi),
		null,
		"no model tool reads private care",
	);
	assert.equal((c.expected as { event?: unknown }).event, null);
});
