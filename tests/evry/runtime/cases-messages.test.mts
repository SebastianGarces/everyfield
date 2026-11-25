import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { approveProposal, readReview, type MailPort, type Proposal } from "../../../packages/evry/src/index.ts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { ok, refused, type Actor } from "../../support/fixture.mts";
import { untouched } from "../../support/recorded.mts";
import {
	caseWorld,
	proposes,
	reads,
	refusal,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Turn,
} from "./case-world.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown> };
	subcases?: { name: string; expected: { result: Record<string, unknown> } }[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

let w: CaseWorld;
before(async () => {
	w = await caseWorld("casemessages", { now: caseOf("MAIL51-009").clock.now });
});
after(() => w?.close());

const nobody = { groups: [] as string[], teamIds: [] as string[], personIds: [] as string[] };
const facts = (card: Proposal) =>
	Object.fromEntries(
		(card.review as { changes: { field: string; after: unknown }[] }).changes.map((c) => [c.field, c.after]),
	);
async function church() {
	const c = await w.church();
	await w.admin.execute(
		sql`UPDATE plant SET street='12 Mill Road',city='Austin',country='United States' WHERE id IN (${c.P.id},${c.Q.id})`,
	);
	return c;
}
function provider() {
	const calls: string[] = [];
	const port: MailPort = {
		keys: {
			encryptionKey: Buffer.alloc(32, 7),
			addressKey: Buffer.alloc(32, 9),
			from: "church@example.test",
			origin: "https://app.example.test",
		},
		transport: {
			paused: false,
			async send(batch) {
				calls.push("send");
				return { outcome: "ids", ids: batch.messages.map(() => `re_${randomUUID()}`) };
			},
			async cancel(ids) {
				calls.push("cancel");
				return ids.map(() => ({ outcome: "done" as const }));
			},
			async reschedule(ids) {
				calls.push("reschedule");
				return ids.map(() => ({ outcome: "done" as const }));
			},
		},
	};
	return { port, calls };
}
const messages = (c: Church) =>
	w.rows<{ id: string; state: string; subject: string; body_html: string; scheduled: string | null }>(
		sql`SELECT id,state,subject,body_html,to_char(scheduled_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS scheduled
			FROM communication WHERE plant_id=${c.P.id} ORDER BY created_at,id`,
	);
const mails = (c: Church) =>
	w.rows<{ state: string; communication_id: string }>(
		sql`SELECT state,communication_id FROM mail WHERE tenant_id=${c.P.id} ORDER BY created_at,id`,
	);

test("AC:MAIL51-009 Evry saves a draft and then schedules, moves, replaces and cancels it, each only after its own exact review is approved, and nothing is sent or changed before that", async () => {
	const { expected, given, action } = caseOf("MAIL51-009");
	const { result } = expected;
	const c = await church();
	const alex = await w.one<{ id: string }>(
		sql`UPDATE person SET email=${(given.C1!.recipients as string[])[0]} WHERE id=${c.rivera} RETURNING id`,
	);
	const email = provider();
	const review = async (said: string, operation: string, input: object): Promise<{ turn: Turn; card: Proposal }> => {
		const turn = await w.quiet(() => w.ask(c.A, said, [proposes(operation, input)]), ["proposal"]);
		const card = turn.proposals[0] ?? assert.fail(JSON.stringify(turn.replies));
		return { turn, card };
	};
	const waits = async (said: string, { turn, card }: { turn: Turn; card: Proposal }) => {
		const state = { messages: await messages(c), mails: await mails(c) };
		await w.quiet(() => w.ask(c.A, `Yes, ${said}`, [], { conversation: turn.conversation }));
		await untouched(w.admin, async () => {
			assert.equal(await w.effect(email.port), null, "no approval, no effect to run");
			for (const witness of [
				{ revision: card.revision + 1, digest: card.digest },
				{ revision: card.revision, digest: "0".repeat(64) },
			])
				assert.equal(await refusal(approveProposal(w.db, c.Aa, card.id, witness, null)), "review_changed");
			const shown = await readReview(w.db, c.Aa, card.id);
			assert.deepEqual([shown.outcome, shown.executing, shown.receipt], [null, false, null]);
		});
		assert.deepEqual({ messages: await messages(c), mails: await mails(c) }, state, said);
	};
	const changes = async (card: Proposal) => {
		const { outcome, review: done } = await w.approve(c.A, card, email.port);
		assert.equal(outcome, "completed", JSON.stringify(done));
		return done;
	};
	const save = await review("Draft a welcome to Alex", "communication.saveDraft", {
		subject: "Welcome",
		body: given.C1!.body,
		audience: { personIds: [alex.id] },
	});
	await waits("save it", save);
	assert.deepEqual(await messages(c), []);
	await changes(save.card);
	const [c1] = await messages(c);
	assert.ok(c1);
	assert.deepEqual(
		{ ...c1, id: null },
		{ id: null, state: "draft", subject: "Welcome", body_html: "<p>Welcome Alex.</p>", scheduled: null },
	);

	const said = "Schedule the welcome for tomorrow at 11";
	assert.equal(action.arguments.send_at, "2026-10-14T16:00:00Z");
	const at = { communicationId: c1.id, sendAt: "2026-10-14T11:00" };
	const scheduling = await review(said, "communication.scheduleReviewed", at);
	assert.deepEqual(facts(scheduling.card), {
		subject: "Welcome",
		recipients: [{ name: "Alex Rivera" }],
		leftOut: [],
		content: given.C1!.body,
		sendAt: { at: "2026-10-14T16:00:00.000Z", zone: "America/Chicago" },
	});
	await waits("schedule it", scheduling);
	const answers = new Map([["awaiting_approval", "review_required"]]);
	assert.equal(answers.get(scheduling.turn.replies[0].status), result.error_code);
	assert.equal((await messages(c))[0]!.state === given.C1!.status, result.draft_saved);
	assert.equal(email.calls.length, result.provider_calls);
	await c.foreignReview(scheduling.card);
	await c.foreign(said, [proposes("communication.scheduleReviewed", at)], { secrets: ["Welcome Alex."] });

	const scheduled = await changes(scheduling.card);
	assert.deepEqual(scheduled.receipt?.report, {
		kind: "schedule",
		confirmation: "confirmed",
		scheduledAt: "2026-10-14T16:00:00.000Z",
		accepted: 1,
		refused: 0,
		unknown: 0,
		waiting: 1,
		leftOut: 0,
	});
	assert.deepEqual(await messages(c), [{ ...c1, state: "scheduled", scheduled: "2026-10-14T16:00:00Z" }]);
	assert.deepEqual(await mails(c), [{ state: "scheduled", communication_id: c1.id }]);

	const moving = await review("Move it to Thursday at 9", "communication.rescheduleReviewed", {
		communicationId: c1.id,
		sendAt: "2026-10-15T09:00",
	});
	assert.deepEqual(facts(moving.card).sendAt, { at: "2026-10-15T14:00:00.000Z", zone: "America/Chicago" });
	await waits("move it", moving);
	await changes(moving.card);
	assert.deepEqual(await messages(c), [{ ...c1, state: "scheduled", scheduled: "2026-10-15T14:00:00Z" }]);
	assert.deepEqual(await mails(c), [{ state: "scheduled", communication_id: c1.id }]);

	const replacing = await review("Say good morning instead", "communication.replaceScheduledReviewed", {
		communicationId: c1.id,
		body: "Good morning.",
	});
	assert.equal(facts(replacing.card).body, "Good morning.");
	await waits("replace it", replacing);
	const replaced = await changes(replacing.card);
	const [, second] = await messages(c);
	assert.ok(second);
	assert.equal(replaced.receipt?.receiptId, second.id);
	assert.deepEqual(
		{ ...second, id: null },
		{
			id: null,
			state: "scheduled",
			subject: "Welcome",
			body_html: "<p>Good morning.</p>",
			scheduled: "2026-10-15T14:00:00Z",
		},
	);
	assert.deepEqual(await mails(c), [
		{ state: "cancelled", communication_id: c1.id },
		{ state: "scheduled", communication_id: second.id },
	]);

	const cancelling = await review("Cancel it", "communication.cancelScheduledReviewed", { communicationId: second.id });
	await waits("cancel it", cancelling);
	const cancelled = await changes(cancelling.card);
	assert.deepEqual(cancelled.receipt?.report, {
		kind: "cancel",
		confirmation: "confirmed",
		cancelled: 1,
		sent: 0,
		open: 0,
	});
	assert.deepEqual(
		(await mails(c)).map((m) => m.state),
		["cancelled", "cancelled"],
	);
	assert.deepEqual(email.calls, [], "nothing was ever sent");
	assert.equal(await w.effect(email.port), null);
});

test("AC:INH-COMMUNICATION-05 the preview of an invitation to three prospects shows who gets it and who does not, saves and sends nothing, tells another church nothing and says when it cannot read", async () => {
	const { expected, subcases = [] } = caseOf("INH-COMMUNICATION-05");
	const sub = (name: string) => subcases.find((s) => s.name === name)?.expected.result ?? assert.fail(name);
	const { result } = expected;
	const c = await church();
	const people = {
		Alex: await c.person("Alex", { email: "alex@example.test" }),
		Casey: await c.person("Casey", { email: "casey@example.test" }),
		Jamie: await c.person("Jamie"),
	};
	const template = randomUUID();
	await w.admin.execute(sql`INSERT INTO message_template(id,plant_id,name,category,subject,body_html,body_text)
		VALUES(${template},${c.P.id},'Our invitation','meeting_invitation','Invitation','<p>Welcome {{name}}.</p>','Welcome {{name}}.')`);
	const personIds = [people.Alex, people.Casey, people.Jamie, people.Alex];
	const ask = async (who: Actor, request: object) => {
		const authority = await w.authorityOf(who);
		return gatedTransaction(w.db, (tx) => communicationWriter.readPreview(tx, authority, request));
	};
	const request = {
		bodyHtml: "<p>Welcome {{name}}.</p>",
		merge: { name: "Alex" },
		templateId: template,
		audience: { ...nobody, personIds },
	};
	const preview = await w.quiet(async () => ok(await ask(c.A, request)));
	assert.deepEqual(
		{
			eligible_recipients: preview.eligibleEmails,
			excluded_missing_email: preview.excludedMissingEmail,
			duplicate_addresses_removed: preview.duplicateAddressesRemoved,
			provider_calls: preview.providerCalls,
			saved_drafts: (await messages(c)).length,
		},
		result,
	);
	assert.equal(preview.previewBody, "<p>Welcome Alex.</p>");
	assert.deepEqual(await mails(c), []);

	const said = "Preview our invitation to Alex, Casey and Jamie";
	const play = [
		reads("people.listPeople", { limit: 10 }),
		reads("communication.templates.list"),
		reads("communication.preview", {
			subject: "Invitation",
			body: "Welcome {{name}}.",
			audience: { personIds },
		}),
		reads("communication.get", { subject: "Invitation" }),
	];
	const asked = await w.quiet(() => w.ask(c.A, said, play, { conversation: c.C }));
	assert.ok(rowsOf(asked.replies[0]).some((r) => r.id === people.Jamie));
	assert.ok(JSON.stringify(asked.replies[1]).includes("Our invitation"), "the template is visible");
	assert.deepEqual(
		rowsOf(asked.replies[2]).map((r) => [r.id, r.label, r.fields.leftOut]),
		[
			[people.Jamie, "Jamie", "no_address"],
			[people.Alex, "Alex", null],
			[people.Casey, "Casey", null],
		],
	);
	assert.equal(asked.replies[3].status, "not_found", "no message exists to read back");
	assert.deepEqual([asked.proposals, await messages(c), await mails(c)], [[], [], []]);

	const refusedCase = sub("foreign-context-refused");
	await untouched(w.admin, async () => {
		const real = refused(await ask(c.F, request), refusedCase.error_code as string);
		const madeUp = refused(
			await ask(c.F, { ...request, templateId: randomUUID(), audience: { ...nobody, personIds: [randomUUID()] } }),
			refusedCase.error_code as string,
		);
		assert.deepEqual(
			[{ ...real, correlationId: null }, real.details.previewBody ?? refusedCase.forbidden_body],
			[{ ...madeUp, correlationId: null }, null],
		);
	});
	const G = await w.seated(c.Q, "admin");
	await untouched(w.admin, async () => {
		refused(await ask(G, request), "invalid_subject");
		const own = ok(await ask(G, { ...request, templateId: undefined }));
		assert.deepEqual([own.eligibleEmails, own.excludedMissingEmail, own.duplicateAddressesRemoved], [[], [], 0]);
	});
	const told = await c.foreign(said, play.slice(2), {
		secrets: ["alex@example.test", "casey@example.test", "Our invitation"],
	});
	assert.equal(told.replies[0].total, 0, "no recipient of the other church exists for the caller");
	assert.deepEqual(
		[(await messages(c)).length, (await mails(c)).length],
		[refusedCase.domain_writes, refusedCase.provider_effects],
	);

	const down = sub("required-boundary-failure");
	const failed = await c.outage(
		said,
		[reads("communication.preview", { subject: "Invitation", body: "Hi", audience: { personIds } })],
		"person",
	);
	assert.equal(failed.replies.at(-1).error, down.error_code);
	await untouched(w.admin, async () => {
		await w.admin.execute(sql`ALTER TABLE person RENAME TO person_away`);
		try {
			await assert.rejects(ask(c.A, request), "the screen's own preview is refused too, with no partial answer");
		} finally {
			await w.admin.execute(sql`ALTER TABLE person_away RENAME TO person`);
		}
	});
	assert.deepEqual(ok(await ask(c.A, request)), preview, "the same preview once the source is back");
	assert.deepEqual(
		[(await messages(c)).length, (await mails(c)).length],
		[down.new_domain_writes, down.new_provider_effects],
	);
	const recovered = await w.ask(c.A, said, play.slice(2, 3));
	assert.equal(rowsOf(recovered.replies[0]).length, 3, "the next read answers again");
});
