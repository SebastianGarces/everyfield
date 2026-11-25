import { AsyncResource } from "node:async_hooks";
import assert from "node:assert/strict";
import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test, { after, before } from "node:test";
import { mutatingRoute, safeResponse } from "../../../../apps/web/src/server/platform/boundary.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { sessionId } from "../../../../packages/contracts/src/common/values.ts";
import { S3Client } from "../../../../packages/db/src/schema/storage.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import sharp from "../../../../packages/db/node_modules/sharp/dist/index.mjs";
import type { PutObjectCommand } from "../../../../packages/db/node_modules/@aws-sdk/client-s3/dist-types/index.js";
import { readViewer, RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { brandWriter, readBrandAsset, uploadBrandAsset } from "../../../../packages/domain/src/branding/index.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { transaction } from "../../../../packages/domain/src/jobs/transaction.ts";
import {
	checkpoint,
	claimDue,
	enqueueJob,
	finishClaim,
	finishJob,
	recoverLease,
} from "../../../../packages/domain/src/jobs/queue.ts";
import { copyStatus, runBackup } from "../../../../ops/maintenance/backup.mts";
import { readiness } from "../../../../ops/maintenance/readiness.mts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../ops/maintenance/restore.mts";
import { fakeBucket } from "../../../support/fake-bucket.mts";
import { fixture, ok, refused, seeds, type Actor } from "../../../support/fixture.mts";
import { setServerEnv } from "../../../support/server-env.mts";
import { testDatabase } from "../../../support/test-database.mts";
import { storedZip } from "../../documents/fixtures/word.mts";
import { MemoryClient } from "../../documents/storage.mts";
import * as identity from "../../identity/support.mts";
import { dropTarget, objectStore, operator, snapshot } from "../sql/knowledge/support.mts";

type Case = {
	id: string;
	given: { input: Record<string, unknown> };
	clock: { now: string };
	expected: { result: Record<string, unknown>; event: null };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));

const database = await fixture({ prefix: "platformcases", plant: { name: "Harvest Point" } });
const db = database.pools.runtime;
let web: Awaited<ReturnType<typeof identity.fixture>>;
before(async () => {
	web = await identity.fixture();
	setServerEnv({ ...web.previewSettings, IDENTITY_ORIGIN: web.origin });
});
after(async () => {
	await web.close();
	await database.close();
});
const rowsOf = async (query: SQL, pool = database.admin) => (await pool.execute(query)).rows;
const one = async (query: SQL, pool = database.admin) =>
	(await rowsOf(query, pool))[0] ?? assert.fail("the query returned no row");
const actorOf = async (who: Actor, pool = db) => {
	const actor = await RequestActor.resolve(pool, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};

test("AC:PLATFORM-001 requests hold only the exact origin, a live Postgres session and the caller's own scope; a failed history write rolls back and a late worker publishes nothing", async (t) => {
	const { result } = caseOf("PLATFORM-001").expected;
	const seed = seeds(web.db);
	const P = await seed.plant({ name: "Harvest Point" });
	const Q = await seed.plant({ name: "Grace Hill" });
	const owner = await seed.actor(P, "owner");
	const email = "platform@example.test";
	assert.equal((await identity.register(web, email)).status, 200);

	await t.test("only the exact origin is accepted, on sign-in and on a session route", async () => {
		const ran: string[] = [];
		const route = mutatingRoute(async (request) => {
			ran.push(request.url);
			return safeResponse({ saved: true });
		});
		for (const origin of [
			"",
			"https://evil.example",
			web.origin.replace("http:", "https:"),
			web.origin + ".evil.example",
		]) {
			const signIn = await web.req("sign-in/email", { email, password: identity.password }, undefined, { origin });
			assert.deepEqual([signIn.status, signIn.headers.getSetCookie()], [403, []]);
			const denied = await route(new Request(web.origin + "/api/settings", { method: "POST", headers: { origin } }));
			assert.deepEqual([denied.status, await denied.json()], [403, { code: "origin_denied" }]);
		}
		assert.deepEqual(ran, []);
		const accepted = await route(
			new Request(web.origin + "/api/settings", { method: "POST", headers: { origin: web.origin } }),
		);
		assert.deepEqual([accepted.status, ran.length], [200, 1]);
		assert.equal(
			(await one(sql`SELECT count(*)::int AS n FROM auth_session WHERE user_id<>${owner.user}`, web.db)).n,
			0,
		);
	});

	await t.test(
		"one session store: a sign-in is one Postgres row and one cookie, and the row decides every read",
		async () => {
			const login = async () => {
				const response = await identity.signIn(web, email);
				assert.equal(response.status, 200);
				return {
					cookie: identity.cookie(response),
					names: response.headers.getSetCookie().map((c) => c.split("=")[0]),
				};
			};
			const read = async (cookie: string) => (await web.req("get-session", undefined, cookie)).json();
			const sessions = () =>
				rowsOf(sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id=s.user_id WHERE u.email=${email}`, web.db);
			const first = await login();
			assert.equal((await sessions()).length, 1);
			assert.equal((await read(first.cookie)).status, "pending_domain");
			assert.equal(
				first.names.some((name) => /cache|session_data/.test(String(name))),
				result.cookie_cache,
			);
			const stores = await rowsOf(
				sql`SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema()
				AND (table_name LIKE '%session%' OR column_name='password_hash') GROUP BY table_name ORDER BY table_name`,
				web.db,
			);
			const other = stores
				.map((row) => row.table_name)
				.filter((name) => name !== "auth_session" && name !== "auth_account");
			assert.equal(other.length > 0, result.second_auth_service, JSON.stringify(stores));

			await web.db.execute(
				sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id<>${owner.user}`,
			);
			assert.deepEqual(await read(first.cookie), { status: "unauthenticated" });
			const second = await login();
			assert.equal((await read(second.cookie)).status, "pending_domain");
			await web.db.execute(sql`DELETE FROM auth_session WHERE user_id<>${owner.user}`);
			assert.deepEqual(await read(second.cookie), { status: "unauthenticated" });
			for (const cookie of ["better-auth.session_token=forged.canary", `better-auth.session_token=${owner.session}`])
				assert.deepEqual(await read(cookie), { status: "unauthenticated" });
		},
	);

	const actor = await actorOf(owner, web.runtime);
	await t.test("an ended session and a forged scope resolve to nobody", async () => {
		for (const ended of [
			sql`UPDATE auth_session SET expires_at=clock_timestamp() WHERE id=${owner.session}`,
			sql`DELETE FROM auth_session WHERE id=${owner.session}`,
		]) {
			assert.equal((await readViewer(web.runtime, owner.session))?.accountId, owner.id);
			await web.db.execute(ended);
			assert.equal(await readViewer(web.runtime, owner.session), null);
			assert.equal((await RequestActor.resolve(web.runtime, owner.session)) instanceof RequestActor, false);
			refused(await documentsWriter.listOwned(web.runtime, actor, {}));
			await web.db.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
				VALUES(${owner.session},${owner.user},${randomUUID()},clock_timestamp()+interval '1 day')
				ON CONFLICT(id) DO UPDATE SET expires_at=excluded.expires_at`);
		}
		const theirs = await seed.actor(Q, "owner");
		const made = ok(
			await documentsWriter.saveNative(web.runtime, await actorOf(theirs, web.runtime), {
				title: "Grace plan",
				body: nativeFromText("Theirs."),
				expectedRevision: "0",
			}),
		);
		refused(
			await documentsWriter.saveNative(web.runtime, actor, {
				title: "Taken",
				body: nativeFromText("Ours now."),
				documentId: made.id,
				expectedRevision: made.revision,
			}),
		);
		refused(
			await documentsWriter.saveNative(web.runtime, actor, {
				title: "Placed",
				body: nativeFromText("Forged."),
				expectedRevision: "0",
				tenantId: Q.id,
			}),
			"invalid_input",
		);
		assert.deepEqual(await rowsOf(sql`SELECT title FROM document WHERE tenant_id=${Q.id}`, web.db), [
			{ title: "Grace plan" },
		]);
		assert.equal(await readViewer(web.runtime, sessionId.parse(randomUUID())), null);
	});

	await t.test("a failed required history write leaves no part of its change", async () => {
		assert.equal(caseOf("PLATFORM-001").given.input.fault, "required_history_write");
		const state = () =>
			one(
				sql`SELECT (SELECT count(*)::int FROM document WHERE tenant_id=${P.id}) AS documents,
					(SELECT count(*)::int FROM document_revision WHERE tenant_id=${P.id}) AS revisions,
					(SELECT count(*)::int FROM audit_event WHERE tenant_id=${P.id}) AS audits`,
				web.db,
			);
		const save = () =>
			documentsWriter.saveNative(web.runtime, actor, {
				title: "Launch plan",
				body: nativeFromText("Ours."),
				expectedRevision: "0",
			});
		const before = await state();
		await web.db.execute(
			sql`CREATE FUNCTION history_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'required_history_write'; END $$`,
		);
		await web.db.execute(
			sql`CREATE TRIGGER history_fault BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION history_fault()`,
		);
		const failed = await save().then(
			(reply) => reply.status !== "ok",
			() => true,
		);
		await web.db.execute(sql`DROP TRIGGER history_fault ON audit_event`);
		assert.equal(failed, true);
		assert.equal(JSON.stringify(await state()) === JSON.stringify(before), result.transaction_rollback);
		ok(await save());
		assert.deepEqual(await state(), { documents: 1, revisions: 1, audits: 1 });
	});

	await t.test("a reclaimed lease fences the worker that lost it", async () => {
		const subject = str((await one(sql`SELECT id FROM document WHERE tenant_id=${P.id}`, web.db)).id);
		const id = await transaction(web.runtime, (tx) =>
			enqueueJob(tx, {
				tenant: P.id,
				subject,
				kind: "object_cleanup",
				key: subject,
				revision: "1",
				eligibleAt: caseOf("PLATFORM-001").clock.now,
			}),
		);
		await web.db.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE id=${id}`);
		const [late] = await claimDue(web.runtime, ["object_cleanup"]);
		assert.ok(late);
		assert.deepEqual(await claimDue(web.runtime, ["object_cleanup"]), []);
		await web.db.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${id}`);
		assert.equal(await recoverLease(web.runtime), 1);
		await web.db.execute(
			sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second',next_attempt_at=NULL WHERE id=${id}`,
		);
		const [current] = await claimDue(web.runtime, ["object_cleanup"]);
		assert.ok(current);
		const published = [
			await finishJob(web.runtime, late, { state: "succeeded" }),
			await transaction(web.runtime, (tx) => finishClaim(tx, late, { state: "succeeded" })),
			await transaction(web.runtime, (tx) => checkpoint(tx, late, "late-output")),
		];
		assert.equal(published.some(Boolean), result.late_worker_publish);
		assert.equal((await one(sql`SELECT state FROM job WHERE id=${id}`, web.db)).state, "claimed");
		assert.equal(await finishJob(web.runtime, current, { state: "succeeded" }), true);
	});
});

class PublicClient extends S3Client {
	override async send() {
		return { Grants: [{ Grantee: { URI: "http://acs.amazonaws.com/groups/global/AllUsers" }, Permission: "READ" }] };
	}
}

class WatchedClient extends MemoryClient {
	puts: PutObjectCommand["input"][] = [];
	beforeGet: (() => Promise<unknown>) | null = null;
	override async send(command: { input?: { Key?: string; Body?: Uint8Array } }) {
		if (command.constructor.name === "PutObjectCommand") this.puts.push(command.input as PutObjectCommand["input"]);
		if (command.constructor.name === "GetObjectCommand") {
			const hold = this.beforeGet;
			this.beforeGet = null;
			const read = await super.send(command);
			await hold?.();
			return read;
		}
		return super.send(command);
	}
}

test("AC:PLATFORM-002 a private file is one fixed object, opened by a short signed link only under authority checked at issue, finalize and reconnect", async (t) => {
	const c = caseOf("PLATFORM-002");
	const { input } = c.given;
	const { result } = c.expected;
	const client = new WatchedClient();
	const keys = { accessKeyId: "test", secretAccessKey: "STORAGE-SECRET" };
	client.config.credentials = async () => keys;
	const storage = { bucket: "synthetic-only", client };
	const P = database.tenant;
	const { owner, member } = database.actors;
	const Q = await database.actor(await database.plant({ name: "Grace Hill" }), "owner");
	const seat = AsyncResource.bind(async (who: Actor, ended: boolean) => {
		await database.admin.execute(
			sql`UPDATE seat SET ended_at=${ended ? sql`clock_timestamp()` : sql`NULL`} WHERE account_id=${who.id}`,
		);
	});
	const author = await actorOf(member);
	const generate = (requestKey: string) =>
		documentsWriter.generate(db, author, { templateId: "commitment-card", format: input.format, requestKey }, storage);
	const made = ok(await generate(str(input.object)));
	const file = await one(sql`SELECT f.id,f.opaque_key,f.sha256,f.state FROM generated_document g
		JOIN file_object f ON f.id=g.object_id WHERE g.id=${made.id}`);
	const key = str(file.opaque_key);
	const download = (who: RequestActor, request: object = { documentId: made.id }) =>
		documentsWriter.download(db, who, request, storage);

	await t.test("the stored object is one opaque key that is never written again and never cached", async () => {
		assert.match(key, new RegExp(`^private/${P.id}/[0-9a-f-]{36}$`));
		assert.equal(client.puts.length, 1);
		const [put] = client.puts;
		assert.deepEqual(
			[put?.Key, put?.ACL, put?.IfNoneMatch, put?.CacheControl],
			[key, "private", "*", result.cache_control],
		);
		assert.deepEqual(ok(await generate(str(input.object))), made);
		assert.equal(client.puts.length, 1);
		refused(
			await documentsWriter.generate(
				db,
				author,
				{ templateId: "commitment-card", format: input.format, requestKey: "public-bucket" },
				{ bucket: "open", client: new PublicClient({ region: "us-east-1" }) },
			),
		);
	});

	const link = ok(await download(author));
	const url = new URL(link.url);
	await t.test("the link names exactly that object and forbids a cached copy", () => {
		assert.ok(url.pathname.endsWith("/" + key));
		assert.equal(url.searchParams.get("response-cache-control"), result.cache_control);
		assert.equal(url.searchParams.get("response-content-disposition"), "attachment");
		assert.ok(url.searchParams.get("X-Amz-Signature"));
		assert.equal(JSON.stringify(link).includes("STORAGE-SECRET"), false);
	});

	await t.test("no key from the caller, no other church's file and no unknown file is opened", async () => {
		const attempts = [
			await download(author, { documentId: key }),
			await download(author, { documentId: input.object }),
			await download(author, { documentId: made.id, key: input.object }),
			await download(author, { documentId: file.id }),
			await download(author, { documentId: randomUUID() }),
			await documentsWriter.generate(
				db,
				author,
				{ templateId: "commitment-card", format: input.format, requestKey: "keyed", key: input.object },
				storage,
			),
		];
		assert.equal(
			attempts.some((reply) => reply.status === "ok"),
			result.client_key_accepted,
		);
		refused(await download(await actorOf(Q)));
	});

	await t.test("authority that ends issues no new link, not even while one is being signed", async () => {
		await seat(member, true);
		const after = await download(author);
		refused(after);
		assert.equal("value" in after ? after.value : null, result.new_url_after_revoke);
		await seat(member, false);
		client.config.credentials = async () => {
			await seat(member, true);
			return keys;
		};
		const during = await download(author);
		refused(during);
		assert.equal("value" in during ? during.value : null, result.new_url_after_revoke);
		client.config.credentials = async () => keys;
		await seat(member, false);
	});

	await t.test("authority that ends during the upload leaves no ready file", async () => {
		client.beforePut = () => seat(member, true);
		refused(await generate("revoked-mid-upload"));
		await seat(member, false);
		const [row] = await rowsOf(
			sql`SELECT state FROM file_object WHERE upload_key=${`generated:${P.id}:revoked-mid-upload`}`,
		);
		assert.equal(row?.state, "pending");
	});

	await t.test("a read that reconnects rechecks authority, and changed or unsigned bytes are refused", async () => {
		const admin = await actorOf(owner);
		const png = await sharp({ create: { width: 60, height: 20, channels: 4, background: "#1F4E79" } })
			.png()
			.toBuffer();
		const upload = async (bytes: Buffer) => {
			const ticket = ok(
				await brandWriter.requestUpload(db, admin, {
					slot: "full_logo",
					mediaType: "image/png",
					byteLength: bytes.length,
					altText: "Logo",
				}),
			);
			return { ticket, stored: await uploadBrandAsset(db, storage, admin, { uploadId: ticket.uploadId, bytes }) };
		};
		refused((await upload(Buffer.from("not a picture"))).stored, "invalid_file");
		const { ticket, stored } = await upload(png);
		ok(stored);
		ok(
			await brandWriter.finalizeUpload(db, admin, {
				uploadId: ticket.uploadId,
				slot: "full_logo",
				altText: "Logo",
				expectedRevision: "0",
			}),
		);
		const read = () => readBrandAsset(db, storage, admin, ticket.uploadId);
		ok(await read());
		client.beforeGet = () => seat(owner, true);
		refused(await read());
		await seat(owner, false);
		const { opaque_key } = await one(sql`SELECT opaque_key FROM file_object WHERE id=${ticket.uploadId}`);
		const held = client.objects.get(str(opaque_key)) ?? assert.fail("no stored logo");
		client.objects.set(str(opaque_key), Buffer.from(held).fill(0, held.length - 4));
		refused(await read());
	});

	await t.test("an Office file opens as inert text", async () => {
		const word = storedZip([
			{
				name: "word/document.xml",
				data: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>`,
			},
		]);
		const imported = ok(
			await documentsWriter.importTextOrWord(
				db,
				await actorOf(owner),
				{ title: "Inert", format: "docx", bytes: word, expectedRevision: "0", requestKey: "inert-docx" },
				storage,
			),
		);
		assert.deepEqual(imported.body, nativeFromText("<script>alert(1)</script>"));
	});

	await t.test("an issued link ends within the maximum lifetime", () => {
		const expiresIn = Number(url.searchParams.get("X-Amz-Expires"));
		assert.equal(expiresIn, link.expiresInSeconds);
		assert.ok(expiresIn > 0 && expiresIn <= Number(result.max_url_ttl_seconds), `${expiresIn} seconds`);
	});
});

const scoped = {
	authority: "explicit_scoped_operator",
	verified: true,
	operation_ids: ["ops.readiness"],
	environment: "isolated-test",
} as const;
const report = (evidence: unknown, now: string, copies?: Awaited<ReturnType<typeof copyStatus>>) => {
	const found = readiness({ capability: scoped, evidence, now: new Date(now), copies });
	return found.refusal === null ? found : assert.fail(found.refusal);
};
const evidenced = (at: string) => ({
	cost_approval: { approved: true, approved_at: at, monthly_usd: { low: 5, expected: 10, high: 20 } },
	host_schedule: { host: "restricted-host-1", schedule: "daily 03:00 UTC", verified_at: at },
	key_exclusion: { denied: { app: true, build: true, preview: true }, verified_at: at },
	coherent_restore: { live_recovery_proven: true, verified_at: at },
});

test("AC:PLATFORM-003 a named provider and a separate bucket with a fresh copy give no customer-data clearance without the operator's own evidence", async (t) => {
	const c = caseOf("PLATFORM-003");
	const { provider, backup_bucket_separate, operator_evidence } = c.given.input;
	const { result } = c.expected;
	const now = new Date(c.clock.now);
	const recovery = await testDatabase({ prefix: "platformrec", clock: now });
	t.after(() => recovery.close());
	const fake = await fakeBucket();
	t.after(() => fake.close());
	fake.settings.now = now;
	const objects = new Map<string, Uint8Array>();
	const copy = await snapshot(recovery.admin, objects, { createdAt: now });
	const taken = await runBackup({
		bucket: fake.bucket,
		key: createSecretKey(randomBytes(32)),
		capture: async () => copy,
		clock: () => now,
	});
	assert.equal(taken.copy_complete, backup_bucket_separate);
	const copies = await copyStatus(fake.bucket, now);
	assert.equal(copies.daily_fallback_eligible, true);
	const stored = fake.objects.size;

	const everything = ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"];
	const named = {
		provider,
		backup_bucket_separate,
		history_days: 7,
		encrypted: true,
		recovery: "configured",
		verified_at: c.clock.now,
	};
	for (const evidence of [operator_evidence, {}, named, { coherent_restore: named, key_exclusion: named }]) {
		const found = report(evidence, c.clock.now, copies);
		assert.equal(found.customer_data_gate !== "blocked", result.customer_data_allowed);
		assert.equal(found.live_evidence_verified || !found.missing.includes("coherent_restore"), result.recovery_proven);
		assert.equal(!found.missing.includes("cost_approval"), result.provider_setup_authorized);
		assert.deepEqual(found.missing, everything);
		assert.equal(found.daily_fallback_eligible, true);
	}
	const full = report(evidenced(c.clock.now), c.clock.now, copies);
	assert.equal(full.customer_data_gate !== "blocked", result.customer_data_allowed);
	assert.equal(full.live_evidence_verified, result.recovery_proven);

	const target = `${recovery.schema}_r`;
	t.after(() => dropTarget(database.admin, target));
	const rehearsal = await restoreWithCurrentManifest(
		{
			admin: recovery.admin,
			source: recovery.schema,
			targetSchema: target,
			objects: objectStore(new Map()),
			clock: () => now,
		},
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(recovery.admin) },
	);
	assert.equal(rehearsal.restore_success, true, JSON.stringify(rehearsal));
	assert.deepEqual(
		[rehearsal.guaranteed_disaster_RTO, rehearsal.customer_SLA],
		[result.disaster_sla, result.disaster_sla],
	);
	const after = report(
		{ ...evidenced(c.clock.now), coherent_restore: { ...rehearsal, verified_at: c.clock.now } },
		c.clock.now,
		copies,
	);
	assert.equal(!after.missing.includes("coherent_restore"), result.recovery_proven);
	assert.equal(fake.objects.size, stored);
});

test("AC:PLATFORM-004 without a concrete priced approval no new paid service is allowed, and a free allowance is never unlimited capacity", () => {
	const c = caseOf("PLATFORM-004");
	const { synthetic, paid_approval } = c.given.input;
	const { result } = c.expected;
	const priced = evidenced(c.clock.now);
	const approval = priced.cost_approval;
	const attempts = {
		"no approval": paid_approval,
		"a free allowance": { plan: "free", allowance: "unlimited", synthetic },
		"an approval with no price": { approved: true, approved_at: approval.approved_at },
		"an unlimited price": { ...approval, monthly_usd: { low: 0, expected: 0, high: "unlimited" } },
		"an unbounded price": { ...approval, monthly_usd: { low: 0, expected: 0, high: Infinity } },
		"no approval time": { ...approval, approved_at: null },
		"a refusal": { ...approval, approved: false },
	};
	for (const [name, cost_approval] of Object.entries(attempts)) {
		const found = report({ ...priced, cost_approval }, c.clock.now);
		assert.deepEqual(found.missing, ["cost_approval"], name);
		assert.equal(!found.missing.includes("cost_approval"), result.new_paid_commitment_allowed, name);
		assert.equal(/unlimited|free/i.test(JSON.stringify(found)), result.unlimited_free_usage_claimed, name);
		assert.equal(found.customer_data_gate, "blocked");
	}
	assert.deepEqual(report(priced, c.clock.now).missing, []);
});
