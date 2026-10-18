import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../packages/domain/package.json', import.meta.url));
const { z } = require('zod');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.strictObject({ id: z.uuid(), sha256: hash, bytes: z.number().int().nonnegative(), version: z.string().min(1).max(128) });
export const manifestSchema = z.strictObject({ version: z.literal(1), source: z.string().regex(/^[a-f0-9]{40}$/), schema: hash,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), database: artifact,
  objects: z.array(artifact).max(10000), keyVersion: z.uuid(), witnessCheckpoint: z.string().regex(/^[1-9]\d*$/),
  subjects: z.array(z.strictObject({ id: z.uuid(), expiresAt: z.iso.datetime() })).max(10000),
});
const DAY = 86_400_000;
// No provider, app endpoint or key-loading fallback. Only the restricted CLI imports this file.
export function validateCandidate(input, now, originalExpiries = new Map()) {
  const m = manifestSchema.parse(input);
  const created = Date.parse(m.createdAt), expires = Date.parse(m.expiresAt);
  if (created > now.getTime() || expires <= now.getTime() || expires > created + 7 * DAY || expires <= created) throw Error('copy_expired_or_invalid');
  const ids = [m.database.id, ...m.objects.map(o => o.id)];
  if (new Set(ids).size !== ids.length || new Set(m.subjects.map(s => s.id)).size !== m.subjects.length) throw Error('duplicate_manifest_identity');
  for (const subject of m.subjects) {
    const prior = originalExpiries.get(subject.id);
    if (Date.parse(subject.expiresAt) <= now.getTime() || (prior && Date.parse(subject.expiresAt) > Date.parse(prior))) throw Error('subject_expired_or_reset');
  }
  return { manifest: m, effectiveExpiresAt: new Date(Math.min(expires,...m.subjects.map(s=>Date.parse(s.expiresAt)))).toISOString(), liveRecoveryProven: false };
}
export function verifyCandidateBytes(manifest, database, objects) {
  function matches(entry, bytes) { return bytes && bytes.length === entry.bytes && createHash('sha256').update(bytes).digest('hex') === entry.sha256; }
  if (!matches(manifest.database,database) || objects.size !== manifest.objects.length || manifest.objects.some(o => !matches(o,objects.get(o.id)))) throw Error('incomplete_copy');
  return { database: 1, objects: manifest.objects.length };
}
// AES-GCM authenticates both the manifest and copied bytes. Caller-held key is
// independently recovered in a drill; a successful round trip is not key custody proof.
export function encryptCopy(bytes, key) {
  if (key.length !== 32) throw Error('invalid_key');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('everyfield-backup-v1'));
  const body = Buffer.concat([cipher.update(bytes),cipher.final()]);
  return Buffer.concat([Buffer.from('EVF1'),nonce,cipher.getAuthTag(),body]);
}
export function decryptCopy(bytes, key) {
  if (key.length !== 32 || bytes.length < 32 || bytes.subarray(0,4).toString() !== 'EVF1') throw Error('invalid_copy');
  const cipher = createDecipheriv('aes-256-gcm',key,bytes.subarray(4,16));
  cipher.setAAD(Buffer.from('everyfield-backup-v1'));cipher.setAuthTag(bytes.subarray(16,32));
  return Buffer.concat([cipher.update(bytes.subarray(32)),cipher.final()]);
}
export function restoreBarriers(input) {
  const v = z.strictObject({ isolated: z.literal(true), usersDisabled: z.literal(true), jobsDisabled: z.literal(true),
    mailDisabled: z.literal(true), issuesDisabled: z.literal(true), currentWitnessesVerified: z.literal(true),
    externalReceiptsReconciled: z.literal(true), matchingBytesVerified: z.literal(true), expiryVerified: z.literal(true) }).safeParse(input);
  return v.success ? { state: 'eligible_for_restricted_drill', serviceMayOpen: false } : { state: 'blocked', serviceMayOpen: false };
}
