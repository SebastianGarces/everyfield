import "../../../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSecretKey, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "../../../../../packages/contracts/node_modules/typescript/lib/typescript.js";
import { sql } from "../../../../../packages/db/src/query.ts";
import { S3Client } from "../../../../../packages/db/src/schema/storage.ts";
import { RequestActor } from "../../../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../../../packages/domain/src/documents/index.ts";
import { BackupDirectory, createEncryptedCopy, openEncryptedCopy } from "../../../../../ops/maintenance/copy.mts";
import { manifestSchema, validateCandidate } from "../../../../../ops/maintenance/recovery.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { type Actor, type Workspace, ok, refused, seeds } from "../../../../support/fixture.mts";
import { freezeClock, operator, readyFile, snapshot, type Store } from "./support.mts";

const NOW = new Date("2026-10-13T16:00:00.000Z");
const RECOPY = new Date("2026-10-19T16:00:00.000Z");
const SUBJECT_EXPIRY = "2026-10-20T16:00:00Z";
const DAY = 86_400_000;
const DOCUMENT = Buffer.from("%PDF-1.7 launch plan D for Harvest Point");

const backupOperator = {
	authority: "authorized_restricted_backup_operator",
	verified: true,
	operation_ids: ["maintenance.createEncryptedCopy"],
	environment: "isolated-test",
} as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const database = await testDatabase({ prefix: "wp092cpy", clock: NOW });
const { admin, schema } = database;
const db = database.pools.runtime;
const seed = seeds(admin);
const live: Store = new Map();

class MemoryClient extends S3Client {
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	override async send(command: { input: { Key?: string } }) {
		if (command.constructor.name !== "GetObjectCommand") throw new Error(`unexpected ${command.constructor.name}`);
		const body = live.get(String(command.input.Key))!;
		return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
	}
}
const storage = { bucket: "synthetic-only", client: new MemoryClient() };

let root: string, store: BackupDirectory;
const stored = (key: string) => readFileSync(join(root, key));
const restore = (key: string, bytes: Buffer) => writeFileSync(join(root, key), bytes);
const keys = () =>
	readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name).slice(root.length + 1));
const writes = () => keys().length;

const kek = randomBytes(32);
const key = createSecretKey(kek);
const otherKey = createSecretKey(randomBytes(32));
let dir: string;
let plant: Workspace, a: Actor, actor: RequestActor, documentId: string, subject: string;
let plain: Awaited<ReturnType<typeof snapshot>>;

before(async () => {
	mock.timers.enable({ apis: ["Date"], now: NOW.getTime() });
	await freezeClock(admin, schema, NOW);
	dir = await mkdtemp(join(tmpdir(), "wp092-copy-"));
	root = join(dir, "backup");
	await mkdir(root, { mode: 0o700 });
	store = new BackupDirectory(root);

	plant = await seed.plant({ name: "Harvest Point" });
	a = await seed.actor(plant, "admin");
	const resolved = await RequestActor.resolve(db, a.session);
	assert.ok(resolved instanceof RequestActor);
	actor = resolved;
	subject = (await seed.actor(plant, "member")).id;
	const file = await readyFile(admin, live, plant.id, DOCUMENT);
	const { rows } = await admin.execute<{ id: string }>(sql`INSERT INTO generated_document (tenant_id, template_id,
		template_version, saved_template_name, renderer_version, format, object_id, inputs, download_name, generated_at)
		VALUES (${plant.id}::uuid, 'vision-meeting-agenda', ${"ef".repeat(32)}, 'Vision Meeting Agenda', 'synthetic', 'pdf',
		${file.id}::uuid, '[]'::jsonb, 'agenda.pdf', clock_timestamp()) RETURNING id`);
	documentId = rows[0]!.id;
	plain = await snapshot(admin, live, { createdAt: NOW, subjects: [{ id: subject, expiresAt: SUBJECT_EXPIRY }] });
});
after(async () => {
	mock.timers.reset();
	await rm(dir, { recursive: true, force: true });
	await database.close();
});

const copyAt = (at: Date, input: Record<string, unknown>) =>
	createEncryptedCopy({ store, clock: () => at }, { capability: backupOperator, key, ...input } as never);

test("only the backup directory type-checks as the copy store; a plain get/put store such as the app's object store does not", async () => {
	const copy = fileURLToPath(new URL("../../../../../ops/maintenance/copy.mts", import.meta.url));
	const fixture = join(dir, "stores.mts");
	const lines = [
		'import { createSecretKey } from "node:crypto";',
		`import { BackupDirectory, createEncryptedCopy, openEncryptedCopy } from ${JSON.stringify(copy)};`,
		"const objects = new Map<string, Uint8Array>();",
		"const app = { put: async (key: string, bytes: Uint8Array) => void objects.set(key, bytes), get: async (key: string) => objects.get(key) ?? null };",
		'const backup = new BackupDirectory("/private/backup");',
		'const input = { capability: null, key: createSecretKey(new Uint8Array(32)), source: { copy: "copy/x" } };',
		'export const backupOpen = openEncryptedCopy(backup, "copy/x", input.key);',
		'export const appOpen = openEncryptedCopy(app, "copy/x", input.key);',
		"export const backupCopy = createEncryptedCopy({ store: backup, clock: () => new Date() }, input);",
		"export const appCopy = createEncryptedCopy({ store: app, clock: () => new Date() }, input);",
	];
	await writeFile(fixture, lines.join("\n"));
	const program = ts.createProgram([fixture], {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		allowImportingTsExtensions: true,
		module: ts.ModuleKind.NodeNext,
		moduleResolution: ts.ModuleResolutionKind.NodeNext,
		target: ts.ScriptTarget.ES2022,
		types: ["node"],
		typeRoots: [fileURLToPath(new URL("../../../../../packages/db/node_modules/@types", import.meta.url))],
	});
	const errors = program
		.getSemanticDiagnostics(program.getSourceFile(fixture))
		.map((d) => lines[d.file!.getLineAndCharacterOfPosition(d.start!).line]!.split(" = ")[0]);
	assert.deepEqual(errors, ["export const appOpen", "export const appCopy"]);
});

test("only a verified restricted-backup capability for the copy operation gets past the first check", async (step) => {
	const cases: [string, unknown][] = [
		["a missing capability", undefined],
		["an unverified capability", { ...backupOperator, verified: false }],
		[
			"another operation's capability",
			{ ...backupOperator, operation_ids: ["maintenance.restoreWithCurrentManifest"] },
		],
		["the restricted recovery capability", operator],
		["the shared development environment", { ...backupOperator, environment: "development" }],
		["A's Admin session", { account: a.id, session: a.session, context: plant.id, role: "Admin" }],
	];
	for (const [name, capability] of cases)
		await step.test(`${name}: refused before anything is written`, async () => {
			const before = writes();
			const result = await createEncryptedCopy(
				{ store, clock: () => NOW },
				{ capability, key, source: { snapshot: plain } },
			);
			assert.deepEqual(result, { copy_encrypted: false, refusal: "operator_unavailable", location: null });
			assert.equal(writes(), before);
		});
});

test("AC:BKT60-002 a dated encrypted DB-plus-bytes copy whose key only the restricted backup key recovers, keeping the original subject expiry through a recopy", async (step) => {
	const result = await copyAt(NOW, { source: { snapshot: plain } });
	assert.equal(result.copy_encrypted, true, JSON.stringify(result));
	if (!result.copy_encrypted) return;
	const { location } = result;

	await step.test("the copy is dated, encrypted, checksummed and carries the original subject expiry", async () => {
		assert.deepEqual(
			{
				copy_encrypted: result.copy_encrypted,
				subject_expiry: result.subject_expiry,
				key_recoverable_by: result.key_recoverable_by,
			},
			{ copy_encrypted: true, subject_expiry: "2026-10-20T16:00:00Z", key_recoverable_by: "restricted-backup" },
		);
		assert.equal(result.snapshot_date, "2026-10-13");
		assert.match(location, /^copy\/2026-10-13\//);
		const manifest = JSON.parse(stored(`${location}/manifest.json`).toString("utf8"));
		const checked = validateCandidate(manifest, NOW);
		assert.equal(checked.manifest.createdAt.slice(0, 10), "2026-10-13");
		assert.deepEqual(checked.manifest.subjects, [{ id: subject, expiresAt: SUBJECT_EXPIRY }]);
		assert.equal(checked.manifest.keyVersion, result.key_version);
		assert.deepEqual(checked.manifest.database, { ...plain.manifest.database });
		assert.deepEqual(
			checked.manifest.objects.map((o) => ({ id: o.id, sha256: o.sha256, bytes: o.bytes })),
			[{ id: plain.manifest.objects[0]!.id, sha256: sha256(DOCUMENT), bytes: DOCUMENT.length }],
		);
		assert.equal(checked.manifest.database.sha256, sha256(plain.image));
		const copied = keys()
			.filter((key) => key.startsWith(location))
			.map((key) => [key, stored(key)] as const);
		assert.deepEqual(copied.map(([key]) => key.slice(location.length + 1)).sort(), [
			"database",
			"key",
			"manifest.json",
			`objects/${plain.manifest.objects[0]!.id}`,
		]);
		for (const [key, bytes] of copied) {
			if (key.endsWith("manifest.json")) continue;
			assert.equal(bytes.indexOf(plain.image.subarray(0, 32)), -1, key);
			assert.equal(bytes.indexOf(Buffer.from("launch plan D")), -1, key);
			assert.equal(bytes.indexOf(Buffer.from("Harvest Point")), -1, key);
			assert.equal(bytes.indexOf(kek), -1, key);
		}
		assert.doesNotMatch(stored(`${location}/manifest.json`).toString("utf8"), /Harvest Point|launch plan/);
	});

	await step.test(
		"the restricted backup key recovers the image and bytes matching the recorded checksums",
		async () => {
			const opened = await openEncryptedCopy(store, location, key);
			assert.deepEqual(opened.image, plain.image);
			assert.equal(sha256(opened.image), plain.manifest.database.sha256);
			const id = plain.manifest.objects[0]!.id;
			assert.deepEqual(Buffer.from(opened.objects.get(id)!), DOCUMENT);
			assert.equal(sha256(opened.objects.get(id)!), sha256(DOCUMENT));
		},
	);

	await step.test("another key, a changed ciphertext and a changed checksum are each refused", async () => {
		await assert.rejects(openEncryptedCopy(store, location, otherKey), { message: "copy_unreadable" });
		const tamper = async (at: string, change: (bytes: Buffer) => Buffer) => {
			const original = stored(at);
			restore(at, change(Buffer.from(original)));
			try {
				await assert.rejects(openEncryptedCopy(store, location, key), { message: "copy_unreadable" }, at);
				const before = writes();
				const recopy = await copyAt(RECOPY, { source: { copy: location } });
				assert.deepEqual(recopy, { copy_encrypted: false, refusal: "copy_unreadable", location: null });
				assert.equal(writes(), before);
			} finally {
				restore(at, original);
			}
		};
		const flip = (b: Buffer) => {
			b[b.length - 1]! ^= 1;
			return b;
		};
		await tamper(`${location}/database`, flip);
		await tamper(`${location}/objects/${plain.manifest.objects[0]!.id}`, flip);
		await tamper(`${location}/key`, flip);
		await tamper(`${location}/manifest.json`, (b) =>
			Buffer.from(b.toString("utf8").replace(plain.manifest.database.sha256, "a".repeat(64))),
		);
	});

	await step.test(
		"the recopy on 2026-10-19 keeps the 2026-10-20 subject expiry, never the recopy date plus seven days",
		async () => {
			const recopy = await copyAt(RECOPY, { source: { copy: location } });
			assert.equal(recopy.copy_encrypted, true, JSON.stringify(recopy));
			if (!recopy.copy_encrypted) return;
			assert.match(recopy.location, /^copy\/2026-10-19\//);
			assert.equal(recopy.subject_expiry, "2026-10-20T16:00:00Z");
			assert.equal(recopy.effective_expires_at, "2026-10-20T16:00:00Z");
			assert.notEqual(recopy.effective_expires_at, new Date(RECOPY.getTime() + 7 * DAY).toISOString());
			assert.notEqual(recopy.key_version, result.key_version);
			const manifest = JSON.parse(stored(`${recopy.location}/manifest.json`).toString("utf8"));
			const checked = validateCandidate(manifest, RECOPY);
			assert.deepEqual(checked.manifest.subjects, [{ id: subject, expiresAt: SUBJECT_EXPIRY }]);
			assert.equal(checked.effectiveExpiresAt, "2026-10-20T16:00:00.000Z");
			const opened = await openEncryptedCopy(store, recopy.location, key);
			assert.deepEqual(opened.image, plain.image);
		},
	);

	await step.test("a recopy that carries a later subject expiry is refused", async () => {
		const opened = await openEncryptedCopy(store, location, key);
		const old = manifestSchema.parse(opened.manifest);
		const later = new Date(RECOPY.getTime() + 7 * DAY).toISOString();
		const redated = {
			...opened,
			manifest: {
				...old,
				createdAt: RECOPY.toISOString(),
				expiresAt: later,
				subjects: [{ id: subject, expiresAt: later }],
			},
		};
		const before = writes();
		const refusedCopy = await copyAt(RECOPY, {
			source: { snapshot: redated },
			originalExpiries: new Map(old.subjects.map((s) => [s.id, s.expiresAt] as const)),
		});
		assert.deepEqual(refusedCopy, { copy_encrypted: false, refusal: "subject_expired_or_reset", location: null });
		assert.equal(writes(), before);
	});

	await step.test("A's ordinary app path reaches neither the copy nor its key", async () => {
		mock.timers.setTime(NOW.getTime());
		ok(await documentsWriter.download(db, actor, { documentId }, storage));
		for (const id of [plain.manifest.database.id, location.split("/")[2]!, result.key_version])
			refused(await documentsWriter.download(db, actor, { documentId: id }, storage));
		for (const bytes of live.values()) assert.equal(Buffer.from(bytes).indexOf(stored(`${location}/key`)), -1);
		const env = Object.values(process.env).join("\n");
		for (const form of [kek.toString("hex"), kek.toString("base64"), kek.toString("base64url")])
			assert.equal(env.includes(form), false);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(kek.toString("hex")));
		assert.equal(JSON.stringify(result).includes(kek.toString("base64")), false);
	});
});
