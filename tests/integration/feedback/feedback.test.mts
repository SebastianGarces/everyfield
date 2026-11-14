import { fixture, ok, refused } from "../../support/fixture.mts";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { feedbackWriter, authorizeTriage } from "../../../packages/domain/src/feedback/index.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Product feedback (WP-049A): the author sends feedback with private page and device details and lists its status; a
// triager with the feedback_triage platform grant, and nobody else, reads the private original and moves its status.

const database = await fixture({ prefix: "fdbk", plant: { name: "Harvest Point" } });
const { admin } = database;
const db = database.pools.runtime;
after(() => database.close());
const daniel = database.actors.owner;
const other = database.actors.member;
const triager = await database.actor(null);
await admin.execute(
	sql`INSERT INTO platform_grant (account_id, capability) VALUES (${triager.id}::uuid, 'feedback_triage')`,
);

const authority = async (who: { session: string }) => {
	const actor = await RequestActor.resolve(db, who.session);
	assert.ok(actor instanceof RequestActor, JSON.stringify(actor));
	return actor;
};
const rowsOf = async (query: ReturnType<typeof sql>) => (await admin.execute(query)).rows as Record<string, any>[];
const server = { appVersion: "3.0.0-test" };
const send = async (who: { session: string }, input: Record<string, unknown>) =>
	feedbackWriter.submit(db, await authority(who), { requestKey: randomUUID(), category: "bug", ...input }, server);

test("AC:CASE-ADM-001 the dialog saves its details, takes church and role from the seat, strips the address and saves a resend once", async () => {
	const key = randomUUID();
	const input = {
		requestKey: key,
		category: "bug",
		description: "  Save button stops  ",
		page: "Documents",
		address: "/documents?token=secret#draft",
		browser: "Chrome 142 · macOS",
		screenWidth: 1440,
		screenHeight: 900,
		theme: null,
		// Forged trusted details: the server ignores them.
		church: "Forged Church",
		role: "Admin",
		appVersion: "forged",
	};
	// The dialog lists the church and role the server will store, and the address we reply to.
	assert.deepEqual(ok(await feedbackWriter.getSendContext(db, await authority(daniel))), {
		church: "Harvest Point",
		role: "Owner",
		replyTo: daniel.email,
	});
	const sent = ok(await feedbackWriter.submit(db, await authority(daniel), input, server));
	assert.equal(sent.page, "Documents");
	assert.equal(sent.replyTo, daniel.email);
	assert.equal(sent.category, "bug");
	// The connection drops and the dialog sends the same feedback again: the same answer, one row, one audit row.
	const again = ok(await feedbackWriter.submit(db, await authority(daniel), input, server));
	assert.deepEqual(again, sent);
	const saved = await rowsOf(
		sql`SELECT * FROM feedback WHERE account_id=${daniel.id}::uuid AND request_key=${key}::uuid`,
	);
	assert.equal(saved.length, 1);
	const row = saved[0]!;
	assert.deepEqual(
		{
			description: row.description,
			page_label: row.page_label,
			page_address: row.page_address,
			church_label: row.church_label,
			role_label: row.role_label,
			browser: row.browser,
			screen_width: row.screen_width,
			screen_height: row.screen_height,
			theme: row.theme,
			app_version: row.app_version,
			status: row.status,
		},
		{
			description: "Save button stops",
			page_label: "Documents",
			page_address: "/documents",
			church_label: "Harvest Point",
			role_label: "Owner",
			browser: "Chrome 142 · macOS",
			screen_width: 1440,
			screen_height: 900,
			theme: null,
			app_version: "3.0.0-test",
			status: "new",
		},
	);
	assert.equal(JSON.stringify(row).includes("secret"), false);
	assert.equal(JSON.stringify(row).includes("draft"), false);
	const audits = await rowsOf(sql`SELECT action FROM audit_event WHERE subject_id=${sent.id}::uuid`);
	assert.deepEqual(
		audits.map((a) => a.action),
		["feedback.received"],
	);

	// A token route's token never reaches the row either, and details the browser could not give stay null.
	const bare = ok(await send(daniel, { description: "Link broke", address: "/invite/abcdefghijklmnopqrstuvwxyz0123" }));
	const [stored] = await rowsOf(
		sql`SELECT page_label, page_address, browser, screen_width, theme FROM feedback WHERE id=${bare.id}::uuid`,
	);
	assert.deepEqual(
		{ ...stored },
		{ page_label: null, page_address: "/invite/[token]", browser: null, screen_width: null, theme: null },
	);

	// An empty, blank or over-long description is refused and nothing is saved.
	const before = (await rowsOf(sql`SELECT count(*)::int AS n FROM feedback`))[0]!.n;
	for (const description of ["", "     ", "x".repeat(5001)])
		refused(await send(daniel, { description }), "invalid_input");
	ok(await send(daniel, { description: "x".repeat(5000) }));
	assert.equal((await rowsOf(sql`SELECT count(*)::int AS n FROM feedback`))[0]!.n, before + 1);
});

test("AC:CASE-ADM-001 AC:PUB57-002 INV-privacy: the author lists only their own feedback, 25 at a time, without private details", async () => {
	const author = await database.actor(database.tenant, "admin");
	const ids: string[] = [];
	for (let i = 0; i < 27; i++) ids.push(ok(await send(author, { description: `Item ${i}`, category: "question" })).id);
	ok(await send(other, { description: "Someone else's" }));
	const first = ok(await feedbackWriter.listOwn(db, await authority(author), {}));
	assert.equal(first.items.length, 25);
	assert.ok(first.next);
	const second = ok(await feedbackWriter.listOwn(db, await authority(author), { cursor: first.next }));
	assert.equal(second.items.length, 2);
	assert.equal(second.next, null);
	const listed = [...first.items, ...second.items];
	assert.deepEqual(new Set(listed.map((i: any) => i.id)), new Set(ids));
	assert.deepEqual(Object.keys(listed[0]).sort(), ["category", "id", "publicUrl", "status", "submittedAt"]);
	assert.deepEqual(
		{ ...listed[0], id: "", submittedAt: "" },
		{ id: "", category: "question", submittedAt: "", status: "new", publicUrl: null },
	);
	// Newest first.
	const times = listed.map((i: any) => i.submittedAt);
	assert.deepEqual(times, [...times].sort().reverse());

	// Another account asking for this feedback's status gets the same answer as for an id that does not exist.
	const mine = ok(await feedbackWriter.getOwnStatus(db, await authority(author), { feedbackId: ids[0] }));
	assert.equal(mine.id, ids[0]);
	refused(await feedbackWriter.getOwnStatus(db, await authority(other), { feedbackId: ids[0] }), "unavailable");
	refused(await feedbackWriter.getOwnStatus(db, await authority(other), { feedbackId: randomUUID() }), "unavailable");
});

test("AC:CASE-ADM-002 AC:PUB57-002 a triager filters, moves a status with history, and never overwrites a newer change", async () => {
	const sent = ok(await send(daniel, { description: "Save button stops", page: "Documents" }));
	ok(await send(daniel, { description: "An idea", category: "suggestion" }));
	const t = await authority(triager);
	assert.equal(await authorizeTriage(db, t), true);
	const listed = ok(await feedbackWriter["admin.list"](db, t, { status: "new", category: "bug" }));
	assert.ok(listed.items.every((i: any) => i.status === "new" && i.category === "bug"));
	const item = listed.items.find((i: any) => i.id === sent.id);
	assert.equal(item.description, "Save button stops");
	assert.equal(item.details.church, "Harvest Point");
	assert.equal(item.author.email, daniel.email);

	const moved = ok(
		await feedbackWriter["admin.changeStatus"](db, t, {
			feedbackId: sent.id,
			expectedRevision: "1",
			status: "reviewed",
		}),
	);
	assert.deepEqual(moved, { outcome: "changed", status: "reviewed", revision: "2" });
	const detail = ok(await feedbackWriter["admin.get"](db, t, { feedbackId: sent.id }));
	assert.equal(detail.history.length, 1);
	assert.deepEqual({ ...detail.history[0], at: "" }, { from: "new", to: "reviewed", by: "Synthetic", at: "" });
	const [audit] = await rowsOf(
		sql`SELECT actor_id, action, kind, before_value, after_value FROM audit_event WHERE subject_id=${sent.id}::uuid AND action='feedback.status_changed'`,
	);
	assert.deepEqual(
		{ ...audit },
		{
			actor_id: triager.id,
			action: "feedback.status_changed",
			kind: "triage",
			before_value: { status: "new" },
			after_value: { status: "reviewed" },
		},
	);
	const own = ok(await feedbackWriter.getOwnStatus(db, await authority(daniel), { feedbackId: sent.id }));
	assert.equal(own.status, "reviewed");

	// Another triager's view from revision 1 is stale: nothing is overwritten and the answer names the current status.
	const stale = ok(
		await feedbackWriter["admin.changeStatus"](db, t, {
			feedbackId: sent.id,
			expectedRevision: "1",
			status: "dismissed",
		}),
	);
	assert.deepEqual(stale, { outcome: "stale", status: "reviewed", revision: "2" });
	// Setting the status it already has records nothing, even from a stale view.
	const same = ok(
		await feedbackWriter["admin.changeStatus"](db, t, {
			feedbackId: sent.id,
			expectedRevision: "1",
			status: "reviewed",
		}),
	);
	assert.deepEqual(same, { outcome: "unchanged", status: "reviewed", revision: "2" });
	const history = await rowsOf(
		sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${sent.id}::uuid AND action='feedback.status_changed'`,
	);
	assert.equal(history[0]!.n, 1);
	assert.equal((await rowsOf(sql`SELECT status FROM feedback WHERE id=${sent.id}::uuid`))[0]!.status, "reviewed");
	refused(
		await feedbackWriter["admin.changeStatus"](db, t, {
			feedbackId: randomUUID(),
			expectedRevision: "1",
			status: "new",
		}),
		"unavailable",
	);
});

test("AC:CASE-ADM-002 INV-privacy: an Owner without a current triage grant reads and changes no one's feedback", async () => {
	const sent = ok(await send(other, { description: "Private words" }));
	const owner = await authority(daniel);
	const revokedAccount = await database.actor(null);
	const expiredAccount = await database.actor(null);
	await admin.execute(
		sql`INSERT INTO platform_grant (account_id, capability, revoked_at) VALUES (${revokedAccount.id}::uuid, 'feedback_triage', clock_timestamp())`,
	);
	await admin.execute(
		sql`INSERT INTO platform_grant (account_id, capability, expires_at) VALUES (${expiredAccount.id}::uuid, 'feedback_triage', clock_timestamp() - interval '1 day')`,
	);
	for (const who of [owner, await authority(revokedAccount), await authority(expiredAccount)]) {
		assert.equal(await authorizeTriage(db, who), false);
		refused(await feedbackWriter["admin.list"](db, who, {}), "access_denied");
		refused(await feedbackWriter["admin.get"](db, who, { feedbackId: sent.id }), "access_denied");
		refused(
			await feedbackWriter["admin.changeStatus"](db, who, {
				feedbackId: sent.id,
				expectedRevision: "1",
				status: "dismissed",
			}),
			"access_denied",
		);
	}
	assert.equal((await rowsOf(sql`SELECT status FROM feedback WHERE id=${sent.id}::uuid`))[0]!.status, "new");
});

test("AC:CASE-ADM-001 a suspended or deleted account cannot send feedback", async () => {
	for (const state of ["pending_deletion", "purging"]) {
		const who = await database.actor(database.tenant, "member");
		const signedIn = await authority(who);
		await admin.execute(sql`INSERT INTO lifecycle_witness(kind,opaque_subject_id,request_revision,state,witness_checkpoint,cleanup_state,request_id,requested_at,cancel_until)
 VALUES('account',${who.id}::uuid,1,${state},1,'not_started',${randomUUID()}::uuid,statement_timestamp(),statement_timestamp()+interval '720 hours')`);
		const result = await feedbackWriter.submit(
			db,
			signedIn,
			{ requestKey: randomUUID(), category: "bug", description: "Hello" },
			server,
		);
		refused(result, "access_denied");
		assert.equal(
			(await rowsOf(sql`SELECT count(*)::int AS n FROM feedback WHERE account_id=${who.id}::uuid`))[0]!.n,
			0,
		);
	}
});
