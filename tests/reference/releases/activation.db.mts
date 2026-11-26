import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { referenceService, ReferenceRefusal } from "../../../packages/reference/src/server.ts";
import type { Promotion } from "../../../packages/contracts/src/reference/release.ts";
import { hash, canonical, stableId, vectorHash } from "../../../packages/reference/src/hash.ts";
import { validateBundle } from "../../../packages/reference/src/bundle.ts";
import { approvedWiki } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { referenceService as wikiService } from "../../../packages/reference/src/starter/verify/service.ts";
import { recorded, touched, untouched, NOTHING } from "../../support/recorded.mts";
import { fixture } from "./fixtures.mts";
import { promotions } from "./promotions.mts";

const { cases } = JSON.parse(
	await readFile(new URL("../../../docs/acceptance/reference-release.json", import.meta.url), "utf8"),
);
const referenceCase = (id: string) => cases.find((row: { id: string }) => row.id === id);
const { database, db, actor, publisher, session, artifacts, reviews, authorize, service, command, seed } =
	await promotions("wp032_test", fixture);
const plant = randomUUID();
let firstCommand: Promotion;
async function counts() {
	return (
		await db.execute(querySql`SELECT (SELECT count(*)::int FROM reference_activation) AS activations,
    (SELECT count(*)::int FROM reference_release) AS releases,(SELECT count(*)::int FROM audit_event) AS operations,
    (SELECT count(*)::int FROM audit_event) AS events`)
	).rows[0];
}
async function refused(cmd: Promotion, code: string) {
	await assert.rejects(
		service.promote(cmd, cmd.generationKey),
		(e) => e instanceof ReferenceRefusal && e.code === code,
	);
}
before(async () => {
	await seed();
	await db.execute(querySql`INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision)
    VALUES(${querySql.param(plant)},'Synthetic existing plant','America/Chicago',7,14,1,8,1,1)`);
	await db.execute(querySql`INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind)
    VALUES(${querySql.param(plant)},'Keep edited title','launch_prep','medium','in_progress',now(),'undated')`);
});
after(database.close);

test("AC:REFREL-001 initial install, exact replay and changed immutable hash refuse without rewriting originals", async () => {
	const { action, given, expected } = referenceCase("REFREL-001");
	const { expected_activation, request_key: requestKey } = action.arguments;
	const cmd = command(given.R1.id, String(expected_activation), "activate", { requestKey });
	firstCommand = cmd;
	const installed = await recorded(db, () => service.promote(cmd, "R1"));
	assert.deepEqual(installed.added, { ...NOTHING, audits: ["reference.activated"] });
	const first = installed.value;
	assert.equal(first.number, "1");
	assert.equal(Number((await counts())!.activations), expected.result.activation_changes);
	assert.deepEqual(await counts(), { activations: 1, releases: 1, operations: 1, events: 1 });
	const replay = await recorded(db, () => touched(db, () => service.promote(cmd, "R1")));
	assert.deepEqual(replay.value.value, { ...first, replayed: true });
	assert.equal(replay.value.tables.length, expected.result.equal_replay_changes);
	const noOp = await service.promote(command("R1", "1"), "R1");
	assert.equal(noOp.activationId, first.activationId);
	assert.deepEqual(await counts(), { activations: 1, releases: 1, operations: 2, events: 2 });
	const forged = { ...cmd, reason: "changed" };
	await refused(forged, "access_denied");
	reviews.get(cmd.requestKey)!.review.commandDigest = hash(canonical(forged));
	await refused(forged, "idempotency_conflict");
	reviews.get(cmd.requestKey)!.review.commandDigest = hash(canonical(cmd));
	const changed = structuredClone(fixture("R1").bundle);
	changed.passages[0]!.embedding = [1, 2, 3];
	changed.passages[0]!.embeddingChecksum = vectorHash([1, 2, 3]);
	const conflict = command("R1", "1");
	conflict.manifestHash = hash(canonical(changed));
	artifacts.set("R1", changed);
	reviews.get(conflict.requestKey)!.review.commandDigest = hash(canonical(conflict));
	assert.notEqual(conflict.manifestHash, cmd.manifestHash);
	await untouched(db, () => refused(conflict, "immutable_conflict"));
	assert.equal(
		(await service.current())!.manifest_hash === conflict.manifestHash,
		expected.result.changed_hash_allowed,
	);
	artifacts.set("R1", fixture("R1").bundle);
	const wrongCatalog = structuredClone(fixture("R1").bundle);
	wrongCatalog.catalogSha256 = "0".repeat(64);
	const mismatch = command("R1", "1");
	mismatch.manifestHash = hash(canonical(wrongCatalog));
	artifacts.set("R1", wrongCatalog);
	reviews.get(mismatch.requestKey)!.review.commandDigest = hash(canonical(mismatch));
	await refused(mismatch, "invalid_generation");
	artifacts.set("R1", fixture("R1").bundle);
	assert.deepEqual(await counts(), { activations: 1, releases: 1, operations: 2, events: 2 });
	const published = await db.execute(
		querySql`SELECT count(*)::int AS n FROM article_revision a JOIN reference_activation r ON r.release_id=a.release_id WHERE r.activation_number=1`,
	);
	assert.equal(published.rows[0]!.n, 124);
	const mail = await db.execute(querySql`SELECT count(*)::int AS n FROM reference_item WHERE kind='mail_template'`);
	assert.equal(mail.rows[0]!.n, 7);
	const sideEffects = await db.execute(
		querySql`SELECT (SELECT count(*)::int FROM mail) AS mail,(SELECT count(*)::int FROM task) AS tasks`,
	);
	assert.deepEqual(sideEffects.rows[0], { mail: 0, tasks: 1 });
});

test("AC:CONTENT50-001 an activated generation keeps the 96 starter articles, 21 sections and 7 mail templates beside 11 separate document templates", async () => {
	const { cases } = JSON.parse(
		await readFile(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
	) as { cases: { id: string; expected: { result: Record<string, number> } }[] };
	const result = cases.find((row) => row.id === "CONTENT50-001")!.expected.result;
	const bytes = await readFile(
		new URL("../../../docs/reference/bootstrap/global-seed-payload.json", import.meta.url),
		"utf8",
	);
	assert.equal(hash(bytes), "7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59");
	const starter = JSON.parse(bytes) as Record<"articles" | "sections", { id: string }[]>;
	const { rows } = await db.execute<{ id: string; kind: string; tenant_id: string }>(
		querySql`SELECT id,kind,tenant_id FROM reference_item`,
	);
	const ids = (kind: string) => rows.filter((row) => row.kind === kind).map((row) => row.id);
	assert.equal(ids("article").filter((id) => starter.articles.some((a) => a.id === id)).length, result.article_count);
	assert.deepEqual(ids("section").toSorted(), starter.sections.map((s) => s.id).toSorted());
	assert.deepEqual(
		[ids("section").length, ids("mail_template").length, ids("document_template").length],
		[result.section_count, result.mail_template_count, result.base_document_template_count],
	);
	assert.equal(
		rows.filter((row) => row.tenant_id !== "00000000-0000-0000-0000-000000000000").length,
		result.customer_rows,
	);
});

type Bundle = ReturnType<typeof fixture>["bundle"];
const article = (bundle: Bundle) => bundle.entries.find((e) => e.kind === "article")!;
function rewrite(entry: Bundle["entries"][number], body: string) {
	entry.body = body;
	entry.contentHash = hash(body);
	entry.revisionId = stableId(`R2:${entry.id}:${entry.contentHash}`);
}
async function refusesCandidate(id: string, edit: (bundle: Bundle) => void, canary?: string) {
	const { expected } = referenceCase(id);
	const candidate = structuredClone(fixture("R2").bundle);
	edit(candidate);
	const cmd = command("R2", "1");
	cmd.manifestHash = hash(canonical(candidate));
	reviews.get(cmd.requestKey)!.review.commandDigest = hash(canonical(cmd));
	artifacts.set("R2", candidate);
	const lines: string[] = [];
	const original = { error: console.error, log: console.log, warn: console.warn };
	const capture = (...args: unknown[]) => void lines.push(inspect(args));
	Object.assign(console, { error: capture, log: capture, warn: capture });
	let error: unknown;
	try {
		error = await untouched(db, () =>
			service.promote(cmd, "R2").then(
				() => assert.fail("activated"),
				(thrown: unknown) => thrown,
			),
		);
	} finally {
		Object.assign(console, original);
		artifacts.set("R2", fixture("R2").bundle);
	}
	assert.ok(error instanceof ReferenceRefusal, inspect(error));
	assert.equal(error.code, "invalid_generation");
	if (canary) {
		assert.ok(JSON.stringify(candidate).includes(canary));
		assert.equal([inspect(error, { depth: 9 }), ...lines].join().match(canary), expected.result.secret_in_output);
	}
	await stillFirst(expected.result.R2_activated ?? expected.result.activated);
}
async function stillFirst(activated: boolean) {
	assert.equal((await service.current())?.release_key, "R1");
	const { rows } = await db.execute(querySql`SELECT release_key FROM reference_release WHERE release_key='R2'`);
	assert.equal(rows.length > 0, activated);
}

test("AC:REFREL-003 a candidate with a missing or changed passage, hash or dimension, or a failed embedding request, leaves R1 active", async () => {
	const { expected } = referenceCase("REFREL-003");
	const first = (bundle: Bundle) => bundle.passages[0]!;
	const edits: ((bundle: Bundle) => void)[] = [
		(b) => void b.passages.pop(),
		(b) => void (first(b).text += "changed"),
		(b) => void (first(b).contentHash = "0".repeat(64)),
		(b) => void (first(b).embeddingChecksum = "0".repeat(64)),
		(b) => Object.assign(first(b), { embedding: [1, 2], embeddingChecksum: vectorHash([1, 2]) }),
	];
	for (const edit of edits) await refusesCandidate("REFREL-003", edit);
	const { tables, value } = await touched(db, () =>
		wikiService(db, {
			env: { EVF_WIKI_EMBEDDINGS: "openai", OPENAI_API_KEY: "sk-test-refrel" },
			fetch: async () => {
				throw new DOMException("timed out", "TimeoutError");
			},
		}).rebuildEmbeddings(
			{ actorId: publisher.id, userId: publisher.user, sessionId: publisher.session },
			{
				release: "R2",
				manifestSha256: approvedWiki.manifestSha256,
				payloadSha256: approvedWiki.payloadSha256,
				requestKey: randomUUID(),
				expectedActivation: "1",
				target: approvedWiki.target,
			},
		),
	);
	assert.deepEqual(
		[value.activated, value.reason, value.activeRelease, value.usageTokens],
		[expected.result.R2_activated, "openai_timeout", null, 0],
	);
	assert.deepEqual(tables, []);
	assert.equal((await service.current())?.release_key, expected.result.active_release);
	await stillFirst(expected.result.R2_activated);
});

test("AC:REFREL-007 a candidate with a wrong rubric, Playbook or template hash, or a church, token or executable body, never activates or shows its text", async () => {
	const { given } = referenceCase("REFREL-007");
	const canary = given.execution.body;
	for (const path of ["rubric-v1.md", "playbook.md", "task-templates.ts", "document-templates.ts"])
		await refusesCandidate("REFREL-007", (b) => {
			const entry = b.entries.find((e) => e.sourcePath === "docs/reference/" + path)!;
			entry.sourceHash = "0".repeat(64);
		});
	for (const kind of ["rubric", "playbook", "task_template", "mail_template"])
		await refusesCandidate(
			"REFREL-007",
			(b) =>
				rewrite(
					b.entries.find((e) => e.kind === kind)!,
					canary,
				),
			canary,
		);
	const bodies: [Record<string, string>, string | null][] = [
		[{ church_id: canary }, "invalid_content"],
		[{ content: `{process.env.${canary}}` }, "unsafe_content"],
		[{ content: `import x from "${canary}";\n\n# Text` }, "unsafe_content"],
		[{ content: `<script>${canary}</script>` }, "unsafe_content"],
		[{ token: "sk-" + canary }, null],
	];
	for (const [change, blocker] of bodies) {
		const edit = (b: Bundle) => {
			const entry = article(b);
			rewrite(entry, JSON.stringify({ ...JSON.parse(entry.body), ...change }));
		};
		await refusesCandidate("REFREL-007", edit, canary);
		if (!blocker) continue;
		const { bundle, policy } = fixture("R2");
		const planned = structuredClone(bundle);
		edit(planned);
		const report = validateBundle(planned, {
			...policy,
			plan: { ...policy.plan, entries: planned.entries },
		});
		assert.ok(report.blockers.includes(blocker), `${blocker}: ${report.blockers.join()}`);
		assert.equal(JSON.stringify(report).includes(canary), false);
	}
	await refusesCandidate("REFREL-007", (b) => void (article(b).body = canary), canary);
});

test("AC:REFREL-004 concurrent promotions have one winner, the loser must be reviewed again, and a resumed stale worker never activates", async () => {
	const { action, given, expected } = referenceCase("REFREL-004");
	const calls = [action, ...given.execution.parallel_calls].map(({ arguments: a }) =>
		command(a.request_key.replace("activate-", ""), String(a.expected_activation), "activate", {
			requestKey: a.request_key,
		}),
	);
	assert.deepEqual(
		calls.map((cmd) => cmd.generationKey),
		given["case-input"].candidates,
	);
	const stale = command("R4", String(given.execution.stale_worker_generation));
	const outcomes = await Promise.allSettled(calls.map((cmd) => service.promote(cmd, cmd.generationKey)));
	assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, expected.result.activation_winners);
	const lost = outcomes.findIndex((o) => o.status === "rejected");
	const loser = outcomes[lost];
	assert.equal(loser?.status === "rejected" && loser.reason.code, "revision_conflict", inspect(loser));
	const won = await counts();
	assert.equal((await service.current())?.activation_number, "2");
	assert.deepEqual(won, { activations: 2, releases: 2, operations: 3, events: 3 });

	await untouched(db, async () => {
		const again = calls[lost]!;
		await refused(again, "revision_conflict");
		const unreviewed = { ...again, expectedActivation: "2" };
		const code = await service.promote(unreviewed, again.generationKey).then(
			() => "activated",
			(e) => e instanceof ReferenceRefusal && e.code,
		);
		assert.equal(code === "access_denied", expected.result.loser_requires_review);
		await refused(stale, "revision_conflict");
	});
	const { rows } = await db.execute(querySql`SELECT 1 FROM reference_release WHERE release_key='R4'`);
	assert.equal(rows.length > 0, expected.result.stale_worker_activated);
});

test("AC:REFREL-005 rollback appends attributable activation and preserves old generations", async () => {
	const { tables, value: rollback } = await touched(db, () => service.promote(command("R1", "2", "rollback"), "R1"));
	assert.deepEqual(tables, ["audit_event", "record", "reference_activation"]);
	assert.equal(rollback.number, "3");
	assert.equal((await service.current())?.release_key, "R1");
	const history = await db.execute<{
		activation_number: string;
		expected_prior_number: string;
		previous_id: string | null;
		actor_id: string;
		reason: string;
	}>(
		querySql`SELECT activation_number::text,expected_prior_number::text,previous_id,actor_id,reason FROM reference_activation ORDER BY activation_number`,
	);
	assert.deepEqual(
		history.rows.map((r: { activation_number: string; expected_prior_number: string }) => [
			r.activation_number,
			r.expected_prior_number,
		]),
		[
			["1", "0"],
			["2", "1"],
			["3", "2"],
		],
	);
	assert.equal(history.rows[2]!.actor_id, actor);
	assert.equal(history.rows[2]!.reason, "Synthetic reviewed reference proof");
	const invalid = command("never-active", "3", "rollback");
	await refused(invalid, "rollback_unavailable");
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
	assert.deepEqual((await db.execute(querySql`SELECT title,status,due_kind FROM task`)).rows, [
		{ title: "Keep edited title", status: "in_progress", due_kind: "undated" },
	]);
});

test("INV-reference-authority: live session, current grant and exact trusted review are required even on replay", async () => {
	const cmd = firstCommand;
	await db.execute(querySql`UPDATE platform_grant SET revoked_at=now() WHERE account_id=${querySql.param(actor)}`);
	await refused(cmd, "access_denied");
	await db.execute(
		querySql`UPDATE platform_grant SET revoked_at=null,expires_at=now()-interval '1 minute' WHERE account_id=${querySql.param(actor)}`,
	);
	await refused(cmd, "access_denied");
	await db.execute(querySql`UPDATE platform_grant SET expires_at=null WHERE account_id=${querySql.param(actor)}`);
	await db.execute(
		querySql`UPDATE auth_session SET expires_at=now()-interval '1 minute' WHERE id=${querySql.param(session)}`,
	);
	await refused(cmd, "access_denied");
	await db.execute(
		querySql`UPDATE auth_session SET expires_at=now()+interval '1 hour' WHERE id=${querySql.param(session)}`,
	);
	reviews.delete(cmd.requestKey);
	await refused(cmd, "access_denied");
	const fresh = command("R1", "3");
	const racing = referenceService(db, {
		authorize,
		policyFor: (key) => fixture(key).policy,
		loadArtifact: async (locator) => {
			await db.execute(querySql`UPDATE platform_grant SET revoked_at=now() WHERE account_id=${querySql.param(actor)}`);
			return artifacts.get(locator);
		},
	});
	try {
		await assert.rejects(
			racing.promote(fresh, "R1"),
			(e) => e instanceof ReferenceRefusal && e.code === "access_denied",
		);
	} finally {
		await db.execute(querySql`UPDATE platform_grant SET revoked_at=null WHERE account_id=${querySql.param(actor)}`);
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
});

test("INV-reference-atomicity: required audit fault rolls back candidate, mapping, activation and receipt", async () => {
	await db.execute(
		querySql`CREATE FUNCTION fail_reference_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit fault' USING ERRCODE='P0001'; END $$`,
	);
	await db.execute(
		querySql`CREATE TRIGGER fail_reference_audit BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION fail_reference_audit()`,
	);
	try {
		await assert.rejects(
			service.promote(command("R5", "3"), "R5"),
			(e: unknown) =>
				typeof e === "object" &&
				e !== null &&
				"cause" in e &&
				e.cause instanceof Error &&
				"code" in e.cause &&
				e.cause.code === "P0001",
		);
	} finally {
		await db.execute(querySql`DROP TRIGGER fail_reference_audit ON audit_event`);
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
	assert.equal((await service.current())?.release_key, "R1");
	const orphans = await db.execute(
		querySql`SELECT count(*)::int AS n FROM record WHERE kind='reference_release' AND id NOT IN(SELECT id FROM reference_release)`,
	);
	assert.equal(orphans.rows[0]!.n, 0);
});

test("INV-reference-revalidation: changed persisted derivatives refuse while a current promotion can replay clean data", async () => {
	const saved = (
		await db.execute<{ id: string; content: string; embedding: string }>(
			querySql`SELECT id,content,embedding::text FROM passage WHERE release_id=(SELECT release_id FROM reference_activation ORDER BY activation_number DESC LIMIT 1) LIMIT 1`,
		)
	).rows[0]!;
	await db.execute(
		querySql`UPDATE passage SET embedding=${querySql.param("[9,9,9]")}::public.vector WHERE id=${querySql.param(saved.id)}`,
	);
	try {
		await refused(command("R1", "3"), "immutable_conflict");
	} finally {
		await db.execute(
			querySql`UPDATE passage SET embedding=${querySql.param(saved.embedding)}::public.vector WHERE id=${querySql.param(saved.id)}`,
		);
	}
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 4, events: 4 });
	assert.equal((await service.promote(command("R1", "3"), "R1")).number, "3");
	assert.deepEqual(await counts(), { activations: 3, releases: 2, operations: 5, events: 5 });
});
