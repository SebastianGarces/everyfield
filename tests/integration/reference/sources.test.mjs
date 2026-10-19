import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile, unlink, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifySources } from "../../../packages/reference/verify.mjs";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const manifestPath = "docs/reference/manifest.json";
const payloadPath = "docs/reference/bootstrap/global-seed-payload.json";
const playbookPath = "docs/reference/playbook.md";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
	const root = await mkdtemp(resolve(tmpdir(), "evf-reference-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const folder of ["reference", "catalog", "acceptance"]) {
		await cp(resolve(checkout, "docs", folder), resolve(root, "docs", folder), { recursive: true });
	}
	return root;
}
const json = async (root, path) => JSON.parse(await readFile(resolve(root, path), "utf8"));
const put = (root, path, value) => writeFile(resolve(root, path), JSON.stringify(value));
const issue = (report, code, path) => report.issues.some((i) => i.code === code && i.path === path);

test("AC:GAP-REF-001 AC:REF-CASE-001 source portion: exact Playbook; missing, welcome substitution and one-byte edit fail", async (t) => {
	const root = await fixture(t);
	const before = await verifySources(root);
	assert.equal(before.ok, true);
	assert.deepEqual(before.files.find((f) => f.path === playbookPath).actual, {
		sha256: "d365dd4992156e674f8e67601239fbf97c173074a3ca7e0bc8010aa725205e7a",
		bytes: 34025,
	});
	const original = await readFile(resolve(root, playbookPath));
	const welcome = (await json(root, payloadPath)).articles.find((a) => a.slug.includes("welcome"));
	assert.ok(welcome);
	for (const replacement of [
		Buffer.concat([original.subarray(0, -1), Buffer.from("X")]),
		Buffer.from(welcome.content),
	]) {
		await writeFile(resolve(root, playbookPath), replacement);
		const report = await verifySources(root);
		assert.equal(report.ok, false);
		assert.ok(issue(report, "hash_mismatch", playbookPath));
	}
	await unlink(resolve(root, playbookPath));
	const missing = await verifySources(root);
	assert.equal(missing.ok, false);
	assert.ok(issue(missing, "source_unavailable", playbookPath));
});

test("AC:CONTENT50-001 AC:REF-CASE-002 AC:REF-CASE-003 AC:REF-CASE-004 AC:REF-CASE-005 AC:REF-CASE-006 source portions: exact starter and distinct catalog inventories", async (t) => {
	const root = await fixture(t);
	const report = await verifySources(root);
	assert.equal(report.ok, true);
	assert.equal(report.files.length, 24);
	assert.equal(
		report.files.find((f) => f.path === payloadPath).actual.sha256,
		"7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59",
	);
	const i = report.inventory;
	assert.deepEqual(
		[i.articles, i.sections, i.templates, i.documents.length, i.checklists.length, i.teams.length, i.messages.length],
		[96, 21, 7, 11, 20, 10, 7],
	);
	assert.deepEqual(i.documents.slice(0, 3), ["commitment-card", "response-card", "guest-sign-in-sheet"]);
	assert.deepEqual(
		i.milestones.map((m) => m.tasks.length),
		[3, 3, 2, 2, 3, 3, 2, 3, 2],
	);
	assert.equal(i.milestones.flatMap((m) => m.tasks).length, 23);
	assert.equal(i.milestones[8].key, "promotion.partner_churches");
	assert.equal(i.milestones[8].tasks[1], "Confirm the partner organization's role in the service");
	// Whole-file verification must include every registered original and derived source.
	for (const file of report.files) {
		const bytes = await readFile(resolve(root, file.path));
		await writeFile(resolve(root, file.path), Buffer.concat([bytes, Buffer.from("\n")]));
		const changed = await verifySources(root);
		assert.equal(changed.ok, false, file.path);
		assert.ok(issue(changed, "hash_mismatch", file.path), file.path);
		await writeFile(resolve(root, file.path), bytes);
	}
});

test("INV-reference-scope: report refuses customer/vector additions and non-global rows even with a refreshed payload hash", async (t) => {
	const root = await fixture(t);
	const original = await json(root, payloadPath);
	for (const mutate of [
		(p) => {
			p.customers = [{ id: "synthetic-customer" }];
		},
		(p) => {
			p.embeddings = [[0.1, 0.2]];
		},
		(p) => {
			p.articles[0].church_id = "synthetic-plant";
		},
		(p) => {
			p.templates[0].churchId = "synthetic-plant";
		},
	]) {
		const payload = structuredClone(original);
		mutate(payload);
		await put(root, payloadPath, payload);
		const bytes = await readFile(resolve(root, payloadPath));
		const manifest = await json(root, manifestPath);
		Object.assign(
			manifest.files.find((f) => f.path === payloadPath),
			{ sha256: hash(bytes), bytes: bytes.length },
		);
		await put(root, manifestPath, manifest);
		const report = await verifySources(root);
		assert.equal(report.ok, false);
		assert.ok(issue(report, "non_global_payload", payloadPath));
	}
});

test("INV-reference-authority: preserve current precedence, historical drift and unrun proof limits in the report", async (t) => {
	const root = await fixture(t);
	const report = await verifySources(root);
	assert.equal(report.ok, true);
	assert.equal(report.releaseIdentity, "everyfield-reference-inputs-2026-10-13");
	assert.equal(
		report.authority.plant_rubric,
		"rubric-v1.md with final accepted C12 disposition in bryan-comments-review.md; historical v0 is independently resolvable",
	);
	assert.equal(
		report.authority.network_rubric,
		"network-rubric-v1.json and .md are separately EveryField-authored target reference, never a plant rubric replacement",
	);
	assert.deepEqual(
		report.knownDrift.map((d) => d.id),
		["REF-DRIFT-C12", "REF-DRIFT-PRAYER", "REF-DRIFT-EVIDENCE"],
	);
	assert.ok(
		report.sourceLimits.includes(
			"Old stored embeddings have absent model provenance and mismatched/obsolete chunks; never bootstrap them.",
		),
	);
	assert.match(report.proofScope, /no runtime, model, provider or activation approval/);
});

test("INV-reference-identity: catalog content changes alter identity without borrowing historical progress claims", async (t) => {
	const root = await fixture(t);
	const first = await verifySources(root);
	assert.equal(first.catalog.specificationVersion, "2026-10-13.current-1");
	assert.match(first.catalog.sha256, /^[a-f0-9]{64}$/);
	const requirements = "docs/catalog/requirements/reference-release.json";
	const bytes = await readFile(resolve(root, requirements));
	await writeFile(resolve(root, requirements), Buffer.concat([bytes, Buffer.from("\n")]));
	const second = await verifySources(root);
	assert.equal(second.ok, true);
	assert.notEqual(second.catalog.sha256, first.catalog.sha256);
	assert.notEqual(
		second.catalog.files.find((f) => f.path === requirements).sha256,
		first.catalog.files.find((f) => f.path === requirements).sha256,
	);
	assert.equal(second.manifestSha256, first.manifestSha256);
	assert.deepEqual(await verifySources(root), second);
});

test("INV-reference-portability: CLI reads an explicit checkout from another directory and refuses a source outside it", async (t) => {
	const root = await fixture(t);
	const cli = resolve(checkout, "packages/reference/verify.mjs");
	const run = () => spawnSync(process.execPath, [cli, root], { cwd: tmpdir(), encoding: "utf8" });
	const success = run();
	assert.equal(success.status, 0, success.stderr);
	assert.equal(JSON.parse(success.stdout).ok, true);
	await unlink(resolve(root, playbookPath));
	await symlink(resolve(checkout, playbookPath), resolve(root, playbookPath));
	const failure = run();
	assert.equal(failure.status, 1);
	assert.ok(issue(JSON.parse(failure.stdout), "invalid_path", playbookPath));
});
