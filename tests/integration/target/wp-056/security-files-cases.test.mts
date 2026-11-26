import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { after } from "node:test";
import { createDeflateRaw, crc32 } from "node:zlib";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import {
	putPrivateObject,
	readAuthorizedObject,
	S3Client,
	toUploadKey,
	type ResourceAuthorizer,
} from "../../../../packages/db/src/schema/storage.ts";
import { StorageError } from "../../../../packages/db/src/schema/storage-error.ts";
import type { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { plantViewer } from "../../../../packages/domain/src/documents/access.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { gateSql, MEDIA, plantScope, rowsOf, storeBytes } from "../../../../packages/domain/src/documents/scope.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { PeopleReadContext } from "../../../../packages/domain/src/people/core.ts";
import {
	getCommitmentDownload,
	peopleCsv,
	peopleWriter,
	saveCommitmentDocument,
	signCommitmentDocument,
	signPeopleImport,
} from "../../../../packages/domain/src/people/index.ts";
import { readSheet, SheetRefused } from "../../../../packages/domain/src/people/csv/sheet.ts";
import { fakeBucket } from "../../../support/fake-bucket.mts";
import { fixture, ok, refused, type Actor } from "../../../support/fixture.mts";
import { frozenClock } from "../../../support/test-database.mts";
import { pdfPages } from "../../documents/fixtures/readers.mts";
import { authorityOf, church } from "../../people/people-support.mts";

type Upload = {
	mime?: string;
	claimed_mime?: string;
	owner?: string;
	expires_at?: string;
	bytes_base64?: string;
	utf8?: string;
	client_key?: string;
	repeat_bytes?: { utf8: string; count: number };
	archive_entries?: { name: string; count: number }[];
};
type Given = {
	upload?: Upload;
	cell?: { value: string };
	url?: { issued_at: string; expires_at: string };
	P?: { lifecycle?: string };
	Q?: { timezone?: string };
	D?: { owner?: string };
	"seat-A"?: { active?: boolean };
};
type Sub = {
	name: string;
	given: Given;
	clock: { now: string };
	action: { operation: string; arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
};
type Case = Sub & { id: string; subcases: Sub[] };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "SEC-08") ?? assert.fail("no case SEC-08");
const sub = (name: string) => c.subcases.find((s) => s.name === name) ?? assert.fail(`no subcase ${name}`);
const bytesOf = (upload: Upload | undefined) =>
	Buffer.from(upload?.bytes_base64 ?? assert.fail("the case gives no bytes"), "base64");

const ExcelJS: {
	Workbook: new () => {
		xlsx: { load(bytes: Buffer): Promise<unknown> };
		worksheets: { getSheetValues(): unknown[][] }[];
	};
} = createRequire(import.meta.url)("../../../../packages/domain/node_modules/exceljs/excel.js");

delete process.env.NODE_OPTIONS;

const database = await fixture({ prefix: "secfiles", clock: new Date(c.clock.now) });
const db = database.pools.runtime;
const P = database.tenant;
const A = database.actors.admin;
const Q = await database.plant({ name: "Grace Hill", timezone: "America/New_York" });
const B = await database.actor(Q, "admin", { email: "casey@example.test" });
await database.admin.execute(sql`UPDATE seat SET accepted_at=accepted_at-interval '1 hour'`);
const fake = await fakeBucket("synthetic-only");
fake.settings.now = new Date(c.clock.now);
const storage = {
	bucket: "synthetic-only",
	client: new S3Client({
		endpoint: fake.endpoint,
		region: "us-east-1",
		forcePathStyle: true,
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	}),
};
after(async () => {
	await fake.close();
	await database.close();
});

const one = async (query: SQL) => (await database.admin.execute(query)).rows[0] ?? assert.fail("no row");
const files = async () => {
	const found = await one(
		sql`SELECT count(*) FILTER (WHERE state='ready')::int AS ready, count(*)::int AS rows FROM file_object`,
	);
	return { ready: Number(found.ready), rows: Number(found.rows) };
};
const ctxOf = (who: Actor, plant = who.selected) => ({ session: who.session, selected: church(plant.id) });
let clock: ((at: number) => void) | null = null;
const at = <T,>(instant: string, body: () => Promise<T>) => {
	clock?.(Date.parse(instant));
	return frozenClock(database.admin, database.schema, instant, body).finally(() => clock?.(Date.parse(c.clock.now)));
};
const actorOf = (who: Actor) => gatedTransaction(db, (t) => authorityOf(t, who));
const today = c.clock.now.slice(0, 10);
const denied = (reply: { status: string; value?: unknown }, code = "unavailable") => {
	const error = refused(reply, code);
	assert.equal("value" in reply, false);
	return error;
};

async function person(who: Actor, name: string) {
	return ok(
		await gatedTransaction(db, (t) =>
			peopleWriter.createPerson(t, ctxOf(who), {
				requestKey: randomUUID(),
				input: { displayName: name, stage: "prospect", adultClassification: "adult" },
			}),
		),
	).person;
}
const sign = (who: Actor, personId: string, bytes: Uint8Array, mime: string) =>
	signCommitmentDocument(db, storage, ctxOf(who), who.id, { personId, mime, byteLength: bytes.length });
async function put(signed: { url: string; headers: Record<string, string> }, bytes: Uint8Array) {
	const response = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: Buffer.from(bytes) });
	assert.equal(response.status, 200, await response.text());
}
const save = async (who: Actor, personId: string, uploadId: string) =>
	saveCommitmentDocument(db, storage, await actorOf(who), {
		requestKey: randomUUID(),
		input: { personId, kind: "core_group", occurredOn: today, documentUploadId: uploadId },
	});
async function attached(who: Actor, bytes: Uint8Array, mime: string) {
	const someone = await person(who, `Signer ${randomUUID().slice(0, 8)}`);
	const signed = ok(await sign(who, someone.id, bytes, mime));
	await put(signed, bytes);
	const saved = ok(await save(who, someone.id, signed.uploadId));
	return { person: someone, uploadId: signed.uploadId, commitmentId: saved.commitment.id };
}
const download = (who: Actor, commitmentId: string, plant = who.selected) =>
	getCommitmentDownload(db, storage, ctxOf(who, plant), { commitmentId });
async function fetched(url: string) {
	const response = await fetch(url);
	return {
		status: response.status,
		type: response.headers.get("content-type"),
		bytes: Buffer.from(await response.arrayBuffer()),
	};
}
const stateOf = async (id: string) => (await one(sql`SELECT state FROM file_object WHERE id=${id}`)).state;

async function expandingWord(name: string, count: number, declared: number) {
	const deflate = createDeflateRaw({ level: 1 });
	const parts: Buffer[] = [];
	deflate.on("data", (part: Buffer) => parts.push(part));
	const block = Buffer.alloc(1 << 20, "x");
	let crc = 0;
	for (let left = count; left > 0; left -= block.length) {
		const piece = left >= block.length ? block : block.subarray(0, left);
		crc = crc32(piece, crc);
		if (!deflate.write(piece)) await once(deflate, "drain");
	}
	deflate.end();
	await once(deflate, "end");
	const data = Buffer.concat(parts);
	const file = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc >>> 0, 14);
	local.writeUInt32LE(data.length, 18);
	local.writeUInt32LE(declared, 22);
	local.writeUInt16LE(file.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 4);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc >>> 0, 16);
	central.writeUInt32LE(data.length, 20);
	central.writeUInt32LE(declared, 24);
	central.writeUInt16LE(file.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + file.length, 12);
	end.writeUInt32LE(local.length + file.length + data.length, 16);
	return Buffer.concat([local, file, data, central, file, end]);
}

const importWord = async (who: RequestActor, bytes: Uint8Array, requestKey: string = randomUUID()) =>
	documentsWriter.importTextOrWord(
		db,
		who,
		{ title: "Welcome", format: "docx", bytes, expectedRevision: "0", requestKey },
		storage,
	);
const scopeOf = (who: RequestActor) => plantScope(plantViewer(who) ?? assert.fail("no plant viewer"));
const reader = (who: RequestActor): ResourceAuthorizer => {
	const scope = scopeOf(who);
	return async (tx, file, intent) => {
		if (intent !== "read" || file.tenant_id !== scope.tenantId) return null;
		const [found] = await rowsOf<{ ok: boolean }>(tx, sql`SELECT ${gateSql(scope, true)} AS ok`);
		return found?.ok === true ? { kind: "account", actorId: scope.accountId } : null;
	};
};
const neverAsked: ResourceAuthorizer = async () => assert.fail("the authorizer ran for a refused key");

test("AC:SEC-08 private uploads and downloads read real PDF, DOCX and XLSX bytes and refuse spoofed, traversing, foreign, expired, suspended, revoked, oversize and expanding files", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.parse(c.clock.now) });
	clock = (instant) => t.mock.timers.setTime(instant);
	await t.test("a real PDF is checked, stored privately and read back by its own signed link", async () => {
		const { result } = c.expected;
		assert.equal(c.action.arguments.format, result.format);
		const bytes = bytesOf(c.given.upload);
		const made = await attached(A, bytes, String(c.given.upload?.mime ?? assert.fail("no mime")));
		assert.equal(await stateOf(made.uploadId), "ready");
		const link = ok(await download(A, made.commitmentId));
		const read = await fetched(link.url);
		assert.equal(read.status, 200);
		assert.deepEqual(read.bytes, bytes);
		assert.deepEqual([read.type, read.bytes.subarray(0, 5).toString()], [MEDIA[result.format as "pdf"], "%PDF-"]);
		assert.deepEqual(await pdfPages(read.bytes), [result.decoded_text]);
		assert.equal(result.readable, true);
	});

	await t.test(
		"valid-docx: the Word import reads the real DOCX into inert text and keeps the exact bytes",
		async () => {
			const s = sub("valid-docx");
			const bytes = bytesOf(s.given.upload);
			assert.equal(s.given.upload?.mime, MEDIA.docx);
			const before = fake.objects.size;
			const imported = ok(await importWord(await actorOf(A), bytes));
			assert.deepEqual(imported.body, nativeFromText(String(s.expected.result.decoded_text)));
			assert.deepEqual(
				[s.action.arguments.format, s.expected.result.format, s.expected.result.readable],
				["docx", "docx", true],
			);
			assert.equal(fake.objects.size, before + 1);
			const stored = [...fake.objects.values()].at(-1) ?? assert.fail("nothing stored");
			assert.deepEqual([stored.bytes, stored.type], [bytes, MEDIA.docx]);
		},
	);

	await t.test(
		"valid-xlsx: the real XLSX bytes are kept exact by an authorized private read and decode to the cell text",
		async () => {
			const s = sub("valid-xlsx");
			const bytes = bytesOf(s.given.upload);
			assert.equal(s.given.upload?.mime, MEDIA.xlsx);
			const who = await actorOf(A);
			const stored = await storeBytes(
				db,
				storage,
				scopeOf(who),
				"native_import",
				MEDIA.xlsx,
				bytes,
				`sec08:${P.id}:xlsx`,
			);
			const read = Buffer.from(await readAuthorizedObject(db, storage, reader(who), stored.id));
			assert.deepEqual(read, bytes);
			const book = new ExcelJS.Workbook();
			await book.xlsx.load(read);
			const cells = book.worksheets.flatMap((sheet) =>
				sheet
					.getSheetValues()
					.flat()
					.filter((value) => typeof value === "string"),
			);
			assert.deepEqual(cells, [s.expected.result.decoded_text]);
			assert.deepEqual(
				[s.action.arguments.format, s.expected.result.format, s.expected.result.readable],
				["xlsx", "xlsx", true],
			);
			await assert.rejects(
				readSheet(read, "welcome.xlsx", { bytes: 5 * 1024 * 1024, rows: 10, columns: 10 }),
				(error) => {
					assert.ok(error instanceof SheetRefused);
					assert.equal(error.problem, "no_rows");
					return true;
				},
			);
			await database.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}`);
			await assert.rejects(readAuthorizedObject(db, storage, reader(who), stored.id), { code: "unavailable" });
			await database.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${A.id}`);
		},
	);

	await t.test("mime-spoof: script text claimed as a PDF is never attached or stored ready", async () => {
		const s = sub("mime-spoof");
		const bytes = Buffer.from(s.given.upload?.utf8 ?? assert.fail("no text"));
		const mime = s.given.upload?.claimed_mime ?? assert.fail("no claim");
		const someone = await person(A, "Spoof Target");
		const signed = ok(await sign(A, someone.id, bytes, mime));
		await put(signed, bytes);
		const before = await files();
		const reply = await save(A, someone.id, signed.uploadId);
		assert.deepEqual(denied(reply, "invalid_input").details, { reason: "unreadable_document" });
		assert.equal(JSON.stringify(reply).includes("alert"), false);
		assert.deepEqual(
			[await stateOf(signed.uploadId), (await files()).ready - before.ready],
			["pending", s.expected.result.new_files],
		);
		const objects = fake.objects.size;
		await assert.rejects(
			putPrivateObject(db, storage, neverAsked, {
				tenantId: P.id,
				purpose: "commitment",
				mediaType: mime,
				bytes,
				uploadKey: toUploadKey(`sec08:${P.id}:spoof`),
			}),
			(error) => error instanceof StorageError && error.code === "invalid_file",
		);
		assert.deepEqual([fake.objects.size, (await files()).rows], [objects, before.rows]);
	});

	await t.test("path-traversal: a caller's key never names the stored object", async () => {
		const s = sub("path-traversal");
		const key = s.given.upload?.client_key ?? assert.fail("no key");
		const before = await files();
		const objects = fake.objects.size;
		await assert.rejects(
			putPrivateObject(db, storage, neverAsked, {
				tenantId: P.id,
				purpose: "native_import",
				mediaType: MEDIA.pdf,
				bytes: bytesOf(c.given.upload),
				uploadKey: toUploadKey(key),
			}),
			(error) => error instanceof StorageError && error.code === "invalid_upload_key",
		);
		denied(await importWord(await actorOf(A), bytesOf(sub("valid-docx").given.upload), key));
		const someone = await person(A, "Key Chooser");
		const keyed = await signCommitmentDocument(db, storage, ctxOf(A), A.id, {
			personId: someone.id,
			mime: MEDIA.pdf,
			byteLength: 100,
			key,
		});
		denied(keyed, "invalid_input");
		assert.deepEqual([(await files()).rows - before.rows, fake.objects.size - objects], [0, 0]);
		assert.equal(
			[...fake.objects.keys()].some((k) => k.includes("..") || k.includes("other")),
			false,
		);
		assert.equal(s.expected.result.new_files, 0);
	});

	await t.test("cross-owner-finalize: another account's upload intent cannot be finalized here", async () => {
		const s = sub("cross-owner-finalize");
		assert.equal(s.given.upload?.owner, "B");
		const bytes = bytesOf(c.given.upload);
		const theirs = await person(B, "Grace Signer");
		const signed = ok(await sign(B, theirs.id, bytes, MEDIA.pdf));
		await put(signed, bytes);
		const ours = await person(A, "Harvest Signer");
		const before = await files();
		denied(await save(A, ours.id, signed.uploadId));
		denied(await save(A, theirs.id, signed.uploadId));
		denied(await sign(A, theirs.id, bytes, MEDIA.pdf));
		assert.deepEqual(
			[await stateOf(signed.uploadId), (await files()).ready - before.ready],
			["pending", s.expected.result.new_files],
		);
		assert.equal((await one(sql`SELECT count(*)::int AS n FROM commitment WHERE object_id=${signed.uploadId}`)).n, 0);
	});

	await t.test("foreign-download: another church's file opens no link", async () => {
		const s = sub("foreign-download");
		assert.deepEqual([s.given.D?.owner, s.given.Q?.timezone], ["Q", "America/New_York"]);
		const theirs = await attached(B, bytesOf(c.given.upload), MEDIA.pdf);
		ok(await download(B, theirs.commitmentId));
		denied(await download(A, theirs.commitmentId));
		denied(await download(A, theirs.commitmentId, Q));
		await assert.rejects(readAuthorizedObject(db, storage, reader(await actorOf(A)), theirs.uploadId), {
			code: "unavailable",
		});
	});

	const ours = await attached(A, bytesOf(c.given.upload), MEDIA.pdf);

	await t.test("expired-handle: an upload intent past its expiry finalizes nothing", async () => {
		const s = sub("expired-handle");
		const expires = Date.parse(s.given.upload?.expires_at ?? assert.fail("no expiry"));
		const bytes = bytesOf(c.given.upload);
		const someone = await person(A, "Late Signer");
		const intent = async (expiresAt: number) => {
			const signedAt = new Date(expiresAt - 15 * 60_000);
			const signed = ok(await at(signedAt.toISOString(), () => sign(A, someone.id, bytes, MEDIA.pdf)));
			fake.settings.now = signedAt;
			await put(signed, bytes).finally(() => (fake.settings.now = new Date(c.clock.now)));
			const { ms } = await one(
				sql`SELECT (extract(epoch FROM expires_at)*1000)::bigint::text AS ms FROM file_object WHERE id=${signed.uploadId}`,
			);
			assert.equal(Number(ms), expiresAt);
			return signed.uploadId;
		};
		const late = await intent(expires);
		const before = await files();
		denied(await at(s.clock.now, () => save(A, someone.id, late)));
		assert.deepEqual(
			[await stateOf(late), (await files()).ready - before.ready],
			["pending", s.expected.result.new_files],
		);
		const onTime = await intent(Date.parse(s.clock.now) + 1000);
		ok(await at(s.clock.now, () => save(A, someone.id, onTime)));
	});

	await t.test("deleted-subject: a church pending deletion opens and accepts no file", async () => {
		const s = sub("deleted-subject");
		assert.equal(s.given.P?.lifecycle, "pending_deletion");
		const witness = randomUUID();
		const who = await actorOf(A);
		await database.admin
			.execute(sql`INSERT INTO lifecycle_witness(id,kind,opaque_subject_id,plant_id,request_id,request_revision,state,
			requested_at,cancel_until,witness_checkpoint,cleanup_state)
			SELECT ${witness},'plant',${P.id},${P.id},${randomUUID()},1,'pending_deletion',x.t,x.t+interval '720 hours',1,'not_started'
			FROM (SELECT clock_timestamp() AS t) x`);
		try {
			const before = await files();
			denied(await download(A, ours.commitmentId));
			denied(await sign(A, ours.person.id, bytesOf(c.given.upload), MEDIA.pdf));
			await assert.rejects(gatedTransaction(db, (t) => authorityOf(t, A)));
			await assert.rejects(readAuthorizedObject(db, storage, reader(who), ours.uploadId), { code: "unavailable" });
			denied(await importWord(who, bytesOf(sub("valid-docx").given.upload)));
			assert.deepEqual([(await files()).rows, (await files()).ready], [before.rows, before.ready]);
			assert.equal(s.expected.result.new_files, 0);
		} finally {
			await database.admin.execute(
				sql`UPDATE lifecycle_witness SET state='cancelled',cancelled_at=clock_timestamp() WHERE id=${witness}`,
			);
		}
		ok(await download(A, ours.commitmentId));
	});

	await t.test("revoked-grant: an ended seat reads nothing", async () => {
		const s = sub("revoked-grant");
		assert.equal(s.given["seat-A"]?.active, false);
		const who = await actorOf(A);
		await database.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}`);
		try {
			denied(await download(A, ours.commitmentId));
			await assert.rejects(readAuthorizedObject(db, storage, reader(who), ours.uploadId), { code: "unavailable" });
			denied(await importWord(who, bytesOf(sub("valid-docx").given.upload)));
		} finally {
			await database.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${A.id}`);
		}
		assert.equal(s.expected.result.new_files, 0);
	});

	await t.test("oversize: one byte over 10 MiB is refused before any file is kept", async () => {
		const s = sub("oversize");
		const repeat = s.given.upload?.repeat_bytes ?? assert.fail("no repeat");
		const bytes = Buffer.alloc(repeat.count, repeat.utf8);
		assert.equal(bytes.length, 10 * 1024 * 1024 + 1);
		const before = await files();
		const objects = fake.objects.size;
		const ctx = new PeopleReadContext(await actorOf(A));
		denied(
			await gatedTransaction(db, (tx) => peopleCsv.previewImport(tx, ctx, { file: bytes })),
			String(s.expected.result.error_code),
		);
		denied(
			await signPeopleImport(db, storage, await actorOf(A), { byteLength: bytes.length }),
			String(s.expected.result.error_code),
		);
		denied(await sign(A, ours.person.id, bytes, MEDIA.pdf), "invalid_input");
		denied(await importWord(await actorOf(A), bytes), "invalid_input");
		await assert.rejects(
			putPrivateObject(db, storage, neverAsked, {
				tenantId: P.id,
				purpose: "native_import",
				mediaType: "text/csv",
				bytes,
				uploadKey: toUploadKey(`sec08:${P.id}:oversize`),
			}),
			(error) => error instanceof StorageError && error.code === "invalid_file",
		);
		assert.deepEqual(
			[(await files()).rows - before.rows, fake.objects.size - objects],
			[s.expected.result.new_files, 0],
		);
	});

	await t.test("office-expansion: a Word part that expands to 1 GiB is refused without expanding it", async () => {
		const s = sub("office-expansion");
		const entry = s.given.upload?.archive_entries?.[0] ?? assert.fail("no entry");
		const honest = await expandingWord(entry.name, entry.count, entry.count);
		assert.ok(honest.length < 10 * 1024 * 1024, String(honest.length));
		const before = await files();
		const refusedImport = denied(await importWord(await actorOf(A), honest), "invalid_input");
		assert.deepEqual(refusedImport.details, {
			issues: [{ path: "bytes", problem: "The Word file expands past 40 MiB." }],
		});
		const lying = await expandingWord(entry.name, entry.count, 1024);
		denied(await importWord(await actorOf(A), lying), "invalid_input");
		assert.equal((await files()).rows - before.rows, s.expected.result.new_files);
	});

	await t.test("spreadsheet-formula-text: an exported cell that starts a formula is neutralized text", async () => {
		const s = sub("spreadsheet-formula-text");
		const value = s.given.cell?.value ?? assert.fail("no cell");
		assert.deepEqual(s.action.arguments.cells, [value]);
		const named = await person(A, value);
		await database.admin.execute(sql`UPDATE person SET notes=${value} WHERE id=${named.id}`);
		const ctx = new PeopleReadContext(await actorOf(A));
		const exported = ok(await gatedTransaction(db, (tx) => peopleCsv.exportPeople(tx, ctx, {})));
		const line = exported.text.split("\r\n").find((row) => row.includes(value)) ?? assert.fail("no row");
		const cells = line.split(",");
		assert.equal(cells[0], s.expected.result.cell_utf8);
		assert.equal(cells[12], s.expected.result.cell_utf8);
		assert.equal(
			cells.some((cell) => /^[=+\-@\t\r]/.test(cell)),
			s.expected.result.formula_executed,
		);
	});

	await t.test(
		"issued-url-bounded-expiry: an ended seat gets no new link, and the old one ends at its own expiry",
		async () => {
			const s = sub("issued-url-bounded-expiry");
			const url = s.given.url ?? assert.fail("no url");
			const link = ok(await at(url.issued_at, () => download(A, ours.commitmentId)));
			assert.equal(Date.parse(link.expiresAt), Date.parse(url.expires_at));
			const later = String(s.action.arguments.now);
			await at(later, () =>
				database.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id}`),
			);
			try {
				const again = await at(later, () => download(A, ours.commitmentId));
				denied(again);
				assert.equal("value" in again ? again.value : null, s.expected.result.new_url);
				const until = Date.parse(String(s.expected.result.old_url_may_work_until));
				for (const [when, status] of [
					[Date.parse(later), 200],
					[until, 200],
					[until + 1000, 403],
				] as const) {
					fake.settings.now = new Date(when);
					assert.equal((await fetched(link.url)).status, status, new Date(when).toISOString());
				}
			} finally {
				fake.settings.now = new Date(c.clock.now);
				await database.admin.execute(sql`UPDATE seat SET ended_at=NULL WHERE account_id=${A.id}`);
			}
		},
	);
});
