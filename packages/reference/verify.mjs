import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const referenceManifest = "docs/reference/manifest.json";
const catalogIndex = "docs/catalog/index.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const strings = (text, expression) => [...text.matchAll(expression)].map((m) => JSON.parse(m[1]));

/** Read-only verification of a checkout's sources, not a release/activation approval. */
export async function verifySources(root) {
	root = await realpath(root);
	const issues = [];
	const inputs = new Map();
	const problem = (code, path) => issues.push({ code, path });
	const check = (ok, code, path) => {
		if (!ok) problem(code, path);
	};
	async function read(path) {
		if (typeof path !== "string" || !path.startsWith("docs/") || path.split("/").includes("..")) {
			problem("invalid_path", referenceManifest);
			return null;
		}
		if (inputs.has(path)) return inputs.get(path);
		try {
			const target = await realpath(resolve(root, path));
			const local = relative(root, target);
			if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) {
				problem("invalid_path", path);
				return null;
			}
			const bytes = await readFile(target);
			inputs.set(path, bytes);
			return bytes;
		} catch {
			problem("source_unavailable", path);
			return null;
		}
	}
	async function json(path) {
		const bytes = await read(path);
		if (!bytes) return null;
		try {
			return JSON.parse(bytes.toString("utf8"));
		} catch {
			problem("invalid_json", path);
			return null;
		}
	}
	const manifest = await json(referenceManifest);
	const catalog = await json(catalogIndex);
	const files = [];
	check(
		manifest?.schema_version === 1 &&
			typeof manifest.release_identity === "string" &&
			Array.isArray(manifest.files) &&
			manifest.files.length > 0 &&
			manifest.authority &&
			manifest.catalog_inventory &&
			Array.isArray(manifest.known_source_limits) &&
			Array.isArray(manifest.derived_copy_drift),
		"invalid_manifest",
		referenceManifest,
	);
	if (!manifest || issues.some((i) => i.code === "invalid_manifest")) return { ok: false, issues };
	for (const entry of manifest.files) {
		if (
			!entry ||
			typeof entry.path !== "string" ||
			!entry.path.startsWith("docs/reference/") ||
			!/^[a-f0-9]{64}$/.test(entry.sha256) ||
			!Number.isSafeInteger(entry.bytes) ||
			entry.bytes < 0
		) {
			problem("invalid_manifest_entry", referenceManifest);
			continue;
		}
		check(!files.some((file) => file.path === entry.path), "duplicate_source", entry.path);
		const bytes = await read(entry.path);
		const actual = bytes ? { sha256: sha256(bytes), bytes: bytes.length } : null;
		files.push({
			path: entry.path,
			expected: { sha256: entry.sha256, bytes: entry.bytes },
			actual,
			authority: entry.content_authority,
			sourcePath: entry.source_path ?? null,
		});
		if (actual) {
			check(actual.sha256 === entry.sha256, "hash_mismatch", entry.path);
			check(actual.bytes === entry.bytes, "byte_length_mismatch", entry.path);
		}
	}
	function source(name) {
		const path = `docs/reference/${name}`;
		check(
			files.some((file) => file.path === path),
			"unregistered_source",
			path,
		);
		return inputs.get(path)?.toString("utf8") ?? "";
	}
	source("playbook.md");
	source("rubric-v0.md");
	source("rubric-v1.md");
	source("bryan-comments-review.md");
	source("plant-rubric-executable.ts");
	source("network-rubric-v1.json");
	source("network-rubric-v1.md");
	const adapter = await json("docs/reference/plant-operational-adapter-v1.json");
	source("plant-operational-adapter-v1.json");
	check(
		adapter?.plant_rubric_path === "docs/reference/rubric-v1.md" &&
			adapter.plant_rubric_sha256 === files.find((f) => f.path === adapter.plant_rubric_path)?.actual?.sha256,
		"rubric_adapter_mismatch",
		"docs/reference/plant-operational-adapter-v1.json",
	);

	const payloadPath = "docs/reference/bootstrap/global-seed-payload.json";
	source("bootstrap/global-seed-payload.json");
	source("bootstrap/manifest.json");
	const payload = await json(payloadPath);
	const bootstrap = await json("docs/reference/bootstrap/manifest.json");
	const inventory = {};
	if (payload && bootstrap) {
		check(Object.keys(payload).sort().join(",") === "articles,sections,templates", "non_global_payload", payloadPath);
		check(
			bootstrap.seedPayloadSHA256 === sha256(inputs.get(payloadPath)) &&
				bootstrap.playbookSHA256 === files.find((f) => f.path === "docs/reference/playbook.md")?.actual?.sha256,
			"bootstrap_hash_mismatch",
			payloadPath,
		);
		for (const group of ["articles", "sections", "templates"]) {
			const rows = payload[group];
			const key = group === "templates" ? "name" : "id";
			check(Array.isArray(rows) && Array.isArray(bootstrap[group]), "invalid_bootstrap", payloadPath);
			if (!Array.isArray(rows) || !Array.isArray(bootstrap[group])) continue;
			inventory[group] = rows.length;
			check(rows.length === manifest.bootstrap_counts[group], "inventory_mismatch", payloadPath);
			check(
				new Set(rows.map((r) => r[key])).size === rows.length &&
					JSON.stringify(rows.map((r) => r[key]).sort()) === JSON.stringify(bootstrap[group].map((r) => r[key]).sort()),
				"bootstrap_identity_mismatch",
				payloadPath,
			);
			if (group === "articles")
				check(
					rows.every((r) => r.church_id === null && r.status === "published"),
					"non_global_payload",
					payloadPath,
				);
			if (group === "templates")
				check(
					rows.every((r) => r.churchId === null && r.isSystem === true && r.sourceTemplateId === null),
					"non_global_payload",
					payloadPath,
				);
		}
		const sections = new Map((payload.sections ?? []).map((s) => [s.id, s]));
		check(
			(payload.sections ?? []).every(
				(s) => s.parent_section_id === null || s.slug.startsWith(`${sections.get(s.parent_section_id)?.slug}/`),
			) &&
				(payload.articles ?? []).every(
					(a) => sections.has(a.section_id) && a.slug.startsWith(`${sections.get(a.section_id).slug}/`),
				),
			"bootstrap_topology_mismatch",
			payloadPath,
		);
	}
	// Read only literal identities in the hashed original files. Never import/execute legacy code.
	const documents = strings(source("document-templates.ts"), /^    id: ("[^"\n]+"),/gm);
	const checklists = strings(source("task-templates.ts"), /^    key: ("[^"\n]+"),/gm);
	const teams = strings(source("ministry-role-templates.ts"), /^    teamKey: ("[^"\n]+"),/gm);
	const messages = strings(source("communication-system-templates.ts"), /^    name: ("[^"\n]+"),/gm);
	const launch = source("launch-milestone-templates.ts");
	const milestones = [
		...launch.matchAll(/^    templateKey: ("[^"\n]+"),[\s\S]*?^    tasks: \[([\s\S]*?)^    \],/gm),
	].map((m) => ({ key: JSON.parse(m[1]), tasks: strings(m[2], /\btitle:\s*("(?:\\.|[^"\\])*"),/g) }));
	const launchInventory = await json("docs/reference/launch-template-inventory.json");
	source("launch-template-inventory.json");
	Object.assign(inventory, { documents, checklists, teams, messages, milestones });
	for (const [values, count] of [
		[documents, "document_templates"],
		[checklists, "phase_checklist_template_keys"],
		[teams, "ministry_team_templates"],
		[messages, "system_communication_templates"],
	]) {
		check(
			values.length === manifest.catalog_inventory[count] && new Set(values).size === values.length,
			"template_inventory_mismatch",
			referenceManifest,
		);
	}
	check(
		JSON.stringify(milestones) ===
			JSON.stringify(launchInventory?.milestones?.map((m) => ({ key: m.template_key, tasks: m.task_titles }))) &&
			milestones.length === manifest.catalog_inventory.launch_milestones &&
			milestones.reduce((n, m) => n + m.tasks.length, 0) === manifest.catalog_inventory.launch_tasks,
		"launch_inventory_mismatch",
		"docs/reference/launch-template-inventory.json",
	);

	const catalogFiles = [];
	if (
		typeof catalog?.specification_version !== "string" ||
		!Array.isArray(catalog.requirement_files) ||
		!Array.isArray(catalog.case_files)
	)
		problem("invalid_catalog", catalogIndex);
	else {
		const paths = [
			catalogIndex,
			catalog.feature_source,
			catalog.acceptance_source,
			catalog.operation_source,
			...catalog.requirement_files,
			...catalog.case_files,
			catalog.generated_evry_tool_source,
		];
		for (const path of [...new Set(paths)].sort()) {
			await json(path);
			const bytes = inputs.get(path);
			if (bytes) catalogFiles.push({ path, sha256: sha256(bytes) });
		}
	}
	return {
		ok: issues.length === 0,
		issues,
		releaseIdentity: manifest.release_identity,
		manifestSha256: sha256(inputs.get(referenceManifest)),
		catalog: {
			specificationVersion: catalog?.specification_version,
			files: catalogFiles,
			sha256: sha256(JSON.stringify(catalogFiles)),
		},
		files,
		inventory,
		authority: manifest.authority,
		knownDrift: manifest.derived_copy_drift,
		sourceLimits: manifest.known_source_limits,
		proofScope:
			"Local source bytes, identity, inventory and scope only; no runtime, model, provider or activation approval.",
	};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	try {
		const report = await verifySources(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
		console.log(JSON.stringify(report, null, 2));
		process.exitCode = report.ok ? 0 : 1;
	} catch {
		console.error("Source verification could not read the checkout.");
		process.exitCode = 1;
	}
}
