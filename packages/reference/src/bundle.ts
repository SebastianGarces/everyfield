import { z } from "zod";
import { generation, profile } from "@everyfield/contracts/reference";
import type {
	ReferenceGeneration,
	ReferenceEntry,
	ReferencePassage,
	ReferenceProfile,
} from "@everyfield/contracts/reference";
import { loadStarter, verifyCheckout } from "./starter.ts";
import type { Starter } from "./starter.ts";
import { hash, canonical, stableId, vectorHash } from "./hash.ts";
import { safeMdx } from "./content.ts";
import { wikiRecords } from "./starter/verify/generation.ts";
import { loadApprovedSnapshot } from "./starter/verify/snapshot.ts";
import type { ApprovedSnapshot } from "./starter/verify/snapshot.ts";

const article = z.object({
	id: z.uuid(),
	slug: z.string(),
	section_id: z.uuid(),
	content: z.string(),
	church_id: z.null(),
	status: z.literal("published"),
	related_article_slugs: z.array(z.string()),
});
// Checkout packaging is an explicit release operation. Pure catalog construction below
// consumes already reviewed data and does not turn unrelated documentation edits into a unit gate.
export async function packageCheckout(root: URL, expectedCatalogSha256?: string): Promise<ReferenceEntry[]> {
	const report = await verifyCheckout(root, expectedCatalogSha256);
	if (!report.ok) throw Error(report.issues[0]!.code);
	return packageStarter(await loadStarter(), await loadApprovedSnapshot(root));
}
/** Frozen reference sources and catalogs, plus the Wiki rows of the approved living seed. */
export function packageStarter(starter: Starter, wiki: ApprovedSnapshot): ReferenceEntry[] {
	const source = (path: string) => {
		const row = starter.sources.find((s) => s.path === "docs/reference/" + path);
		if (!row) throw Error("source_unavailable");
		return row;
	};
	const rows: ReferenceEntry[] = [];
	function add(
		kind: ReferenceEntry["kind"],
		key: string,
		body: string,
		path: string,
		extra: Partial<ReferenceEntry> = {},
	) {
		const s = source(path),
			id = extra.id ?? stableId(kind + ":" + key),
			contentHash = hash(body);
		rows.push({
			kind,
			key,
			body,
			id,
			revisionId: stableId(id + ":" + contentHash),
			contentHash,
			sourcePath: s.path,
			sourceHash: s.sha256,
			format: "catalog",
			...extra,
		});
	}
	// The bootstrap files stay in the frozen inventory as provenance only. The Wiki rows come from `wiki`.
	for (const s of starter.sources) {
		const file = s.path.slice("docs/reference/".length);
		if (file.startsWith("bootstrap/")) continue;
		add(
			file === "playbook.md"
				? "playbook"
				: ["rubric-v0.md", "rubric-v1.md", "network-rubric-v1.md"].includes(file)
					? "rubric"
					: "source",
			file,
			s.body,
			file,
			{ format: "source" },
		);
	}
	for (const row of wikiRecords(wiki)) rows.push({ ...row, revisionId: stableId(row.id + ":" + row.contentHash) });
	for (const [name, kind, key, path] of [
		["tasks", "task_template", "key", "task-templates.ts"],
		["teams", "ministry_template", "teamKey", "ministry-role-templates.ts"],
		["documents", "document_template", "id", "document-templates.ts"],
		["launch", "launch_inventory", "templateKey", "launch-milestone-templates.ts"],
		["phases", "phase", "phase", "rubric-v1.md"],
		["criteria", "criterion", "key", "phase-exit-criteria.ts"],
	] as const)
		for (const row of starter.catalogs[name])
			add(kind, String(Object.fromEntries(Object.entries(row))[key]), canonical(row), path);
	return rows.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
export function chunkEntries(
	entries: readonly ReferenceEntry[],
): Omit<ReferencePassage, "embedding" | "embeddingChecksum">[] {
	return entries
		.filter((e) => e.kind === "article")
		.flatMap((e) => {
			const text = e.kind === "article" ? article.parse(JSON.parse(e.body)).content : e.body;
			const chars = Array.from(text),
				rows = [];
			for (let start = 0; start < chars.length; start += 1200) {
				const text = chars.slice(start, start + 1200).join(""),
					ordinal = start / 1200;
				rows.push({
					key: e.revisionId + ":" + ordinal,
					revisionId: e.revisionId,
					ordinal,
					text,
					contentHash: hash(text),
				});
			}
			return rows;
		});
}
export function planGeneration(
	starter: Starter,
	wiki: ApprovedSnapshot,
	key: string,
	configuredProfile: ReferenceProfile,
) {
	profile.parse(configuredProfile);
	const freezeSource = starter.sources.find((s) => s.path === "docs/reference/discovery-foundations.json");
	const discovery = z
		.object({ articles: z.array(z.object({ id: z.uuid() })).length(6) })
		.parse(JSON.parse(freezeSource!.body));
	return {
		key,
		profile: configuredProfile,
		entries: packageStarter(starter, wiki).map((e) => ({
			...e,
			revisionId: stableId(key + ":" + e.id + ":" + e.contentHash),
		})),
		discoveryIds: discovery.articles.map((a) => a.id),
	};
}
export type GenerationPlan = ReturnType<typeof planGeneration>;
export function completeGeneration(
	plan: GenerationPlan,
	identities: { sourceManifestSha256: string; catalogSha256: string },
	vectors: ReadonlyMap<string, readonly number[]>,
): ReferenceGeneration {
	return generation.parse({
		version: 1,
		sourceManifestSha256: identities.sourceManifestSha256,
		catalogSha256: identities.catalogSha256,
		...plan,
		passages: chunkEntries(plan.entries).map((p) => {
			const embedding = vectors.get(p.key) ?? [];
			return { ...p, embedding, embeddingChecksum: vectorHash(embedding) };
		}),
	});
}
export interface ValidationPolicy {
	identities: { sourceManifestSha256: string; catalogSha256: string };
	plan: {
		profile: ReferenceProfile;
		entries: readonly ReferenceEntry[];
		discoveryIds: readonly string[];
	};
	editorial: { approved: boolean; originalAvailable: boolean; conflicts: readonly string[] };
	// The approved snapshot install stores no derived passages. A later rebuild supplies them.
	deferDerivatives?: boolean;
}
export interface ValidationReport {
	ok: boolean;
	hashIntegrity: boolean;
	editorialApproved: boolean;
	manifestHash: string | null;
	blockers: string[];
}
export function validateBundle(input: unknown, policy: ValidationPolicy): ValidationReport {
	try {
		return validateParsed(input, policy);
	} catch {
		return {
			ok: false,
			hashIntegrity: false,
			editorialApproved: false,
			manifestHash: null,
			blockers: ["invalid_content"],
		};
	}
}
function validateParsed(input: unknown, policy: ValidationPolicy): ValidationReport {
	const result = generation.safeParse(input);
	if (!result.success)
		return {
			ok: false,
			hashIntegrity: false,
			editorialApproved: false,
			manifestHash: null,
			blockers: ["invalid_generation"],
		};
	const value = result.data,
		blockers = new Set<string>();
	const reject = (ok: boolean, code: string) => {
		if (!ok) blockers.add(code);
	};
	reject(
		value.sourceManifestSha256 === policy.identities.sourceManifestSha256 &&
			value.catalogSha256 === policy.identities.catalogSha256,
		"source_identity_mismatch",
	);
	reject(canonical(value.profile) === canonical(policy.plan.profile), "unsupported_profile");
	reject(
		canonical(value.discoveryIds) === canonical(policy.plan.discoveryIds) && new Set(value.discoveryIds).size === 6,
		"discovery_identity_mismatch",
	);
	reject(canonical(value.entries) === canonical(policy.plan.entries), "source_manifest_mismatch");
	reject(new Set(value.entries.map((e) => e.id)).size === value.entries.length, "duplicate_identity");
	reject(
		value.entries.every(
			(e) => hash(e.body) === e.contentHash && e.revisionId === stableId(value.key + ":" + e.id + ":" + e.contentHash),
		),
		"content_hash_mismatch",
	);
	const sections = new Map(value.entries.filter((e) => e.kind === "section").map((e) => [e.id, e]));
	const articles = value.entries.filter((e) => e.kind === "article"),
		slugs = new Set(articles.map((a) => a.slug!));
	reject(slugs.size === articles.length, "duplicate_slug");
	for (const s of sections.values()) {
		const seen = new Set<string>([s.id]);
		let parent = s.parentId;
		while (parent) {
			if (seen.has(parent) || !sections.has(parent)) {
				blockers.add("invalid_topology");
				break;
			}
			seen.add(parent);
			parent = sections.get(parent)!.parentId;
		}
		if (s.parentId) reject(s.slug!.startsWith(sections.get(s.parentId)?.slug + "/"), "invalid_topology");
	}
	for (const e of articles) {
		const parsed = article.safeParse(JSON.parse(e.body));
		if (!parsed.success) {
			blockers.add("non_global_content");
			continue;
		}
		reject(
			parsed.data.id === e.id &&
				parsed.data.slug === e.slug &&
				parsed.data.section_id === e.sectionId &&
				!!e.sectionId &&
				sections.has(e.sectionId) &&
				e.slug!.startsWith(sections.get(e.sectionId)?.slug + "/"),
			"invalid_topology",
		);
		reject(
			parsed.data.related_article_slugs.every((s) => slugs.has(s)),
			"missing_link",
		);
		reject(safeMdx(parsed.data.content, slugs), "unsafe_content");
	}
	if (policy.deferDerivatives) reject(value.passages.length === 0, "derivative_keys_mismatch");
	else {
		const expected = chunkEntries(value.entries),
			actual = new Map(value.passages.map((p) => [p.key, p]));
		reject(actual.size === value.passages.length && actual.size === expected.length, "derivative_keys_mismatch");
		for (const p of expected) {
			const a = actual.get(p.key);
			reject(
				!!a &&
					a.revisionId === p.revisionId &&
					a.ordinal === p.ordinal &&
					a.text === p.text &&
					a.contentHash === p.contentHash,
				"derivative_mismatch",
			);
		}
		reject(
			value.passages.every(
				(p) => p.embedding.length === value.profile.dimensions && vectorHash(p.embedding) === p.embeddingChecksum,
			),
			"embedding_mismatch",
		);
	}
	const hashIntegrity = blockers.size === 0;
	reject(policy.editorial.conflicts.length === 0, "editorial_conflict");
	reject(policy.editorial.originalAvailable, "original_unavailable");
	const editorialReady = policy.editorial.originalAvailable && policy.editorial.conflicts.length === 0;
	if (editorialReady) reject(policy.editorial.approved, "editorial_approval_required");
	return {
		ok: blockers.size === 0,
		hashIntegrity,
		editorialApproved: policy.editorial.approved && editorialReady,
		manifestHash: hash(canonical(value)),
		blockers: [...blockers].sort(),
	};
}
