import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { LanguageModelV4CallOptions } from "../../../packages/evry/node_modules/@ai-sdk/provider/dist/index.js";
import {
	approveProposal,
	cancelProposal,
	cancelTurn,
	createConversation,
	listConversations,
	observeConversation,
	openLatestConversation,
	readConversation,
	readReview,
	retryTurn,
	submitTurn,
	type EvryActor,
} from "../../../packages/evry/src/index.ts";
import {
	actor,
	admin,
	bucket,
	counts,
	db,
	freshActor,
	otherPlant,
	scripted,
	setup,
	sql,
	teardown,
	work,
} from "./support.mts";

before(setup);
after(teardown);

const refused = async (body: () => Promise<unknown>, code: string) =>
	assert.rejects(body, (e: { code?: string }) => {
		assert.equal(e.code, code);
		return true;
	});

const CANARY = "Discovery canary about our sending budget";

async function account(kind: "discovery" | "planter") {
	const [id, user, session] = [randomUUID(), randomUUID(), randomUUID()];
	await admin.execute(
		sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${user},${id + "@example.test"},true,'Planter')`,
	);
	await admin.execute(
		sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${id},${user},'active',${kind})`,
	);
	await admin.execute(
		sql`INSERT INTO auth_session(id,user_id,token,expires_at) VALUES(${session},${user},${randomUUID()},clock_timestamp()+interval '1 day')`,
	);
	if (kind === "discovery") await admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${id})`);
	const as = async () => (await freshActor(session))!;
	return { id, as };
}
const discoveryAccount = () => account("discovery");
const seat = (accountId: string, church: string, role: "owner" | "admin" | "member") =>
	admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${accountId},${church},${role},clock_timestamp())`,
	);

async function discoveryChat(as: EvryActor, text: string) {
	const c = await createConversation(db, as, { requestKey: randomUUID() });
	await submitTurn(db, as, c.id, { requestKey: randomUUID(), text });
	await cancelTurn(db, as, c.id);
	return c.id;
}

async function pendingReview(accountId: string, conversationId: string) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO proposal(id,tenant_id,account_id,conversation_id,operation,revision,input,review,digest,state,created_at,updated_at,expires_at)
		VALUES(${id},${accountId},${accountId},${conversationId},'documents.saveNative',1,'{"input":{}}'::jsonb,
			'{"target":{"kind":"document","id":"x","label":"Vision statement","href":"/documents"},"changes":[]}'::jsonb,
			${"a".repeat(64)},'pending',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '15 minutes')`);
	const result = { proposalId: id, rows: [{ kind: "document", id: "x", label: "Vision statement" }] };
	await admin.execute(sql`WITH c AS (UPDATE conversation SET last_sequence=last_sequence+1 WHERE id=${conversationId} RETURNING id,last_sequence)
		INSERT INTO conversation_event(conversation_id,sequence,kind,body)
		SELECT id,last_sequence,'tool_result',${JSON.stringify({ operation: "propose_change", result })}::jsonb FROM c`);
	return id;
}

async function convert(accountId: string, church: string) {
	await admin.execute(
		sql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES(${church},'New Hope','America/Chicago',7,14,1,8,1,1)`,
	);
	await seat(accountId, church, "owner");
	await admin.execute(
		sql`UPDATE discovery SET converted_at=clock_timestamp(),converted_plant_id=${church} WHERE account_id=${accountId}`,
	);
}

const proposalState = async (id: string) =>
	(await admin.execute(sql`SELECT state,approved_at FROM proposal WHERE id=${id}`)).rows[0];

async function convertedPlanter() {
	const planter = await discoveryAccount();
	const seatless = await planter.as();
	assert.equal(seatless.discovery, true);
	const older = await discoveryChat(seatless, "Vision for the north side");
	const pending = await discoveryChat(seatless, CANARY);
	const review = await pendingReview(planter.id, pending);
	const plantId = randomUUID();
	await convert(planter.id, plantId);
	const church = await planter.as();
	assert.equal(church.owner.id, plantId);
	const own = await createConversation(db, church, { requestKey: randomUUID() });
	await submitTurn(db, church, own.id, { requestKey: randomUUID(), text: "Who is new this week?" });
	await cancelTurn(db, church, own.id);
	return { planter, older, pending, review, own: own.id, plantId };
}

const listed = async (as: EvryActor, search?: string) =>
	(await listConversations(db, as, search ? { search } : {})).items.map((c) => [c.id, c.discovery]);

test("INV-discovery-chats: a converted planter lists Discovery chats in their own group after church chats, finds them by title and message, and reads them with their closed reviews", async () => {
	const { planter, older, pending, review, own } = await convertedPlanter();
	const church = await planter.as();
	assert.deepEqual(await listed(church), [
		[own, false],
		[pending, true],
		[older, true],
	]);
	assert.deepEqual(await listed(church, "north side"), [[older, true]], "by title");
	assert.deepEqual(await listed(church, "sending budget"), [[pending, true]], "by the planter's own message");
	assert.equal((await openLatestConversation(db, church))?.conversation.id, own, "a Discovery chat never opens first");

	const read = await readConversation(db, church, pending);
	assert.equal(read.conversation.discovery, true);
	assert.equal(read.conversation.context, "account");
	assert.deepEqual(
		read.events.filter((e) => e.kind === "user_message").map((e) => e.body.text),
		[CANARY],
	);
	assert.equal(read.reviews[review]?.status, "pending");
	assert.equal(read.reviews[review]?.closed, true);
	assert.equal((await readReview(db, church, review)).closed, true);
	const streamed = [];
	for await (const e of observeConversation(db, church, pending, 0, AbortSignal.timeout(2_000))) streamed.push(e.kind);
	assert.ok(streamed.includes("user_message"), "the planter can stream their own Discovery chat");
	await refused(() => readConversation(db, church, randomUUID()), "not_found");
});

test("INV-discovery-chats: a Discovery chat refuses a new message, retry, cancel, attachment and approval after conversion and writes nothing", async () => {
	const { planter, pending, review } = await convertedPlanter();
	const files = bucket();
	for (const label of ["church seat", "ended seat"]) {
		if (label === "ended seat")
			await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${planter.id}`);
		const as = await planter.as();
		const before = await counts();
		await refused(() => submitTurn(db, as, pending, { requestKey: randomUUID(), text: "One more thing" }), "discovery_read_only");
		await refused(() => retryTurn(db, as, pending, { requestKey: randomUUID() }), "discovery_read_only");
		await refused(() => cancelTurn(db, as, pending), "discovery_read_only");
		await refused(() => files.attach(as, pending, "notes.txt", Buffer.from("notes")), "discovery_read_only");
		await refused(
			() => approveProposal(db, as, review, { revision: 1, digest: "a".repeat(64) }, files.storage),
			"review_closed",
		);
		assert.equal((await cancelProposal(db, as, review)).cancelled, false, label);
		assert.deepEqual(await counts(), before, `${label}: nothing is written`);
		assert.deepEqual(await proposalState(review), { state: "pending", approved_at: null }, label);
		assert.equal((await readConversation(db, as, pending)).conversation.discovery, true, label);
	}
});

test("INV-discovery-chats: an ended or moved seat keeps reading Discovery chats the same way, and an open Discovery profile keeps writable chats", async () => {
	const { planter, older, pending, own } = await convertedPlanter();
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${planter.id}`);
	const ended = await planter.as();
	assert.equal(ended.seatId, null);
	assert.deepEqual(await listed(ended), [
		[pending, true],
		[older, true],
	]);
	assert.equal((await readConversation(db, ended, older)).conversation.discovery, true);
	const fresh = await createConversation(db, ended, { requestKey: randomUUID() });
	assert.equal(fresh.discovery, false, "a chat the seatless account starts later is not from Discovery");
	await cancelTurn(db, ended, fresh.id);

	await admin.execute(
		sql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${planter.id},${otherPlant},'member',clock_timestamp())`,
	);
	const moved = await planter.as();
	assert.equal(moved.owner.id, otherPlant);
	assert.equal((await readConversation(db, moved, older)).conversation.discovery, true);
	assert.ok((await listed(moved)).some(([id, d]) => id === older && d));
	await refused(() => readConversation(db, moved, own), "church_changed");

	const open = await discoveryAccount();
	const exploring = await open.as();
	const c = await discoveryChat(exploring, "Still exploring");
	assert.deepEqual(await listed(exploring), [[c, false]]);
	const sent = await submitTurn(db, exploring, c, { requestKey: randomUUID(), text: "And another question" });
	assert.equal(sent.replayed, false, "an unconverted Discovery chat still takes messages");
	await cancelTurn(db, exploring, c);
});

test("INV-tenancy: only the planter reaches their Discovery chats; church seats, other churches, the network and other accounts get not_found", async () => {
	const { pending, review, plantId } = await convertedPlanter();
	const seated = [];
	for (const role of ["admin", "member"] as const) {
		const other = await account("planter");
		await seat(other.id, plantId, role);
		seated.push(await other.as());
	}
	const before = await counts();
	const others = [...seated, ...(await Promise.all((["owner", "member", "foreign", "orgOwner", "seatless"] as const).map(actor)))];
	for (const other of others) {
		const who = `${other.owner.kind}:${other.role}`;
		await refused(() => readConversation(db, other, pending), "not_found");
		await refused(async () => {
			for await (const _ of observeConversation(db, other, pending, 0, AbortSignal.timeout(200))) void _;
		}, "not_found");
		await refused(() => submitTurn(db, other, pending, { requestKey: randomUUID(), text: "append" }), "not_found");
		await refused(() => readReview(db, other, review), "not_found");
		const seen = (await listConversations(db, other, { search: "sending budget" })).items;
		assert.deepEqual(seen, [], who);
		assert.ok((await listConversations(db, other, {})).items.every((c) => !c.discovery), `${who} has no Discovery group`);
	}
	assert.deepEqual(await counts(), before, "no refused call wrote anything");
});

test("INV-discovery-chats: church Evry's model context and tools for a converted planter hold no Discovery chat text", async () => {
	const { planter } = await convertedPlanter();
	const church = await planter.as();
	const base = scripted();
	if (base.status !== "qualified") throw Error("the scripted model is qualified");
	const seen: LanguageModelV4CallOptions[] = [];
	const model = {
		...base,
		model: {
			...base.model,
			doStream: (o: LanguageModelV4CallOptions) => (seen.push(o), base.model.doStream(o)),
			doGenerate: (o: LanguageModelV4CallOptions) => (seen.push(o), base.model.doGenerate(o)),
		},
	};
	const c = await createConversation(db, church, { requestKey: randomUUID() });
	await submitTurn(db, church, c.id, { requestKey: randomUUID(), text: "Summarize my earlier conversations" });
	assert.equal(await work(model), "succeeded");
	assert.ok(seen.length > 0, "the model was called");
	const told = JSON.stringify(seen.map((o) => ({ prompt: o.prompt, tools: o.tools })));
	assert.ok(told.includes("Summarize my earlier conversations"), "the capture sees this chat");
	for (const text of [CANARY, "Vision for the north side"]) assert.ok(!told.includes(text), text);
});
