import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { ReferenceRefusal } from "../../../packages/reference/src/server.ts";
import { hash, canonical, stableId } from "../../../packages/reference/src/hash.ts";
import { chunkEntries, completeGeneration } from "../../../packages/reference/src/bundle.ts";
import { fixture, identities } from "./fixtures.mts";
import { promotions } from "./promotions.mts";

type Built = ReturnType<typeof fixture>;
const built = new Map<string, Built>();
const { database, db, artifacts, service, command, seed } = await promotions("t625_reference", (key) =>
	built.get(key)!,
);
before(async () => {
	await seed();
	built.set("R1", fixture("R1"));
	built.set("R2", secondRelease());
});
after(database.close);

function secondRelease(): Built {
	const base = fixture("R2");
	const chunks = (id: string) => base.bundle.passages.filter((p) => p.revisionId === id).length;
	const articles = base.policy.plan.entries.filter((e) => e.kind === "article");
	const long = articles.find((e) => chunks(e.revisionId) > 1)!;
	const [grown, changed] = articles.filter((e) => e.id !== long.id);
	const content = new Map([
		[long.id, () => "One short section now."],
		[grown!.id, (text: string) => `${text}\n\n${"A newly added passage. ".repeat(60)}`],
		[changed!.id, (text: string) => text.replace(/[a-z]/, "x")],
	]);
	const entries = base.policy.plan.entries.map((e) => {
		const edit = content.get(e.id);
		if (!edit) return e;
		const article = JSON.parse(e.body);
		const body = JSON.stringify({ ...article, content: edit(article.content) });
		const contentHash = hash(body);
		return { ...e, body, contentHash, revisionId: stableId(`R2:${e.id}:${contentHash}`) };
	});
	const plan = { ...base.policy.plan, key: "R2", entries } as Parameters<typeof completeGeneration>[0];
	const bundle = completeGeneration(
		plan,
		identities,
		new Map(chunkEntries(entries).map((p) => [p.key, [0.4, 0.5, 0.6]])),
	);
	return { bundle, policy: { ...base.policy, plan }, manifestHash: hash(canonical(bundle)) };
}
const stored = async () =>
	(
		await db.execute(querySql`SELECT (SELECT count(*)::int FROM reference_release) AS releases,
		(SELECT count(*)::int FROM passage) AS passages,(SELECT count(*)::int FROM article_revision) AS articles,
		(SELECT count(*)::int FROM reference_version) AS versions,(SELECT count(*)::int FROM reference_activation) AS activations,
		(SELECT count(*)::int FROM audit_event) AS audits`)
	).rows[0];
const history = async () =>
	(
		await db.execute<{ n: string; release: string; row: string }>(querySql`SELECT a.activation_number::text AS n,
		r.release_key AS release,a::text AS row FROM reference_activation a JOIN reference_release r ON r.id=a.release_id
		ORDER BY a.activation_number`)
	).rows;

test("AC:ASMT-011 a second release that removes, adds and changes passages and fails while building leaves R1 active with no partial generation; built, it activates second, and a rollback is activation 3 with the earlier ones unchanged", async () => {
	const text = (key: string) => new Set(built.get(key)!.bundle.passages.map((p) => p.contentHash));
	const added = [...text("R2")].filter((h) => !text("R1").has(h));
	const removed = [...text("R1")].filter((h) => !text("R2").has(h));
	assert.ok(added.length >= 2 && removed.length >= 2, "R2 adds, removes and changes passages");

	assert.equal((await service.promote(command("R1", "0"), "R1")).number, "1");
	const first = await stored();
	await db.execute(querySql`CREATE FUNCTION t625_build_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		RAISE EXCEPTION 'synthetic build fault' USING ERRCODE='P0001'; END $$`);
	await db.execute(
		querySql.raw(`CREATE TRIGGER t625_build_fault AFTER INSERT ON passage FOR EACH ROW
		WHEN (NEW.content_hash='${added.at(-1)!}') EXECUTE FUNCTION t625_build_fault()`),
	);
	try {
		await assert.rejects(service.promote(command("R2", "1"), "R2"), (e: unknown) => {
			const cause = (e as { cause?: { code?: string } }).cause;
			return cause?.code === "P0001";
		});
	} finally {
		await db.execute(querySql`DROP TRIGGER t625_build_fault ON passage`);
	}
	assert.equal((await service.current())!.release_key, "R1", "R1 stays active");
	assert.deepEqual(await stored(), first, "no part of R2 was kept");
	const unfinished = command("R2", "1");
	artifacts.set("R2", { ...built.get("R2")!.bundle, passages: built.get("R2")!.bundle.passages.slice(1) });
	await assert.rejects(
		service.promote(unfinished, "R2"),
		(e) => e instanceof ReferenceRefusal && e.code === "invalid_generation",
	);
	assert.deepEqual(await stored(), first, "nor of a bundle missing a passage");
	const one = await history();

	assert.equal((await service.promote(command("R2", "1"), "R2")).number, "2");
	const live = await db.execute<{ hash: string }>(querySql`SELECT DISTINCT p.content_hash AS hash FROM passage p
		JOIN reference_activation a ON a.release_id=p.release_id WHERE a.activation_number=2`);
	assert.deepEqual(new Set(live.rows.map((r) => r.hash)), text("R2"), "exactly R2's passages");
	const two = await history();
	assert.deepEqual(two.slice(0, 1), one);

	assert.equal((await service.promote(command("R1", "2", "rollback"), "R1")).number, "3");
	const three = await history();
	assert.deepEqual(
		three.map((a) => [a.n, a.release]),
		[
			["1", "R1"],
			["2", "R2"],
			["3", "R1"],
		],
	);
	assert.deepEqual(three.slice(0, 2), two, "the earlier activations are not rewritten");
});
