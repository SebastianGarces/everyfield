import { z } from "zod";
import { revision } from "../common/values.ts";
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const referenceId = z.uuid();
export const profile = z.strictObject({
	chunker: z.literal("fixed-codepoints-1200-v1"),
	model: z.string().min(1).max(100),
	dimensions: z.number().int().min(1).max(4096),
});
export const entry = z.strictObject({
	id: referenceId,
	revisionId: referenceId,
	kind: z.enum([
		"phase",
		"source",
		"article",
		"section",
		"playbook",
		"rubric",
		"task_template",
		"ministry_template",
		"mail_template",
		"document_template",
		"launch_inventory",
		"criterion",
	]),
	key: z.string().min(1).max(300),
	body: z.string().max(2_000_000),
	contentHash: digest,
	sourcePath: z.string().max(300),
	sourceHash: digest,
	format: z.enum(["source", "safe_mdx", "catalog"]),
	slug: z.string().optional(),
	sectionId: referenceId.optional(),
	parentId: referenceId.nullable().optional(),
});
export const passage = z.strictObject({
	key: z.string().min(1).max(100),
	revisionId: referenceId,
	ordinal: z.number().int().min(0),
	text: z.string().max(10000),
	contentHash: digest,
	embedding: z.array(z.number().finite().min(-3.402823466e38).max(3.402823466e38)).max(4096),
	embeddingChecksum: digest,
});
export const generation = z.strictObject({
	version: z.literal(1),
	key: z.string().min(1).max(200),
	sourceManifestSha256: digest,
	catalogSha256: digest,
	profile,
	discoveryIds: z.array(referenceId).length(6),
	entries: z.array(entry).min(1).max(5000),
	passages: z.array(passage).max(100_000),
});
export type ReferenceProfile = z.infer<typeof profile>;
export type ReferenceEntry = z.infer<typeof entry>;
export type ReferencePassage = z.infer<typeof passage>;
export type ReferenceGeneration = z.infer<typeof generation>;
export const promotion = z.strictObject({
	kind: z.enum(["activate", "rollback"]),
	generationKey: z.string().min(1).max(200),
	manifestHash: digest,
	expectedActivation: revision,
	reason: z.string().min(1).max(500),
	requestKey: z.string().min(1).max(200),
});
export type Promotion = z.infer<typeof promotion>;
