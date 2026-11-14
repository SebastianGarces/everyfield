// The Evry Documents reviewed writes, approved and run through the WP-031 queue as the app worker runs them. Each effect
// runs the same native Documents command the app runs, for the approving session, with the effect key as its request
// key: the change and its audit row commit with the saved outcome. The effect loads the document renderer, whose
// layouts are .tsx, so this file runs under tsx (the package's test:db).
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	approveProposal,
	createConversation,
	executeProposal,
	prepareProposal,
	readReview,
	submitTurn,
	type EvryActor,
	type Proposal,
} from "../../../../packages/evry/src/index.ts";
import { transaction } from "../../../../apps/web/src/server/platform/database.ts";
import { claimDue, finishClaim } from "../../../../apps/web/src/server/jobs/queue.ts";
import { actor, admin, db, plant, setup, sql, teardown } from "../../runtime/support.mts";
import { seedDocument, type Seeded } from "./seed.mts";

/** The process's private bucket, as privateStorage() returns it: a memory fake that holds what the export puts. */
const objects = new Map<string, Buffer>();
const storage = {
	bucket: "synthetic-only",
	client: {
		async send(command: { constructor: { name: string }; input: { Key?: string; Body?: Uint8Array } }) {
			if (command.constructor.name === "GetBucketAclCommand")
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			if (command.constructor.name === "PutObjectCommand") {
				objects.set(command.input.Key!, Buffer.from(command.input.Body!));
				return {};
			}
			throw Error(`unexpected provider operation ${command.constructor.name}`);
		},
	},
};
// The storage module keeps the process's bucket on globalThis (RT-6c), already loaded by the imports above.
const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = storage;

before(setup);
after(teardown);

let docs: Record<string, Seeded>;
before(async () => {
	docs = {
		draft: await seedDocument(plant, "native", "Values Draft", "Prayer comes before planning.", 5),
		agenda: await seedDocument(plant, "native", "Vision Meeting Agenda", "6:30 PM Welcome", 4),
		policy: await seedDocument(plant, "church_document", "Conflict of Interest Policy", null, 2),
		other: await seedDocument(plant, "church_document", "Board Covenant", null, 1),
	};
});

const noReminders = async () => {
	throw Error("unexpected task reminder replan");
};

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
	const proposal = await prepareProposal(db, who, run, c.id, { operation, input });
	assert.ok(proposal, operation);
	return proposal;
}

/** The approval of the exact revision shown, then the effect run once, as the app worker runs it. */
async function approveAndRun(who: EvryActor, proposal: Proposal) {
	await approveProposal(db, who, proposal.id, { revision: proposal.revision, digest: proposal.digest });
	const [claim] = await claimDue(db, ["evry_effect"], 1, 60);
	assert.ok(claim);
	const outcome = await executeProposal(
		db,
		{ jobId: claim.id, tenantId: claim.tenant_id, leaseOwner: claim.lease_owner, generation: claim.claim_generation },
		noReminders,
	);
	await transaction(db, (tx) => finishClaim(tx, claim, { state: outcome === "failed" ? "failed" : "succeeded" }));
	return { outcome, review: await readReview(db, who, proposal.id) };
}
const audits = async (proposalId: string) =>
	(
		await admin.execute(
			sql`SELECT action,subject_id FROM audit_event WHERE request_key LIKE ${"evry:" + proposalId + ":%"} ORDER BY action`,
		)
	).rows as { action: string; subject_id: string }[];
const documentRow = async (id: string) =>
	(
		await admin.execute(
			sql`SELECT kind,title,template_id,template_version,archived_at IS NOT NULL AS archived,
				church_archived_at IS NOT NULL AS church_archived FROM document WHERE id=${id}`,
		)
	).rows[0] as Record<string, unknown>;

test("an approved template review makes a Church Document with the church's details, ready to edit", async () => {
	const owner = await actor("owner");
	const proposal = await propose(owner, "documents.createFromTemplate", { templateId: "financial-controls-policy" });
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.equal(review.outcome, "completed");
	const id = review.receipt!.receiptId!;
	assert.deepEqual(await documentRow(id), {
		kind: "church_document",
		title: "Financial Controls Policy",
		template_id: "financial-controls-policy",
		template_version: 1,
		archived: false,
		church_archived: false,
	});
	const body = (
		await admin.execute(
			sql`SELECT r.body FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${id}`,
		)
	).rows[0] as { body: string };
	assert.deepEqual(JSON.parse(body.body).data, { church_name: "Synthetic", church_legal_name: "Synthetic" });
	assert.deepEqual(await audits(proposal.id), [{ action: "documents.created_from_template", subject_id: id }]);
});

test("a church name that changed after the review refuses the new document instead of filling in unseen values", async () => {
	const owner = await actor("owner");
	const proposal = await propose(owner, "documents.createFromTemplate", { templateId: "child-protection-policy" });
	await admin.execute(sql`UPDATE plant SET name='Renamed Church' WHERE id=${plant}`);
	try {
		const { outcome, review } = await approveAndRun(owner, proposal);
		assert.equal(outcome, "refused");
		assert.equal(review.receipt?.code, "revision_conflict");
		assert.deepEqual(await audits(proposal.id), []);
	} finally {
		await admin.execute(sql`UPDATE plant SET name='Synthetic' WHERE id=${plant}`);
	}
});

test("an approved export saves the PDF with the Church Document, in private storage", async () => {
	const owner = await actor("owner");
	const proposal = await propose(owner, "documents.exportNative", { documentId: docs.policy.id, format: "pdf" });
	const { outcome, review } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	const saved = (
		await admin.execute(sql`SELECT gd.id, gd.format, gd.source_document_id, f.state, f.opaque_key FROM generated_document gd
			JOIN file_object f ON f.id=gd.object_id WHERE gd.id=${review.receipt!.receiptId!}`)
	).rows[0] as Record<string, string>;
	assert.deepEqual([saved.format, saved.source_document_id, saved.state], ["pdf", docs.policy.id, "ready"]);
	assert.equal(objects.get(saved.opaque_key)!.subarray(0, 5).toString(), "%PDF-");
	assert.deepEqual(await audits(proposal.id), [{ action: "documents.exported", subject_id: saved.id }]);
});

test("an approved archive archives a written document or a Church Document the way its own list does", async () => {
	const owner = await actor("owner");
	for (const doc of [docs.agenda, docs.other]) {
		const { outcome } = await approveAndRun(owner, await propose(owner, "documents.archive", { documentId: doc.id }));
		assert.equal(outcome, "completed", doc.title);
	}
	assert.deepEqual(
		[(await documentRow(docs.agenda.id)).archived, (await documentRow(docs.agenda.id)).church_archived],
		[true, false],
	);
	// A Church Document's archive is church_archived_at; archived_at would mean deleted.
	assert.deepEqual(
		[(await documentRow(docs.other.id)).archived, (await documentRow(docs.other.id)).church_archived],
		[false, true],
	);
});

test("an approved mark makes the written document the church's core values", async () => {
	const owner = await actor("owner");
	const proposal = await propose(owner, "documents.designateCoreValues", { documentId: docs.draft.id });
	const { outcome } = await approveAndRun(owner, proposal);
	assert.equal(outcome, "completed");
	assert.equal((await documentRow(docs.draft.id)).kind, "core_values");
	assert.deepEqual(await audits(proposal.id), []);
	const audit = await admin.execute(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE action='documents.designated' AND subject_id=${docs.draft.id}`,
	);
	assert.equal((audit.rows[0] as { n: number }).n, 1);
});
