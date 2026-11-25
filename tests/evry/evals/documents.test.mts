import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { S3Client, type PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import { docDocument, readNative } from "../../../packages/contracts/src/documents/index.ts";
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { createConversation, prepareProposal, submitTurn, type EvryActor } from "../../../packages/evry/src/index.ts";
import { READ_DOMAINS } from "../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter } from "../../../packages/evry/src/catalog/types.ts";
import { applyEdits, plainField } from "../../../packages/evry/src/adapters/documents/draft.ts";
import { claimDue, finishClaim } from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { DOCS, goldenChurch, PLANT, type ActorName, type GoldenChurch } from "./golden-church.mts";
import { nativePorts } from "./settings-ports.mts";
import { scriptedTurns } from "./scripted-turns.mts";

type Row = [field: string, before: unknown, after: unknown];
type Case = {
	id: string;
	actor: ActorName;
	ask: string;
	operation: string;
	calls: string[];
	answer?: string[];
	proposal?: { operation: string; target: string | null; changes: Row[]; notes?: string[] };
	approve?: "completed" | "refused";
};
const { cases } = JSON.parse(readFileSync(new URL("./documents.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

const objects = new Map<string, Buffer>();
const client = new S3Client({
	endpoint: "http://127.0.0.1:9",
	region: "auto",
	forcePathStyle: true,
	credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
});
let failing = false;
client.send = (async (command: { constructor: { name: string }; input: { Key?: string; Body?: Uint8Array } }) => {
	if (command.constructor.name === "GetBucketAclCommand")
		return { Grants: [{ Grantee: { Type: "CanonicalUser", ID: "owner" }, Permission: "FULL_CONTROL" }] };
	if (command.constructor.name !== "PutObjectCommand") throw Error(`unexpected ${command.constructor.name}`);
	if (failing) throw Error("the bucket is down");
	objects.set(command.input.Key!, Buffer.from(command.input.Body!));
	return {};
}) as never;
const storage = { bucket: "synthetic-only", client } as PrivateStorage;
const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = storage;

let church: GoldenChurch;
let turns: ReturnType<typeof scriptedTurns>;
before(async () => {
	church = await goldenChurch({ seatNames: true });
	turns = scriptedTurns(church.db, nativePorts(), storage);
});
after(() => church?.close());

const reads = new Map(READ_DOMAINS.documents.map((a) => [a.operation, a as ReadAdapter<unknown>]));
const read = (who: ActorName, operation: string, input: unknown) =>
	invokeRead(church.db, church.actors[who], reads.get(operation)!, input);
const stored = async (id: string) =>
	(
		await church.admin.execute(sql`SELECT d.kind,d.title,d.revision::int AS revision,r.body FROM document d
			JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${id}::uuid`)
	).rows[0] as { kind: string; title: string; revision: number; body: string };
const counts = async () =>
	(
		await church.admin.execute(sql`SELECT (SELECT count(*)::int FROM document) AS documents,
			(SELECT count(*)::int FROM document_revision) AS revisions,
			(SELECT count(*)::int FROM generated_document) AS made, (SELECT count(*)::int FROM file_object) AS files`)
	).rows[0];
const native = (id: string) => stored(id).then((d) => readNative(d.body).body);

async function propose(actor: EvryActor, operation: string, input: unknown) {
	const c = await createConversation(church.db, actor, { requestKey: randomUUID() });
	await submitTurn(church.db, actor, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(church.db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const lease = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	try {
		return await prepareProposal(church.db, actor, lease, c.id, { operation, input });
	} finally {
		await transaction(church.db, (tx) => finishClaim(tx, claim, { state: "succeeded" }));
	}
}

let letter = "";
let file = "";
const AFTER: Record<string, (receipt: string, earlier: string) => Promise<void>> = {
	"DOC-01": async (receipt) => {
		letter = receipt;
		assert.deepEqual(await native(letter), {
			type: "doc",
			content: [
				{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Welcome to the launch team" }] },
				{
					type: "paragraph",
					content: [{ type: "text", text: "We are glad you said yes to helping start this church." }],
				},
				{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "What to expect" }] },
				{
					type: "bulletList",
					content: ["Team night every other Thursday", "A ministry to serve in"].map((text) => ({
						type: "listItem",
						content: [{ type: "paragraph", content: [{ type: "text", text }] }],
					})),
				},
				{ type: "paragraph", content: [{ type: "text", text: "Reply to this letter with any question." }] },
			],
		});
		const edited = await documentsWriter.saveNative(church.db, church.actors.owner.authority, {
			title: "Launch team welcome letter",
			body: await native(letter),
			documentId: letter,
			expectedRevision: "1",
		} as unknown);
		assert.equal(edited.status, "ok", "the church edits the saved document itself");
	},
	"DOC-02": async (receipt, earlier) => {
		assert.equal(receipt, letter);
		const now = await stored(letter);
		assert.deepEqual([now.kind, now.revision], ["native", 3]);
		assert.equal(now.body, earlier.replace("every other Thursday", "every Tuesday"));
	},
	"DOC-13": async (receipt) => {
		file = receipt;
		const [row] = (
			await church.admin
				.execute(sql`SELECT gd.inputs,gd.format,gd.creator_account_id,f.sha256,f.opaque_key FROM generated_document gd
				JOIN file_object f ON f.id=gd.object_id AND f.state='ready' WHERE gd.id=${file}::uuid`)
		).rows as { inputs: unknown; format: string; creator_account_id: string; sha256: string; opaque_key: string }[];
		assert.deepEqual(row!.inputs, [
			{ key: "church_name", value: "Hope Fellowship", source: "church_name" },
			{ key: "pastor_name", value: "Pastor Nate Ellis", source: "override" },
		]);
		assert.equal(row!.creator_account_id, church.actors.member.accountId);
		const bytes = objects.get(row!.opaque_key)!;
		assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
		assert.equal(createHash("sha256").update(bytes).digest("hex"), row!.sha256);
	},
};

test("INV-evry-documents: every document case passes on the scripted model: the card shows what is saved, nothing is written before approval, and the download link names the file only", async () => {
	for (const c of cases) {
		const actor = church.actors[c.actor];
		const earlier = letter ? (await stored(letter)).body : "";
		const held = await counts();
		const turn = await turns.ask(actor, c.ask);
		assert.deepEqual(turn.reads, c.calls, `${c.id} reads: ${turn.answer}`);
		for (const text of c.answer ?? [])
			assert.ok(turn.answer.includes(text), `${c.id} answer ${JSON.stringify(turn.answer)} has ${text}`);
		assert.deepEqual(await counts(), held, `${c.id} writes nothing before approval`);
		for (const key of [...objects.keys(), "X-Amz-"])
			assert.equal(turn.transcript.includes(key), false, `${c.id} shows no storage key or signed link`);
		if (!c.proposal) {
			assert.equal(turn.proposals.length, 0, c.id);
			continue;
		}
		assert.equal(turn.proposals.length, 1, `${c.id}: ${turn.answer}`);
		const [proposal] = turn.proposals;
		assert.equal(proposal!.operation, c.proposal.operation, c.id);
		assert.equal(proposal!.review.target?.label ?? null, c.proposal.target, c.id);
		assert.deepEqual(
			proposal!.review.changes.map((x) => [x.field, x.before, x.after]),
			c.proposal.changes,
			c.id,
		);
		if (c.proposal.notes) assert.deepEqual(proposal!.review.notes, c.proposal.notes, c.id);
		if (!c.approve) continue;
		const { outcome, review } = await turns.approve(actor, proposal!);
		assert.equal(outcome, c.approve, c.id);
		if (outcome === "completed") await AFTER[c.id]!(review.receipt!.receiptId!, earlier);
	}
});

test("INV-evry-documents: a Church Document edit keeps its fields, tables and every other block, and shows the passage before and after", async () => {
	const owner = church.actors.owner;
	const before = docDocument.parse(JSON.parse((await stored(DOCS.policy.id)).body));
	const text = String((await read("owner", "documents.read", { documentId: DOCS.policy.id })).rows[0]!.fields.text);
	const line = text
		.split("\n")
		.find((l) => l.length > 60 && !l.includes("Hope Fellowship") && !l.includes("[") && !l.includes(" | "))!;
	const find = line.slice(0, 40);
	const proposal = (await propose(owner, "documents.saveNative", {
		kind: "edit",
		documentId: DOCS.policy.id,
		edits: [{ find, replace: `Reviewed. ${find}` }],
	}))!;
	assert.deepEqual(proposal.review.changes, [{ field: "text", before: line, after: `Reviewed. ${line}` }]);
	assert.equal((await turns.approve(owner, proposal)).outcome, "completed");
	const now = docDocument.parse(JSON.parse((await stored(DOCS.policy.id)).body));
	const { body: bodyBefore, ...rest } = before;
	const { body: bodyNow, ...restNow } = now;
	assert.deepEqual(restNow, rest);
	assert.equal(JSON.stringify(bodyNow).replace("Reviewed. ", ""), JSON.stringify(bodyBefore));
});

test("INV-evry-documents: words that hold a filled-in detail are refused, so a merge field never becomes plain text", () => {
	const doc = {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "Welcome to " },
					{ type: "field", attrs: { key: "church_name" } },
					{ type: "text", text: ", friend." },
				],
			},
			{
				type: "bulletList",
				content: [
					{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Bring a chair" }] }] },
				],
			},
		],
	} as never;
	const church = () => "Hope";
	const edit = (find: string, replace: string) => applyEdits(doc, [{ find, replace }], church);
	assert.throws(() => edit("Welcome to Hope", "Welcome home"), /invalid_input/);
	assert.throws(() => edit("missing words", "x"), /invalid_input/);
	assert.throws(() => edit("e", "x"), /invalid_input/);
	assert.deepEqual(edit("Welcome to Hope, friend.", "Welcome to Hope, dear friend.").passages, [
		{ before: "Welcome to Hope, friend.", after: "Welcome to Hope, dear friend." },
	]);
	assert.deepEqual(edit("Welcome to Hope, friend.", "Welcome to Hope, dear friend.").body, {
		type: "doc",
		content: [
			{
				type: "paragraph",
				content: [
					{ type: "text", text: "Welcome to " },
					{ type: "field", attrs: { key: "church_name" } },
					{ type: "text", text: ", dear friend." },
				],
			},
			(doc as { content: unknown[] }).content[1],
		],
	});
	const list = applyEdits(doc, [{ find: "Bring a chair", replace: "Bring a chair\nBring a Bible" }], plainField);
	assert.deepEqual((list.body as { content: { content: unknown[] }[] }).content[1]!.content.length, 2);
	assert.deepEqual(list.passages, [{ before: "Bring a chair", after: "Bring a chair\nBring a Bible" }]);
});

test("INV-evry-documents: a document that changed after the card was prepared is refused as a conflict and keeps the newer text, for both kinds", async () => {
	const owner = church.actors.owner;
	const policy = docDocument.parse(JSON.parse((await stored(DOCS.policy.id)).body));
	const kinds = [
		{
			id: DOCS.octoberAgenda.id,
			find: "Welcome and tacos",
			raw: { title: "Newer title", body: await native(DOCS.octoberAgenda.id) },
		},
		{ id: DOCS.policy.id, find: "Reviewed. ", raw: { body: { ...policy, title: "Newer policy" } } },
	];
	for (const k of kinds) {
		const proposal = (await propose(owner, "documents.saveNative", {
			kind: "edit",
			documentId: k.id,
			edits: [{ find: k.find, replace: "Changed by Evry " }],
		}))!;
		const at = await stored(k.id);
		const newer = await documentsWriter.saveNative(church.db, owner.authority, {
			...k.raw,
			documentId: k.id,
			expectedRevision: String(at.revision),
		} as unknown);
		assert.equal(newer.status, "ok");
		const kept = await stored(k.id);
		const { outcome, review } = await turns.approve(owner, proposal);
		assert.deepEqual([outcome, review.receipt?.code], ["refused", "revision_conflict"]);
		assert.deepEqual(await stored(k.id), kept);
	}
});

test("INV-evry-documents: an edit is refused to a Member, and another church's document is never found", async () => {
	const input = { kind: "edit", documentId: DOCS.otherChurch.id, edits: [{ find: "New Hope", replace: "x" }] };
	assert.equal(await propose(church.actors.owner, "documents.saveNative", input), null);
	await assert.rejects(propose(church.actors.member, "documents.saveNative", input), /access_denied/);
});

test("INV-evry-documents: the template answers are the domain's own, and a file whose reviewed value changed, or whose store fails, is never made", async () => {
	const owner = church.actors.owner;
	for (const input of [{ phase: 1 }, { category: "vision_meeting" }, { phase: 6 }, {}] as const) {
		const mine = await read("owner", "documents.templates.contextual", input);
		const theirs = await documentsReader["templates.contextual"](church.db, owner.authority, input);
		assert.ok(theirs.status === "ok");
		assert.deepEqual(
			mine.rows.map((r) => [r.id, r.label]),
			theirs.value.templates.map((t) => [t.id, t.name]),
		);
	}
	const before = await counts();
	const request = { templateId: "response-card" };
	const proposal = (await propose(owner, "documents.generate", request))!;
	await church.admin.execute(sql`UPDATE plant SET name='Renamed Church' WHERE id=${PLANT}::uuid`);
	const changed = await turns.approve(owner, proposal);
	assert.deepEqual([changed.outcome, changed.review.receipt?.code], ["refused", "revision_conflict"]);

	await church.admin.execute(sql`UPDATE plant SET name=E'\\t' WHERE id=${PLANT}::uuid`);
	const missing = await read("owner", "documents.resolveContext", request);
	assert.deepEqual(missing.facts, { complete: false, missing: "Church Name" });
	const blank = await read("owner", "documents.preview", request);
	assert.deepEqual([blank.facts?.rendered, blank.facts?.missing], [false, "Church Name"]);
	const refused = (await propose(owner, "documents.generate", request))!;
	assert.equal(refused.review.refusal, "Still needed before a file can be made: Church Name.");
	await church.admin.execute(sql`UPDATE plant SET name='Hope Fellowship' WHERE id=${PLANT}::uuid`);

	const unsafe = await read("owner", "documents.preview", {
		templateId: "follow-up-letter",
		values: [{ key: "pastor_name", value: "bad\ud800" }],
	});
	assert.deepEqual([unsafe.facts?.rendered, unsafe.facts?.failure], [false, "The preview could not be made."]);

	const down = (await propose(owner, "documents.generate", request))!;
	failing = true;
	const failed = await turns.approve(owner, down).finally(() => (failing = false));
	assert.notEqual(failed.outcome, "completed");
	assert.deepEqual(
		{ ...(before as object), files: 0 },
		{ ...((await counts()) as object), files: 0 },
		"no document or made file is added",
	);
});

test("INV-tenancy: the history is the domain's own for the seat; another church, a deleted file and a file that is not ready give no link", async () => {
	const mine = await read("owner", "documents.history.list", {});
	const raw: unknown = {};
	const theirs = await documentsWriter["history.list"](church.db, church.actors.owner.authority, raw);
	assert.ok(theirs.status === "ok");
	assert.deepEqual(
		mine.rows.map((r) => [r.id, r.label, r.fields.madeAt]),
		theirs.value.entries.map((e) => [e.id, e.savedTemplateName, e.generatedAt]),
	);
	const link = async (who: ActorName, fileId: string) =>
		(await read(who, "documents.download", { fileId })).rows.map((r) => r.fields.href);
	assert.deepEqual(await link("owner", file), [`/documents/files/${file}`]);
	assert.deepEqual(await link("other", file), []);
	assert.deepEqual(await link("owner", randomUUID()), []);
	for (const state of ["pending", "failed", "cleanup"]) {
		await church.admin.transaction(async (tx) => {
			await tx.execute(sql`SET LOCAL session_replication_role=replica`);
			await tx.execute(
				sql`UPDATE file_object SET state=${state} WHERE id=(SELECT object_id FROM generated_document WHERE id=${file}::uuid)`,
			);
		});
		assert.deepEqual(await link("owner", file), [], state);
		assert.deepEqual((await read("owner", "documents.history.list", {})).rows, [], state);
	}
});
