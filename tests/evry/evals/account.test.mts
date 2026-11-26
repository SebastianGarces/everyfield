import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stageAttachment } from "../../../packages/evry/src/index.ts";
import { scriptedModel } from "../../../packages/evry-scripted/src/index.ts";
import { seedDocument } from "../adapters/documents/seed.mts";
import { seedWiki, wikiIds } from "../adapters/wiki/corpus.mts";
import { caseWorld, sql, type CaseWorld } from "../runtime/case-world.mts";
import { nativePorts } from "./settings-ports.mts";

type Case = {
	id: string;
	ask: string;
	calls: string[];
	file?: { name: string; text: string };
	answer?: string[];
	proposal?: { operation: string; target: string | null; changes: [string, unknown, unknown][] };
	approve?: true;
};
const { cases } = JSON.parse(readFileSync(new URL("./account.cases.json", import.meta.url), "utf8")) as {
	cases: Case[];
};

let w: CaseWorld;
const shared = globalThis as Record<symbol, { configured?: unknown; checks: WeakMap<object, unknown> } | undefined>;
before(async () => {
	w = await caseWorld("evryacc", { native: nativePorts() });
	(shared[Symbol.for("everyfield.db.privateStorage")] ??= { checks: new WeakMap() }).configured = w.files.storage;
	const plant = await w.plant({});
	await seedWiki((query) => w.admin.execute(query), plant.id, wikiIds(randomUUID));
});
after(() => w?.close());

test("INV-evry-account: every case of a person with no church passes on the scripted model: the card shows what is saved and nothing is written before approval", async () => {
	const a = await w.actor(null, "owner", { account: { registration_kind: "discovery" } });
	await w.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${a.id})`);
	await seedDocument(w.admin, a.id, "native", "My Discovery", "My Discovery values.");
	const documents = () =>
		w.rows(sql`SELECT d.id,d.title,d.revision::text AS revision,d.archived_at IS NOT NULL AS archived,r.body
			FROM document d JOIN document_revision r ON r.id=d.current_revision_id WHERE d.tenant_id=${a.id} ORDER BY d.id`);
	for (const c of cases) {
		const who = await w.actorOf(a);
		const conversation = await w.converse(who);
		const attachments: { id: string; name: string }[] = [];
		if (c.file) {
			const bytes = Buffer.from(c.file.text);
			const staged = await stageAttachment(w.db, w.files.storage, who, conversation, {
				name: c.file.name,
				byteLength: bytes.length,
			});
			w.files.objects.set(
				decodeURIComponent(new URL(staged.upload.url).pathname).replace("/synthetic-only/", ""),
				bytes,
			);
			attachments.push({ id: staged.attachment.id, name: staged.attachment.name });
		}
		const held = await documents();
		const turn = await w.ask(a, c.ask, [], {
			conversation,
			attachments,
			storage: w.files.storage,
			model: scriptedModel(),
		});
		assert.deepEqual(
			turn.cards.map((card) => card.operation),
			c.calls,
			`${c.id} reads: ${turn.text}`,
		);
		for (const text of c.answer ?? [])
			assert.ok(turn.text.includes(text), `${c.id} answer ${JSON.stringify(turn.text)} has ${text}`);
		assert.deepEqual(await documents(), held, `${c.id} writes nothing before approval`);
		assert.deepEqual(
			turn.proposals.map((p) => ({
				operation: p.operation,
				target: p.review.target?.label ?? null,
				changes: p.review.changes.map((x) => [x.field, x.before, x.after]),
			})),
			c.proposal ? [c.proposal] : [],
			`${c.id} ${turn.text}`,
		);
		const [proposal] = turn.proposals;
		if (!c.approve || !proposal) continue;
		assert.equal((await w.approve(a, proposal)).review.outcome, "completed", c.id);
		assert.notDeepEqual(await documents(), held, `${c.id} saves what was approved`);
	}
	const saved = (await documents()) as { title: string; body: string; archived: boolean }[];
	const of = (title: string) => saved.find((d) => d.title === title)!;
	assert.equal(saved.length, 3);
	assert.deepEqual(
		[of("My Discovery").archived, of("My Discovery").body.includes("My Discovery hopes.")],
		[true, true],
	);
	assert.ok(of("My call").body.includes("I want to serve Austin."));
	assert.ok(of("Launch team welcome letter").body.includes("Team night every other Thursday"));
});
