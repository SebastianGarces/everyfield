// The Evry Documents reads and the reviews of its reviewed writes, against real rows in two churches. Every read runs
// through invokeRead under the actor's live authority; every review is prepared as the model's propose_change prepares
// it. Executing an approved change loads the document renderer, so commands.test.mts covers that under tsx.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createConversation,
	EvryRefusal,
	prepareProposal,
	submitTurn,
	type EvryActor,
} from "../../../../packages/evry/src/index.ts";
import { READ_DOMAINS, readCatalog } from "../../../../packages/evry/src/catalog/catalog.ts";
import { invokeRead } from "../../../../packages/evry/src/catalog/invoke.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { allowedWrites } from "../../../../packages/evry/src/proposals/store.ts";
import { claimDue } from "../../../../apps/web/src/server/jobs/queue.ts";
import { actor, admin, db, otherPlant, plant, setup, sql, teardown } from "../../runtime/support.mts";
import { seedDocument, type Seeded } from "./seed.mts";

before(setup);
after(teardown);

const reads = new Map(READ_DOMAINS.documents.map((a) => [a.operation, a as ReadAdapter<unknown>]));
const read = (who: EvryActor, operation: string, input: unknown = {}) =>
	invokeRead(db, who, reads.get(operation)!, input);

let docs: Record<string, Seeded>;
let theirs: Record<string, Seeded>;
before(async () => {
	docs = {
		coreValues: await seedDocument(plant, "core_values", "Our Core Values", "We pray first.\nWe make room.", 30),
		september: await seedDocument(
			plant,
			"native",
			"Vision Meeting Agenda - September",
			"6:30 PM Welcome and dinner\n7:00 PM The story of the church",
			20,
		),
		october: await seedDocument(
			plant,
			"native",
			"Vision Meeting Agenda - October",
			"6:00 PM Kids' activity\n6:50 PM Worship and testimony",
			10,
		),
		draft: await seedDocument(plant, "native", "Values Draft", "Prayer comes before planning.", 5),
		empty: await seedDocument(plant, "native", "Blank Page", "", 4),
		policy: await seedDocument(plant, "church_document", "Conflict of Interest Policy", null, 2),
	};
	// The other church has its own documents and marks none as core values.
	theirs = {
		agenda: await seedDocument(otherPlant, "native", "Vision Meeting Agenda - Theirs", "7:00 PM Their welcome", 3),
		policy: await seedDocument(otherPlant, "church_document", "Their Policy", null, 3),
	};
});

/** A running turn in a new conversation: the only place a proposal can be prepared. */
async function propose(who: EvryActor, operation: string, input: unknown) {
	const c = await createConversation(db, who, { requestKey: randomUUID() });
	await submitTurn(db, who, c.id, { requestKey: randomUUID(), text: "hold this turn" });
	const [claim] = await claimDue(db, ["assistant_turn"], 1, 240);
	assert.ok(claim);
	const run = {
		turnId: claim.id,
		tenantId: claim.tenant_id,
		leaseOwner: claim.lease_owner,
		generation: claim.claim_generation,
	};
	return prepareProposal(db, who, run, c.id, { operation, input });
}
const values = (changes: { field: string; after: unknown }[]) =>
	Object.fromEntries(changes.map((c) => [c.field, c.after]));

test("the core values read names the marked document with its link, and says none is marked when none is", async () => {
	const found = await read(await actor("owner"), "documents.readCoreValuesEvidence");
	assert.equal(found.status, "available");
	assert.deepEqual(
		found.rows.map((r) => [r.kind, r.id, r.label, r.fields.type, r.fields.link]),
		[["document", docs.coreValues.id, "Our Core Values", "Core values", `/documents/written/${docs.coreValues.id}`]],
	);
	// The read names the document and never returns its text: Evry does not present core values as its own words.
	assert.equal(JSON.stringify(found).includes("We pray first"), false);
	const none = await read(await actor("foreign"), "documents.readCoreValuesEvidence");
	assert.deepEqual([none.status, none.rows], ["not_found", []]);
});

test("the list shows each live document of the church with its type and link, and no other church's", async () => {
	const list = await read(await actor("owner"), "documents.listOwned");
	assert.deepEqual(
		list.rows.map((r) => [r.label, r.fields.type, r.fields.link]),
		[
			["Conflict of Interest Policy", "Church Document", `/documents/church/${docs.policy.id}`],
			["Blank Page", "Written document", `/documents/written/${docs.empty.id}`],
			["Values Draft", "Written document", `/documents/written/${docs.draft.id}`],
			["Vision Meeting Agenda - October", "Written document", `/documents/written/${docs.october.id}`],
			["Vision Meeting Agenda - September", "Written document", `/documents/written/${docs.september.id}`],
			["Our Core Values", "Core values", `/documents/written/${docs.coreValues.id}`],
		],
	);
	assert.equal(list.total, 6);
	const agendas = await read(await actor("owner"), "documents.listOwned", { title: "vision meeting agenda" });
	assert.deepEqual(
		agendas.rows.map((r) => r.id),
		[docs.october.id, docs.september.id],
	);
	const church = await read(await actor("owner"), "documents.listOwned", { store: "church" });
	assert.deepEqual(
		church.rows.map((r) => r.id),
		[docs.policy.id],
	);
});

test("a document read returns its actual saved text, so a comparison quotes what each agenda says", async () => {
	const owner = await actor("owner");
	for (const doc of [docs.september, docs.october]) {
		const found = await read(owner, "documents.read", { documentId: doc.id });
		assert.equal(found.status, "available");
		assert.equal(found.rows[0]!.fields.text, doc.text);
		assert.equal(found.rows[0]!.fields.textCut, false);
	}
	// A Church Document reads as it prints: the church's details filled in, never the stored JSON.
	const policy = (await read(owner, "documents.read", { documentId: docs.policy.id })).rows[0]!;
	assert.match(
		String(policy.fields.text),
		/^Board policy\nConflict of Interest Policy\nThis policy says how the board of Synthetic, a church plant/,
	);
	assert.equal(String(policy.fields.text).includes('"type"'), false);
});

test("no read in one church returns or names another church's documents", async () => {
	const owner = await actor("owner");
	const foreign = await actor("foreign");
	for (const doc of Object.values(theirs))
		assert.deepEqual((await read(owner, "documents.read", { documentId: doc.id })).rows, []);
	for (const doc of Object.values(docs))
		assert.deepEqual((await read(foreign, "documents.read", { documentId: doc.id })).rows, []);
	const ours = JSON.stringify([
		await read(owner, "documents.listOwned"),
		await read(owner, "documents.readCoreValuesEvidence"),
	]);
	for (const doc of Object.values(theirs)) assert.equal(ours.includes(doc.id) || ours.includes(doc.title), false);
	const list = await read(foreign, "documents.listOwned");
	assert.deepEqual(list.rows.map((r) => r.label).sort(), ["Their Policy", "Vision Meeting Agenda - Theirs"]);
	// A review of another church's document has nothing to show.
	assert.equal(await propose(owner, "documents.archive", { documentId: theirs.agenda.id }), null);
	assert.equal(await propose(owner, "documents.exportNative", { documentId: theirs.policy.id, format: "pdf" }), null);
});

test("the templates list offers the built-in templates with their version and the not-legal-advice notice", async () => {
	const found = await read(await actor("member"), "documents.templates.list", { title: "policy" });
	assert.deepEqual(
		found.rows.map((r) => [r.id, r.fields.version, r.fields.notice]),
		[
			["child-protection-policy", "1", "Template, not legal advice"],
			["conflict-of-interest-policy", "1", "Template, not legal advice"],
			["financial-controls-policy", "1", "Template, not legal advice"],
		],
	);
});

test("a new Church Document's review names the template, its version and the church details it fills in", async () => {
	const proposal = await propose(await actor("owner"), "documents.createFromTemplate", {
		templateId: "child-protection-policy",
	});
	assert.ok(proposal);
	assert.deepEqual(proposal.review.target, {
		kind: "template",
		id: "child-protection-policy",
		label: "Child Protection Policy",
	});
	assert.deepEqual(values(proposal.review.changes), {
		template: "Child Protection Policy",
		templateVersion: "Version 1",
		"Church name": "Synthetic (from church name)",
		"Legal name": "Synthetic (from church name)",
		notice: "Template, not legal advice",
	});
	assert.equal(proposal.status, "pending");
});

test("export, archive and mark-as-core-values reviews show the change on the document the app changes", async () => {
	const owner = await actor("owner");
	const exported = await propose(owner, "documents.exportNative", { documentId: docs.policy.id, format: "pdf" });
	assert.deepEqual(exported?.review.target, {
		kind: "document",
		id: docs.policy.id,
		label: "Conflict of Interest Policy",
	});
	assert.deepEqual(values(exported!.review.changes), { format: "PDF", version: "Version 1" });
	// Only a Church Document has a saved file; a written document has none to export.
	assert.equal(await propose(owner, "documents.exportNative", { documentId: docs.draft.id, format: "pdf" }), null);

	const church = await propose(owner, "documents.archive", { documentId: docs.policy.id });
	assert.deepEqual(values(church!.review.changes), { status: "Archived", list: "Church Documents" });
	const written = await propose(owner, "documents.archive", { documentId: docs.september.id });
	assert.deepEqual(values(written!.review.changes), { status: "Archived", list: "Documents" });

	const mark = await propose(owner, "documents.designateCoreValues", { documentId: docs.draft.id });
	assert.deepEqual(
		mark!.review.changes.map((c) => [c.field, c.before, c.after]),
		[["documentType", "Written document", "Core values"]],
	);
	assert.equal(mark!.review.refusal, undefined);
	// A document with no text, or one already marked, cannot be marked: the card says why and offers no approval.
	const blank = await propose(owner, "documents.designateCoreValues", { documentId: docs.empty.id });
	assert.match(blank!.review.refusal ?? "", /has no text yet/);
	const already = await propose(owner, "documents.designateCoreValues", { documentId: docs.coreValues.id });
	assert.match(already!.review.refusal ?? "", /already marked/);
	assert.equal(await propose(owner, "documents.designateCoreValues", { documentId: docs.policy.id }), null);
});

test("a Member reads documents but gets no document change to propose", async () => {
	const member = await actor("member");
	assert.deepEqual(
		readCatalog(member)
			.domains.find((d) => d.domain === "documents")
			?.operations.map((o) => o.operation),
		["documents.listOwned", "documents.read", "documents.readCoreValuesEvidence", "documents.templates.list"],
	);
	assert.deepEqual(
		allowedWrites(member).filter((w) => w.operation.startsWith("documents.")),
		[],
	);
	assert.deepEqual(
		allowedWrites(await actor("owner"))
			.filter((w) => w.operation.startsWith("documents."))
			.map((w) => w.operation),
		["documents.createFromTemplate", "documents.exportNative", "documents.archive", "documents.designateCoreValues"],
	);
	assert.equal(
		(await read(member, "documents.read", { documentId: docs.october.id })).rows[0]!.fields.text,
		docs.october.text,
	);
	for (const [operation, input] of [
		["documents.createFromTemplate", { templateId: "child-protection-policy" }],
		["documents.exportNative", { documentId: docs.policy.id, format: "pdf" }],
		["documents.archive", { documentId: docs.october.id }],
		["documents.designateCoreValues", { documentId: docs.draft.id }],
	] as const)
		await assert.rejects(
			propose(member, operation, input),
			(e: unknown) => e instanceof EvryRefusal && e.code === "access_denied",
			operation,
		);
	// An organization seat has no Church Documents, so it gets no documents tool at all.
	assert.equal(
		readCatalog(await actor("orgOwner")).domains.some((d) => d.domain === "documents"),
		false,
	);
	const proposals = await admin.execute(sql`SELECT count(*)::int AS n FROM proposal WHERE account_id IN
		(SELECT account_id FROM seat WHERE role='member')`);
	assert.equal((proposals.rows[0] as { n: number }).n, 0);
});
