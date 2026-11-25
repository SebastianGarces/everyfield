import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/index.ts";
import { approveProposal } from "../../../../packages/evry/src/index.ts";
import { ok, type Actor } from "../../../support/fixture.mts";
import { caseWorld, propose, read, rowsOf, sql, type CaseWorld, type Reply } from "../../runtime/case-world.mts";

let w: CaseWorld;
before(async () => {
	w = await caseWorld("familydocuments");
	const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
	(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = w.files.storage;
});
after(() => w?.close());

const refusedStatus = (reply: { status: string; error?: { code?: string } }) => [reply.status, reply.error?.code];

test("AC:EVRY-FAMILY-DOCUMENTS documents are cited in their own words, a private document stays its author's, a preview saves nothing and each reviewed file, edit and import is made once", async () => {
	const c = await w.church({ name: "Grace Church" });
	const B = await w.seated(c.P, "owner");
	const member = await w.seated(c.P, "member");
	const authority = (who: Actor) => w.authorityOf(who);
	const saved = () =>
		w.one(sql`SELECT (SELECT count(*)::int FROM document WHERE tenant_id=${c.P.id}) AS documents,
			(SELECT count(*)::int FROM generated_document WHERE tenant_id=${c.P.id}) AS history,
			(SELECT count(*)::int FROM file_object WHERE tenant_id=${c.P.id}) AS files,(SELECT count(*)::int FROM mail) AS mail,
			(SELECT count(*)::int FROM audit_event WHERE tenant_id=${c.P.id} AND action LIKE 'documents.%') AS audits`);

	await w.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${c.A.id}`);
	const mine = ok<Reply>(
		await documentsWriter.saveNative(w.db, await authority(c.A), {
			title: "agenda-A",
			body: nativeFromText("Welcome Alex."),
			expectedRevision: "0",
		}),
	);
	await w.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${c.A.id}`);
	assert.equal(mine.tenantId, c.A.id, "the private document is its author's own");
	const { current_revision_id: revisionId } = await w.one(
		sql`SELECT current_revision_id FROM document WHERE id=${mine.id}`,
	);
	for (const who of [B, member, c.F]) {
		assert.deepEqual(refusedStatus(await documentsWriter.read(w.db, await authority(who), { documentId: mine.id })), [
			"refused",
			"unavailable",
		]);
		const asked = await w.look(who, "documents.read", { documentId: mine.id });
		assert.deepEqual([asked.status, asked.rows], ["not_found", []], "no role reads another person's document");
		assert.deepEqual(
			refusedStatus(
				await documentsWriter.useForChurch(w.db, await authority(who), {
					documentId: mine.id,
					revisionId,
					requestKey: randomUUID(),
				}),
			),
			["refused", "unavailable"],
		);
	}
	const key = randomUUID();
	const use = async () =>
		ok<Reply>(
			await documentsWriter.useForChurch(w.db, await authority(c.A), {
				documentId: mine.id,
				revisionId,
				requestKey: key,
			}),
		);
	const agendaA = (await use()).id;
	assert.equal((await use()).id, agendaA, "its author shares it with the church once");
	assert.notEqual(agendaA, mine.id);

	const bodyB = "# Agenda B\nMeet Casey.";
	const made = await w.apply(c.A, "documents.saveNative", { kind: "new", title: "agenda-B", text: bodyB });
	const agendaB = made.receipt!.receiptId!;
	const compared = await w.ask(c.A, "Compare agenda A and agenda B", [
		() => [read("documents.read", { documentId: agendaA }), read("documents.read", { documentId: agendaB })],
	]);
	const cited = compared.replies.map((r) => rowsOf(r)[0]);
	assert.deepEqual(
		cited.map((r) => [r.id, r.label]),
		[
			[agendaA, "agenda-A"],
			[agendaB, "agenda-B"],
		],
	);
	assert.equal(cited[0].fields.text, "Welcome Alex.");
	assert.match(cited[1].fields.text, /Meet Casey\./);
	assert.ok(cited.every((r) => r.fields.textCut === false));
	const native = ok<Reply>(await documentsWriter.getAuthorized(w.db, await authority(c.A), { documentId: agendaA }));
	assert.deepEqual([native.id, native.title, native.body], [agendaA, "agenda-A", nativeFromText("Welcome Alex.")]);
	const list = rowsOf(await w.look(c.A, "documents.listOwned", {}));
	assert.deepEqual(list.map((r) => r.label).sort(), ["agenda-A", "agenda-B"]);
	assert.ok(
		list.every((r) => !("text" in r.fields)),
		"a name alone carries no words to compare",
	);

	await w.apply(c.A, "documents.saveNative", {
		kind: "edit",
		documentId: agendaB,
		edits: [{ find: "Meet Casey.", replace: "Meet Casey Reed." }],
	});
	const { body } = await w.one<{ body: string }>(
		sql`SELECT r.body FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${agendaB}`,
	);
	assert.match(body, /"heading"/);
	assert.match(body, /Meet Casey Reed\./);
	assert.deepEqual(rowsOf(await w.look(c.A, "documents.readCoreValuesEvidence", {})), [], "nothing is marked");
	await w.apply(c.A, "documents.designateCoreValues", { documentId: agendaA });
	const evidence = rowsOf(await w.look(c.A, "documents.readCoreValuesEvidence", {}));
	assert.deepEqual(
		evidence.map((r) => [r.id, r.label]),
		[[agendaA, "agenda-A"]],
	);

	const church = rowsOf(await w.look(c.A, "documents.templates.list", {}));
	assert.ok(church.length > 0);
	assert.equal(
		church.some((t) => /bank|payroll|cms/i.test(t.label)),
		false,
		"no bank data or content system is invented",
	);
	const library: Reply[] = [];
	for (const category of ["commitment", "vision_meeting", "administrative", "operational"])
		library.push(...rowsOf(await w.look(c.A, "documents.templates.contextual", { category })));
	const formats = new Set<string>();
	for (const t of library) {
		const [row] = rowsOf(await w.look(c.A, "documents.templates.get", { templateId: t.id }));
		for (const f of String(row.fields.formats).split(/,\s*/)) formats.add(f);
	}
	assert.ok(
		[...formats].some((f) => /pdf/i.test(f)) && [...formats].some((f) => /excel|xlsx|spreadsheet/i.test(f)),
		[...formats].join("|"),
	);
	const fill = { templateId: "follow-up-letter", values: [{ key: "pastor_name", value: "Pastor Alex" }] };
	const still = await saved();
	const context = await w.look(c.A, "documents.resolveContext", fill);
	assert.equal(context.facts.complete, true, JSON.stringify(context.facts));
	const shown = await w.quiet(() => w.look(c.A, "documents.preview", fill));
	assert.equal(shown.facts.rendered, true, JSON.stringify(shown.facts));
	assert.deepEqual(await saved(), still, "a preview saves no file, history or message");

	const card = await w.prepare(c.A, "documents.generate", fill);
	assert.deepEqual(
		card.review.changes.map((x: Reply) => x.after).filter((x: string) => /Pastor Alex|Grace Church/.test(x)),
		["Grace Church (from the church profile)", "Pastor Alex (your text)"],
	);
	const done = await w.approve(c.A, card);
	assert.equal(done.outcome, "completed", JSON.stringify(done.review.receipt));
	const file = done.review.receipt!.receiptId!;
	const row = await w.one<{
		sha256: string;
		opaque_key: string;
		inputs: { key: string; value: string }[];
		byte_count: string;
	}>(
		sql`SELECT f.sha256,f.opaque_key,f.byte_count,g.inputs FROM generated_document g JOIN file_object f ON f.id=g.object_id AND f.state='ready' WHERE g.id=${file}`,
	);
	const bytes = w.files.objects.get(row.opaque_key)!;
	assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
	assert.deepEqual(
		[createHash("sha256").update(bytes).digest("hex"), bytes.length],
		[row.sha256, Number(row.byte_count)],
	);
	assert.deepEqual(
		row.inputs.map((i) => [i.key, i.value]),
		[
			["church_name", "Grace Church"],
			["pastor_name", "Pastor Alex"],
		],
	);
	const after = await saved();
	const again = await approveProposal(w.db, await w.actorOf(c.A), card.id, w.witness(card), null);
	assert.deepEqual(
		[again.replayed, await w.effect(), await saved()],
		[true, null, after],
		"one file, one history entry",
	);
	assert.deepEqual([Number(after.history) - Number(still.history), Number(after.files) - Number(still.files)], [1, 1]);
	const history = rowsOf(await w.look(c.A, "documents.history.list", {}));
	assert.deepEqual(
		history.map((r) => r.id),
		[file],
	);
	assert.equal(rowsOf(await w.look(c.A, "documents.history.get", { fileId: file }))[0].id, file);
	const [download] = rowsOf(await w.look(c.A, "documents.download", { fileId: file }));
	assert.equal(download.id, file);
	assert.equal(JSON.stringify(download).includes(row.opaque_key), false, "the link names the file, never its storage");

	const conversation = await w.converse(c.Aa);
	const upload = await c.attach(c.A, conversation, "notes.txt", "Our notes.");
	const attached = {
		conversation,
		storage: w.files.storage,
		attachments: [{ id: upload.id, name: upload.name }],
	};
	const before = await saved();
	const imported = await w.prepare(
		c.A,
		"documents.importTextOrWord",
		{ attachmentId: upload.id, title: "Notes" },
		attached,
	);
	assert.deepEqual({ ...(await saved()), files: before.files }, before, "an unbound upload is in no document");
	assert.equal((await w.approve(c.A, imported)).outcome, "completed");
	assert.equal(Number((await saved()).documents) - Number(before.documents), 1);
	assert.match(
		rowsOf(
			await w.look(c.A, "documents.read", {
				documentId: (await w.one(sql`SELECT id FROM document WHERE title='Notes'`)).id,
			}),
		)[0].fields.text,
		/Our notes\./,
	);
	await w.apply(c.A, "documents.archive", { documentId: agendaB });
	assert.equal(
		rowsOf(await w.look(c.A, "documents.listOwned", {})).some((r) => r.id === agendaB),
		false,
	);

	const open = await w.prepare(c.A, "documents.saveNative", { kind: "new", title: "Later", text: "Later words." });
	await c.foreignReview(open);
	await c.foreign(
		"Compare their agendas",
		[
			() => [read("documents.read", { documentId: agendaA }), read("documents.listOwned", {})],
			() => [read("documents.download", { fileId: file }), read("documents.history.list", {})],
			() => propose("documents.designateCoreValues", { documentId: agendaA }),
			() => propose("documents.archive", { documentId: agendaA }),
		],
		{ secrets: ["Welcome Alex", "agenda-A", "Pastor Alex", row.opaque_key], on: { onError: "go_on" } },
	);
	await c.failedWrite(open, "document");
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM document WHERE tenant_id=${c.P.id} AND title='Later'`),
		1,
	);
});
