import test from "node:test";
import assert from "node:assert/strict";
import { fixture, key } from "./invitations-support.mts";
import { currentActor } from "../../../packages/domain/src/access/index.ts";
import { owner, sessionId } from "../../../packages/contracts/src/common/index.ts";
import { eq, sql } from "../../../packages/db/src/query.ts";
import * as t from "../../../packages/db/src/schema/tables.ts";

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
