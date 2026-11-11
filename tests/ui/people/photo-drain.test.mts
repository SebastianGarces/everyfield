// T-144 (people/peo-47): the person photo actions (REQ-PPL-005) schedule the object-cleanup drain only after a photo
// change saved. An anonymous call, invalid input, a refused or failed write and a refused byte upload schedule none;
// an ok upload or removal schedules it once.
//
// It calls the real uploadPhoto and removePhoto in node, with no browser and no database: node's module mocks stand in
// for the request viewer, the request database, the People write runner, the byte adapter and the drain itself.
// It runs in packages/domain's test:unit: tsx with the react-server condition and module mocks.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { beforeEach, mock, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const web = createRequire(root + "apps/web/package.json");
const at = (file: string) => pathToFileURL(root + file).href;

let drains = 0;
let viewer: unknown = null;
let writes: unknown[] = [];
let stored: unknown = { status: "ok", value: {} };

mock.module(at("apps/web/src/server/jobs/drain-object-cleanup.ts"), {
	exports: { drainObjectCleanup: () => void drains++ },
});
mock.module(at("apps/web/src/server/request-context.ts"), { exports: { getViewer: async () => viewer } });
mock.module(at("apps/web/src/server/database.ts"), { exports: { requestDatabase: () => ({}) } });
mock.module(at("apps/web/src/features/people/server.ts"), {
	exports: {
		read: async () => {
			throw new Error("no read in this test");
		},
		// Each write answers the next reply the case set up.
		write: async () => writes.shift() ?? { status: "failed" },
	},
});
const schema = web.resolve("@everyfield/db/schema");
mock.module(pathToFileURL(schema).href, {
	exports: { ...(await import(schema)), privateStorage: () => ({ bucket: "synthetic-only" }) },
});
const domainPeople = web.resolve("@everyfield/domain/people");
mock.module(pathToFileURL(domainPeople).href, {
	exports: { ...(await import(domainPeople)), uploadPersonPhoto: async () => stored },
});

const { uploadPhoto, removePhoto } = await import("../../../apps/web/src/features/people/fields/actions.ts");

const PERSON = "00000000-0000-4000-8000-000000000001";
const UPLOAD = "00000000-0000-4000-8000-000000000002";
const KEY = "00000000-0000-4000-8000-000000000003";
const admin = {
	people: { authority: { session: "s", actor: { context: { owner: { kind: "plant", id: PERSON } } } } },
};
const refused = { status: "refused", error: { code: "conflict", details: {} } };
const staged = { status: "ok", value: { uploadId: UPLOAD, expiresAt: "2026-11-11T00:00:00.000Z" } };
const saved = (photo: unknown) => ({
	status: "ok",
	value: { photo, personRevision: "2", outcome: "changed", receiptId: "00000000-0000-4000-8000-000000000004" },
});
const available = { status: "available", personId: PERSON, versionId: UPLOAD };

function form(fields: { personId?: string; file?: File } = {}) {
	const f = new FormData();
	f.set("requestKey", KEY);
	f.set("expectedRevision", "1");
	f.set("personId", fields.personId ?? PERSON);
	f.set("file", fields.file ?? new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "a.jpg", { type: "image/jpeg" }));
	return f;
}

beforeEach(() => {
	drains = 0;
	viewer = admin;
	writes = [];
	stored = { status: "ok", value: { uploadId: UPLOAD } };
});

test("peo-47 an anonymous photo upload or removal schedules no drain", async () => {
	viewer = null;
	assert.deepEqual(await uploadPhoto(form()), { status: "refused", code: "access_denied" });
	assert.deepEqual(await removePhoto(KEY, "1", PERSON), { status: "refused", code: "access_denied" });
	assert.equal(drains, 0);
});

test("peo-47 invalid photo input schedules no drain", async () => {
	const invalid = { status: "refused", code: "invalid_input" };
	assert.deepEqual(await uploadPhoto(form({ personId: "not-a-person" })), invalid);
	assert.deepEqual(await uploadPhoto(form({ file: new File(["x"], "a.gif", { type: "image/gif" }) })), invalid);
	assert.deepEqual(await removePhoto(KEY, "1", "not-a-person"), invalid);
	assert.equal(drains, 0);
});

test("peo-47 a refused or failed photo write, or refused bytes, schedules no drain", async () => {
	writes = [refused];
	assert.deepEqual(await uploadPhoto(form()), { status: "refused", code: "conflict" });
	stored = { status: "refused", error: { code: "invalid_input", details: { reason: "image" } } };
	writes = [staged];
	assert.deepEqual(await uploadPhoto(form()), { status: "refused", code: "invalid_input" });
	stored = { status: "ok", value: { uploadId: UPLOAD } };
	writes = [staged, refused];
	assert.deepEqual(await uploadPhoto(form()), { status: "refused", code: "conflict" });
	writes = [staged, { status: "failed" }];
	assert.deepEqual(await uploadPhoto(form()), { status: "lost" });
	writes = [refused];
	assert.deepEqual(await removePhoto(KEY, "1", PERSON), { status: "refused", code: "conflict" });
	assert.equal(drains, 0);
});

test("peo-47 an ok photo upload or removal schedules the drain once, after the write saved", async () => {
	writes = [staged, saved(available)];
	const uploaded = await uploadPhoto(form());
	assert.equal(uploaded.status, "ok");
	assert.equal(drains, 1);
	writes = [saved({ status: "absent" })];
	const removed = await removePhoto(KEY, "2", PERSON);
	assert.equal(removed.status, "ok");
	assert.equal(drains, 2);
});
