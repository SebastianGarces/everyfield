// maintenance.createEncryptedCopy: the restricted backup copy (docs/architecture/recovery.md, "Before-customer-data
// gate"). It turns a snapshot (a database image and the ready objects' bytes, described by the external manifest
// validateCandidate checks) into a dated, encrypted copy in a private backup store, or recopies an older copy. Each
// artifact is sealed with AES-256-GCM under a fresh data key, and the data key is kept only wrapped by the restricted
// backup key-encryption key, read from a private file. The wrap binds the exact stored manifest, so a changed checksum,
// expiry or ciphertext no longer opens. A recopy keeps every original subject expiry: validateCandidate refuses one later
// than the original expiry it is given. No provider, bucket, schedule or spend: G-RECOVERY stays open. Only the
// restricted CLI and tests import this file.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readPrivateBytes } from "./control.mts";
import { validateCandidate } from "./recovery.mts";
import type { Snapshot } from "./restore.mts";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z } = require("zod");

export const COPY_OPERATION = "maintenance.createEncryptedCopy";
const capability = z.strictObject({
	authority: z.literal("authorized_restricted_backup_operator"),
	verified: z.literal(true),
	operation_ids: z.array(z.string()).refine((ids: string[]) => ids.includes(COPY_OPERATION)),
	environment: z.literal("isolated-test"),
});

/** The private backup store: opaque keys to bytes. Never the app's object store. */
export type BackupStore = {
	put(key: string, bytes: Uint8Array): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
};
export type CopyDeps = { store: BackupStore; clock: () => Date };
export type CopyInput = {
	capability: unknown;
	/** The private file that holds the 32-byte restricted backup key-encryption key. */
	keyFile: string;
	/** A plaintext snapshot to copy, or the location of an older copy in the store to recopy. */
	source: { snapshot: Snapshot } | { copy: string };
	/** Original subject expiries known from outside the snapshot (the current witnesses); none may be exceeded. */
	originalExpiries?: ReadonlyMap<string, string>;
};
export type CopyRefusal =
	| "operator_unavailable"
	| "key_unavailable"
	| "copy_unreadable"
	| "manifest_invalid"
	| "copy_expired_or_invalid"
	| "duplicate_manifest_identity"
	| "subject_expired_or_reset"
	| "database_mismatch"
	| "file_missing"
	| "file_mismatch";
export type CopyResult =
	| {
			copy_encrypted: true;
			refusal: null;
			/** Where the copy lives in the backup store: copy/<copy date>/<id>. */
			location: string;
			snapshot_date: string;
			key_version: string;
			key_recoverable_by: "restricted-backup";
			/** The earliest original subject expiry the copy carries, or null without subjects. */
			subject_expiry: string | null;
			effective_expires_at: string;
			live_recovery_proven: false;
	  }
	| { copy_encrypted: false; refusal: CopyRefusal; location: null };

class Refused extends Error {
	code: CopyRefusal;
	constructor(code: CopyRefusal) {
		super(code);
		this.code = code;
	}
}
const MANIFEST_REFUSALS = new Set([
	"copy_expired_or_invalid",
	"duplicate_manifest_identity",
	"subject_expired_or_reset",
]);
const IV = 12,
	TAG = 16;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const instant = (value: string | number) => new Date(value).toISOString().replace(/\.000Z$/, "Z");

/** iv ‖ tag ‖ AES-256-GCM ciphertext, authenticated with `aad`. */
function seal(key: Uint8Array, plain: Uint8Array, aad: string) {
	const iv = randomBytes(IV);
	const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
	const body = Buffer.concat([cipher.update(plain), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
function open(key: Uint8Array, sealed: Uint8Array | null, aad: string) {
	if (!sealed || sealed.length < IV + TAG) throw new Refused("copy_unreadable");
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, IV)).setAAD(Buffer.from(aad));
		decipher.setAuthTag(sealed.subarray(IV, IV + TAG));
		return Buffer.concat([decipher.update(sealed.subarray(IV + TAG)), decipher.final()]);
	} catch {
		throw new Refused("copy_unreadable");
	}
}
const artifactAad = (a: { id: string; sha256: string }) => `${a.id}:${a.sha256}`;

async function backupKey(path: string) {
	const key = await readPrivateBytes(path, 32).catch(() => null);
	if (!key || key.length !== 32) throw new Refused("key_unavailable");
	return key;
}

/**
 * Opens the copy at `location` with the restricted backup key in `keyFile`: unwraps its data key, decrypts the image
 * and every object, and checks each against the manifest's sha256 and size. Any other key, or any changed byte of the
 * manifest, the wrapped key or a ciphertext, refuses with copy_unreadable.
 */
export async function openEncryptedCopy(store: BackupStore, location: string, keyFile: string): Promise<Snapshot> {
	const kek = await backupKey(keyFile);
	const manifestBytes = await store.get(`${location}/manifest.json`);
	if (!manifestBytes) throw new Refused("copy_unreadable");
	const dataKey = open(kek, await store.get(`${location}/key`), sha256(manifestBytes));
	let manifest;
	try {
		manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8"));
	} catch {
		throw new Refused("copy_unreadable");
	}
	const artifact = async (a: { id: string; sha256: string; bytes: number }, key: string) => {
		const plain = open(dataKey, await store.get(key), artifactAad(a));
		if (plain.length !== a.bytes || sha256(plain) !== a.sha256) throw new Refused("copy_unreadable");
		return plain;
	};
	const image = await artifact(manifest.database, `${location}/database`);
	const objects = new Map<string, Uint8Array>();
	for (const o of manifest.objects) objects.set(o.id, await artifact(o, `${location}/objects/${o.id}`));
	return { manifest, image, objects };
}

export async function createEncryptedCopy(deps: CopyDeps, input: CopyInput): Promise<CopyResult> {
	// Authority first: a refusal here reads no key and writes nothing.
	if (!capability.safeParse(input.capability).success)
		return { copy_encrypted: false, refusal: "operator_unavailable", location: null };
	try {
		return await copy(deps, input);
	} catch (error) {
		const code = error instanceof Refused ? error.code : "manifest_invalid";
		return { copy_encrypted: false, refusal: code, location: null };
	}
}

async function copy(deps: CopyDeps, input: CopyInput): Promise<CopyResult> {
	const now = deps.clock();
	const kek = await backupKey(input.keyFile);
	const snapshot =
		"copy" in input.source
			? await openEncryptedCopy(deps.store, input.source.copy, input.keyFile)
			: input.source.snapshot;
	// A recopy carries the older copy's recorded expiries, bound by its key wrap; the caller's originals cap them.
	let checked;
	try {
		checked = validateCandidate(snapshot.manifest, now, input.originalExpiries);
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		throw new Refused(MANIFEST_REFUSALS.has(code) ? (code as CopyRefusal) : "manifest_invalid");
	}
	// A recopy keeps the copy's own artifacts and expiries; only the data key and its version are new.
	const manifest = { ...checked.manifest, keyVersion: randomUUID() };
	if (snapshot.image.length !== manifest.database.bytes || sha256(snapshot.image) !== manifest.database.sha256)
		throw new Refused("database_mismatch");
	for (const o of manifest.objects) {
		const bytes = snapshot.objects.get(o.id);
		if (!bytes) throw new Refused("file_missing");
		if (bytes.length !== o.bytes || sha256(bytes) !== o.sha256) throw new Refused("file_mismatch");
	}

	const dataKey = randomBytes(32);
	const location = `copy/${now.toISOString().slice(0, 10)}/${randomUUID()}`;
	const manifestBytes = Buffer.from(JSON.stringify(manifest));
	await deps.store.put(`${location}/database`, seal(dataKey, snapshot.image, artifactAad(manifest.database)));
	for (const o of manifest.objects)
		await deps.store.put(`${location}/objects/${o.id}`, seal(dataKey, snapshot.objects.get(o.id)!, artifactAad(o)));
	await deps.store.put(`${location}/key`, seal(kek, dataKey, sha256(manifestBytes)));
	// The manifest last: a copy without it is incomplete and never opens.
	await deps.store.put(`${location}/manifest.json`, manifestBytes);
	dataKey.fill(0);
	const subjects = manifest.subjects.map((s) => Date.parse(s.expiresAt));
	return {
		copy_encrypted: true,
		refusal: null,
		location,
		snapshot_date: manifest.createdAt.slice(0, 10),
		key_version: manifest.keyVersion,
		key_recoverable_by: "restricted-backup",
		subject_expiry: subjects.length ? instant(Math.min(...subjects)) : null,
		effective_expires_at: instant(checked.effectiveExpiresAt),
		live_recovery_proven: false,
	};
}
