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
import { documentsReader, documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { library } from "../../../packages/domain/src/documents/catalog.ts";
import { resolveMerge } from "../../../packages/domain/src/documents/merge.ts";
import { renderPreview } from "../../../packages/domain/src/documents/library-render.ts";
import { createLaunchReader, createLaunchWriter } from "../../../packages/domain/src/launch/index.ts";
import { createPhaseWriter } from "../../../packages/domain/src/phases/index.ts";
import { TEMPLATES as TEMPLATE_TEAMS, TEMPLATE_VERSION } from "../../../packages/domain/src/teams/templates.ts";
import { frozenClock, instant } from "../../../packages/contracts/src/common/index.ts";
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

type SchemaCase = {
	id: string;
	given: Record<string, { value?: unknown; path?: string; sha256?: string } & Record<string, unknown>>;
	action: { arguments: Record<string, unknown> };
	clock: { now: string };
	expected: { result: Record<string, unknown> };
};
const schemaCases: SchemaCase[] = JSON.parse(
	await readFile(new URL("docs/acceptance/schema.json", checkout), "utf8"),
).cases;
const schemaCase = (id: string) => schemaCases.find((row) => row.id === id) ?? assert.fail(`no case ${id}`);
const fileHash = async (path: string, root: string | URL = checkout) =>
	hash(await readFile(typeof root === "string" ? join(root, path) : new URL(path, root)));
const LAUNCH_SOURCE = "docs/reference/launch-milestone-templates.ts";

test("AC:REF-CASE-001 the Playbook packages only from its byte-exact original; a one-byte edit or the welcome article in its place packages nothing", async () => {
	const { given, expected } = schemaCase("REF-CASE-001");
	const { path, sha256 } = given.source as { path: string; sha256: string };
	assert.deepEqual([await fileHash(path), await fileHash(path, copy)], [sha256, sha256]);
	assert.equal(given.execution?.source_sha256, sha256);
	const { articles } = JSON.parse(
		await readFile(new URL("docs/reference/bootstrap/global-seed-payload.json", checkout), "utf8"),
	);
	const welcomes = articles.filter((a: { slug: string }) => a.slug.includes("welcome"));
	assert.equal(welcomes.length, 1, String(given.welcome_article?.value));
	const welcome = welcomes[0];
	const playbook = join(copy, path);
	const original = await readFile(playbook);
	const edited = Buffer.concat([original.subarray(0, -1), Buffer.from([original.at(-1)! ^ 1])]);
	assert.equal(given.one_byte_edit_candidate?.value, true);
	const key = "ref-case-playbook";
	for (const replacement of [edited, Buffer.from(welcome.content)]) {
		await writeFile(playbook, replacement);
		try {
			await unpublished(key, "hash_mismatch");
		} finally {
			await writeFile(playbook, original);
		}
	}
	await packaged(key);
	const [stored, ...more] = await installed(key, "playbook");
	assert.deepEqual(more, []);
	assert.equal(stored!.hash, expected.result.accepted_original_sha256);
	assert.equal(stored!.credit, `${path}@${sha256}`);
	assert.equal(stored!.hash === hash(welcome.content), expected.result.welcome_substitution_accepted);
	assert.equal(stored!.hash === hash(edited), expected.result.one_byte_edit_accepted);
});

test("AC:REF-CASE-003 the eleven base document templates package beside a church's edited copy: the three examples print as PDF, need the church name, and render no bytes without it", async () => {
	const { action, expected } = schemaCase("REF-CASE-003");
	const args = action.arguments as {
		catalog_sha256: string;
		examples: string[];
		required_merge_field: string;
		tenant_modified_generated_copy: boolean;
		preserved_base_entry_count: number;
	};
	assert.equal(await fileHash("docs/reference/document-templates.ts"), args.catalog_sha256);
	const admins = await actor(A);
	const copied = ok(
		await documentsWriter.createFromTemplate(runtime, admins, {
			templateId: args.examples[0]!,
			requestKey: randomUUID(),
		}),
	);
	const body = structuredClone(copied.body) as { page: { margin: { left: number } } };
	body.page.margin.left = 72;
	ok(await documentsWriter.saveNative(runtime, admins, { documentId: copied.id, expectedRevision: "1", body }));
	assert.equal(args.tenant_modified_generated_copy, true);
	const churchCopy = () =>
		rows(sql`SELECT d.title,d.revision::text AS revision,r.content_hash,r.body FROM document d
			JOIN document_revision r ON r.id=d.current_revision_id WHERE d.id=${copied.id}`);
	const before = await churchCopy();
	assert.equal(JSON.parse(String(before[0]!.body)).page.margin.left, 72);

	await packaged("ref-case-documents");
	const stored = await installed("ref-case-documents", "document_template");
	assert.equal(stored.length, expected.result.preserved_base_template_count);
	assert.equal(stored.length, args.preserved_base_entry_count);
	for (const row of stored) assert.equal(row.credit, `docs/reference/document-templates.ts@${args.catalog_sha256}`);
	const listed = ok(await documentsReader["templates.list"](runtime, admins, {})).templates;
	const examples = args.examples.map((id) => listed.find((t) => t.id === id) ?? assert.fail(id));
	assert.ok(args.examples.every((id) => stored.some((row) => row.key === id)));
	assert.deepEqual(
		examples.filter((t) => t.formats.includes("pdf")).map((t) => t.id),
		expected.result.PDF_ids,
	);
	const catalogued = (await library()).templates;
	for (const listedTemplate of examples) {
		const field = listedTemplate.mergeFields.find((f) => f.key === expected.result.required_field);
		assert.equal(field?.required, true, listedTemplate.id);
		const template = catalogued.find((t) => t.id === listedTemplate.id) ?? assert.fail(listedTemplate.id);
		const merged = resolveMerge(template, { churchName: null, pastorName: null, launchDate: null }, {});
		assert.ok(merged.ok);
		assert.ok(merged.missing.includes(args.required_merge_field), template.id);
		const bytes = await renderPreview(template, "pdf", merged);
		assert.equal(bytes !== null, expected.result.missing_required_field_generates_bytes, template.id);
		const named = resolveMerge(template, { churchName: "P", pastorName: "Pat", launchDate: "2026-12-06" }, {});
		assert.ok(named.ok && !named.missing.includes(args.required_merge_field));
		assert.ok(named.complete, template.id);
		const printed = await renderPreview(template, "pdf", named);
		assert.equal(Buffer.from(printed!).subarray(0, 5).toString(), "%PDF-", template.id);
	}
	const after = await churchCopy();
	assert.equal(!isDeepStrictEqual(after, before), expected.result.tenant_edited_document_overwritten);
});

test("AC:REF-CASE-004 twenty checklists and nine Launch milestones with twenty-three undated tasks seed once; a replay, a declined offer and an edited task add or change nothing", async () => {
	const { given, expected, clock: when } = schemaCase("REF-CASE-004");
	const exec = given.execution as unknown as {
		checklist_catalog_sha256: string;
		launch_source_sha256: string;
		checklist_key_count: number;
		launch_milestone_task_counts: number[];
		import_local_date: string;
	};
	assert.deepEqual(
		[await fileHash("docs/reference/task-templates.ts"), await fileHash(LAUNCH_SOURCE)],
		[exec.checklist_catalog_sha256, exec.launch_source_sha256],
	);
	await packaged("ref-case-tasks");
	const stored = await installed("ref-case-tasks", "task_template");
	assert.equal(stored.length, expected.result.checklist_keys);
	assert.equal(stored.length, exec.checklist_key_count);
	assert.deepEqual(
		stored.map((row) => row.key),
		CATALOG.checklists.map((k) => k.key).toSorted(),
	);

	const R = await world.plant({ name: "Ridge", timezone: "America/Chicago" });
	const owner = await actor(await world.actor(R, "owner"));
	const clock = frozenClock(instant.parse(when.now));
	const reader = createLaunchReader(clock);
	const launch = createLaunchWriter({ notices: async () => {}, clock });
	const plan = async () => ok(await reader.readPlan(runtime, owner)).plan;
	assert.equal((await plan()).today, exec.import_local_date);
	const footprint = async () =>
		(
			await rows<{ milestones: number; tasks: number; dated: number }>(sql`SELECT
			(SELECT count(*)::int FROM launch_milestone WHERE plant_id=${R.id}) AS milestones,
			(SELECT count(*)::int FROM task WHERE plant_id=${R.id}) AS tasks,
			(SELECT count(*)::int FROM task WHERE plant_id=${R.id} AND (due_kind<>'undated' OR due_date IS NOT NULL OR due_at IS NOT NULL)) AS dated`)
		)[0]!;
	const scheduleKey = randomUUID();
	const schedule = (expectedRevision: string, requestKey: string) =>
		launch.schedule(runtime, owner, { requestKey, expectedRevision, input: { date: "2026-12-06", reason: null } });
	ok(await schedule("1", scheduleKey));
	const seeded = await plan();
	assert.equal(seeded.milestones.length, expected.result.milestones);
	assert.deepEqual(
		seeded.milestones.map((m) => m.tasks.length),
		expected.result.task_counts,
	);
	assert.deepEqual(expected.result.task_counts, exec.launch_milestone_task_counts);
	const once = await footprint();
	assert.deepEqual([once.milestones, once.tasks], [expected.result.milestones, expected.result.task_count]);
	assert.equal(once.dated > 0 ? "automatic" : null, expected.result.launch_automatic_due_dates);

	const task = seeded.milestones[0]!.tasks[0]!;
	const tasks = createTaskWriter({ reminders: async () => {} });
	const [{ revision } = assert.fail("seeded task")] = await rows<{ revision: string }>(
		sql`SELECT revision::text AS revision FROM task WHERE id=${task.id}`,
	);
	ok(
		await withTaskWrite(runtime, owner, (tx, ctx) =>
			tasks.edit(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: revision,
				input: { taskId: task.id, patch: { title: "Our own equipment order" } },
			}),
		),
	);
	const edited = await rows(sql`SELECT id,title,revision FROM task WHERE plant_id=${R.id} ORDER BY id`);
	ok(await schedule("1", scheduleKey));
	assert.deepEqual(ok(await launch.ensureReadiness(runtime, owner)), { milestones: 0, tasks: 0 });
	const replayed = await footprint();
	assert.equal(
		replayed.tasks - once.tasks + replayed.milestones - once.milestones,
		expected.result.replay_duplicate_rows,
	);
	const kept = await rows(sql`SELECT id,title,revision FROM task WHERE plant_id=${R.id} ORDER BY id`);
	assert.equal(!isDeepStrictEqual(kept, edited), expected.result.user_edits_overwritten);

	const checklist = CATALOG.checklists.find((k) => k.key === "vision-meeting-preparation")!;
	const importing = (requestKey: string) =>
		withTaskWrite(runtime, owner, (tx, ctx) =>
			tasks.importTemplate(tx, ctx, {
				requestKey,
				input: {
					catalogVersion: CATALOG.version,
					checklistKey: checklist.key,
					itemKeys: checklist.items.map((i) => i.key),
				},
			}),
		);
	const importKey = randomUUID();
	const first = ok(await importing(importKey)).tasks;
	const imported = await footprint();
	assert.equal(imported.tasks - replayed.tasks, checklist.items.length);
	assert.deepEqual(ok(await importing(importKey)).tasks, first);
	assert.equal((await footprint()).tasks - imported.tasks, expected.result.replay_duplicate_rows);

	const phases = createPhaseWriter({ async notices() {} });
	const [{ revision: plantRevision } = assert.fail("plant")] = await rows<{ revision: string }>(
		sql`SELECT revision::text AS revision FROM plant WHERE id=${R.id}`,
	);
	ok(
		await phases.transition(runtime, owner, {
			requestKey: randomUUID(),
			expectedRevision: plantRevision,
			input: { toPhase: 2, reason: "The core group is ready for the next phase" },
		}),
	);
	const [moved] = await rows<{ id: string }>(
		sql`SELECT id FROM phase_transition WHERE plant_id=${R.id} ORDER BY occurred_at DESC, id DESC LIMIT 1`,
	);
	const offered = await footprint();
	const declined = ok(
		await withTaskWrite(runtime, owner, (tx, ctx) =>
			tasks.declinePhaseOffer(tx, ctx, { requestKey: randomUUID(), input: { transitionId: moved!.id } }),
		),
	);
	assert.equal(declined.answer.answer, "declined");
	assert.equal(declined.created.length, expected.result.declined_offer_new_rows);
	assert.equal((await footprint()).tasks - offered.tasks, expected.result.declined_offer_new_rows);
});

test("AC:REF-CASE-005 ten team templates package; importing only Worship maps no custom team of the same name, forces no other team and keeps a renamed team, with eight areas and a separate Prayer Leader", async () => {
	const { given, expected } = schemaCase("REF-CASE-005");
	const exec = given.execution as unknown as {
		catalog_sha256: string;
		template_count: number;
		renamed_worship_team: string;
		custom_team_same_name: boolean;
		selected_imports: string[];
		required_methodology_areas: number;
	};
	assert.equal(await fileHash("docs/reference/ministry-role-templates.ts"), exec.catalog_sha256);
	await packaged("ref-case-teams");
	const stored = await installed("ref-case-teams", "ministry_template");
	assert.equal(stored.length, expected.result.template_count);
	assert.equal(stored.length, exec.template_count);

	const R = await world.plant({ name: "Cedar", timezone: "America/Chicago" });
	const admin = await world.actor(R, "admin");
	const ctx = { session: admin.session, selected: { kind: "plant" as const, id: R.id } };
	const run = <V,>(op: (tx: never, context: never, raw: unknown) => Promise<V>, input: unknown) =>
		gatedTransaction(runtime, (tx) => op(tx as never, ctx as never, input));
	const worship = TEMPLATE_TEAMS.find((t) => t.key === exec.selected_imports[0])!;
	assert.equal(exec.custom_team_same_name, true);
	const custom = ok(await run(teamsWriter.create, { requestKey: randomUUID(), input: { name: worship.name } })).team;
	const selections = exec.selected_imports.map((teamKey) => ({
		teamKey,
		roleKeys: TEMPLATE_TEAMS.find((t) => t.key === teamKey)!.roles.map((r) => r.key),
	}));
	const initialize = () =>
		run(teamsWriter.initialize, {
			requestKey: randomUUID(),
			input: { expectedVersion: TEMPLATE_VERSION, mode: "import", selections },
		});
	const first = ok(await initialize());
	assert.deepEqual(first.teamKeys, expected.result.imported_team_keys);
	const teams = () =>
		rows<{ id: string; name: string; template_key: string | null; revision: string }>(
			sql`SELECT id,name,template_key,revision::text AS revision FROM team WHERE plant_id=${R.id} ORDER BY name`,
		);
	const imported = (await teams()).find((t) => t.template_key === worship.key)!;
	assert.notEqual(imported.id, custom.id);
	ok(
		await run(teamsWriter.edit, {
			requestKey: randomUUID(),
			expectedRevision: imported.revision,
			input: { teamId: imported.id, name: exec.renamed_worship_team },
		}),
	);
	const again = ok(await initialize());
	assert.equal(again.newTenantRows, 0);
	const now = await teams();
	assert.deepEqual(
		now.map((t) => [t.name, t.template_key]),
		[
			[exec.renamed_worship_team, worship.key],
			[worship.name, null],
		],
	);
	assert.equal(
		now.some((t) => t.id === custom.id && t.template_key !== null),
		expected.result.custom_same_name_auto_mapped,
	);
	assert.equal(
		now.filter((t) => t.template_key && !exec.selected_imports.includes(t.template_key)).length,
		expected.result.forced_teams,
	);

	const { coverage } = ok(await createFacts().readFacts(runtime, await actor(admin), {}));
	assert.deepEqual(
		[coverage.slots, coverage.responsibilities.length],
		[expected.result.required_areas, exec.required_methodology_areas],
	);
	const areaOf = (key: string) => TEMPLATE_TEAMS.find((t) => t.key === key)!.roles.map((r) => r.responsibilityKey);
	const prayer = TEMPLATE_TEAMS.find((t) => t.roles.some((r) => r.responsibilityKey === "prayer"))!;
	assert.equal(
		prayer.key !== worship.key &&
			isDeepStrictEqual(areaOf(prayer.key), ["prayer"]) &&
			!areaOf(worship.key).includes("prayer") &&
			!coverage.responsibilities.some((r) => r.key === "prayer"),
		expected.result.Prayer_Leader_separate,
	);
	assert.equal(given.prayer_responsibility?.value, "separate");
});
