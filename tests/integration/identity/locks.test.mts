import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { fixture, key } from "./invitations-support.mts";
import { eq, sql, and } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";
import { currentActor, RequestActor } from "../../../packages/domain/src/access/index.ts";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";
import {
	PeopleReadContext,
	readPeopleViewer,
	peopleWriter,
	peopleReader,
} from "../../../packages/domain/src/people/index.ts";
import { readPeoplePage, readPersonPage } from "../../../apps/web/src/features/people/page-data.ts";
import { parseQuery } from "../../../apps/web/src/features/people/model.ts";
let f;
before(async () => {
	f = await fixture({ lockTimeout: "1s" });
});
after(async () => {
	await f?.close();
});
const outcome = (p) =>
	p.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
async function waitingOn(pid) {
	for (let n = 0; n < 100; n++) {
		const r = await f.admin.execute(
			sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`,
		);
		if (r.rows[0].n > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("Competing operation did not reach the held lock");
}

test("BUG-124: People membership read takes no account write lock", async () => {
	const s = await f.setup();
	await f.admin.transaction(async (tx) => {
		await tx.select().from(t.account).where(eq(t.account.id, s.sender.id)).for("share");
		const member = await f.seats.readCurrentMembership(s.sender.session);
		assert.equal(member.status, "active");
		const page = await f.db.transaction((tx) =>
			peopleReader.listPeople(
				tx,
				{
					session: s.sender.session,
					selected: member.workspace,
					purpose: "native",
				},
				{ search: "No matching person" },
			),
		);
		assert.equal(page.status, "ok");
		assert.equal(page.value.total, 0);
	});
});

test("BUG-124: a held account write returns a retryable refusal and the read resumes", async () => {
	const s = await f.setup();
	await f.admin.transaction(async (tx) => {
		await tx.update(t.account).set({ revision: "2" }).where(eq(t.account.id, s.sender.id));
		await assert.rejects(f.seats.readCurrentMembership(s.sender.session), (error) => {
			assert.equal(error.value?.code, "temporary");
			assert.equal(error.value.retry, "same_request");
			return true;
		});
	});
	assert.equal((await f.seats.readCurrentMembership(s.sender.session)).status, "active");
});

test("BUG-127: resend during a 250-duty removal completes or safely retries", async () => {
	const s = await f.setup(),
		invitation = await f.invitation(s);
	const accepted = await f.invitations.accept(s.recipient.session, invitation.claim);
	const pending = await f.invitations.invite(s.sender.session, {
		requestKey: key(),
		expectedRevision: "1",
		input: { workspace: s.w, role: "member", recipientEmail: key() + "@example.test" },
	});
	await f.admin
		.update(t.invitation)
		.set({ created_at: new Date(Date.now() - 120000) })
		.where(eq(t.invitation.id, pending.invitation.invitationId));
	const ids = Array.from({ length: 250 }, () => key());
	await f.admin.insert(t.task).values(
		ids.map((id) => ({
			id,
			plant_id: s.w.id,
			title: "Open duty",
			category: "general",
			priority: "medium",
			status: "not_started",
			created_at: new Date(),
			assignee_id: s.recipient.id,
			due_kind: "undated",
		})),
	);
	const command = {
		requestKey: key(),
		expectedRevision: "1",
		input: {
			seatId: accepted.seat.seatId,
			expectedRole: "member",
			handoffs: ids.map((dutyId) => ({
				kind: "assign",
				dutyId,
				expectedRevision: "1",
				recipientAccountId: s.sender.id,
			})),
		},
	};
	const resend = { requestKey: key(), expectedRevision: "1", input: { invitationId: pending.invitation.invitationId } };
	let removal, concurrent;
	try {
		await f.admin.transaction(async (tx) => {
			await tx.select().from(t.task).where(eq(t.task.id, ids[0])).for("update");
			const r = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
			removal = outcome(f.seats.remove(s.sender.session, s.w, command));
			await waitingOn(r.rows[0].pid);
			concurrent = outcome(f.invitations.resend(s.sender.session, resend));
		});
	} finally {
		if (removal) await removal;
		if (concurrent) await concurrent;
	}
	const removed = await removal,
		sent = await concurrent;
	assert.equal(removed.error, undefined, "Removal must complete atomically");
	assert.equal(removed.value.duties.length, 250);
	if (sent.error) {
		assert.equal(sent.error.value?.code, "temporary");
		assert.equal(sent.error.value.retry, "same_request");
	}
	const result = sent.value ?? (await f.invitations.resend(s.sender.session, resend));
	assert.equal(result.invitation.revision, "2");
	assert.deepEqual(await f.seats.remove(s.sender.session, s.w, command), removed.value);
	const [{ n }] = await f.admin
		.select({ n: sql`count(*)::int` })
		.from(t.task)
		.where(and(eq(t.task.plant_id, s.w.id), eq(t.task.assignee_id, s.sender.id), eq(t.task.revision, "2")));
	assert.equal(n, 250);
	assert.equal(removed.value.receipt.eventIds.length, 251);
});

test("BUG-124: HTTP resume returns 503 temporary after lock timeout, with the same request retry", async () => {
	const s = await f.setup(),
		native = f.native(),
		email = key() + "@example.test";
	const password = "Synthetic-lock-password-1";
	s.recipient.email = email;
	const invitation = await f.invitation(s);
	await native("register", {
		kind: "invitation",
		name: "Synthetic invitee",
		email,
		password,
		invitationProof: invitation.proof,
		requestKey: key(),
	});
	const [user] = await f.admin.select().from(t.auth_user).where(eq(t.auth_user.email, email));
	await f.admin.update(t.auth_user).set({ email_verified: true }).where(eq(t.auth_user.id, user.id));
	const [account] = await f.admin.select().from(t.account).where(eq(t.account.auth_user_id, user.id));
	const login = await native("sign-in/email", { email, password });
	assert.equal(login.status, 200);
	const cookie = login.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const request = { requestKey: key(), invitationProof: invitation.proof };
	await f.admin.transaction(async (tx) => {
		await tx.update(t.account).set({ revision: "2" }).where(eq(t.account.id, account.id));
		const response = await native("resume-registration", request, cookie);
		assert.equal(response.status, 503);
		const body = await response.json();
		assert.equal(body.code, "temporary");
		assert.equal(body.retry, "same_request");
		assert.equal(
			(
				await f.admin.select().from(t.invitation).where(eq(t.invitation.id, invitation.result.invitation.invitationId))
			)[0].state,
			"pending",
		);
	});
	const resumed = await native("resume-registration", request, cookie);
	assert.equal(resumed.status, 200);
	assert.equal((await resumed.json()).status, "active");
});

test("BUG-127: statement timeout rolls back every handoff and permits exact retry", async () => {
	const s = await f.setup(),
		invitation = await f.invitation(s),
		accepted = await f.invitations.accept(s.recipient.session, invitation.claim),
		duty = key();
	await f.admin.insert(t.task).values({
		id: duty,
		plant_id: s.w.id,
		title: "Original duty",
		category: "general",
		priority: "medium",
		status: "not_started",
		created_at: new Date(),
		assignee_id: s.recipient.id,
		due_kind: "undated",
	});
	const command = {
		requestKey: key(),
		expectedRevision: "1",
		input: {
			seatId: accepted.seat.seatId,
			expectedRole: "member",
			handoffs: [{ kind: "assign", dutyId: duty, expectedRevision: "1", recipientAccountId: s.sender.id }],
		},
	};
	// A real Postgres statement deadline after the writes, not a fake thrown database error.
	await f.admin.execute(
		sql`CREATE FUNCTION stall_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(11); RETURN NEW; END $$`,
	);
	await f.admin.execute(
		sql`CREATE TRIGGER stall_receipt BEFORE INSERT ON identity_operation_result FOR EACH ROW EXECUTE FUNCTION stall_receipt()`,
	);
	try {
		await assert.rejects(f.seats.remove(s.sender.session, s.w, command), (error) => {
			assert.equal(error.value?.code, "temporary");
			assert.equal(error.value.retry, "same_request");
			return true;
		});
	} finally {
		await f.admin.execute(sql`DROP TRIGGER stall_receipt ON identity_operation_result`);
		await f.admin.execute(sql`DROP FUNCTION stall_receipt()`);
	}
	const [task] = await f.admin.select().from(t.task).where(eq(t.task.id, duty));
	assert.equal(task.assignee_id, s.recipient.id);
	assert.equal(task.revision, "1");
	assert.equal((await f.seats.readCurrentMembership(s.recipient.session)).status, "active");
	const [{ n }] = await f.admin
		.select({ n: sql`count(*)::int` })
		.from(t.operation)
		.where(eq(t.operation.request_key, command.requestKey));
	assert.equal(n, 0);
	const result = await f.seats.remove(s.sender.session, s.w, command);
	assert.deepEqual(result.duties, [{ status: "moved", dutyId: duty, recipientAccountId: s.sender.id }]);
});

test("INV-identity: current actor preserves authority within two database round trips", async (test) => {
	const f = await fixture();
	test.after(() => f.close());
	const plant = await f.workspace();
	const organization = await f.workspace("sending_network");
	const cases = [];
	for (const [name, workspace, role] of [
		["owner", plant, "owner"],
		["member", plant, "member"],
		["organization seat", organization, "admin"],
	]) {
		const account = await f.account();
		const seatId = await f.seat(account, workspace, role);
		cases.push({
			name,
			account,
			selected: workspace,
			expected: {
				status: "active",
				accountId: account.id,
				context: {
					kind: "seat",
					owner: workspace,
					seatId,
					role,
					revision: "1",
				},
			},
		});
	}
	const seatless = await f.account();
	cases.push({
		name: "seatless account",
		account: seatless,
		selected: { kind: "account", id: seatless.id },
		expected: {
			status: "active",
			accountId: seatless.id,
			context: { kind: "account", owner: { kind: "account", id: seatless.id } },
		},
	});
	cases.push({ name: "seatless workspace", account: seatless, selected: plant, expected: { status: "unavailable" } });
	const expired = await f.account();
	await f.admin
		.update(t.auth_session)
		.set({ expires_at: new Date(0) })
		.where(eq(t.auth_session.id, expired.session));
	cases.push({ name: "expired session", account: expired, selected: plant, expected: { status: "unavailable" } });
	const pending = await f.account("pending_domain");
	cases.push({
		name: "pending registration",
		account: pending,
		selected: plant,
		expected: { status: "pending_domain", accountId: pending.id },
	});
	cases.push({
		name: "foreign account",
		account: seatless,
		selected: { kind: "account", id: pending.id },
		expected: { status: "unavailable" },
	});
	cases.push({
		name: "unknown session",
		account: { session: key() },
		selected: plant,
		expected: { status: "unavailable" },
	});
	let recording = false;
	let statements = [];
	const instrumented = new WeakSet();
	f.db.$client.on("acquire", (client) => {
		if (instrumented.has(client)) return;
		instrumented.add(client);
		const query = client.query;
		test.mock.method(client, "query", function (...args) {
			if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
			return query.apply(this, args);
		});
	});
	for (const c of cases) {
		await test.test(c.name, async () => {
			const times = [];
			const trips = [];
			for (let n = 0; n < 3; n++) {
				await f.db.transaction(async (tx) => {
					statements = [];
					recording = true;
					const start = performance.now();
					let result;
					try {
						result = await currentActor(tx, sessionId.parse(c.account.session), owner.parse(c.selected));
					} finally {
						times.push(performance.now() - start);
						recording = false;
					}
					assert.deepEqual(result, c.expected);
					trips.push(statements.length);
				});
			}
			test.diagnostic(
				JSON.stringify({ actor: c.name, roundTrips: statements.length, milliseconds: times.map((n) => Math.round(n)) }),
			);
			assert.ok(
				trips.every((n) => n <= 2),
				`${c.name}: ${trips.join(", ")} round trips, expected at most 2 each`,
			);
			if (!["foreign account", "seatless workspace"].includes(c.name)) {
				await f.db.transaction(async (tx) => {
					statements = [];
					recording = true;
					let resolved;
					try {
						resolved = await RequestActor.resolve(tx, sessionId.parse(c.account.session));
					} finally {
						recording = false;
					}
					assert.deepEqual(resolved instanceof RequestActor ? resolved.actor : resolved, c.expected);
					assert.ok(statements.length <= 2, `auto-selected ${c.name}: ${statements.length} trips`);
				});
			}
			assert.equal(
				statements.some((sql) => /for\s+update/i.test(sql)),
				false,
				"Reads must not lock for update",
			);
		});
	}
});

test("INV-identity: deletion committed while actor waits for a root lock denies access", async (test) => {
	const f = await fixture();
	test.after(() => f.close());
	for (const kind of ["account", "plant"]) {
		await test.test(kind, async () => {
			const s = await f.setup();
			const load = () =>
				f.db.transaction((tx) => currentActor(tx, sessionId.parse(s.sender.session), owner.parse(s.w)));
			const initial = await load();
			assert.equal(initial.status, "active");
			assert.equal(initial.accountId, s.sender.id);
			let actor;
			try {
				await f.admin.transaction(async (tx) => {
					if (kind === "account") await tx.select().from(t.account).where(eq(t.account.id, s.sender.id)).for("update");
					else await tx.select().from(t.plant).where(eq(t.plant.id, s.w.id)).for("update");
					const pid = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
					actor = load();
					let blocked = false;
					for (let n = 0; n < 50; n++) {
						const waiting = await tx.execute(
							sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`,
						);
						if (waiting.rows[0].n > 0) {
							blocked = true;
							break;
						}
					}
					assert.equal(blocked, true, "Actor must reach the held root lock before deletion");
					await tx.insert(t.lifecycle_witness).values({
						kind,
						opaque_subject_id: kind === "account" ? s.sender.id : s.w.id,
						account_id: kind === "account" ? s.sender.id : null,
						plant_id: kind === "plant" ? s.w.id : null,
						request_id: key(),
						requester_id: s.sender.id,
						request_revision: "1",
						state: "pending_deletion",
						requested_at: new Date(),
						cancel_until: new Date(Date.now() + 30 * 86400000),
						witness_checkpoint: "1",
						cleanup_state: "not_started",
					});
				});
				assert.deepEqual(await actor, { status: "unavailable" });
			} finally {
				if (actor) await actor;
			}
		});
	}
});

test("INV-request-page: native session, viewer and page reads use bounded trips and two transactions", async (test) => {
	const f = await fixture();
	test.after(() => f.close());
	const native = f.native();
	const email = key() + "@example.test",
		password = "Request-page-password-1";
	await native("register", { kind: "discovery", name: "Request Viewer", email, password, requestKey: key() });
	const login = await native("sign-in/email", { email, password });
	assert.equal(login.status, 200);
	const cookie = login.headers
		.getSetCookie()
		.map((v) => v.split(";")[0])
		.join("; ");
	const session = await native.auth.api.getSession({ headers: new Headers({ cookie }) });
	assert.equal(session.user.email, email);
	const [account] = await f.admin.select().from(t.account).where(eq(t.account.auth_user_id, session.user.id));
	await f.admin.update(t.account).set({ registration_state: "active" }).where(eq(t.account.id, account.id));
	const workspace = await f.workspace();
	const seat = await f.seat(account, workspace);
	const ids = Array.from({ length: 25 }, () => key());
	await f.admin.insert(t.person).values(
		ids.map((id, n) => ({
			id,
			tenant_id: workspace.id,
			plant_id: workspace.id,
			display_name: `Request Person ${String(n).padStart(2, "0")}`,
			source: "other",
			created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
			state: "live",
			stage: "prospect",
			commitment_state: "unknown",
			adult_classification: "unknown",
			pipeline_position: String(n + 1),
			linked_account_id: n === 0 ? account.id : null,
		})),
	);
	let recording = false,
		statements = [];
	const instrumented = new WeakSet();
	for (const store of [f.db, f.admin])
		store.$client.on("acquire", (client) => {
			if (instrumented.has(client)) return;
			instrumented.add(client);
			const query = client.query;
			test.mock.method(client, "query", function (...args) {
				if (recording) statements.push(typeof args[0] === "string" ? args[0] : args[0].text);
				return Reflect.apply(query, this, args);
			});
		});
	let viewer;
	async function measure(name, page) {
		statements = [];
		recording = true;
		let value;
		try {
			const session = await native.auth.api.getSession({ headers: new Headers({ cookie }) });
			const resolved = await f.db.transaction((tx) => readPeopleViewer(tx, sessionId.parse(session.session.id)));
			assert.equal(resolved.status, "viewer");
			viewer = resolved.viewer;
			assert.equal(viewer.displayName, "Request Person 00");
			assert.equal(viewer.ownPersonId, ids[0]);
			value = await f.db.transaction((tx) => page(tx, new PeopleReadContext(viewer.authority, "native")));
		} finally {
			recording = false;
		}
		const result = {
			page: name,
			roundTrips: statements.length,
			transactions: statements.filter((s) => /^begin/i.test(s)).length,
		};
		test.diagnostic(JSON.stringify(result));
		assert.equal(result.transactions, 2);
		assert.equal(
			statements.filter((s) => /access_session\(/.test(s)).length,
			1,
			"Resolve the actor once per page request",
		);
		assert.equal(
			statements.some((s) => /savepoint/i.test(s)),
			false,
			"Reads create no savepoints",
		);
		return { value, ...result };
	}
	const list = await measure("list", (tx, ctx) =>
		readPeoplePage(tx, ctx, parseQuery(new URLSearchParams("search=Request+Person"))),
	);
	assert.equal(list.value.data.kind, "list");
	assert.deepEqual(
		list.value.data.page.items.map((p) => p.id),
		ids.slice(0, 24),
	);
	assert.equal(list.value.data.page.total, 25);
	const person = await measure("person", (tx, ctx) => readPersonPage(tx, ctx, ids[0]));
	assert.equal(person.value.status, "ok");
	assert.equal(person.value.value.found.person.displayName, "Request Person 00");
	assert.deepEqual(person.value.value.link, { status: "ok", value: { status: "linked", personId: ids[0] } });
	// A read snapshot can never authorize a later write. The writer must recheck
	// its session/seat inside the mutation transaction even with this context.
	await f.admin.update(t.seat).set({ ended_at: new Date() }).where(eq(t.seat.id, seat));
	const stale = Object.assign(new PeopleReadContext(viewer.authority, "native"), { origin: { kind: "native" } });
	const changed = await f.db.transaction((tx) =>
		peopleWriter.updatePerson(tx, stale, {
			requestKey: key(),
			expectedRevision: "1",
			input: { personId: ids[0], patch: { displayName: "Must refuse" } },
		}),
	);
	assert.equal(changed.status, "refused");
	assert.equal(changed.error.code, "unavailable");
	assert.equal(
		(await f.admin.select().from(t.person).where(eq(t.person.id, ids[0])))[0].display_name,
		"Request Person 00",
	);
	const next = await f.db.transaction((tx) => readPeopleViewer(tx, sessionId.parse(session.session.id)));
	assert.deepEqual(next, { status: "no_access" });
	assert.ok(
		list.roundTrips <= 12,
		`Full list request: ${list.roundTrips} round trips, expected at most 12 including native auth and both transactions`,
	);
	assert.ok(person.roundTrips <= 16, `Full person request: ${person.roundTrips} round trips, expected at most 16`);
});
