import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture } from "../identity/invitations-support.mts";
import { GLOBAL_TENANT, readFlags, setFlag } from "../../../packages/domain/src/flags/index.ts";
import { withFlag } from "../../support/flags.mts";

const declared = {
	"test-release": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-kill": {
		owner: "Tests",
		task: "T-470",
		kind: "kill",
		default: true,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-global": {
		owner: "Tests",
		task: "T-470",
		kind: "ops",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-workspace": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-account": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-audit": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-tenancy": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-ended": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
	"test-helper": {
		owner: "Tests",
		task: "T-470",
		kind: "release",
		default: false,
		created: "2026-11-18",
		expires: "2027-01-01",
	},
} as const;

let f, plantA, plantB, operator, a1, a2, b1, loner;
const read = async (who, name) => (await readFlags(f.db, who?.actor ?? null, declared)).value(name);
const set = (flag, scope, value) => setFlag(f.db, { flag, scope, value, operator: operator.id }, declared);

before(async () => {
	f = await fixture();
	plantA = await f.workspace();
	plantB = await f.workspace();
	operator = await f.account();
	const seated = async (w, role = "owner") => {
		const account = await f.account();
		await f.seat(account, w, role);
		return { ...account, actor: await f.actor(account.session) };
	};
	a1 = await seated(plantA);
	a2 = await seated(plantA, "member");
	b1 = await seated(plantB);
	const alone = await f.account();
	loner = { ...alone, actor: await f.actor(alone.session) };
});
after(() => f?.close());

test("with no stored value a flag reads its registry default, off for a release flag and on for a kill flag", async () => {
	assert.equal(await read(a1, "test-release"), false);
	assert.equal(await read(a1, "test-kill"), true);
	assert.equal(await read(null, "test-kill"), true);
	assert.equal((await readFlags(f.db, a1.actor)).value("overview-role-subtitle"), false);
});

test("a global value, once set, is what every actor reads", async () => {
	await set("test-global", { kind: "global" }, true);
	assert.deepEqual(await Promise.all([a1, a2, b1, loner, null].map((who) => read(who, "test-global"))), [
		true,
		true,
		true,
		true,
		true,
	]);
	await set("test-kill", { kind: "global" }, false);
	assert.equal(await read(b1, "test-kill"), false);
});

test("a workspace override beats the global value in that workspace only", async () => {
	await set("test-workspace", { kind: "global" }, true);
	await set("test-workspace", { kind: "workspace", id: plantA.id }, false);
	assert.deepEqual(await Promise.all([a1, a2, b1].map((who) => read(who, "test-workspace"))), [false, false, true]);
});

test("an account override beats the workspace override for that account only", async () => {
	await set("test-account", { kind: "workspace", id: plantA.id }, true);
	await set("test-account", { kind: "account", id: a1.id }, false);
	assert.deepEqual(await Promise.all([a1, a2, b1].map((who) => read(who, "test-account"))), [false, true, false]);
	await set("test-account", { kind: "account", id: a1.id }, null);
	assert.equal(await read(a1, "test-account"), true);
});

test("each value change writes one audit row naming the actor, flag, scope and before and after values", async () => {
	const audit = async () =>
		(
			await f.admin.execute(sql`SELECT a.tenant_id::text AS tenant, a.actor_id::text AS actor, a.kind,
 a.subject_type AS "subjectType", a.subject_id::text AS subject, a.before_value->'value' AS before,
 a.after_value->'value' AS after, a.metadata AS metadata
 FROM audit_event a JOIN feature_flag f ON f.id=a.subject_id
 WHERE a.action='flags.changed' AND f.name='test-audit' ORDER BY a.occurred_at, a.id`)
		).rows;
	const changes = [
		[{ kind: "global" }, true, GLOBAL_TENANT],
		[{ kind: "workspace", id: plantA.id }, false, plantA.id],
		[{ kind: "account", id: a1.id }, true, a1.id],
		[{ kind: "account", id: a1.id }, null, a1.id],
		[{ kind: "workspace", id: plantA.id }, null, plantA.id],
		[{ kind: "global" }, null, GLOBAL_TENANT],
	] as const;
	const results = [];
	for (const [scope, value] of changes) results.push(await set("test-audit", scope, value));
	assert.deepEqual(
		results.map((r) => r.changed),
		[true, true, true, true, true, true],
	);
	const rows = await audit();
	assert.deepEqual(
		rows.map(({ subject, ...row }) => row),
		changes.map(([scope, value, tenant]) => ({
			tenant,
			actor: operator.id,
			kind: "edit",
			subjectType: "feature_flag",
			before: value === null ? (scope.kind === "workspace" ? false : true) : null,
			after: value,
			metadata: { flag: "test-audit", scope: scope.kind },
		})),
	);
	assert.equal(new Set(rows.map((r) => r.subject)).size, 3, "one subject per flag and scope");
	assert.deepEqual(await set("test-audit", { kind: "global" }, null), { changed: false, before: null, after: null });
	await set("test-audit", { kind: "global" }, true);
	assert.deepEqual(await set("test-audit", { kind: "global" }, true), { changed: false, before: true, after: true });
	assert.equal((await audit()).length, changes.length + 1, "an unchanged value writes no audit row");
});

test("another tenant's workspace or account override is never read", async () => {
	await set("test-tenancy", { kind: "workspace", id: plantA.id }, true);
	await set("test-tenancy", { kind: "account", id: a2.id }, true);
	assert.deepEqual(await Promise.all([a1, b1, loner, null].map((who) => read(who, "test-tenancy"))), [
		true,
		false,
		false,
		false,
	]);
	await assert.rejects(set("test-tenancy", { kind: "workspace", id: a1.id }, true), /flag_scope_unavailable/);
	await assert.rejects(set("test-tenancy", { kind: "account", id: plantB.id }, true), /flag_scope_unavailable/);
	await assert.rejects(
		setFlag(f.db, { flag: "not-registered", scope: { kind: "global" }, value: true, operator: operator.id }, declared),
		/flag_not_registered/,
	);
});

test("an actor whose seat has ended no longer reads the workspace override", async () => {
	const ended = await f.account();
	await f.seat(ended, plantA, "member");
	const who = { actor: await f.actor(ended.session) };
	await set("test-ended", { kind: "workspace", id: plantA.id }, true);
	assert.equal(await read(who, "test-ended"), true);
	await f.admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${ended.id}::uuid`);
	assert.equal(await read(who, "test-ended"), false);
	assert.equal(await read(a1, "test-ended"), true);
});

test("withFlag sets a flag for one tenant while its body runs and clears it after", async () => {
	const seen = await withFlag(
		f.db,
		{ flag: "test-helper", scope: { kind: "workspace", id: plantA.id }, operator: operator.id, declared },
		() => Promise.all([read(a1, "test-helper"), read(b1, "test-helper")]),
	);
	assert.deepEqual(seen, [true, false]);
	assert.equal(await read(a1, "test-helper"), false);
});
