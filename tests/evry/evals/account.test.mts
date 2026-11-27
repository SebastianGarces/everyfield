import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { cancelProposal, stageAttachment } from "../../../packages/evry/src/index.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
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
	absent?: string[];
	proposal?: { operation: string; target: string | null; changes: [string, unknown, unknown][] };
	approve?: true;
	cancel?: true;
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
	const discovery = async () => {
		const who = await w.actor(null, "owner", {
			account: { registration_kind: "discovery" },
			user: { name: "Jo Rivera" },
		});
		await w.admin.execute(sql`INSERT INTO discovery(account_id) VALUES(${who.id})`);
		return who;
	};
	const a = await discovery();
	await seedDocument(w.admin, a.id, "native", "My Discovery", "My Discovery values.");
	const sending = await w.organization("sending_church");
	await w.admin
		.execute(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${a.id},${sending.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	const home = await w.plant({ name: "Sending Church" });
	await w.admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${home.id},${sending.id},clock_timestamp(),false,false,false,false,false,false,false)`);
	const covenant = await seedDocument(w.admin, home.id, "church_document", "Sending Church Covenant", null);
	await seedDocument(w.admin, home.id, "native", "Sending Church Budget Notes", "SENDING-CHURCH-CANARY");
	const director = await w.authorityOf(await w.seated(home, "owner"));
	const template = await documentsWriter.saveChurchTemplate(w.db, director, {
		documentId: covenant.id,
		revision: 1,
		name: "Sending Church Template",
		requestKey: randomUUID(),
	});
	assert.equal(template.status, "ok");
	const mirror = await discovery();
	const madeByDocuments = async (templateId: string) => {
		const authority = await RequestActor.resolve(w.db, mirror.session);
		assert.ok(authority instanceof RequestActor);
		const made = await documentsWriter.createMineFromTemplate(w.db, authority, {
			templateId,
			requestKey: randomUUID(),
		});
		assert.equal(made.status, "ok");
		return made.status === "ok" ? JSON.stringify(made.value.body) : null;
	};
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
		for (const text of c.absent ?? [])
			assert.ok(!turn.text.includes(text), `${c.id} answer ${JSON.stringify(turn.text)} lacks ${text}`);
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
		if (c.cancel && proposal) {
			await cancelProposal(w.db, await w.actorOf(a), proposal.id);
			assert.deepEqual(await documents(), held, `${c.id} cancelled saves nothing`);
		}
		if (!c.approve || !proposal) continue;
		const approved = await w.approve(a, proposal);
		assert.equal(approved.review.outcome, "completed", c.id);
		const now = (await documents()) as { id: string; body: string }[];
		assert.notDeepEqual(now, held, `${c.id} saves what was approved`);
		if (proposal.operation !== "documents.createMineFromTemplate") continue;
		const made = now.filter((d) => !(held as { id: string }[]).some((h) => h.id === d.id));
		assert.equal(made.length, 1, `${c.id} makes exactly one document`);
		const input = proposal.review.target?.id ?? assert.fail("a template");
		assert.equal(made[0]!.body, await madeByDocuments(input), `${c.id} makes what Documents makes`);
	}
	const saved = (await documents()) as { title: string; body: string; archived: boolean }[];
	const of = (title: string) => saved.find((d) => d.title === title)!;
	assert.equal(saved.length, 4);
	assert.ok(of("Bylaws").body.includes("Grace Austin"));
	assert.equal(of("Bylaws").body.includes("[church name]"), false);
	assert.deepEqual(
		[of("My Discovery").archived, of("My Discovery").body.includes("My Discovery hopes.")],
		[true, true],
	);
	assert.ok(of("My call").body.includes("I want to serve Austin."));
	assert.ok(of("Launch team welcome letter").body.includes("Team night every other Thursday"));
});
