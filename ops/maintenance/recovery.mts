import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z } = require("zod");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.strictObject({
	id: z.uuid(),
	sha256: hash,
	bytes: z.number().int().nonnegative(),
	version: z.string().min(1).max(128),
});
export const manifestSchema = z.strictObject({
	version: z.literal(1),
	source: z.string().regex(/^[a-f0-9]{40}$/),
	schema: hash,
	createdAt: z.iso.datetime(),
	expiresAt: z.iso.datetime(),
	database: artifact,
	objects: z.array(artifact).max(10000),
	keyVersion: z.uuid(),
	witnessCheckpoint: z.string().regex(/^[1-9]\d*$/),
	subjects: z.array(z.strictObject({ id: z.uuid(), expiresAt: z.iso.datetime() })).max(10000),
});
const DAY = 86_400_000;
// No provider, app endpoint or key-loading fallback. Only the restricted CLI imports this file.
export function validateCandidate(input, now, originalExpiries = new Map()) {
	const m = manifestSchema.parse(input);
	const created = Date.parse(m.createdAt),
		expires = Date.parse(m.expiresAt);
	if (created > now.getTime() || expires <= now.getTime() || expires > created + 7 * DAY || expires <= created)
		throw Error("copy_expired_or_invalid");
	const ids = [m.database.id, ...m.objects.map((o) => o.id)];
	if (new Set(ids).size !== ids.length || new Set(m.subjects.map((s) => s.id)).size !== m.subjects.length)
		throw Error("duplicate_manifest_identity");
	for (const subject of m.subjects) {
		const prior = originalExpiries.get(subject.id);
		if (Date.parse(subject.expiresAt) <= now.getTime() || (prior && Date.parse(subject.expiresAt) > Date.parse(prior)))
			throw Error("subject_expired_or_reset");
	}
	return {
		manifest: m,
		effectiveExpiresAt: new Date(Math.min(expires, ...m.subjects.map((s) => Date.parse(s.expiresAt)))).toISOString(),
		liveRecoveryProven: false,
	};
}
