import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	cancelUnsubscribedHeld,
	communicationWriter,
	runDueScheduled,
	withCommunicationWrite,
} from "../../../packages/domain/src/communication/index.ts";
import { claimDue, recoverLease, type Claim } from "../../../packages/domain/src/jobs/queue.ts";
import { applyMailCallback, replayStoredCallbacks } from "../../../packages/domain/src/jobs/webhook.ts";
import {
	approveProposal,
	executeProposal,
	observeConversation,
	readConversation,
	readReview,
	retryUnresolvedEffects,
	reviseProposal,
	type MailPort,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { ok, raced } from "../../support/fixture.mts";
import { touched } from "../../support/recorded.mts";
import { frozenClock } from "../../support/test-database.mts";
import {
	caseWorld,
	proposes,
	read,
	reads,
	refusal,
	rowsOf,
	sql,
	type CaseWorld,
	type Church,
	type Play,
	type Step,
} from "./case-world.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: { utterances: string[]; request_key: string } };
	expected: { result: Record<string, unknown> };
	subcases: { name: string; action: Case["action"]; expected: Case["expected"] }[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((x) => x.id === id) ?? assert.fail(`no case ${id}`);
function inherited(id: string) {
	const c = caseOf(id);
	const said = c.action.arguments.utterances;
	assert.deepEqual(
		c.subcases.map((s) => [s.name, s.action.arguments.utterances]),
		[
			["foreign-context-refused", said],
			["required-boundary-failure", said],
		],
	);
	return { said, key: c.action.arguments.request_key, expected: c.expected.result };
}

const { now: NOW } = caseOf("INH-REGRESSION-EXPIRED-APPROVAL").clock;
let w: CaseWorld;
before(async () => {
	w = await caseWorld("casecomm", { now: "2026-10-13T15:30:00Z" });
});
after(() => w?.close());

const PORTS = { reminders: async () => undefined as never, phaseNotices: async () => undefined };
const lease = (claim: Claim) => ({
	jobId: claim.id,
	tenantId: claim.tenant_id,
	leaseOwner: claim.lease_owner,
	generation: claim.claim_generation,
});
function provider() {
	const calls: { key: string; to: string[]; subject: string; bytes: string }[] = [];
	const effects = new Map<string, string[]>();
	const hooks = { lose: false, during: async () => {} };
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
				const to = batch.messages.map((m) => m.to);
				calls.push({
					key: batch.key,
					to,
					subject: batch.messages[0]!.subject,
					bytes: JSON.stringify(batch.messages.map((m) => [m.to, m.subject, m.html, m.text])),
				});
				if (!effects.has(batch.key))
					effects.set(
						batch.key,
						to.map(() => "re_" + randomUUID()),
					);
				await hooks.during();
				if (hooks.lose) throw new Error("the answer was lost");
				return { outcome: "ids", ids: effects.get(batch.key)! };
			},
			cancel: async (ids) => ids.map(() => ({ outcome: "unknown" as const })),
			reschedule: async (ids) => ids.map(() => ({ outcome: "unknown" as const })),
		},
	};
	return { port, calls, effects, hooks };
}

async function hall(c: Church) {
	await w.admin.execute(
		sql`UPDATE plant SET street='12 Mill Road',city='Chicago',country='United States' WHERE id=${c.P.id}`,
	);
	const venue = async (name: string) => {
		const id = randomUUID();
		await w.admin.execute(
			sql`INSERT INTO venue(id,plant_id,name,address) VALUES(${id},${c.P.id},${name},${name + " Street"})`,
		);
		return id;
	};
	await w.admin.execute(sql`UPDATE person SET email='alex@example.test' WHERE id=${c.rivera}`);
	await w.admin.execute(sql`UPDATE person SET email='casey@example.test' WHERE id=${c.casey}`);
	const jamie = await c.person("Jamie Doe", { email: "jamie@example.test" });
	return { venue, northHall: await venue("North Hall"), northChurch: await venue("North Church"), jamie };
}
const invitation = (venueId: string, personIds: string[], more: object = {}) => ({
	meeting: { type: "orientation", date: "2026-10-20", time: "10:00", venueId },
	audience: { personIds },
	...more,
});
const PREPARE = "evry.prepareMeetingInvitation";
async function prepared(
	c: Church,
	said: string,
	input: object,
	play: Play = [],
	conversation = c.C,
): Promise<Proposal> {
	const asked = await w.ask(c.A, said, [...play, proposes(PREPARE, input)], { conversation });
	assert.equal(asked.proposals.length, 1, JSON.stringify(asked.replies));
	return asked.proposals[0]!;
}
const shown = (p: Proposal, field: string) => p.review.changes.find((x) => x.field === field)?.after;
const names = (p: Proposal, field: string) => (shown(p, field) as { name: string }[]).map((x) => x.name);
const when = (p: Proposal) => (shown(p, "meeting") as { when: string }).when;
const footprint = (c: Church) =>
	w.one<{ meetings: number; guests: number; messages: number; mail: number }>(
		sql`SELECT (SELECT count(*)::int FROM meeting WHERE plant_id=${c.P.id}) AS meetings,
			(SELECT count(*)::int FROM participation WHERE plant_id=${c.P.id}) AS guests,
			(SELECT count(*)::int FROM communication WHERE plant_id=${c.P.id}) AS messages,
			(SELECT count(*)::int FROM mail WHERE tenant_id=${c.P.id}) AS mail`,
	);
const NONE = { meetings: 0, guests: 0, messages: 0, mail: 0 };
const addresses = {
	"Alex Rivera": "alex@example.test",
	"Casey Reed": "casey@example.test",
	"Jamie Doe": "jamie@example.test",
};
const emailed = (p: Proposal, field: string) =>
	names(p, field).map((name) => addresses[name as keyof typeof addresses]);
const reviewStep =
	(id: string): Step =>
	() => ({ tool: "read_review", input: { proposalId: id } });
const domainTables = (tables: string[]) =>
	tables.filter((t) => !["audit_event", "conversation", "conversation_event", "job", "record", "proposal"].includes(t));
async function boundary(
	c: Church,
	said: string,
	pending: Proposal,
	play: Play,
	source: string,
	email: ReturnType<typeof provider>,
) {
	await c.foreignReview(pending);
	await c.foreign(said, play, { secrets: ["alex@example.test", "jamie@example.test", "North Hall"] });
	await c.outage(said, play, source);
	const held = await footprint(c);
	const calls = email.calls.length;
	await c.effectOutage(pending, "meeting", email.port);
	assert.deepEqual([await footprint(c), email.calls.length], [held, calls], "no write and no send");
}

test("AC:INH-REGRESSION-EXPIRED-APPROVAL at exactly its fifteen-minute expiry an approval neither stands nor runs, and the same invitation needs a fresh review", async () => {
	const { said, key, expected } = inherited("INH-REGRESSION-EXPIRED-APPROVAL");
	const c = await w.church();
	const v = await hall(c);
	const email = provider();
	const made = "2026-10-13T15:45:00.000Z";
	await w.at("2026-10-13T15:45:00Z");
	const input = invitation(v.northHall, [c.rivera, c.casey]);
	const [waiting, agreed] = await frozenClock(w.admin, w.schema, made, async () => {
		const one = await prepared(c, "Invite Alex and Casey", input);
		const two = await prepared(c, "Invite Alex and Casey", input);
		await approveProposal(w.db, c.Aa, two.id, w.witness(two), null);
		return [one, two] as const;
	});
	for (const p of [waiting, agreed]) assert.equal(p.expiresAt.toISOString(), new Date(NOW).toISOString());
	await frozenClock(w.admin, w.schema, "2026-10-13T15:59:59.999Z", async () =>
		assert.equal(
			(await readReview(w.db, c.Aa, waiting.id)).status,
			"pending",
			"one millisecond earlier it still waits",
		),
	);
	await w.at(NOW);
	const ran = await touched(w.admin, () =>
		frozenClock(w.admin, w.schema, NOW, async () => {
			const code = await refusal(approveProposal(w.db, c.Aa, waiting.id, w.witness(waiting), null));
			return [code, await w.effect(email.port), await w.effect(email.port)];
		}),
	);
	assert.deepEqual(ran.value, [expected.error_code, "expired", null]);
	assert.deepEqual(domainTables(ran.tables), [], "no domain write");
	assert.deepEqual(
		[await footprint(c), email.calls.length],
		[{ ...NONE, meetings: expected.domain_writes, guests: expected.domain_writes }, expected.provider_calls],
	);
	for (const p of [waiting, agreed]) {
		const old = await readReview(w.db, c.Aa, p.id);
		assert.deepEqual([old.status === "expired", old.outcome], [expected.new_review_required, null]);
		assert.equal(await refusal(retryUnresolvedEffects(w.db, c.Aa, p.id)), "review_expired");
	}
	const asked = await w.ask(c.A, said[0]!, [reviewStep(agreed.id), () => proposeAgain(input)], {
		conversation: c.C,
		requestKey: key,
	});
	const fields = JSON.stringify(rowsOf(asked.cards[0]?.result)[0]?.fields);
	assert.match(fields, /expired before approval/, "the chat says the earlier approval lapsed");
	const [fresh] = asked.proposals;
	assert.deepEqual([fresh?.status, fresh?.revision, fresh?.outcome], ["pending", 1, null]);
	assert.notEqual(fresh!.id, agreed.id);
	const again = await reviseProposal(w.db, c.Aa, agreed.id, { operation: PREPARE, revision: 1, input }, email.port);
	assert.deepEqual([again.status, again.revision, again.digest === agreed.digest], ["pending", 2, false]);
	assert.equal(await refusal(approveProposal(w.db, c.Aa, agreed.id, w.witness(agreed), null)), "review_changed");
	assert.deepEqual([await w.effect(email.port), await footprint(c), email.calls.length], [null, NONE, 0]);
	await boundary(c, said[0]!, fresh!, [reads("meetings.list"), () => proposeAgain(input)], "meeting", email);
});
const proposeAgain = (input: object) => ({ tool: "propose_change", input: { operation: PREPARE, input } });

test("AC:INH-REGRESSION-REVISED-APPROVAL replacing a recipient voids the earlier confirmation: it never sends to either audience, and only a new approval of the changed review does", async () => {
	const { said, key, expected } = inherited("INH-REGRESSION-REVISED-APPROVAL");
	const c = await w.church();
	const v = await hall(c);
	const email = provider();
	const first = await prepared(c, "Invite Alex and Casey", invitation(v.northHall, [c.rivera, c.casey]));
	const old = w.witness(first);
	const short = (p: Proposal) => names(p, "recipients").map((n) => n.split(" ")[0]);
	assert.deepEqual(short(first), expected.old_digest_authorizes);
	await approveProposal(w.db, c.Aa, first.id, old, null);
	const [claimed] = await claimDue(w.db, ["evry_effect"], 1, 60);
	const changed = invitation(v.northHall, [c.rivera, v.jamie]);
	const { value: edited, tables } = await touched(w.admin, async () => {
		const p = await reviseProposal(
			w.db,
			c.Aa,
			first.id,
			{ operation: PREPARE, revision: 1, input: changed },
			email.port,
		);
		for (const witness of [old, { revision: 2, digest: old.digest }, { revision: 1, digest: p.digest }])
			assert.equal(
				await refusal(approveProposal(w.db, c.Aa, first.id, witness, null)),
				"review_changed",
				"the earlier confirmation does not carry over",
			);
		assert.ok(
			["closed", "lost"].includes(await executeProposal(w.db, lease(claimed!), PORTS, email.port, null)),
			"the run queued for the old audience starts nothing",
		);
		assert.equal(await w.effect(email.port), null);
		return p;
	});
	assert.deepEqual(short(edited), expected.changed_recipient_ids);
	assert.deepEqual(
		[edited.status === "approved", edited.status === "pending", edited.revision, edited.digest === old.digest],
		[expected.old_approval_valid, expected.new_review_required, 2, false],
	);
	assert.equal(domainTables(tables).length, expected.domain_writes);
	assert.deepEqual([await footprint(c), email.calls.length], [NONE, 0]);

	const asked = await w.ask(c.A, said[0]!, [reviewStep(first.id), () => proposeAgain(changed)], {
		conversation: c.C,
		requestKey: key,
	});
	assert.equal(
		asked.tools.some((t) => /approve|confirm|execute/i.test(t)),
		false,
		"the chat cannot confirm for a person",
	);
	assert.match(JSON.stringify(asked.replies), /waiting for the user's review/);
	assert.deepEqual(
		[asked.proposals[0]?.status, await w.effect(email.port), await footprint(c)],
		["pending", null, NONE],
	);

	const ran = await w.approve(c.A, edited, email.port);
	assert.deepEqual(
		[ran.outcome, email.calls.map((x) => [...x.to].sort()), (await footprint(c)).mail],
		["completed", [["alex@example.test", "jamie@example.test"]], 2],
		"only the newly approved people",
	);
	await boundary(
		c,
		said[0]!,
		asked.proposals[0]!,
		[reads("meetings.list"), () => proposeAgain(changed)],
		"meeting",
		email,
	);
});

test("AC:INH-REGRESSION-TEMPLATE-EDIT a new subject makes a new revision and digest with the same people and time, voids the old approval and sends nothing", async () => {
	const { said, key, expected } = inherited("INH-REGRESSION-TEMPLATE-EDIT");
	const c = await w.church();
	const v = await hall(c);
	const email = provider();
	for (const id of [c.rivera, c.casey]) await w.admin.execute(sql`UPDATE person SET stage='core_group' WHERE id=${id}`);
	const input = (subject: string) => ({
		...invitation(v.northHall, []),
		audience: { groups: ["core_group"] },
		subject,
	});
	const first = await prepared(c, said[0]!, input("Old"), [reads("people.listPeople", { stages: ["core_group"] })]);
	assert.deepEqual([shown(first, "subject"), first.status], ["Old", "pending"]);
	const short = (p: Proposal) => names(p, "recipients").map((n) => n.split(" ")[0]);
	const { value: edited, tables } = await touched(w.admin, async () => {
		const follow = await w.ask(c.A, said[1]!, [reviewStep(first.id)], { conversation: c.C, requestKey: key });
		assert.match(JSON.stringify(follow.replies), /waiting for the user's review/);
		return reviseProposal(
			w.db,
			c.Aa,
			first.id,
			{ operation: PREPARE, revision: 1, input: input("Welcome to orientation") },
			email.port,
		);
	});
	assert.deepEqual(
		[shown(edited, "subject"), short(edited), short(first)],
		[expected.subject, expected.recipient_ids, expected.recipient_ids],
	);
	assert.equal(when(edited), when(first), "the time is kept");
	assert.ok(when(edited).includes(String(expected.local_time)), when(edited));
	assert.deepEqual([edited.revision, edited.digest === first.digest], [2, false]);
	assert.equal(
		(await refusal(approveProposal(w.db, c.Aa, first.id, w.witness(first), null))) !== "review_changed",
		expected.old_approval_valid,
	);
	assert.deepEqual(domainTables(tables), []);
	assert.deepEqual(
		[await w.effect(email.port), await footprint(c), email.calls.length],
		[null, NONE, expected.provider_calls],
	);
	await boundary(c, said[0]!, edited, [reads("people.listPeople"), () => proposeAgain(input("Old"))], "person", email);
	assert.equal((await readReview(w.db, c.Aa, edited.id)).outcome, "unknown");
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, edited.id)).retried, true);
	assert.equal(await w.effect(email.port), "completed");
	assert.deepEqual(
		email.calls.map((x) => [x.subject, [...x.to].sort()]),
		[[expected.subject, ["alex@example.test", "casey@example.test"]]],
	);
	const at = await w.one<{ starts: Date | string }>(
		sql`SELECT starts_at AS starts FROM meeting WHERE plant_id=${c.P.id}`,
	);
	assert.equal(new Date(at.starts).toISOString(), "2026-10-20T15:00:00.000Z");
});

test("AC:INH-REGRESSION-CONFIRM-REPLAY two confirms at once and a reconnect leave one meeting, one guest link and one message for each person, and the same saved result", async () => {
	const { said, key, expected } = inherited("INH-REGRESSION-CONFIRM-REPLAY");
	const c = await w.church();
	const v = await hall(c);
	const email = provider();
	const p = await prepared(c, "Invite Alex and Casey", invitation(v.northHall, [c.rivera, c.casey]));
	const confirm = () => approveProposal(w.db, c.Aa, p.id, w.witness(p), null);
	const both = await raced(w.admin, w.db, sql`SELECT id FROM proposal WHERE id=${p.id} FOR UPDATE`, [confirm, confirm]);
	assert.deepEqual(both.map((x) => x.replayed).sort(), [false, true]);
	const outcomes = await Promise.all([w.effect(email.port), w.effect(email.port)]);
	assert.deepEqual(outcomes.sort(), ["completed", null].sort());
	const counts = async () => {
		const n = await footprint(c);
		return { meetings: n.meetings, guest_links: n.guests, recipient_intents: n.mail };
	};
	const { additional_intents_on_reconnect: additional, ...once } = expected;
	assert.deepEqual(await counts(), once);
	assert.equal(
		await w.count(sql`SELECT count(DISTINCT person_id)::int AS n FROM participation WHERE plant_id=${c.P.id}`),
		2,
	);
	assert.equal(
		await w.count(sql`SELECT count(DISTINCT recipient_person_id)::int AS n FROM mail WHERE tenant_id=${c.P.id}`),
		2,
	);
	assert.deepEqual(
		email.calls.map((x) => [...x.to].sort()),
		[["alex@example.test", "casey@example.test"]],
	);
	const saved = (await readReview(w.db, c.Aa, p.id)).receipt;
	assert.deepEqual([saved?.report?.confirmation, Boolean(saved?.meetingId)], ["confirmed", true]);
	const held = await footprint(c);
	for (let n = 0; n < 2; n++) {
		for await (const _ of observeConversation(w.db, c.Aa, c.C, 0, AbortSignal.timeout(300), 50)) void _;
		await readConversation(w.db, c.Aa, c.C);
		const repeat = await confirm();
		assert.deepEqual([repeat.replayed, repeat.proposal.receipt], [true, saved], "the same saved result");
		assert.equal((await retryUnresolvedEffects(w.db, c.Aa, p.id)).retried, false);
		assert.equal(await w.effect(email.port), null);
	}
	const asked = await w.ask(c.A, said[0]!, [reviewStep(p.id)], { conversation: c.C, requestKey: key });
	assert.match(JSON.stringify(asked.replies), /approved and applied/);
	const after = await footprint(c);
	assert.deepEqual([after.mail - held.mail, after, email.calls.length], [additional, held, 1]);
	const twin = await prepared(c, "Invite Alex and Jamie", invitation(v.northChurch, [c.rivera, v.jamie]));
	await boundary(c, said[0]!, twin, [reviewStep(p.id), reads("meetings.list")], "meeting", email);
	assert.deepEqual((await readReview(w.db, c.Aa, p.id)).receipt, saved);
});

test("AC:INH-CROSS-07 asked whether the invitations went out, Evry tells an unapproved preview from an applied send the email service took but has not delivered, and records no human contact", async () => {
	const { said, key, expected } = inherited("INH-CROSS-07");
	const c = await w.church();
	const v = await hall(c);
	const email = provider();
	const preview = await prepared(c, "Invite Jamie", invitation(v.northChurch, [v.jamie]));
	const applied = await prepared(c, "Invite Alex and Casey", invitation(v.northHall, [c.rivera, c.casey]));
	const ran = await w.approve(c.A, applied, email.port);
	const message = ran.review.receipt!.receiptId!;
	const sends = email.calls.length;
	const play: Play = [
		reviewStep(preview.id),
		reviewStep(applied.id),
		reads("communication.get", { communicationId: message }),
		reads("communication.deliveryTotals", { communicationId: message }),
		reads("communication.list", {}),
	];
	const facts = () =>
		w.rows(sql`SELECT (SELECT count(*)::int FROM contact_outcome WHERE plant_id=${c.P.id}) AS contacts,
			(SELECT jsonb_agg(jsonb_build_array(p.id,p.revision) ORDER BY p.id) FROM person p WHERE p.plant_id=${c.P.id}) AS people,
			(SELECT jsonb_agg(jsonb_build_array(t.person_id,t.rsvp,t.presence) ORDER BY t.person_id) FROM participation t WHERE t.plant_id=${c.P.id}) AS guests`);
	const before = await facts();
	const asked = await w.ask(c.A, said[0]!, play, { conversation: c.C, requestKey: key });
	assert.equal(asked.outcome, "succeeded");
	const [shownPreview, shownApplied, got, totals, open] = asked.replies;
	const said7 = (reply: unknown) => JSON.stringify(reply);
	const isPreview = /waiting for the user's review: nothing changed/.test(said7(shownPreview));
	const isApplied = /approved and applied/.test(said7(shownApplied));
	const [, ...people] = rowsOf(got);
	const taken = people.every(
		(r) => r.fields.result === "sent" && r.fields.deliveredAt === null && r.fields.openedAt === null,
	);
	const tally = rowsOf(totals)[0].fields;
	assert.deepEqual([people.length, tally.recipients, tally.delivered, tally.opened], [2, 2, 0, 0]);
	assert.deepEqual(
		{
			"review-P": isPreview && !/applied/.test(said7(shownPreview)) ? "preview" : said7(shownPreview),
			"review-Q": isApplied ? "applied" : said7(shownApplied),
			"message-M": taken ? "accepted_unknown" : said7(people),
			human_contact_recorded: Number(((await facts())[0] as { contacts: number }).contacts) > 0,
		},
		expected,
	);
	assert.deepEqual(
		rowsOf(open).filter((r) => r.label.includes("Jamie")),
		[],
		"the preview is no message",
	);
	assert.deepEqual([await facts(), email.calls.length], [before, sends], "asking sends and records nothing");
	assert.equal((await readReview(w.db, c.Aa, preview.id)).status, "pending");
	assert.equal(
		await w.count(
			sql`SELECT count(*)::int AS n FROM mail m WHERE m.tenant_id=${c.P.id} AND m.recipient_person_id=${v.jamie}`,
		),
		0,
	);

	await c.foreignReview(preview);
	await c.foreign(said[0]!, play, { secrets: ["alex@example.test", "North Hall", "approved and applied"] });
	await c.outage(said[0]!, [reads("communication.list", {})], "communication");
	await c.outage(said[0]!, [reads("communication.get", { communicationId: message })], "mail");
	const held = await footprint(c);
	await c.effectOutage(preview, "meeting", email.port);
	assert.deepEqual([await footprint(c), email.calls.length], [held, sends]);
	assert.equal((await readReview(w.db, c.Aa, applied.id)).outcome, "completed", "the applied send is kept");
});

test("AC:INH-MEETINGS-08 an invitation to a Tuesday meeting asks which of two venues, names who gets it and who is blocked, and after one exact review makes one meeting and one send from the people already found", async () => {
	const { said, key, expected } = inherited("INH-MEETINGS-08");
	const c = await w.church();
	const v = await hall(c);
	const email = provider();
	const tag = randomUUID();
	await w.admin.execute(
		sql`INSERT INTO tag(id,plant_id,name,normalized_name) VALUES(${tag},${c.P.id},'Northside','northside')`,
	);
	await w.admin.execute(sql`UPDATE person SET stage='prospect' WHERE id IN (${c.rivera},${c.casey},${v.jamie})`);
	for (const id of [c.rivera, c.casey, v.jamie])
		await w.admin.execute(sql`INSERT INTO person_tag(plant_id,person_id,tag_id) VALUES(${c.P.id},${id},${tag})`);
	await w.admin.execute(sql`INSERT INTO person_email_opt_out(plant_id,person_id) VALUES(${c.P.id},${v.jamie})`);
	const tagged: string[] = [];
	const audience = () => ({ personIds: [...tagged] });
	const meeting = { type: "vision_meeting", date: "2026-10-20", time: "18:00" };
	const draft = { subject: "Vision Meeting", body: "Join us.", audience: { groups: [], teamIds: [] } };
	const find: Play = [
		reads("meetings.list", {}),
		reads("people.listPeople", { stages: ["prospect"] }),
		(replies) => rowsOf(replies.at(-1), "person").map((r) => read("people.getPersonTags", { personId: r.id })),
		(replies) => {
			const people = rowsOf(
				replies.find((r) => r.operation === "people.listPeople" || rowsOf(r, "person").length),
				"person",
			);
			const tags = replies.slice(-people.length);
			people.forEach((p, n) => {
				if (rowsOf(tags[n]).some((r) => r.label === "Northside")) tagged.push(p.id);
			});
			return read("communication.preview", { ...draft, audience: { ...draft.audience, personIds: tagged } });
		},
		reads("venues.list", { search: "North" }),
		() => proposeAgain({ meeting, audience: audience() }),
	];
	const { value: first, tables } = await touched(w.admin, () =>
		w.ask(c.A, said[0]!, find, { conversation: c.C, requestKey: key, onError: "go_on" }),
	);
	assert.deepEqual([...tagged].sort(), [c.rivera, c.casey, v.jamie].sort(), "the tagged prospects and nobody else");
	const refused = JSON.stringify(first.replies.at(-1));
	const venues = first.cards.find((x) => x.operation === "venues.list")!;
	assert.deepEqual(
		rowsOf(venues.result)
			.map((r) => r.label)
			.sort(),
		["North Church", "North Hall"],
	);
	const asksVenue = first.proposals.length === 0 && /venueId/.test(refused);
	const preview = rowsOf(first.cards.find((x) => x.operation === "communication.preview")!.result, "person");
	const to = (blocked: boolean) =>
		preview
			.filter((r) => (r.fields.leftOut !== null) === blocked)
			.map((r) => addresses[r.label as keyof typeof addresses])
			.sort();
	const start = await footprint(c);
	assert.deepEqual(
		{
			status: asksVenue ? "needs_clarification" : refused,
			field: asksVenue ? "location" : refused,
			eligible_recipients: to(false),
			suppressed_recipients: to(true),
			meeting_writes: start.meetings,
			provider_calls: email.calls.length,
		},
		expected,
	);
	assert.deepEqual([domainTables(tables), start], [[], NONE], "nothing is made before the question is answered");

	await w.admin.execute(sql`DELETE FROM person_email_opt_out WHERE person_id=${v.jamie}`);
	const event = randomUUID();
	await w.admin
		.execute(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${event},${event},${event},'bounced',clock_timestamp(),clock_timestamp(),'x','{"hard_bounce":true}'::jsonb)`);
	await w.admin.execute(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${createHmac("sha256", email.port.keys.addressKey).update("jamie@example.test").digest("hex")},'hard_bounce',${event},clock_timestamp())`);
	const answered = await w.ask(
		c.A,
		"North Hall",
		[() => proposeAgain({ meeting: { ...meeting, venueId: v.northHall }, audience: audience() })],
		{ conversation: c.C },
	);
	assert.deepEqual([answered.cards.length, answered.proposals.length], [0, 1], "the people found are reused");
	const p = answered.proposals[0]!;
	assert.deepEqual(
		[
			emailed(p, "recipients").sort(),
			emailed(p, "leftOut"),
			(shown(p, "leftOut") as { reason: string }[]).map((x) => x.reason),
		],
		[expected.eligible_recipients, expected.suppressed_recipients, ["blocked"]],
	);
	assert.deepEqual(names(p, "guests").sort(), ["Alex Rivera", "Casey Reed", "Jamie Doe"]);
	const shownMeeting = shown(p, "meeting") as { venue: string; isNew: boolean; when: string };
	assert.deepEqual([shownMeeting.venue, shownMeeting.isNew], ["North Hall", true]);
	assert.match(shownMeeting.when, /Tue/);
	assert.match(shownMeeting.when, /18:00|6:00 PM/);
	assert.deepEqual([await footprint(c), email.calls.length], [NONE, 0], "no effect before confirmation");
	const content = JSON.stringify(shown(p, "content"));
	const ran = await w.approve(c.A, p, email.port);
	assert.deepEqual(
		[ran.outcome, email.calls.map((x) => [x.subject, [...x.to].sort()])],
		["completed", [[shown(p, "subject"), expected.eligible_recipients]]],
	);
	assert.ok(
		content.includes("North Hall") && email.calls[0]!.bytes.includes("North Hall"),
		"the reviewed words are sent",
	);
	assert.deepEqual({ ...(await footprint(c)), mail: 0 }, { meetings: 1, guests: 3, messages: 1, mail: 0 });
	const made = await w.one<{ starts: Date | string }>(
		sql`SELECT starts_at AS starts FROM meeting WHERE plant_id=${c.P.id}`,
	);
	assert.equal(new Date(made.starts).toISOString(), "2026-10-20T23:00:00.000Z", "Tuesday at 6 PM in the church's zone");

	const next = await prepared(c, "Invite Alex again", invitation(v.northChurch, [c.rivera]));
	for (const source of ["meeting", "person"])
		await c.outage(said[0]!, [reads(source === "meeting" ? "meetings.list" : "people.listPeople", {})], source);
	await c.outage(said[0]!, [reads("communication.get", {})], "communication");
	await boundary(
		c,
		said[0]!,
		next,
		[
			reads("people.listPeople", {}),
			() => proposeAgain({ meeting: { ...meeting, venueId: v.northHall }, audience: { personIds: [c.rivera] } }),
		],
		"person",
		email,
	);
	assert.equal((await readReview(w.db, c.Aa, p.id)).outcome, "completed");
});

test("AC:MAIL-LEDGER-001 Evry and the Messages page handing off one approved message at once make one intent and one request; after a crash nothing sends it again by itself, and the old worker can save nothing", async () => {
	const ledger = caseOf("MAIL-LEDGER-001");
	const { logical_intents, provider_attempt_owners, status, provider_calls_after_crash } = ledger.expected.result;
	const c = await w.church();
	await hall(c);
	const email = provider();
	const input = { subject: "Welcome", body: "Welcome Alex.", audience: { personIds: [c.rivera] } };
	const asked = await w.ask(c.A, "Email Alex", [proposes("communication.sendReviewed", input)], { conversation: c.C });
	const p = asked.proposals[0]!;
	assert.ok(p, JSON.stringify(asked.replies));
	const authority = await w.authorityOf(c.A);
	const native = (op: "dispatchAttempt" | "reconcileProviderOutcome", port = email.port) =>
		w
			.one<{ id: string; revision: string }>(sql`SELECT id, revision::text FROM communication WHERE plant_id=${c.P.id}`)
			.then((m) =>
				communicationWriter[op](
					w.db,
					authority,
					{ requestKey: randomUUID(), expectedRevision: m.revision, input: { communicationId: m.id } },
					port.transport,
					port.keys,
				),
			);
	const ledgerRows = () =>
		w.one<{ intents: number; requests: number; attempts: number; keys: number; state: string; taken: number }>(
			sql`SELECT count(DISTINCT m.logical_key)::int AS intents, count(DISTINCT r.id)::int AS requests, count(DISTINCT a.id)::int AS attempts,
				count(DISTINCT r.provider_key)::int AS keys, min(m.state) AS state, count(m.accepted_at)::int AS taken
			FROM mail m JOIN mail_request_member mem ON mem.mail_id=m.id JOIN mail_request r ON r.id=mem.request_id
			LEFT JOIN mail_attempt a ON a.request_id=r.id WHERE m.tenant_id=${c.P.id}`,
		);
	await approveProposal(w.db, c.Aa, p.id, w.witness(p), null);
	const [first] = await claimDue(w.db, ["evry_effect"], 1, 60);
	email.hooks.lose = true;
	let concurrent: Awaited<ReturnType<typeof native>> | undefined;
	email.hooks.during = async () => {
		email.hooks.during = async () => {};
		concurrent = await native("dispatchAttempt");
		await w.admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${first!.id}`);
		assert.equal(await recoverLease(w.admin), 1);
	};
	assert.equal(
		await executeProposal(w.db, lease(first!), PORTS, email.port, null),
		"lost",
		"the worker died before its receipt",
	);
	assert.ok(concurrent);
	const answered = ok(concurrent);
	assert.equal(answered.status, status);
	const one = await ledgerRows();
	assert.deepEqual(
		[one.intents, one.requests, one.attempts, one.keys, one.state, one.taken],
		[logical_intents, provider_attempt_owners, provider_attempt_owners, 1, "unknown", 0],
	);
	assert.deepEqual(
		[email.effects.size, new Set(email.calls.map((x) => x.key + x.bytes)).size],
		[1, 1],
		"one provider message",
	);

	const crashed = email.calls.length;
	const background = async () => {
		await runDueScheduled(w.db, email.port.transport, email.port.keys, 50, Infinity);
		await cancelUnsubscribedHeld(w.db, email.port.transport, 50);
		assert.equal(await w.effect(email.port), null);
		assert.deepEqual(await claimDue(w.db, ["mail"], 10), []);
		await replayStoredCallbacks(w.db);
	};
	await background();
	const providerId = [...email.effects.values()][0]![0]!;
	const late = await applyMailCallback(
		w.db,
		Buffer.from(JSON.stringify({ type: "email.delivered", created_at: NOW, data: { email_id: providerId } })),
		randomUUID(),
	);
	assert.deepEqual(late, { stored: true, result: "unmatched" }, "a late callback is kept, and guesses no message");
	await background();
	assert.equal(email.calls.length - crashed, provider_calls_after_crash);
	assert.equal((await ledgerRows()).state, "unknown");

	const old = ledger.subcases[0]!;
	assert.equal(old.name, "old-lease-cannot-finalize");
	const { value: resumed, tables: resumedWrites } = await touched(w.admin, () =>
		executeProposal(w.db, lease(first!), PORTS, email.port, null),
	);
	assert.deepEqual(
		[resumed === "lost" ? "stale_claim" : resumed, resumedWrites.length, email.calls.length - crashed],
		[old.expected.result.error_code, old.expected.result.receipt_writes, old.expected.result.provider_calls],
	);
	assert.deepEqual([(await readReview(w.db, c.Aa, p.id)).outcome], ["unknown"]);

	email.hooks.lose = false;
	assert.equal((await retryUnresolvedEffects(w.db, c.Aa, p.id)).retried, true);
	assert.equal(await w.effect(email.port), "completed");
	assert.deepEqual(
		[email.effects.size, new Set(email.calls.map((x) => x.key + x.bytes)).size, await replayStoredCallbacks(w.db)],
		[1, 1, 1],
		"a person's retry asks about the same request, and the kept callback then settles it",
	);
	const settled = await ledgerRows();
	assert.deepEqual([settled.intents, settled.attempts, settled.state], [1, 1, "sent"]);
	assert.equal(await executeProposal(w.db, lease(first!), PORTS, email.port, null), "lost");

	const twin = await w.church();
	await hall(twin);
	const both = provider();
	const person = await w.authorityOf(twin.A);
	const save = <T,>(body: Parameters<typeof withCommunicationWrite<T>>[2]) =>
		withCommunicationWrite(w.db, person, body).then((reply) => ok(reply));
	const draft = await save((tx, context) =>
		communicationWriter.saveDraft(tx, context, {
			requestKey: randomUUID(),
			input: {
				subject: "Welcome",
				bodyHtml: "<p>Welcome Alex.</p>",
				audience: { groups: [], teamIds: [], personIds: [twin.rivera] },
			},
		}),
	);
	const ready = await save((tx, context) =>
		communicationWriter.scheduleReviewed(tx, context, {
			requestKey: randomUUID(),
			expectedRevision: draft.revision,
			input: { communicationId: draft.communicationId, scheduledAt: "2026-10-14T16:00:00.000Z" },
		}),
	);
	const start = (op: "dispatchAttempt" | "sendReviewed") => () =>
		communicationWriter[op](
			w.db,
			person,
			{
				requestKey: randomUUID(),
				expectedRevision: ready.revision,
				input: { communicationId: draft.communicationId },
			},
			both.port.transport,
			both.port.keys,
		).then(
			(reply) => (reply.status !== "ok" ? reply.error.code : reply.value.providerCalls > 0 ? "sent" : "sent nothing"),
			() => "lost the race",
		);
	const race = await raced(w.admin, w.db, sql`LOCK TABLE mail IN SHARE MODE`, [
		start("dispatchAttempt"),
		start("sendReviewed"),
	]);
	assert.deepEqual(
		[race.filter((x) => x === "sent").length, both.calls.length, both.effects.size],
		[1, 1, 1],
		"two first handoffs at once: one owns the request and the other sends nothing",
	);
	assert.deepEqual(
		await w.one(sql`SELECT count(*)::int AS intents, (SELECT count(*)::int FROM mail_attempt WHERE tenant_id=${twin.P.id}) AS attempts
			FROM mail WHERE tenant_id=${twin.P.id}`),
		{ intents: logical_intents, attempts: provider_attempt_owners },
	);
});
