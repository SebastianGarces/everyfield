import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";
import test, { after, before } from "node:test";
import { sql } from "../../../packages/db/src/query.ts";
import {
	completeGeneration,
	chunkEntries,
	packageCheckout,
	validateBundle,
} from "../../../packages/reference/src/bundle.ts";
import { hash, stableId } from "../../../packages/reference/src/hash.ts";
import {
	referenceService,
	ReferenceRefusal,
	type ReferenceDependencies,
} from "../../../packages/reference/src/server.ts";
import { verifySources } from "../../../packages/reference/verify.mjs";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsReader } from "../../../packages/domain/src/documents/index.ts";
import { createFacts } from "../../../packages/domain/src/intelligence/index.ts";
import { CATALOG, createTaskWriter, withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { teamsWriter } from "../../../packages/domain/src/teams/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { fixture as church, ok, type Actor } from "../../support/fixture.mts";
import { NOTHING, recorded, touched, untouched } from "../../support/recorded.mts";
import { fixture, identities, profile } from "./fixtures.mts";
import { promotions, type Reviewer } from "./promotions.mts";

const checkout = new URL("../../../", import.meta.url);
const { cases } = JSON.parse(await readFile(new URL("docs/acceptance/reference-release.json", checkout), "utf8"));
const referenceCase = (id: string) => cases.find((row: { id: string }) => row.id === id);
const subcase = (id: string, name: string) =>
	referenceCase(id).subcases.find((row: { name: string }) => row.name === name);

const world = await church({
	prefix: "packagecases",
	clock: new Date("2026-10-13T16:00:00Z"),
	plant: { name: "P" },
});
const { admin } = world;
const runtime = world.pools.runtime;
const P = world.tenant.id;
const A = world.actors.admin;
const editorial = new Map<string, ReturnType<typeof fixture>["policy"]["editorial"]>();
const p = await promotions(world, (key) => {
	const built = fixture(key);
	return {
		...built,
		policy: { ...built.policy, editorial: editorial.get(key) ?? built.policy.editorial },
	};
});
let foreign: Reviewer;
let active = 0;
let copy: string;
let catalog: string;
const REFERENCE_TABLES = [
	"article_revision",
	"audit_event",
	"passage",
	"record",
	"reference_activation",
	"reference_item",
	"reference_release",
	"reference_version",
];
before(async () => {
	await p.seed();
	const Q = await world.plant({ name: "Quarry Hill", timezone: "America/New_York" });
	foreign = await world.actor(Q, "member");
	copy = await mkdtemp(join(tmpdir(), "package-cases-"));
	await cp(new URL("docs", checkout), join(copy, "docs"), { recursive: true });
	catalog = (await verifySources(fileURLToPath(checkout))).catalog!.sha256;
});
after(async () => {
	await world.close();
	await rm(copy, { recursive: true, force: true });
});

const rows = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
	(await admin.execute<T>(query)).rows;
const actor = async (who: Actor) => {
	const resolved = await RequestActor.resolve(runtime, who.session);
	assert.ok(resolved instanceof RequestActor);
	return resolved;
};
async function built(root: URL, key: string) {
	const entries = (await packageCheckout(root, catalog)).map((e) => ({
		...e,
		revisionId: stableId(`${key}:${e.id}:${e.contentHash}`),
	}));
	const discoveryIds = [...fixture(key).policy.plan.discoveryIds];
	const vectors = new Map(chunkEntries(entries).map((c) => [c.key, [0.1, 0.2, 0.3]]));
	return completeGeneration({ key, profile, entries, discoveryIds }, identities, vectors);
}
function packaging(root: URL) {
	const seen = { loads: 0 };
	const deps: ReferenceDependencies = {
		authorize: p.authorize,
		policyFor: (key) => {
			const { policy } = fixture(key);
			return { ...policy, editorial: editorial.get(key) ?? policy.editorial };
		},
		loadArtifact: (key) => {
			seen.loads += 1;
			return built(root, key);
		},
	};
	return { seen, service: referenceService(admin, deps) };
}
const publish = (key: string, root = checkout, by?: Reviewer) =>
	packaging(root).service.promote(p.command(key, String(active), "activate", { by }), key);
async function packaged(key: string) {
	const first = active === 0;
	const { value, added } = await recorded(admin, () => touched(admin, () => publish(key)));
	active += 1;
	assert.deepEqual(added, { ...NOTHING, audits: ["reference.activated"] });
	assert.deepEqual(
		value.tables,
		REFERENCE_TABLES.filter((table) => first || table !== "reference_item"),
	);
	assert.deepEqual([value.value.generationKey, value.value.number], [key, String(active)]);
	const [current] = await rows<{ key: string }>(
		sql`SELECT r.release_key AS key FROM reference_activation a JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number DESC LIMIT 1`,
	);
	assert.equal(current?.key, key);
}
const installed = (key: string, kind: string) =>
	rows<{
		key: string;
		hash: string;
		credit: string;
		tenant: string;
	}>(sql`SELECT i.canonical_key AS key,
		v.content_hash AS hash,v.source_credit AS credit,i.tenant_id AS tenant FROM reference_version v
		JOIN reference_item i ON i.id=v.item_id JOIN reference_release r ON r.id=v.release_id
		WHERE r.release_key=${key} AND i.kind=${kind} ORDER BY i.canonical_key`);
const refusedCode = (error: unknown, code: string) =>
	error instanceof Error && (error instanceof ReferenceRefusal ? error.code : error.message) === code;

async function refusesForeign(id: string, secrets: readonly string[]) {
	const { expected } = subcase(id, "foreign-context-refused");
	for (const by of [foreign, A]) {
		const { seen, service } = packaging(checkout);
		const error = await untouched(admin, () =>
			service.promote(p.command("foreign", String(active), "activate", { by }), "foreign").then(
				() => assert.fail("published"),
				(thrown: unknown) => thrown,
			),
		);
		assert.ok(refusedCode(error, expected.result.error_code), inspect(error));
		assert.equal(seen.loads, 0, "no source is read for a caller without the publish grant");
		for (const secret of secrets) assert.equal(inspect(error).includes(secret), false, secret);
	}
	assert.deepEqual(await rows(sql`SELECT 1 AS n FROM reference_release WHERE release_key='foreign'`), []);
}
async function refusesMissing(id: string, path: string) {
	const { expected } = subcase(id, "required-boundary-failure");
	const { result } = expected;
	const file = join(copy, path);
	const committed = () =>
		rows(sql`SELECT to_jsonb(a) AS activation,to_jsonb(r) AS release,(SELECT count(*)::int FROM reference_version v
			WHERE v.release_id=r.id) AS versions FROM reference_activation a JOIN reference_release r ON r.id=a.release_id ORDER BY a.activation_number`);
	const before = await committed();
	await rename(file, file + ".away");
	try {
		await unpublished("unavailable", result.error_code);
	} finally {
		await rename(file + ".away", file);
	}
	assert.equal(isDeepStrictEqual(await committed(), before), result.prior_committed_outcomes_retained);
	const recovered = await publish("recovered-" + id, pathToFileURL(copy + "/"));
	assert.equal(recovered.number, String(++active));
}
async function unpublished(key: string, code: string) {
	const { service } = packaging(pathToFileURL(copy + "/"));
	await untouched(admin, () =>
		assert.rejects(service.promote(p.command(key, String(active)), key), (error) => refusedCode(error, code)),
	);
	assert.deepEqual(await rows(sql`SELECT 1 AS n FROM reference_release WHERE release_key=${key}`), []);
}
const source = async (id: string, fixtureName: string) => {
	const { path, sha256, bytes } = referenceCase(id).given[fixtureName];
	const file = await readFile(new URL(path, checkout));
	assert.deepEqual([hash(file), file.length], [sha256, bytes], path);
	return { credit: `${path}@${sha256}`, text: file.toString("utf8") };
};

const inventoryOf = async (kind: "documents" | "checklists" | "teams"): Promise<string[]> => {
	const { inventory = {} } = await verifySources(fileURLToPath(checkout));
	return (inventory as Record<typeof kind, string[]>)[kind];
};

test("AC:GAP-REF-001 the Playbook publishes with its exact bytes, and a missing or changed source, another hash, a foreign caller or an unavailable input publishes nothing", async () => {
	const { given, expected } = referenceCase("GAP-REF-001");
	const { path } = given.playbook;
	const playbook = join(copy, path);
	const missing = subcase("GAP-REF-001", "missing-original-is-blocked").expected.result;
	await rename(playbook, playbook + ".away");
	try {
		await unpublished("R1", missing.error_code);
	} finally {
		await rename(playbook + ".away", playbook);
	}
	const none = () => installed("R1", "playbook");
	assert.equal((await none()).length > 0, missing.published);

	const mismatch = subcase("GAP-REF-001", "hash-mismatch");
	const manifest = join(copy, "docs/reference/manifest.json");
	const approved = await readFile(manifest, "utf8");
	assert.equal(JSON.parse(approved).release_identity, given.execution.manifest_release);
	await writeFile(manifest, approved.replace(given.playbook.sha256, mismatch.given.execution.expected_sha256));
	try {
		await unpublished("R1", mismatch.expected.result.error_code);
	} finally {
		await writeFile(manifest, approved);
	}
	const { articles } = JSON.parse(
		await readFile(new URL("docs/reference/bootstrap/global-seed-payload.json", checkout), "utf8"),
	);
	const welcome = articles.find((a: { slug: string }) => a.slug.includes("welcome")).content;
	const original = await readFile(playbook);
	await writeFile(playbook, welcome);
	try {
		await unpublished("R1", mismatch.expected.result.error_code);
	} finally {
		await writeFile(playbook, original);
	}
	assert.equal((await none()).length > 0, mismatch.expected.result.published);

	await packaged("R1");
	const { credit, text } = await source("GAP-REF-001", "playbook");
	const stored = await none();
	assert.equal(stored.length === 1, expected.result.published);
	assert.deepEqual([stored[0]!.hash, stored[0]!.credit], [expected.result.sha256, credit]);
	const body = fixture("R1").bundle.entries.find((e) => e.kind === "playbook")!.body;
	assert.deepEqual([body, hash(body)], [text, stored[0]!.hash]);
	assert.equal(stored[0]!.hash === hash(welcome), expected.result.summary_substituted);
	await refusesForeign("GAP-REF-001", [text.slice(0, 80), expected.result.sha256]);
	await refusesMissing("GAP-REF-001", "docs/reference/manifest.json");
	assert.deepEqual(await none(), stored, "the earlier publication is kept");
});

test("AC:GAP-REF-003 the eleven original document templates keep one format each, only their own merge fields, and add no finance module", async () => {
	const { action, expected } = referenceCase("GAP-REF-003");
	const { credit, text } = await source("GAP-REF-003", "templates");
	const schema = () =>
		rows(sql`SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema() ORDER BY 1`);
	const before = await schema();
	await packaged("documents");
	const stored = await installed("documents", "document_template");
	assert.equal(stored.length, expected.result.base_template_count);
	for (const row of stored) assert.equal(row.credit, credit);
	const inventory = await inventoryOf("documents");
	assert.deepEqual(
		stored.map((row) => row.key),
		inventory.toSorted(),
	);

	const reads = await recorded(admin, async () =>
		ok(await documentsReader["templates.list"](runtime, await actor(A), {})),
	);
	assert.deepEqual(reads.added, NOTHING);
	const base = reads.value.templates.filter((t) => stored.some((row) => row.key === t.id));
	assert.equal(base.length, expected.result.base_template_count);
	const formats = base.flatMap((t) => t.formats);
	assert.equal(formats.length, expected.result.base_format_count);
	for (const format of formats) assert.ok(action.arguments.formats.includes(format), format);
	const declared = new Map(
		text
			.split(/^  \{$/m)
			.slice(1)
			.map((block) => [
				/^ {4}id: "([^"]+)",$/m.exec(block)![1]!,
				[...block.matchAll(/^ +key: "([^"]+)",$/gm)].map((m) => m[1]!),
			]),
	);
	assert.equal(declared.size, expected.result.base_template_count);
	assert.deepEqual(
		base.flatMap((t) => t.mergeFields.filter((f) => !declared.get(t.id)!.includes(f.key)).map((f) => f.key)),
		expected.result.foreign_merge_fields,
	);
	assert.deepEqual(await schema(), before);
	assert.equal(
		before.some((t) => /finance|giving|budget/.test(String(t.name))),
		expected.result.finance_module_created,
	);
	assert.deepEqual(await rows(sql`SELECT 1 AS n FROM document UNION ALL SELECT 1 FROM generated_document`), []);
	await refusesForeign("GAP-REF-003", [base[0]!.name, credit]);
	await refusesMissing("GAP-REF-003", "docs/reference/document-templates.ts");
	assert.deepEqual(await installed("documents", "document_template"), stored);
});

test("AC:GAP-REF-004 twenty task templates publish without renaming a church's edited copy or completing any task", async () => {
	const { given, expected } = referenceCase("GAP-REF-004");
	const { credit } = await source("GAP-REF-004", "templates");
	const writer = createTaskWriter({ reminders: async () => {} });
	const admins = await actor(A);
	const checklist = CATALOG.checklists.find((k) => k.key === "vision-meeting-preparation")!;
	const copied = ok(
		await withTaskWrite(runtime, admins, (tx, ctx) =>
			writer.importTemplate(tx, ctx, {
				requestKey: randomUUID(),
				input: {
					catalogVersion: CATALOG.version,
					checklistKey: checklist.key,
					itemKeys: checklist.items.map((i) => i.key),
				},
			}),
		),
	).tasks;
	const T = copied[0]!;
	ok(
		await withTaskWrite(runtime, admins, (tx, ctx) =>
			writer.edit(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: T.revision,
				input: { taskId: T.id, patch: { title: given.T.title } },
			}),
		),
	);
	const tasks = () =>
		rows<{ id: string; title: string; status: string }>(
			sql`SELECT id,title,status FROM task WHERE plant_id=${P} ORDER BY id`,
		);
	const before = await tasks();
	assert.equal(before.find((t) => t.id === T.id)!.status, given.T.status);
	await packaged("tasks");
	const stored = await installed("tasks", "task_template");
	assert.equal(stored.length, expected.result.template_count);
	for (const row of stored) assert.equal(row.credit, credit);
	const inventory = await inventoryOf("checklists");
	assert.deepEqual(
		stored.map((row) => row.key),
		inventory.toSorted(),
	);
	const now = await tasks();
	assert.deepEqual(now, before);
	assert.equal(now.find((t) => t.id === T.id)!.title, expected.result.existing_task_title);
	assert.equal(now.filter((t) => t.status === "complete").length, expected.result.tasks_completed);
	await refusesForeign("GAP-REF-004", [given.T.title, credit]);
	await refusesMissing("GAP-REF-004", "docs/reference/task-templates.ts");
	assert.deepEqual(await installed("tasks", "task_template"), stored);
	assert.deepEqual(await tasks(), before);
});

test("AC:GAP-REF-005 ten team templates publish beside eight lens areas, add no team to a church with its own three, and hold no background-check field", async () => {
	const { given, expected } = referenceCase("GAP-REF-005");
	const { credit } = await source("GAP-REF-005", "templates");
	const ctx = { session: A.session, selected: { kind: "plant" as const, id: P } };
	const areas = ["worship", "children", "facilities"];
	for (const [n, name] of given.custom.names.entries()) {
		const { team } = ok(
			await gatedTransaction(runtime, (tx) =>
				teamsWriter.create(tx, ctx as never, { requestKey: randomUUID(), input: { name } }),
			),
		);
		const role = randomUUID();
		const person = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,commitment_state,pipeline_position,state,created_at)
			VALUES(${person},${P},${P},${"Leader " + n},'other','leader','unknown','unknown',0,'live',clock_timestamp())`);
		await admin.execute(sql`INSERT INTO team_role(id,plant_id,team_id,name,leadership,sort_order,responsibility_key)
			VALUES(${role},${P},${team.id},${name + " lead"},true,0,${areas[n]})`);
		await admin.execute(
			sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${P},${role},${person},'2026-10-01')`,
		);
	}
	const teams = () =>
		rows<{ name: string; template_key: string | null }>(
			sql`SELECT name,template_key FROM team WHERE plant_id=${P} ORDER BY name`,
		);
	const before = await teams();
	assert.deepEqual(
		before,
		given.custom.names.map((name: string) => ({ name, template_key: null })),
	);
	await packaged("teams");
	const stored = await installed("teams", "ministry_template");
	assert.equal(stored.length, expected.result.template_count);
	for (const row of stored) assert.equal(row.credit, credit);
	const inventory = await inventoryOf("teams");
	assert.deepEqual(
		stored.map((row) => row.key),
		inventory.toSorted(),
	);
	const now = await teams();
	assert.deepEqual(now, before);
	assert.equal(now.length - before.length, expected.result.tenant_teams_created);

	const { coverage } = ok(await createFacts().readFacts(runtime, await actor(A), {}));
	assert.deepEqual(
		[coverage.slots, coverage.responsibilities.length],
		[expected.result.lens_area_count, expected.result.lens_area_count],
	);
	assert.equal(coverage.filled, areas.length, "custom teams fill their areas by their own role mapping");
	const { bundle } = fixture("teams");
	const fields: string[] = [];
	for (const entry of bundle.entries.filter((e) => e.kind === "ministry_template"))
		JSON.parse(entry.body, (key, value) => {
			if (/background/i.test(key)) fields.push(key);
			return value;
		});
	assert.deepEqual(fields, expected.result.background_check_fields);
	const columns = await rows<{
		name: string;
	}>(sql`SELECT column_name AS name FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name IN ('team','team_role','team_tenure','reference_item','reference_version')`);
	assert.deepEqual(
		columns.filter((c) => /background/i.test(c.name)).map((c) => c.name),
		expected.result.background_check_fields,
	);
	await refusesForeign("GAP-REF-005", [...given.custom.names, credit]);
	await refusesMissing("GAP-REF-005", "docs/reference/ministry-role-templates.ts");
	assert.deepEqual(await installed("teams", "ministry_template"), stored);
	assert.deepEqual(await teams(), before);
});

test("AC:GAP-REF-008 a bundle with exact hashes but an open editorial conflict and no original is blocked, and changes no release", async () => {
	const { given, expected } = referenceCase("GAP-REF-008");
	const { editorial_conflict, original_available } = given.candidate;
	const key = given.R2.id;
	const open = {
		approved: true,
		originalAvailable: original_available,
		conflicts: editorial_conflict ? ["known-source-conflict"] : [],
	};
	const candidate = await built(checkout, key);
	for (const approved of [true, false]) {
		editorial.set(key, { ...open, approved });
		const report = validateBundle(candidate, {
			...fixture(key).policy,
			editorial: editorial.get(key)!,
		});
		assert.deepEqual(
			[report.hashIntegrity, report.editorialApproved, report.ok, report.blockers],
			[
				expected.result.hash_integrity,
				expected.result.editorial_approved,
				expected.result.release_allowed,
				expected.result.blockers,
			],
		);
		const { seen, service } = packaging(checkout);
		await untouched(admin, () =>
			assert.rejects(service.promote(p.command(key, String(active)), key), (e) => refusedCode(e, "invalid_generation")),
		);
		assert.equal(seen.loads, 1);
	}
	assert.deepEqual(await rows(sql`SELECT 1 AS n FROM reference_release WHERE release_key=${key}`), []);
	await refusesForeign("GAP-REF-008", ["known-source-conflict", candidate.entries[0]!.contentHash]);
	await refusesMissing("GAP-REF-008", "docs/reference/playbook.md");
});
