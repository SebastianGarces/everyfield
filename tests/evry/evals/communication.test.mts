import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { readViewer } from "../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../packages/domain/src/communication/index.ts";
import {
	approveProposal,
	createConversation,
	evryActor,
	executeProposal,
	prepareProposal,
	readConversation,
	runTurn,
	selectQualifiedModel,
	submitTurn,
	type EvryActor,
	type MailPort,
	type Proposal,
} from "../../../packages/evry/src/index.ts";
import { READ_DOMAINS, readCatalog } from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter, SourceRow } from "../../../packages/evry/src/catalog/types.ts";
import { listForSelf } from "../../../packages/evry/src/adapters/communication/reads/index.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { ACTOR_SPECS, goldenChurch, PLANT, type ActorName } from "./golden-church.mts";
import { RECORDED } from "./golden-harness.mts";
import {
	ADDRESS_KEY,
	ALEX_CALL,
	INVITATION,
	INVITED,
	OWNER_EMAIL,
	REMINDER,
	seedCommunication,
	USED_TEMPLATE,
} from "./communication-church.mts";

const TOOLS = [
	"communication.forMeeting",
	"communication.meetingRecipientTracking",
	"communication.deliveryTotals",
	"communication.listAudienceTeams",
	"communication.searchRecipients",
	"mail.suppression.listForSelf",
	"communication.templates.archiveOrDelete",
	"communication.correctContactLog",
];

type Change = [field: string, after: unknown, before?: unknown];
type Case = {
	id: string;
	operation: string;
	actor: ActorName;
	ask: string;
	then?: string;
	calls: string[];
	answer?: string[];
	absent?: string[];
	facts?: "forMeeting" | "tracking" | "totals" | "teams";
	proposal?: { operation: string; target: string; changes: Change[]; hidden?: string[] };
	approve?: true;
	check?: "deleted" | "archived" | "corrected" | "retimed" | "unchanged";
};
const file = JSON.parse(readFileSync(new URL("./communication.cases.json", import.meta.url), "utf8")) as {
	forbid: string[];
	cases: Case[];
};
const pattern = (p: string) => {
	const m = /^\/(.*)\/([a-z]*)$/s.exec(p);
	return m ? new RegExp(m[1]!, m[2]) : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
};
const adapter = (operation: string) =>
	Object.values(READ_DOMAINS)
		.flat()
		.find((a) => a.operation === operation) as ReadAdapter<unknown>;

const mail: MailPort = {
	keys: {
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: ADDRESS_KEY,
		from: "church@example.test",
		origin: "https://app.example.test",
	},
	transport: {
		async send() {
			throw Error("no email is sent in this suite");
		},
		async cancel(ids) {
			return ids.map(() => ({ outcome: "done" as const }));
		},
		async reschedule(ids) {
			return ids.map(() => ({ outcome: "done" as const }));
		},
	},
};

let close: () => Promise<void>;
let db: Database;
let admin: Database;
const model = selectQualifiedModel({ EVRY_SCRIPTED_MODEL: "1" });
const freshActor = async (session: string) => {
	const viewer = await readViewer(db, session as never);
	return viewer?.authority ? evryActor(viewer.authority) : null;
};
const actorOf = async (who: ActorName) => (await freshActor(ACTOR_SPECS[who].session))!;
const read = (who: EvryActor, operation: string, input: unknown = {}) =>
	invokeRead(db, who, adapter(operation), input, null, undefined, mail);
const rows = async <T,>(q: ReturnType<typeof sql>) => (await admin.execute(q)).rows as T[];

before(async () => {
	const church = await goldenChurch();
	close = church.close;
	db = church.db;
	admin = church.admin;
	await seedCommunication(admin);
});
after(() => close?.());

async function ask(actor: EvryActor, texts: string[]) {
	const conversation = await createConversation(db, actor, { requestKey: randomUUID() });
	for (const text of texts) {
		await submitTurn(db, actor, conversation.id, { requestKey: randomUUID(), text, references: [] });
		const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
		assert.ok(claim, "the turn is queued");
		const outcome = await runTurn(
			{ db, model, freshActor, native: null, mail },
			{
				turnId: claim.id,
				tenantId: claim.tenant_id,
				leaseOwner: claim.lease_owner,
				generation: claim.claim_generation,
			},
			{ claimStart: new Date(), claimEnd: new Date() },
		);
		await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
		assert.equal(outcome, "succeeded", text);
	}
	const conversationRead = await readConversation(db, actor, conversation.id);
	const events = conversationRead.events;
	const first = events.findIndex((e) => e.kind === "user_message");
	const turn = events.slice(first + 1);
	const results = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof e.body.operation === "string" && e.body.operation !== "evry.prepareProposal"
			? [{ operation: e.body.operation, result: e.body.result as { rows?: SourceRow[] } }]
			: [],
	);
	const answers = turn.flatMap((e) =>
		e.kind === "assistant_text" && typeof e.body.text === "string" ? [e.body.text] : [],
	);
	const ids = turn.flatMap((e) =>
		e.kind === "tool_result" && typeof (e.body.result as { proposalId?: unknown })?.proposalId === "string"
			? [(e.body.result as { proposalId: string }).proposalId]
			: [],
	);
	const proposals = ids.map((id) => conversationRead.reviews[id]).filter((p): p is Proposal => Boolean(p));
	return { results, answer: answers.join(""), proposals };
}

async function approveAndRun(actor: EvryActor, proposal: Proposal) {
	await approveProposal(db, actor, proposal.id, { revision: proposal.revision, digest: proposal.digest }, null);
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim, "the effect is queued");
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		{ reminders: async () => undefined, phaseNotices: async () => undefined },
		mail,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return outcome;
}

const nativeTemplates = async (who: EvryActor) => {
	const listed = await gatedTransaction(db, (tx) => communicationWriter.listTemplates(tx, who.authority));
	assert.equal(listed.status, "ok");
	return listed.status === "ok" ? listed.value.templates.filter((t) => !t.archived).map((t) => t.name) : [];
};

async function checkFacts(c: Case, who: EvryActor, found: SourceRow[], answer: string) {
	if (c.facts === "forMeeting") {
		const emails = found.filter((r) => r.kind === "message");
		const expected = await rows<{ id: string }>(
			sql`SELECT c.id FROM communication c WHERE c.plant_id=${PLANT} AND c.meeting_id=(SELECT meeting_id FROM communication WHERE id=${INVITATION}) ORDER BY c.id`,
		);
		assert.deepEqual(emails.map((r) => r.id).toSorted(), expected.map((r) => r.id).toSorted());
		assert.deepEqual(emails.map((r) => r.id).toSorted(), [INVITATION, REMINDER].toSorted());
		const sent = emails.find((r) => r.id === INVITATION)!;
		assert.deepEqual([sent.fields.state, sent.fields.sentAt], ["sent", "2026-11-09 08:00 America/Chicago"]);
		assert.match(answer, /"You're invited: Vision Night": sent, sent 2026-11-09 08:00 America\/Chicago/);
		assert.match(answer, /"Vision Night reminder": draft, not sent/);
	}
	if (c.facts === "tracking") {
		const people = found.filter((r) => r.kind === "person");
		assert.deepEqual(
			people.map((p) => [p.label, p.fields.result]).toSorted(),
			INVITED.map((r) => [r.name, r.result]).toSorted(),
		);
		for (const r of INVITED) {
			const line = answer.split("\n").find((l) => l.startsWith(`- ${r.name}: `));
			assert.ok(line, `the answer names ${r.name}`);
			if (r.result === "sent" || r.result === "checking") assert.doesNotMatch(line, /\bdelivered\b/i, r.name);
			if (r.result === "delivered" || r.result === "opened") assert.match(line, /\bdelivered\b/, r.name);
		}
	}
	if (c.facts === "totals") {
		const totals = await gatedTransaction(db, (tx) =>
			communicationWriter.getDeliveryTotals(tx, who.authority, { communicationId: INVITATION }),
		);
		assert.equal(totals.status, "ok");
		if (totals.status !== "ok") return;
		const t = totals.value;
		const [row] = found.filter((r) => r.kind === "tally");
		assert.equal(row?.id, INVITATION);
		assert.deepEqual(
			[row.fields.sent, row.fields.delivered, row.fields.opened, row.fields.bounced, row.fields.failed],
			[t.sent, t.delivered, t.opened, t.bounced, t.failed],
		);
		assert.deepEqual([row.fields.unsubscribed, row.fields.stillChecking], [t.unsubscribed, t.unknown]);
		assert.match(
			answer,
			new RegExp(`^- Delivered: ${t.delivered} \\(delivery not confirmed yet for ${t.sent - t.delivered}\\)$`, "m"),
		);
		assert.match(answer, new RegExp(`^- Sent \\(accepted by the email service\\): ${t.sent} of ${t.selected}$`, "m"));
		for (const [label, n] of [
			["Opened", t.opened],
			["Bounced", t.bounced],
			["Failed", t.failed],
			["Unsubscribed", t.unsubscribed],
			["Still being checked", t.unknown],
		] as const)
			assert.match(answer, new RegExp(`^- ${label}: ${n}$`, "m"));
	}
	if (c.facts === "teams") {
		const teams = await gatedTransaction(db, (tx) => communicationWriter.listAudienceTeams(tx, who.authority));
		assert.equal(teams.status, "ok");
		const names = teams.status === "ok" ? teams.value.teams.map((t) => t.name) : [];
		assert.ok(names.length > 0);
		assert.deepEqual(
			found.filter((r) => r.kind === "team").map((r) => r.label),
			names,
		);
		for (const name of names) assert.ok(answer.includes(name), name);
	}
}

async function checkAfter(c: Case, who: EvryActor) {
	const templates = await nativeTemplates(who);
	if (c.check === "deleted") {
		assert.ok(!templates.includes("Hope newcomer welcome"), "the template list no longer shows it");
		assert.deepEqual(await rows(sql`SELECT FROM message_template WHERE name='Hope newcomer welcome'`), []);
	}
	if (c.check === "archived" || c.check === "unchanged") {
		const [kept] = await rows<{ name: string; archived: boolean; used: string | null }>(
			sql`SELECT t.name,t.archived_at IS NOT NULL AS archived,(SELECT c.template_id::text FROM communication c WHERE c.id=${INVITATION}) AS used
				FROM message_template t WHERE t.id=${USED_TEMPLATE}`,
		);
		assert.deepEqual(kept, {
			name: "Vision night invitation",
			archived: c.check === "archived",
			used: USED_TEMPLATE,
		});
		assert.equal(templates.includes("Vision night invitation"), c.check === "unchanged");
	}
	if (c.check === "corrected") {
		const log = (await read(who, "followups.listContactHistory", { personId: await alexId() })).rows.filter(
			(r) => r.kind === "contact",
		);
		const old = log.find((r) => r.id === ALEX_CALL);
		const next = log.find((r) => r.id !== ALEX_CALL && r.fields.outcome === "attempted_no_contact");
		assert.equal(old?.fields.state, "corrected", "the old entry is kept as superseded");
		assert.equal(old?.fields.outcome, "contacted");
		assert.ok(next, "the corrected entry is in the log");
		assert.equal(next.fields.occurredAt, old.fields.occurredAt);
		assert.equal(next.fields.state, "effective");
	}
	if (c.check === "retimed") {
		const log = (await read(who, "followups.listContactHistory", { personId: await alexId() })).rows.filter(
			(r) => r.kind === "contact" && r.fields.state === "effective",
		);
		assert.deepEqual(
			log.map((r) => [r.fields.outcome, r.fields.occurredAt]),
			[["contacted", "2026-11-03 17:00 America/Chicago"]],
			"the saved entry has the time the card showed",
		);
	}
}
const alexId = async () =>
	(await rows<{ id: string }>(sql`SELECT person_id AS id FROM contact_outcome WHERE id=${ALEX_CALL}`))[0]!.id;

test("INV-communication-catalog: the recorded suites offer the eight tools, a Member is offered the four meeting and delivery reads and correctContactLog, never teams, recipients or template removal", async () => {
	for (const op of TOOLS) assert.equal(RECORDED(op), true, op);
	const offered = (who: EvryActor) => {
		const catalog = readCatalog(who);
		return [
			...catalog.domains.flatMap((d) => d.operations.map((o) => o.operation)),
			...catalog.reviewedWrites.map((w) => w.operation),
		];
	};
	const owner = offered(await actorOf("owner"));
	for (const op of TOOLS) assert.ok(owner.includes(op), `owner ${op}`);
	const member = offered(await actorOf("member"));
	for (const op of [
		"communication.forMeeting",
		"communication.meetingRecipientTracking",
		"communication.deliveryTotals",
		"mail.suppression.listForSelf",
		"communication.correctContactLog",
	])
		assert.ok(member.includes(op), `member ${op}`);
	for (const op of [
		"communication.listAudienceTeams",
		"communication.searchRecipients",
		"communication.templates.archiveOrDelete",
	])
		assert.ok(!member.includes(op), `member ${op}`);
	assert.deepEqual(
		offered(await actorOf("org")).filter((op) => TOOLS.includes(op)),
		[],
		"an organization seat gets none",
	);
});

test("INV-communication-self: mail.suppression.listForSelf takes no input and reads only the signed-in account's own address", async () => {
	assert.deepEqual(listForSelf.input.safeParse({}).success, true);
	for (const extra of [{ address: OWNER_EMAIL }, { accountId: randomUUID() }, { personId: randomUUID() }])
		assert.equal(listForSelf.input.safeParse(extra).success, false, JSON.stringify(extra));
	const owner = (await read(await actorOf("owner"), "mail.suppression.listForSelf")).rows;
	assert.deepEqual(owner[0]?.fields, { blocked: true, restores: 1 });
	assert.equal(owner[1]?.fields.reason, "My inbox was full");
	const admin = (await read(await actorOf("admin"), "mail.suppression.listForSelf")).rows;
	assert.deepEqual(admin[0]?.fields, { blocked: false, restores: 0 });
	const member = (await read(await actorOf("member"), "mail.suppression.listForSelf")).rows;
	assert.deepEqual(member[0]?.fields, { blocked: true, restores: 0 }, "the Member's own block, not the Owner's");
	assert.doesNotMatch(JSON.stringify([owner, admin, member]), /@example\./);
});

test("INV-communication-meeting-match: the meeting matching the most words wins, then one with emails, before a sooner meeting of the same type", async () => {
	const owner = await actorOf("owner");
	const [interest, potluck] = [randomUUID(), randomUUID()];
	const meeting = (id: string, title: string, day: string, startsAt: string) =>
		admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
			VALUES(${id},${PLANT},'vision_meeting',${title},${day},'18:30','America/Chicago',${startsAt},'1','planning',1)`);
	const ops = ["communication.forMeeting", "communication.meetingRecipientTracking"];
	const first = async (op: string, meetingWords: string) => (await read(owner, op, { meetingWords })).rows[0]?.id;
	try {
		const thursday = (
			await rows<{ id: string }>(sql`SELECT meeting_id AS id FROM communication WHERE id=${INVITATION}`)
		)[0]!.id;
		await meeting(interest, "Interest meeting", "2026-11-10", "2026-11-11T00:30:00Z");
		for (const op of ops)
			assert.equal(
				await first(op, "vision night"),
				thursday,
				`${op}: a sooner vision meeting with no emails is passed over`,
			);
		await meeting(potluck, "Vision night potluck", "2026-11-11", "2026-11-12T00:30:00Z");
		for (const op of ops)
			assert.equal(await first(op, "vision night potluck"), potluck, `${op}: the meeting matching more words wins`);
	} finally {
		await admin.execute(sql`DELETE FROM meeting WHERE id IN (${interest},${potluck})`);
	}
});

test("INV-communication-system-template: a system template gets no review card, with the reason", async () => {
	const owner = await actorOf("owner");
	const listed = await gatedTransaction(db, (tx) => communicationWriter.listTemplates(tx, owner.authority));
	assert.equal(listed.status, "ok");
	const system = listed.status === "ok" ? listed.value.templates.find((t) => t.origin === "system") : undefined;
	assert.ok(system);
	const conversation = await createConversation(db, owner, { requestKey: randomUUID() });
	const lease = { turnId: randomUUID(), leaseOwner: "test", generation: 1 } as never;
	await assert.rejects(
		prepareProposal(
			db,
			owner,
			lease,
			conversation.id,
			{ operation: "communication.templates.archiveOrDelete", input: { templateId: system.templateId } },
			mail,
		),
		(error: { code?: string; problem?: string }) =>
			error.code === "invalid_subject" && /System templates .* can't be deleted or archived/.test(error.problem ?? ""),
	);
	assert.deepEqual(await rows(sql`SELECT FROM proposal WHERE conversation_id=${conversation.id}`), []);
});

test("INV-evry-communication-evals: every Communication case passes on the scripted model", async (t) => {
	const forbid = file.forbid.map(pattern);
	for (const c of file.cases) {
		await t.test(c.id, async () => {
			const actor = await actorOf(c.actor);
			const turn = await ask(actor, [c.ask, ...(c.then ? [c.then] : [])]);
			assert.deepEqual(
				turn.results.map((r) => r.operation),
				c.calls,
				"tool calls",
			);
			for (const p of c.answer ?? []) assert.match(turn.answer, pattern(p));
			for (const p of [...(c.absent ?? []).map(pattern), ...forbid]) assert.doesNotMatch(turn.answer, p);
			await checkFacts(
				c,
				actor,
				turn.results.flatMap((r) => r.result.rows ?? []),
				turn.answer,
			);
			if (!c.proposal) {
				assert.equal(turn.proposals.length, 0, "no review card");
				if (c.check) await checkAfter(c, actor);
				return;
			}
			const [proposal] = turn.proposals;
			assert.ok(proposal, "a review card");
			assert.equal(proposal.operation, c.proposal.operation);
			assert.equal(proposal.review.target?.label, c.proposal.target);
			assert.equal(proposal.review.refusal ?? null, null);
			for (const [field, after, before] of c.proposal.changes) {
				const shown: { field: string; before: unknown; after: unknown } | undefined = proposal.review.changes.find(
					(x) => x.field === field,
				);
				assert.ok(shown, field);
				assert.deepEqual(shown.after, after, field);
				if (before !== undefined) assert.deepEqual(shown.before, before, `${field} before`);
			}
			for (const field of c.proposal.hidden ?? [])
				assert.ok(!proposal.review.changes.some((x) => x.field === field), `${field} is not on the card`);
			if (!c.approve) {
				if (c.check) await checkAfter(c, actor);
				return;
			}
			assert.equal(await approveAndRun(actor, proposal), "completed");
			await checkAfter(c, actor);
		});
	}
});
