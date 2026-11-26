import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { approveProposal } from "../../../packages/evry/src/index.ts";
import {
	caseWorld,
	propose,
	proposes,
	read,
	reads,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Play,
} from "./case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("casepeople");
});
after(() => w?.close());

const crowd = (plant: string, n: number, stage: string) =>
	w.admin
		.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		SELECT ${plant}::uuid,${plant}::uuid,'Match '||lpad(n::text,3,'0'),'other',clock_timestamp(),${stage},'unknown','unknown',500+n,'live' FROM generate_series(1,${n}::int) n`);
const signed = (reply: unknown) => rowsOf(reply).filter((r) => r.fields.record === "commitment");
const labels = (reply: unknown) => rowsOf(reply).map((r) => r.label);

async function commitment(c: Church, person: string, signedOn: string, plant = c.P.id) {
	const id = randomUUID();
	const object = randomUUID();
	const key = `private/${plant}/${object}`;
	await w.admin
		.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
		VALUES(${object},${plant},'commitment',${key},'application/pdf',2048,2048,${"0".repeat(64)},'ready',${object},0)`);
	await w.admin.execute(sql`INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at,object_id)
		VALUES(${id},${plant},${person},'core_group',${signedOn},clock_timestamp(),${object})`);
	return { id, key, href: `/people/${person}/commitments/${id}/document` };
}

test("AC:GAP-EVR-400 a selection reuses only the people this turn returned, with the count they came from, and never a ministry row", async () => {
	const c = await w.church();
	await w.admin.execute(sql`UPDATE person SET stage='leader' WHERE id=${c.rivera}`);
	await w.admin.execute(sql`UPDATE person SET display_name='Alex' WHERE id=${c.rivera}`);
	await w.admin.execute(sql`UPDATE person SET display_name='Casey' WHERE id=${c.casey}`);
	await crowd(c.P.id, 198, "leader");
	const worship = randomUUID();
	await w.admin.execute(
		sql`INSERT INTO team(id,plant_id,name,state,sort_order) VALUES(${worship},${c.P.id},'Worship','active',1)`,
	);
	const said = "Select Alex result and attempt combining team row as Person";
	const play: Play = [
		() => [read("people.listPeople", { stages: ["leader"], limit: 2 }), read("teams.list")],
		(r) => ({ tool: "select_returned_rows", input: { resultId: r[0].resultId, ids: [c.rivera, worship] } }),
		(r) => ({ tool: "select_returned_rows", input: { resultId: r[1].resultId, ids: [worship] } }),
		(r) => ({ tool: "select_returned_rows", input: { resultId: r[0].resultId, ids: [c.rivera] } }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play, { onError: "go_on" }));
	const [people, teams, mixed, team, selected] = asked.replies;
	assert.deepEqual([labels(people), people.total], [["Alex", "Casey"], 200]);
	assert.deepEqual([labels(teams), rowsOf(teams)[0].kind], [["Worship"], "team"]);
	assert.deepEqual(
		[mixed, team],
		[
			{ error: "not_returned", rejected: 1 },
			{ error: "not_returned", rejected: 1 },
		],
	);
	assert.deepEqual([labels(selected), selected.total], [["Alex"], 1]);
	const saved = asked.cards.filter((card) => card.operation === "evry.selectReturnedRows");
	assert.deepEqual(
		saved.map((card) => [rowsOf(card.result).map((r) => r.id), card.originalTotal, card.result.exclusions]),
		[[[c.rivera], 200, ["selected from 200 matched"]]],
	);
	await c.foreign(said, play, { secrets: ["Worship", "Match 001"] });
	await c.outage(said, play, "team");
});

test("AC:GAP-EVR-423 AC:INH-COMMITMENTS-03 the exact commitment gives its PDF by an access-checked link, never a storage key, and another church's or a Member's is not found", async () => {
	const c = await w.church();
	await commitment(c, c.rivera, "2026-09-01");
	const latest = await commitment(c, c.rivera, "2026-10-01");
	const other = await commitment(c, c.chen, "2026-10-05");
	const stranger = await c.person("Alex Rivera", { plant: c.Q.id, city: "Peoria" });
	const D = await commitment(c, stranger, "2026-10-06", c.Q.id);
	const resolve: Play = [
		reads("people.listPeople", { search: "Alex Rivera" }),
		(r) => read("people.getCommitments", { personId: rowsOf(r[0])[0].id }),
		(r) => read("people.getCommitmentDownload", { commitmentId: signed(r[1])[0].id }),
		reads("people.getCommitmentDownload", { commitmentId: D.id }),
	];
	for (const said of ["Resolve exact commitment and request document", "Show Alex's commitment document."]) {
		const asked = await w.quiet(() => w.ask(c.A, said, resolve));
		const [found, cards, download, forbidden] = asked.replies;
		assert.deepEqual([rowsOf(found).map((r) => r.id), found.total], [[c.rivera], 1]);
		assert.deepEqual([signed(cards).length, signed(cards)[0].id], [2, latest.id], "the latest comes first");
		assert.deepEqual(
			rowsOf(download).map((r) => [r.id, r.fields.href, r.fields.mediaType]),
			[[latest.id, latest.href, "application/pdf"]],
		);
		assert.deepEqual([forbidden.status, forbidden.rows, forbidden.total], ["not_found", [], 0]);
		const told = JSON.stringify([asked.prompts, asked.saved, asked.cards]);
		for (const secret of [latest.key, D.key, "Peoria", "X-Amz", "https://"])
			assert.equal(JSON.stringify(asked.replies).includes(secret), false, secret);
		for (const secret of [latest.key, D.key, "Peoria"]) assert.equal(told.includes(secret), false, secret);
		const [file] = await w.rows<{ object_id: string }>(sql`SELECT object_id FROM commitment WHERE id=${latest.id}`);
		await w.admin.execute(sql`UPDATE commitment SET object_id=NULL WHERE id=${latest.id}`);
		const gone = await w.ask(c.A, said, [reads("people.getCommitmentDownload", { commitmentId: latest.id })]);
		assert.deepEqual(gone.replies[0].rows, [], "a link from before is not given again once its file is gone");
		await w.admin.execute(sql`UPDATE commitment SET object_id=${file!.object_id} WHERE id=${latest.id}`);
		const member = await w.seated(c.P, "member");
		const denied = await w.quiet(() =>
			w.ask(member, said, [reads("people.getCommitmentDownload", { commitmentId: other.id })]),
		);
		assert.equal(denied.offered.includes("people.getCommitmentDownload"), false);
		assert.equal(denied.cards.length, 0);
		await c.foreign(said, resolve, { secrets: [latest.key, latest.href], found: ["Alex Rivera"] });
		await c.outage(said, resolve, "commitment");
	}
});

test("AC:INH-CROSS-06 200 matches report the exact total and one page of 100 with the next page, never 200 profiles", async () => {
	const c = await w.church();
	await w.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id=${c.casey}`);
	await crowd(c.P.id, 200, "launch_team");
	const said = "Show all 200 matches and tell me the exact total.";
	const play: Play = [reads("people.listPeople", { stages: ["launch_team"], limit: 100 })];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	const [page] = asked.cards;
	assert.equal(
		await w.count(
			sql`SELECT count(*)::int AS n FROM person WHERE plant_id=${c.P.id} AND stage='launch_team' AND state='live'`,
		),
		200,
	);
	assert.deepEqual(
		[page!.result.total, page!.result.rows.length, page!.result.completeness, page!.result.next],
		[200, 100, "partial", 2],
	);
	assert.equal(asked.prompts.at(-1)!.match(/Match \d{3}/g)!.length, 100);
	assert.equal(new Set(asked.replies[0].rows.map((r: { id: string }) => r.id)).size, 100);
	await c.foreign(said, play, { secrets: ["Match 001"] });
	await c.outage(said, play, "person");
});

test("AC:INH-EDGES-01 two people named Alex come back once as two choices with safe fields only, and nothing is picked or written", async () => {
	const c = await w.church();
	await w.admin.execute(
		sql`UPDATE person SET email='alex.r@example.test',phone='555-0100',notes='Private note' WHERE id=${c.rivera}`,
	);
	const said = "Find Alex. There are two people named Alex.";
	const play: Play = [reads("people.listPeople", { search: "Alex" })];
	const asked = await w.quiet(() => w.ask(c.A, said, play));
	assert.equal(asked.cards.length, 1, "one clarification");
	assert.deepEqual(
		rowsOf(asked.cards[0]!.result).map((r) => ({ id: r.id, name: r.label, ...r.fields })),
		[
			{ id: c.rivera, name: "Alex Rivera", city: "Chicago", stage: "prospect" },
			{ id: c.chen, name: "Alex Chen", city: "Evanston", stage: "prospect" },
		],
	);
	assert.deepEqual([asked.proposals, asked.status.state], [[], "completed"]);
	assert.doesNotMatch(JSON.stringify([asked.prompts, asked.saved]), /alex\.r@|555-0100|Private note/);
	assert.match(asked.prompts.at(-1)!, /When a name matches more than one person, ask once which one/);
	await c.foreign(said, play, { secrets: ["Rivera"] });
	await c.outage(said, play, "person");
});

test("AC:INH-EDGES-03 a guessed Person id of another church is not found, with no row, total or citation", async () => {
	const c = await w.church();
	const Q1 = await c.person("Quinn Foreign", { plant: c.Q.id, city: "Peoria" });
	const said = `Show people from another plant using this person ID. ${Q1}`;
	const play: Play = [reads("people.getPerson", { personId: Q1 }), reads("people.listPeople")];
	const asked = await w.quiet(() =>
		w.ask(c.A, said, play, {
			references: [
				{ kind: "person", id: Q1 },
				{ kind: "person", id: c.rivera },
			],
		}),
	);
	const [one, own] = asked.replies;
	assert.deepEqual([one.status, one.rows, one.total], ["not_found", [], 0]);
	assert.deepEqual([own.total, labels(own).includes("Quinn Foreign")], [3, false]);
	assert.doesNotMatch(JSON.stringify([asked.prompts, asked.saved]), /Quinn|Peoria/);
	const verified = /Verified references on the user's page: (\[.*?\])/.exec(
		JSON.parse(asked.prompts.at(-1)!)[0].content,
	)![1]!;
	assert.deepEqual(JSON.parse(verified), [{ kind: "person", id: c.rivera, label: "Alex Rivera" }]);
	const unknown = await w.ask(c.A, said, [reads("people.getPerson", { personId: randomUUID() })]);
	const bare = ({ resultId: _, ...rest }: Record<string, unknown>) => rest;
	assert.deepEqual(bare(one), bare(unknown.replies[0]), "another church's id answers as an unknown one");
	const mine: Play = [reads("people.getPerson", { personId: c.casey })];
	await c.foreign("Show people from another plant using this person ID.", mine);
	await c.outage(said, play, "person");
});

const NOTE = "Called today; prefers an evening interview.";
test("AC:INH-NOTES-05 the exact reviewed note is saved once, by its author and to no meeting, only after approval", async () => {
	const c = await w.church();
	const said = `Add this note to Alex: '${NOTE}'`;
	const play: Play = [
		reads("people.listPeople", { search: "Rivera" }),
		(r) => propose("people.addNote", { personId: rowsOf(r[0])[0].id, body: NOTE }),
	];
	const notes = () => w.rows(sql`SELECT person_id,author_id,body,plant_id FROM person_note WHERE plant_id=${c.P.id}`);
	const asked = await w.ask(c.A, said, play);
	const [card] = asked.proposals;
	assert.deepEqual(
		[card!.status, card!.review.target, card!.review.changes],
		["pending", { kind: "person", id: c.rivera, label: "Alex Rivera" }, [{ field: "note", before: null, after: NOTE }]],
	);
	assert.deepEqual(await notes(), [], "nothing is saved before approval");
	const done = await w.approve(c.A, card!);
	assert.deepEqual([done.outcome, done.review.outcome], ["completed", "completed"]);
	const again = await approveProposal(w.db, await w.actorOf(c.A), card!.id, w.witness(card!), null);
	assert.deepEqual([again.replayed, await w.effect()], [true, null]);
	assert.deepEqual(await notes(), [{ person_id: c.rivera, author_id: c.A.id, body: NOTE, plant_id: c.P.id }]);
	const [activity] = rowsOf(
		(await w.ask(c.A, "What happened with Alex?", [reads("people.getActivities", { personId: c.rivera })])).replies[0],
	);
	assert.deepEqual([activity.label, activity.fields.kind], ["Note", "note"]);
	assert.equal(
		Object.keys(activity.fields).some((f) => /meeting/i.test(f)),
		false,
		"the note names no meeting",
	);
	await c.foreign(said, [proposes("people.addNote", { personId: c.rivera, body: NOTE })]);
	await c.outage(said, play, "person");
	assert.equal((await notes()).length, 1);
});

test("AC:INH-REGRESSION-CLARIFICATION-NAME which Alex is asked once, the note's exact words stay in the conversation, and nothing is saved or approved before the choice", async () => {
	const c = await w.church();
	const said = "Prepare a note for Alex: Called today.";
	const play: Play = [
		reads("people.listPeople", { search: "Alex" }),
		() => ({ tool: "update_planning_notes", input: { notes: "Note for Alex: Called today", expectedRevision: 0 } }),
		() => "Which Alex do you mean?",
	];
	const audits = () =>
		w.count(sql`SELECT count(*)::int AS n FROM audit_event WHERE tenant_id=${c.P.id} AND action LIKE 'people.%'`);
	const saved = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM person_note WHERE plant_id=${c.P.id}) AS notes,
			(SELECT count(*)::int FROM proposal WHERE tenant_id=${c.P.id} AND approved_at IS NOT NULL) AS approved`);
	const before = await saved();
	const written = await audits();
	const asked = await w.ask(c.A, said, play);
	assert.equal(asked.cards.filter((card) => card.operation === "people.listPeople").length, 1);
	assert.deepEqual(
		rowsOf(asked.replies[0]).map((r) => [r.id, Object.keys(r.fields).sort()]),
		[
			[c.rivera, ["city", "stage"]],
			[c.chen, ["city", "stage"]],
		],
	);
	assert.deepEqual([asked.proposals, asked.text], [[], "Which Alex do you mean?"]);
	const chosen = await w.ask(
		c.A,
		"Alex Chen",
		[
			() => ({ tool: "read_planning_notes", input: {} }),
			proposes("people.addNote", { personId: c.chen, body: "Called today" }),
		],
		{ conversation: asked.conversation },
	);
	assert.match(chosen.prompts.at(-1)!, /Prepare a note for Alex: Called today\./);
	assert.deepEqual([chosen.replies[0].notes, chosen.replies[0].revision], ["Note for Alex: Called today", 1]);
	assert.deepEqual(
		[chosen.proposals[0]!.status, chosen.proposals[0]!.review.target?.id, chosen.proposals[0]!.review.changes],
		["pending", c.chen, [{ field: "note", before: null, after: "Called today" }]],
	);
	assert.deepEqual([await saved(), before.notes, await audits()], [before, 0, written]);
	await c.foreign(said, [reads("people.listPeople", { search: "Alex" })], { secrets: ["Rivera"] });
	await c.outage(said, play, "person");
});
