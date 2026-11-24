import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	approveProposal,
	createConversation,
	executeProposal,
	invokeRead,
	prepareProposal,
	readReview,
	reviseProposal,
	submitTurn,
	type EvryActor,
	type MailPort,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { ASSESSMENT_READS } from "../../../../packages/evry/src/adapters/people-assessments/reads/index.ts";
import { getPerson, listPeople } from "../../../../packages/evry/src/adapters/people/reads/index.ts";
import { getActivities } from "../../../../packages/evry/src/adapters/people-organization/reads/index.ts";
import { peopleMerge, peopleUnmerge } from "../../../../packages/domain/src/people/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../../packages/domain/src/jobs/queue.ts";
import { ok } from "../../../support/fixture.mts";
import { actor, admin, db, plant, setup, sql, teardown } from "../../runtime/support.mts";

before(setup);
after(teardown);

type Expected = { expected: { result: Record<string, unknown> }; name?: string };
function caseOf(id: string, file = "evry") {
	const all = JSON.parse(
		readFileSync(new URL(`../../../../docs/acceptance/${file}.json`, import.meta.url), "utf8"),
	) as {
		cases: (Expected & { id: string; subcases: Expected[] })[];
	};
	const found = all.cases.find((c) => c.id === id);
	assert.ok(found);
	return {
		main: found.expected.result,
		of: (name: string) => found.subcases.find((s) => s.name === name)?.expected.result,
	};
}
const rows = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows;
const reads = new Map(ASSESSMENT_READS.map((a) => [a.operation, a]));
const read = (who: EvryActor, operation: string, input: unknown) =>
	invokeRead(db, who, reads.get(operation)! as never, input as never);
async function addPerson(name: string, values: { email?: string; account?: string } = {}) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,created_at,stage,adult_classification,
		commitment_state,pipeline_position,state,email,linked_account_id) VALUES(${id},${plant},${plant},${name},'other',
		clock_timestamp()-interval '1 day','prospect','unknown','unknown',1000,'live',${values.email ?? null},${values.account ?? null}::uuid)`);
	return id;
}
async function turn(who: EvryActor, mail: MailPort | null = null) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return (operation: string, input: unknown) => prepareProposal(db, who, lease, c.id, { operation, input }, mail);
}
const approve = (who: EvryActor, p: Proposal) =>
	approveProposal(db, who, p.id, { revision: p.revision, digest: p.digest }, null);
async function run() {
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: async () => undefined, phaseNotices: async () => undefined },
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}
async function merge(who: EvryActor, sourceId: string, survivorId: string) {
	const context = { session: who.session, selected: who.owner } as never;
	const { reviewDigest } = ok(
		await gatedTransaction(db, (tx) => peopleMerge.getMergeReview(tx, context, { sourceId, survivorId })),
	);
	return ok(
		await gatedTransaction(db, (tx) =>
			peopleMerge.mergePeople(tx, context, {
				requestKey: randomUUID(),
				input: { sourceId, survivorId, reviewDigest },
			}),
		),
	);
}
async function unmerge(who: EvryActor, mergeId: string) {
	const context = { session: who.session, selected: who.owner } as never;
	const { reviewRevision } = ok(
		await gatedTransaction(db, (tx) => peopleUnmerge.previewUnmerge(tx, context, { mergeId })),
	);
	return ok(
		await gatedTransaction(db, (tx) =>
			peopleUnmerge.unmergePeople(tx, context, {
				requestKey: randomUUID(),
				expectedRevision: reviewRevision,
				input: { mergeId },
			}),
		),
	);
}
const stored = (id: string) =>
	rows(sql`SELECT input,review,digest,state,outcome,approved_at FROM proposal WHERE id=${id}`);
const peopleRows = (...ids: string[]) =>
	rows(sql`SELECT to_jsonb(p) AS row,(SELECT count(*)::int FROM person_note n WHERE n.person_id=p.id) AS notes,
		(SELECT count(*)::int FROM task t WHERE t.person_id=p.id) AS tasks FROM person p
		WHERE p.id=ANY(${sql.param(ids)}::uuid[]) ORDER BY p.id`);

test("AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-MERGE AC:PERSONREF-ASSISTANT-VERIFIED-CONTEXT-PROPOSAL-UNMERGE a draft prepared before a merge or Unmerge is never retargeted, approving it does nothing and Evry asks for another review", async () => {
	const owner = await actor("owner");
	const source = await addPerson("Alex Chen Draft"),
		survivor = await addPerson("Alex Rivera Draft");
	const propose = await turn(owner);
	const drafts = {
		source: await propose("people.updatePerson", { personId: source, patch: { city: "Elgin" } }),
		survivor: await propose("people.updatePerson", { personId: survivor, patch: { city: "Aurora" } }),
		note: await propose("people.addNote", { personId: source, body: "Met again" }),
		followUp: await propose("tasks.createFollowUp", { personId: source }),
	};
	for (const [name, draft] of Object.entries(drafts)) assert.ok(draft && !draft.stale, name);
	const prepared = new Map(
		await Promise.all(Object.values(drafts).map(async (d) => [d!.id, await stored(d!.id)] as const)),
	);
	const merged = await merge(owner, source, survivor);
	const afterMerge = await peopleRows(source, survivor);
	for (const [name, draft] of Object.entries(drafts)) {
		assert.ok(draft);
		const shown = await readReview(db, owner, draft.id);
		assert.deepEqual([shown.status, shown.stale], ["pending", "merge"], name);
		await assert.rejects(approve(owner, draft), { code: "review_changed" }, name);
		assert.deepEqual(await stored(draft.id), prepared.get(draft.id), name);
	}
	assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), []);
	assert.deepEqual(await peopleRows(source, survivor), afterMerge);

	const again = await reviseProposal(db, owner, drafts.survivor!.id, {
		operation: "people.updatePerson",
		revision: drafts.survivor!.revision,
		input: { personId: survivor, patch: { city: "Aurora" } },
	});
	assert.equal(again.stale, null, "reviewed again, so it can be approved");
	await unmerge(owner, merged.mergeId);
	assert.equal((await readReview(db, owner, again.id)).stale, "merge", "an Unmerge asks for a review too");
	await assert.rejects(approve(owner, again), { code: "review_changed" });
});

test("an invitation and an email drafted before a merge say the merge made them stale, and approving them adds nobody and sends nothing", async () => {
	const owner = await actor("owner");
	const source = await addPerson("Sage Source", { email: "sage.source@example.test" }),
		survivor = await addPerson("Sage Kept", { email: "sage.kept@example.test" });
	await admin.execute(
		sql`UPDATE plant SET street='12 Mill Road',city='Austin',country='United States' WHERE id=${plant}`,
	);
	const meeting = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision) VALUES(${meeting},${plant},'vision_meeting','Sage night','2030-11-01','18:00','America/Chicago',
		'2030-11-01T23:00:00Z','1','planning',1)`);
	const sent: unknown[] = [];
	const propose = await turn(owner, {
		keys: {
			encryptionKey: Buffer.alloc(32, 7),
			addressKey: Buffer.alloc(32, 9),
			from: "church@example.test",
			origin: "https://app.example.test",
		},
		transport: {
			paused: false,
			async send(batch) {
				sent.push(batch);
				return { outcome: "refused" };
			},
			cancel: async () => [],
			reschedule: async () => [],
		},
	});
	const audience = { groups: [], teamIds: [], personIds: [source] };
	const drafts = {
		invitation: await propose("evry.prepareMeetingInvitation", {
			meetingId: meeting,
			audience: { groups: [], householdIds: [], personIds: [source] },
		}),
		email: await propose("communication.saveDraft", { subject: "Hello", body: "Hello", audience }),
		send: await propose("communication.sendReviewed", { subject: "Hello", body: "Hello", audience }),
	};
	for (const [name, draft] of Object.entries(drafts)) {
		assert.ok(draft, name);
		assert.deepEqual([draft.review.refusal, draft.stale], [undefined, null], name);
	}
	const effects = () =>
		rows(sql`SELECT (SELECT count(*)::int FROM communication) AS messages,(SELECT count(*)::int FROM mail) AS mail,
			(SELECT count(*)::int FROM participation WHERE meeting_id=${meeting}) AS guests`);
	const before = await effects();
	await merge(owner, source, survivor);
	for (const [name, draft] of Object.entries(drafts)) {
		assert.ok(draft);
		assert.equal((await readReview(db, owner, draft.id)).stale, "merge", name);
		await assert.rejects(approve(owner, draft), { code: "review_changed" }, name);
	}
	assert.deepEqual(await claimDue(db, ["evry_effect"], 1, 60), []);
	assert.deepEqual([await effects(), sent], [before, []]);
});

test("a draft approved just before a merge is refused when it runs", async () => {
	const owner = await actor("owner");
	const source = await addPerson("Pat Approved"),
		survivor = await addPerson("Pat Kept");
	const propose = await turn(owner);
	const draft = await propose("people.addNote", { personId: survivor, body: "Late note" });
	assert.ok(draft);
	await approve(owner, draft);
	await merge(owner, source, survivor);
	assert.equal(await run(), "refused");
	assert.equal((await readReview(db, owner, draft.id)).receipt?.code, "revision_conflict");
	assert.equal((await rows(sql`SELECT count(*)::int AS n FROM person_note WHERE person_id=${survivor}`))[0]!.n, 0);
});

test("after a merge Evry answers about the survivor from the merged record and finds nobody under the merged id", async () => {
	const owner = await actor("owner");
	const source = await addPerson("Quincy Source"),
		survivor = await addPerson("Quincy Kept");
	await admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
		VALUES(${plant},${plant},${source},${owner.accountId},'Plays drums',clock_timestamp(),clock_timestamp())`);
	await merge(owner, source, survivor);
	const found = await invokeRead(db, owner, listPeople, { search: "Quincy" } as never);
	assert.deepEqual(
		found.rows.filter((r) => r.kind === "person").map((r) => r.id),
		[survivor],
	);
	const feed = await invokeRead(db, owner, getActivities, { personId: survivor } as never);
	assert.ok(feed.rows.some((r) => r.fields.kind === "note"));
	assert.ok(feed.rows.some((r) => r.label === "person_merged"));
	assert.equal(
		(await invokeRead(db, owner, getPerson, { personId: source } as never)).rows.some(
			(r) => r.kind === "person" && r.id === source && r.fields.state === "live",
		),
		false,
	);
});

test("AC:GAP-MTG-011 an ambiguous name returns every match to choose from and adds nobody", async () => {
	const owner = await actor("owner");
	const name = `Zephyr${randomUUID().slice(0, 6)}`;
	const ids: Record<string, string> = { Alex: await addPerson(name), "Alex-2": await addPerson(name) };
	const count = async () =>
		(
			await rows(sql`SELECT (SELECT count(*)::int FROM person) AS p,(SELECT count(*)::int FROM participation) AS a`)
		)[0]!;
	const start = await count();
	const found = await invokeRead(db, owner, listPeople, { search: name } as never);
	const candidates = found.rows.filter((r) => r.kind === "person").map((r) => r.id);
	const end = await count();
	assert.deepEqual(
		{
			status: candidates.length > 1 ? "needs_selection" : "resolved",
			candidate_ids: Object.keys(ids)
				.filter((k) => candidates.includes(ids[k]!))
				.sort(),
			people_added: Number(end.p) - Number(start.p),
			attendance_links_added: Number(end.a) - Number(start.a),
		},
		caseOf("GAP-MTG-011", "meetings-follow-up").of("ambiguous-alex-needs-selection"),
	);
});

test("two people with their own logins refuse in Evry with the reason and nothing changes", async () => {
	const owner = await actor("owner");
	const member = await actor("member");
	const a = await addPerson("Login One", { account: owner.accountId }),
		b = await addPerson("Login Two", { account: member.accountId });
	const before = await peopleRows(a, b);
	const propose = await turn(owner);
	const draft = await propose("people.mergePeople", { sourceId: a, survivorId: b });
	assert.ok(draft);
	assert.equal(
		draft.review.refusal,
		"This merge cannot run. Login One and Login Two both have an Everyfield account. Two accounts cannot become one person.",
	);
	await assert.rejects(approve(owner, draft), { code: "review_closed" });
	assert.deepEqual(await peopleRows(a, b), before);
});

const merges = (mergeId: string, survivor: string) =>
	rows(sql`SELECT (SELECT count(*)::int FROM audit_event WHERE subject_id=${survivor} AND action='people.unmerged' AND kind<>'noop') AS inverses,
		(SELECT count(*)::int FROM audit_event WHERE subject_id=${survivor} AND action='people.merged') AS merged,
		(SELECT unmerged_at IS NOT NULL FROM person_merge WHERE id=${mergeId}) AS unmerged`).then((r) => r[0]!);
const sends = () =>
	rows(sql`SELECT (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.id) FROM mail m) AS mail,
		(SELECT count(*)::int FROM mail_attempt) AS attempts,(SELECT count(*)::int FROM job WHERE kind='mail') AS jobs`);
const sentEmail = (person: string) =>
	admin.execute(sql`INSERT INTO mail(tenant_id,purpose,recipient_person_id,logical_key,payload_hash,audience_hash,state,sent_at,created_at)
		VALUES(${plant},'notification',${person},${"unmerge-" + randomUUID()},'p','a','sent',clock_timestamp(),clock_timestamp())`);
async function scene(name: string) {
	const owner = await actor("owner");
	const source = await addPerson(`${name} Source`),
		survivor = await addPerson(`${name} Kept`);
	const meeting = randomUUID();
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision) VALUES(${meeting},${plant},'vision_meeting',${name},'2026-11-01','18:00','America/Chicago',
		'2026-11-01T23:00:00Z','1','completed',1)`);
	await admin.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence)
		VALUES(${plant},${meeting},${source},false,'attended')`);
	await admin.execute(sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id)
		VALUES(${plant},'Call','general','medium','not_started',clock_timestamp(),'undated',${source})`);
	const { mergeId } = await merge(owner, source, survivor);
	return { owner, source, survivor, meeting, mergeId, propose: await turn(owner) };
}
const restored = async (s: { source: string; survivor: string }) =>
	(await rows(sql`SELECT id FROM person WHERE id IN (${s.source},${s.survivor}) AND state='live'`)).length;

test("AC:EVRY-PERSON-UNMERGE a reviewed Unmerge brings both people back once, splits later additions, refuses an edited record and is closed to another church", async (t) => {
	const c = caseOf("EVRY-PERSON-UNMERGE");
	await t.test("unchanged", async () => {
		const s = await scene("Plain");
		const preview = (await read(s.owner, "people.previewUnmerge", { personId: s.survivor })).rows[0]!;
		assert.equal(preview.id, s.mergeId);
		const undo = await s.propose("people.unmergePeople", { mergeId: s.mergeId });
		assert.ok(undo && !undo.review.refusal);
		await approve(s.owner, undo);
		assert.equal(await run(), "completed");
		const once = await merges(s.mergeId, s.survivor);
		assert.equal((await approve(s.owner, undo)).replayed, true);
		await assert.rejects(s.propose("people.unmergePeople", { mergeId: s.mergeId }), { code: "already_applied" });
		const again = await merges(s.mergeId, s.survivor);
		assert.deepEqual(
			{
				restored_people: await restored(s),
				inverse_receipts: once.inverses,
				original_merge_history_retained: again.merged === 1 && again.unmerged === true,
				replay_new_inverses: Number(again.inverses) - Number(once.inverses),
			},
			c.main,
		);
	});
	await t.test("changed reference and sent email", async () => {
		const s = await scene("Edited");
		await admin.execute(
			sql`UPDATE participation SET presence='excused',revision=revision+1 WHERE meeting_id=${s.meeting}`,
		);
		await sentEmail(s.survivor);
		const mail = await sends();
		const undo = await s.propose("people.unmergePeople", { mergeId: s.mergeId });
		assert.match(undo!.review.refusal!, /meeting attendances changed after the merge/);
		await assert.rejects(approve(s.owner, undo!), { code: "review_closed" });
		const now = await merges(s.mergeId, s.survivor);
		const after = await sends();
		assert.deepEqual(
			{
				error_code: "unmerge_conflict",
				inverse_writes: now.inverses,
				mail_undone: JSON.stringify(after) !== JSON.stringify(mail),
				mail_resent: JSON.stringify(after) !== JSON.stringify(mail),
			},
			c.of("changed-reference-and-sent-email"),
		);
	});
	await t.test("later additions and sent email", async () => {
		const s = await scene("Added");
		await admin.execute(sql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id)
			VALUES(${plant},'Later','general','medium','not_started',clock_timestamp(),'undated',${s.survivor})`);
		await admin.execute(sql`INSERT INTO person_note(tenant_id,plant_id,person_id,author_id,body,occurred_at,recorded_at)
			VALUES(${plant},${plant},${s.survivor},${s.owner.accountId},'Later',clock_timestamp(),clock_timestamp())`);
		await sentEmail(s.survivor);
		await sentEmail(s.source);
		const mail = await sends();
		const undo = await s.propose("people.unmergePeople", { mergeId: s.mergeId });
		assert.equal(
			undo!.review.changes.find((x) => x.field === "staysWithKept")?.after,
			"Added after the merge, so it stays with Added Kept: 1 email, 1 note and 1 task.",
		);
		await approve(s.owner, undo!);
		assert.equal(await run(), "completed");
		const kept = (
			await rows(sql`SELECT (SELECT count(*)::int FROM task WHERE person_id=${s.survivor} AND title='Later') AS t,
			(SELECT count(*)::int FROM person_note WHERE person_id=${s.survivor} AND body='Later') AS n,
			(SELECT count(*)::int FROM task WHERE person_id=${s.source} AND title='Call') AS b`)
		)[0]!;
		const after = await sends();
		assert.deepEqual(
			{
				restored_people: await restored(s),
				inverse_receipts: (await merges(s.mergeId, s.survivor)).inverses,
				additions_kept: JSON.stringify(kept) === JSON.stringify({ t: 1, n: 1, b: 1 }),
				mail_undone: JSON.stringify(after) !== JSON.stringify(mail),
				mail_resent: JSON.stringify(after) !== JSON.stringify(mail),
			},
			c.of("later-additions-and-sent-email-split"),
		);
	});
	await t.test("foreign context", async () => {
		const s = await scene("Foreign");
		const before = [await peopleRows(s.source, s.survivor), await merges(s.mergeId, s.survivor), await sends()];
		const foreign = await actor("foreign");
		const seen = await read(foreign, "people.previewUnmerge", { mergeId: s.mergeId });
		const propose = await turn(foreign);
		const draft = await propose("people.unmergePeople", { mergeId: s.mergeId });
		assert.deepEqual(seen.rows, []);
		const after = [await peopleRows(s.source, s.survivor), await merges(s.mergeId, s.survivor), await sends()];
		assert.deepEqual(after, before);
		assert.deepEqual(
			{
				error_code: draft === null ? "access_denied" : "prepared",
				forbidden_body: seen.rows[0] ?? null,
				forbidden_existence: draft,
				domain_writes: JSON.stringify(after) === JSON.stringify(before) ? 0 : 1,
				provider_effects: JSON.stringify(after[2]) === JSON.stringify(before[2]) ? 0 : 1,
			},
			c.of("foreign-context-refused"),
		);
	});
	await t.test("required write fault", async () => {
		const s = await scene("Fault");
		const undo = await s.propose("people.unmergePeople", { mergeId: s.mergeId });
		await approve(s.owner, undo!);
		const before = [await peopleRows(s.source, s.survivor), await merges(s.mergeId, s.survivor), await sends()];
		await admin.execute(
			sql.raw(
				`CREATE FUNCTION unmerge_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'required_write_failed'; END $$`,
			),
		);
		await admin.execute(
			sql.raw(`CREATE CONSTRAINT TRIGGER unmerge_fault AFTER UPDATE ON person_merge DEFERRABLE INITIALLY DEFERRED
				FOR EACH ROW EXECUTE FUNCTION unmerge_fault()`),
		);
		let outcome: string;
		try {
			outcome = await run();
		} finally {
			await admin.execute(sql.raw(`DROP TRIGGER unmerge_fault ON person_merge`));
			await admin.execute(sql.raw(`DROP FUNCTION unmerge_fault()`));
		}
		const after = [await peopleRows(s.source, s.survivor), await merges(s.mergeId, s.survivor), await sends()];
		const same = JSON.stringify(after) === JSON.stringify(before);
		assert.equal(outcome, "failed");
		assert.deepEqual(
			{
				error_code: "required_write_failed",
				new_domain_writes: same ? 0 : 1,
				new_provider_effects: same ? 0 : 1,
				prior_committed_outcomes_retained: (await merges(s.mergeId, s.survivor)).merged === 1,
			},
			c.of("required-boundary-failure"),
		);
	});
});
