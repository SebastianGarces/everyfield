import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import * as S from "./support.mts";
import * as I from "../identity/support.mts";
import * as Q from "../../../packages/contracts/src/organizations/index.ts";
import { OrganizationRefusal, readAnswerableInvitation } from "../../../packages/domain/src/organizations/index.ts";
import { RequestActor, readRequestViewer } from "../../../packages/domain/src/access/index.ts";
import { createMailService } from "../../../packages/domain/src/jobs/mail.ts";
import { authorizeNotificationMail } from "../../../packages/domain/src/jobs/notice-mail.ts";
import { getPlant, getSendingChurch, listPlants } from "../../../packages/domain/src/oversight/index.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import { createNotificationWorker } from "../../../apps/web/src/features/notifications/worker.ts";
import { evryActor, READ_DOMAINS } from "../../../packages/evry/src/index.ts";
import { REVIEWED_WRITES } from "../../../packages/evry/src/proposals/review.ts";
import { RELATIONSHIP_COMMANDS } from "../../../packages/evry/src/adapters/relationships/commands/index.ts";
import { scriptedQualifiedModel } from "../../../packages/evry-scripted/src/index.ts";
import { harness } from "../../evry/evals/intelligence-harness.mts";
import { nativePorts } from "../../evry/evals/settings-ports.mts";
import { ok } from "../../support/fixture.mts";

after(S.teardown);
type Tenant = Awaited<ReturnType<typeof S.tenant>>;
type Identity = Awaited<ReturnType<typeof S.identity>>;
type Role = "owner" | "admin" | "member";
const ROLES: Role[] = ["owner", "admin", "member"];
type Org = { o: Tenant } & Record<Role, Identity>;
const rows = async (q: Parameters<typeof S.db.execute>[0]) => (await S.db.execute(q)).rows as Record<string, unknown>[];
const one = async (q: Parameters<typeof S.db.execute>[0]) => (await rows(q))[0]!;

async function staffed(kind: Parameters<typeof S.tenant>[0], name?: string): Promise<Org> {
	const o = await S.tenant(kind, name);
	return {
		o,
		owner: await S.identity(o, "owner"),
		admin: await S.identity(o, "admin"),
		member: await S.identity(o, "member"),
	};
}
async function church() {
	const p = await staffed("plant", "Harvest");
	return {
		p,
		S1: await staffed("sending_church", "First Church"),
		S2: await staffed("sending_church", "Second Church"),
		N1: await staffed("sending_network", "North Network"),
		N2: await staffed("sending_network", "South Network"),
	};
}
type Church = Awaited<ReturnType<typeof church>>;
type Name = "S1" | "S2" | "N1" | "N2";
const pairOf = (subject: Tenant | Identity, o: Tenant) =>
	"account" in subject
		? { kind: "discovery" as const, accountId: subject.account, organization: o }
		: { kind: subject.kind === "plant" ? ("plant" as const) : ("sending_church" as const), subject, organization: o };
const request = async (by: Identity, subject: Tenant | Identity, o: Tenant, email: string) =>
	Q.invitationResult.parse(
		await S.call("associations.invite", by, S.command({ pair: pairOf(subject, o), recipientEmail: email })),
	);
type Pending = Awaited<ReturnType<typeof request>>;
const acceptance = (i: Pending, key: string = randomUUID(), revision = "1") =>
	S.command(
		{ invitationId: i.invitationId, proof: S.proofs.get(i.invitationId), decision: "accept" as const },
		revision,
		key as ReturnType<typeof randomUUID>,
	);
async function approve(i: Pending, by: Identity, key?: string) {
	const r = Q.acceptedInvitationResult.parse(await S.call("associations.acceptInvitation", by, acceptance(i, key)));
	if (r.status !== "accepted") throw Error(r.status);
	return r.relationship;
}
const join = async (c: Church, name: Name) =>
	approve(await request(c.p.owner, c.p.o, c[name].o, c[name].owner.email), c[name].owner);
type Link = Awaited<ReturnType<typeof join>>;
const ending = (
	l: Link,
	key: string = randomUUID(),
	over: { pair?: unknown; revision?: string; reason?: string | null } = {},
) =>
	S.command(
		{ relationshipId: l.id, pair: over.pair ?? l.pair, confirmed: true, reason: over.reason ?? null },
		over.revision ?? l.revision,
		key as ReturnType<typeof randomUUID>,
	);
const end = (by: S.Actor, l: Link, key?: string, over?: Parameters<typeof ending>[2]) =>
	S.call("associations.end", by, ending(l, key, over));

async function history(by: Identity, scope: object) {
	const h = Q.relationshipHistoryResult.parse(await S.call("associations.getHistory", by, scope));
	if (h.status !== "available") throw Error(h.status);
	return { ...h, items: h.items.toSorted((a, b) => a.occurredAt.localeCompare(b.occurredAt)) };
}
const activeOf = async (c: Church, by: Identity = c.p.owner) =>
	(await history(by, { plant: c.p.o })).activeRelationships
		.map((r) => (["S1", "S2", "N1", "N2"] as const).find((n) => c[n].o.id === r.pair.organization.id))
		.sort();
const events = (id: string, action = "affiliation.%") =>
	rows(
		sql`SELECT action,actor_id,before_revision::text AS before,after_revision::text AS after,reason,metadata FROM audit_event WHERE subject_id=${id} AND action LIKE ${action} ORDER BY after_revision`,
	);
const actions = async (id: string) => (await events(id)).map((e) => e.action);
const recorded = async (key: string) =>
	Number((await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE request_key=${key}`)).n);
const seats = async () => Number((await one(sql`SELECT count(*)::int AS n FROM seat`)).n);
const liveSeats = async (who: Identity) =>
	Number((await one(sql`SELECT count(*)::int AS n FROM seat WHERE account_id=${who.account} AND ended_at IS NULL`)).n);
const links = () => rows(sql`SELECT to_jsonb(a) AS row FROM affiliation a ORDER BY a.id`);
const orgs = () => rows(sql`SELECT to_jsonb(o) AS row FROM organization o ORDER BY o.id`);
const jobs = (id: string) =>
	rows(sql`SELECT tenant_id,producer_key,state FROM job WHERE subject_record_id=${id} ORDER BY source_revision`);

let tables: string[] | undefined;
async function state(): Promise<Record<string, string>> {
	tables ??= (
		await rows(
			sql`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY 1`,
		)
	).map((r) => String(r.t));
	const found = await rows(
		sql.raw(
			tables
				.map(
					(t) =>
						`SELECT '${t}' AS t, coalesce(md5(string_agg(to_jsonb(x)::text, '|' ORDER BY to_jsonb(x)::text)),'') AS h FROM "${t}" x`,
				)
				.join(" UNION ALL "),
		),
	);
	return Object.fromEntries(found.map((r) => [String(r.t), String(r.h)]));
}
async function changed(body: () => Promise<unknown>) {
	const before = await state();
	await body();
	const now = await state();
	return Object.keys(now)
		.filter((t) => now[t] !== before[t])
		.sort();
}
async function unchanged<T>(body: () => Promise<T>): Promise<T> {
	let result!: T;
	assert.deepEqual(await changed(async () => (result = await body())), []);
	return result;
}
const refuses = (body: () => Promise<unknown>, code = "unavailable") =>
	unchanged(() =>
		assert.rejects(body, (e) => {
			assert.ok(e instanceof OrganizationRefusal, String(e));
			assert.deepEqual([e.code, e.message, Object.keys(e)], [code, code, ["code"]]);
			return true;
		}),
	);
const direct = (
	name: "associations.end" | "associations.acceptInvitation",
	by: unknown,
	selected: unknown,
	q: unknown,
) => S.tx((c): Promise<unknown> => S.api[name](c, by as never, selected as never, q));
async function failing<T>(table: string, body: () => Promise<T>): Promise<T> {
	await S.db.execute(
		sql`CREATE OR REPLACE FUNCTION fail_required() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_write_failure'; END $$`,
	);
	await S.db.execute(
		sql.raw(`CREATE TRIGGER fail_required BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_required()`),
	);
	try {
		return await body();
	} finally {
		await S.db.execute(sql.raw(`DROP TRIGGER fail_required ON ${table}`));
	}
}
const breaks = (body: () => Promise<unknown>) =>
	unchanged(() =>
		assert.rejects(body, (e: Error & { cause?: { message?: string } }) => {
			assert.match(String(e.cause?.message), /synthetic_write_failure/);
			return true;
		}),
	);
const as = async (who: { session: string }) => {
	const found = await RequestActor.resolve(S.runtime, who.session as never);
	assert.ok(found instanceof RequestActor);
	return found;
};
const listed = async (who: Identity) => (await listPlants(S.runtime, await as(who)))!.plants.map((r) => r.plantId);
const page = async (who: Identity, c: Church) => getPlant(S.runtime, await as(who), c.p.o.id);

const ENDED_TABLES = ["affiliation", "audit_event", "job", "organization", "record"];

const CONFIGURATIONS: [string, Name[]][] = [
	["AC:AF-001 zero affiliations", []],
	["AC:AF-002 one sending church", ["S1"]],
	["AC:AF-003 one network", ["N1"]],
	["AC:AF-004 one of each", ["S1", "N1"]],
	["AC:AF-005 two sending churches", ["S1", "S2"]],
	["AC:AF-006 two networks", ["N1", "N2"]],
];
for (const [label, names] of CONFIGURATIONS)
	test(`${label} read as exactly the approved links, for every seat of the plant and nobody else, with no new seat`, async () => {
		const c = await church();
		const before = await seats();
		for (const n of names) await join(c, n);
		assert.equal(await seats(), before);
		const foreign = await S.identity(await S.tenant("plant"));
		await unchanged(async () => {
			for (const role of ROLES)
				for (let repeat = 0; repeat < 2; repeat++) assert.deepEqual(await activeOf(c, c.p[role]), [...names].sort());
			for (const who of [foreign, ...(["S1", "S2", "N1", "N2"] as const).flatMap((n) => ROLES.map((r) => c[n][r]))])
				assert.deepEqual(await S.call("associations.getHistory", who, { plant: c.p.o }), { status: "unavailable" });
			for (const n of ["S1", "S2", "N1", "N2"] as const)
				for (const role of ROLES)
					assert.deepEqual(await listed(c[n][role]), names.includes(n) ? [c.p.o.id] : [], `${n} ${role}`);
		});
		if (names.length < 2) return;
		const [first, second] = names as [Name, Name];
		const shown = await history(c.p.owner, { plant: c.p.o });
		const relationshipId = shown.activeRelationships.find((r) => r.pair.organization.id === c[first].o.id)!.id;
		await S.call(
			"privacy.setSharing",
			c.p.admin,
			S.command({
				plant: c.p.o,
				organization: c[first].o,
				relationshipId,
				category: "people",
				enabled: false,
				expectedConsentRevision: "1",
			}),
		);
		assert.deepEqual((await page(c[first].admin, c))!.sections.people, { status: "withheld" });
		assert.deepEqual((await page(c[second].admin, c))!.sections.people, { status: "empty" });
		assert.deepEqual(await activeOf(c), [...names].sort());
	});

test("AC:AF-007 a pending request is no active link and gives the organization no oversight, no plant authority and no seat", async () => {
	const c = await church();
	const before = await seats();
	const i = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	assert.equal(i.status, "pending");
	const outsiders = [...ROLES.map((r) => c.S1[r]), c.N1.admin];
	await unchanged(async () => {
		for (const role of ROLES) assert.deepEqual(await activeOf(c, c.p[role]), []);
		assert.deepEqual((await history(c.p.owner, { plant: c.p.o })).items, []);
		for (const who of outsiders) {
			assert.deepEqual(await listed(who), []);
			assert.equal(await page(who, c), null);
			assert.deepEqual(await S.call("associations.getHistory", who, { plant: c.p.o }), { status: "unavailable" });
			assert.deepEqual(await S.call("privacy.getSharing", who, { plant: c.p.o, organization: c.S1.o }), {
				status: "unavailable",
			});
			assert.deepEqual((await history(who, { organization: who.selected })).activeRelationships, []);
		}
		assert.equal(await RequestActor.resolve(S.runtime, c.S1.admin.session).then((r) => r.status), "active");
		assert.equal(
			await S.tx((t) => RequestActor.claimWrite(t, c.S1.admin.session, c.p.o)),
			null,
			"the organization cannot act in the plant",
		);
	});
	assert.equal(await seats(), before);
	assert.deepEqual(await rows(sql`SELECT id FROM affiliation WHERE plant_id=${c.p.o.id}`), []);
});

test("AC:AF-013 a network reaches no plant through its sending church", async () => {
	const c = await church();
	await join(c, "S1");
	const parent = await approve(await request(c.S1.owner, c.S1.o, c.N1.o, c.N1.owner.email), c.N1.owner);
	assert.equal(parent.pair.kind, "sending_church");
	await unchanged(async () => {
		assert.deepEqual(await listed(c.S1.member), [c.p.o.id], "the sending church has its own direct link");
		for (const role of ROLES) {
			const who = c.N1[role];
			assert.deepEqual(await listed(who), []);
			assert.equal(await page(who, c), null);
			const child = await getSendingChurch(S.runtime, await as(who), c.S1.o.id);
			assert.equal(child!.name, "First Church");
			assert.deepEqual(child!.plants, []);
			assert.equal(JSON.stringify(child).includes(c.p.o.id), false);
			assert.deepEqual(
				(await history(who, { organization: c.N1.o })).activeRelationships.map((r) => r.id),
				[parent.id],
			);
			assert.deepEqual(await S.call("privacy.getSharing", who, { plant: c.p.o, organization: c.N1.o }), {
				status: "unavailable",
			});
			assert.deepEqual(await S.call("associations.getHistory", who, { plant: c.p.o }), { status: "unavailable" });
		}
		for (const role of ROLES) assert.equal(await listPlants(S.runtime, await as(c.p[role])), null, `plant ${role}`);
		assert.deepEqual(await activeOf(c), ["S1"]);
		assert.equal(await S.tx((t) => RequestActor.claimWrite(t, c.N1.admin.session, c.p.o)), null);
	});
});

test("AC:AF-008 two organizations approving at the same time both link, and neither waits for or replaces the other", async () => {
	const c = await church();
	const before = await seats();
	const [s, n] = [
		await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email),
		await request(c.p.admin, c.p.o, c.N1.o, c.N1.admin.email),
	];
	const keys = [randomUUID(), randomUUID()] as const;
	let second!: Link;
	const first = await S.write(c.S1.admin, async (tx) => {
		const held = await S.api["associations.acceptInvitation"](
			tx,
			c.S1.admin.session,
			c.S1.admin.selected,
			acceptance(s, keys[0]),
		);
		second = await approve(n, c.N1.admin, keys[1]);
		return held;
	});
	assert.equal(first.status, "accepted");
	if (first.status !== "accepted") throw Error();
	assert.deepEqual(await activeOf(c), ["N1", "S1"]);
	assert.deepEqual([await recorded(keys[0]), await recorded(keys[1])], [1, 1]);
	assert.deepEqual(
		[await actions(first.relationship.id), await actions(second.id)],
		[["affiliation.approved"], ["affiliation.approved"]],
	);
	assert.equal(await seats(), before);
	assert.deepEqual([await listed(c.S1.admin), await listed(c.N1.admin)], [[c.p.o.id], [c.p.o.id]]);
});

const APPROVALS: [string, Role, Role][] = [
	["AC:AF-011 AC:AF-018 the plant Owner asks, one organization Admin approves", "owner", "admin"],
	["AC:AF-011 an ordinary plant Admin asks, the organization Owner approves", "admin", "owner"],
	["AC:AF-011 AC:AF-018 an ordinary plant Admin asks, one organization Admin approves", "admin", "admin"],
	["AC:AF-011 the plant Owner asks, the organization Owner approves", "owner", "owner"],
];
for (const [label, asker, approver] of APPROVALS)
	test(`${label}: that one approval links them, once, with no seat and no vote from anyone else`, async () => {
		const c = await church();
		const other = await join(c, "N1");
		const before = await seats();
		await refuses(() => request(c.p.member, c.p.o, c.S1.o, c.S1[approver].email));
		for (const who of [c.N1.admin, c.S1.admin]) await refuses(() => request(who, c.p.o, c.S1.o, c.S1[approver].email));
		const i = await request(c.p[asker], c.p.o, c.S1.o, c.S1[approver].email);
		const by = c.S1[approver];
		const others = [
			...ROLES.filter((r) => r !== approver).map((r) => c.S1[r]),
			...ROLES.map((r) => c.N1[r]),
			c.p.owner,
		];
		for (const who of others) await refuses(() => S.call("associations.acceptInvitation", who, acceptance(i)));
		await refuses(
			() => S.call("associations.acceptInvitation", by, acceptance(i, randomUUID(), "9")),
			"stale_revision",
		);
		const key = randomUUID();
		const otherLink = (await links()).find((l) => (l.row as { id: string }).id === other.id);
		const r = await approve(i, by, key);
		assert.deepEqual(r.pair.organization, c.S1.o);
		assert.equal(r.endedAt, null);
		assert.deepEqual(await unchanged(() => approve(i, by, key)), r, "the same request returns the same outcome");
		assert.equal(await recorded(key), 1);
		assert.deepEqual(
			(await events(r.id)).map((e) => [e.action, e.actor_id, e.metadata]),
			[["affiliation.approved", by.account, { pair: r.pair, sourceInvitationId: i.invitationId }]],
		);
		assert.deepEqual(await activeOf(c), ["N1", "S1"]);
		assert.deepEqual(
			(await links()).find((l) => (l.row as { id: string }).id === other.id),
			otherLink,
			"the other link keeps its own state and consent",
		);
		assert.equal(await seats(), before);
	});

test("AC:AF-009 the same organization approving twice, at once and again later, leaves one link, one event and one outcome", async () => {
	const c = await church();
	await join(c, "N1");
	const before = await seats();
	const i = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	const key = randomUUID();
	const [a, b] = await Promise.all([approve(i, c.S1.admin, key), approve(i, c.S1.admin, key)]);
	assert.deepEqual(a, b);
	assert.deepEqual(await unchanged(() => approve(i, c.S1.admin, key)), a);
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i, randomUUID(), "2")));
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i)), "stale_revision");
	await refuses(() => request(c.p.owner, c.p.o, c.S1.o, c.S1.owner.email), "already_active");
	assert.equal(a.pair.organization.id, c.S1.o.id);
	assert.equal(await recorded(key), 1);
	assert.deepEqual(await actions(a.id), ["affiliation.approved"]);
	assert.deepEqual(
		await rows(sql`SELECT id FROM affiliation WHERE plant_id=${c.p.o.id} AND organization_id=${c.S1.o.id}`),
		[{ id: a.id }],
	);
	assert.deepEqual(await activeOf(c), ["N1", "S1"]);
	assert.equal(await seats(), before);
});

test("AC:AF-016 without the plant's live consent the organization's approval links nothing", async () => {
	const c = await church();
	await join(c, "N1");
	const before = await seats();
	for (const who of [c.S1.owner, c.S1.admin]) await refuses(() => request(who, c.p.o, c.S1.o, c.S1.admin.email));
	const consent: [string, string, string][] = [
		["the asker's seat ended", "ended_at=clock_timestamp()", "ended_at=NULL"],
		["the asker is now a Member", "role='member'", "role='admin'"],
	];
	const i = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	for (const [label, withdraw, restore] of consent) {
		const set = (change: string) =>
			S.db.execute(sql`UPDATE seat SET ${sql.raw(change)} WHERE account_id=${c.p.admin.account}`);
		await set(withdraw);
		for (const name of ["associations.acceptInvitation", "associations.respondInvitation"] as const)
			await refuses(() => S.call(name, c.S1.admin, acceptance(i)));
		assert.deepEqual(await activeOf(c), ["N1"], label);
		await set(restore);
	}
	await S.call("associations.revokeInvitation", c.p.admin, S.command({ invitationId: i.invitationId }));
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i)), "stale_revision");
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i, randomUUID(), "2")));
	assert.deepEqual(await activeOf(c), ["N1"]);
	assert.deepEqual(await rows(sql`SELECT id FROM affiliation WHERE organization_id=${c.S1.o.id}`), []);
	assert.deepEqual(await listed(c.S1.admin), []);
	assert.equal(await seats(), before);
});

test("AC:AF-017 without the exact organization's approval the plant's consent links nothing", async () => {
	const c = await church();
	await join(c, "N1");
	const before = await seats();
	const i = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	for (const who of [c.p.admin, c.p.owner, c.p.member])
		for (const name of ["associations.acceptInvitation", "associations.respondInvitation"] as const)
			await refuses(() => S.call(name, who, acceptance(i)));
	for (const who of [c.S1.member, c.S1.owner])
		await refuses(() => S.call("associations.acceptInvitation", who, acceptance(i)));
	await refuses(() =>
		S.call(
			"associations.acceptInvitation",
			c.S1.admin,
			S.command({ invitationId: i.invitationId, proof: "wrong", decision: "accept" }),
		),
	);
	const set = (change: string) =>
		S.db.execute(sql`UPDATE seat SET ${sql.raw(change)} WHERE account_id=${c.S1.admin.account}`);
	await set("role='member'");
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i)));
	await set("role='admin'");
	await S.db.execute(
		sql`UPDATE invitation SET created_at=clock_timestamp()-interval '30 days' WHERE id=${i.invitationId}`,
	);
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i)));
	await S.db.execute(sql`UPDATE invitation SET created_at=clock_timestamp() WHERE id=${i.invitationId}`);
	await S.call(
		"associations.declineInvitation",
		c.S1.admin,
		S.command({ invitationId: i.invitationId, decision: "decline" }),
	);
	await refuses(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i, randomUUID(), "2")));
	assert.deepEqual(await activeOf(c), ["N1"]);
	assert.deepEqual(await rows(sql`SELECT id FROM affiliation WHERE organization_id=${c.S1.o.id}`), []);
	assert.deepEqual(await listed(c.S1.admin), []);
	assert.equal(await seats(), before);
});

test("AC:AF-019 a foreign organization and the plant's other affiliates can neither approve nor veto this link", async () => {
	const c = await church();
	await join(c, "N1");
	const i = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	const addressedElsewhere = await request(c.p.admin, c.p.o, c.S2.o, c.N2.admin.email);
	const outsiders = [...ROLES.map((r) => c.N2[r]), ...ROLES.map((r) => c.N1[r]), c.S2.admin];
	for (const who of outsiders) {
		for (const name of ["associations.acceptInvitation", "associations.respondInvitation"] as const)
			await refuses(() => S.call(name, who, acceptance(i)));
		await refuses(() =>
			S.call("associations.declineInvitation", who, S.command({ invitationId: i.invitationId, decision: "decline" })),
		);
		for (const name of ["associations.revokeInvitation", "associations.resendInvitation"] as const)
			await refuses(() => S.call(name, who, S.command({ invitationId: i.invitationId })));
		await refuses(() => direct("associations.acceptInvitation", who.session, c.S1.o, acceptance(i)));
		await refuses(() =>
			S.call(
				"associations.acceptInvitation",
				who,
				S.command({ invitationId: randomUUID(), proof: S.proofs.get(i.invitationId), decision: "accept" }),
			),
		);
	}
	await refuses(() => S.call("associations.acceptInvitation", c.N2.admin, acceptance(addressedElsewhere)));
	assert.deepEqual(await activeOf(c), ["N1"]);
	const approved = await approve(i, c.S1.admin);
	assert.equal(approved.pair.organization.id, c.S1.o.id);
	assert.deepEqual(await activeOf(c), ["N1", "S1"]);
});

const ENDERS: [string, "plant" | "organization", Role][] = [
	["the plant Owner", "plant", "owner"],
	["a plant Admin", "plant", "admin"],
	["the organization's Owner", "organization", "owner"],
	["an organization Admin", "organization", "admin"],
];
for (const [label, side, role] of ENDERS)
	test(`AC:AF-010 AC:AF-014 AC:AF-015 AC:AF-020 AC:AF-021 ${label} ends only the reviewed link: every other record stays, one event and one notice are kept, and nobody else can`, async () => {
		const c = await church();
		const s1 = await join(c, "S1");
		const n1 = await join(c, "N1");
		const pending = await request(c.p.owner, c.p.o, c.S2.o, c.S2.owner.email);
		await S.db.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at) VALUES(${randomUUID()},${c.p.o.id},${c.p.o.id},'Dana Ortiz','other',
			'core_group','unknown','unknown','1','live',clock_timestamp())`);
		const by = (side === "plant" ? c.p : c.S1)[role];
		const foreign = await S.identity(await S.tenant("plant"));
		const denied = [c.p.member, c.S1.member, ...ROLES.map((r) => c.N2[r]), ...ROLES.map((r) => c.N1[r]), foreign];
		const key = randomUUID();
		for (const who of denied) await refuses(() => end(who, s1));
		for (const who of [c.N2.admin, c.N1.admin, foreign]) {
			await refuses(() => end(who, { ...s1, id: randomUUID() as never }));
			if (who.selected.kind === "organization")
				await refuses(() => end(who, s1, randomUUID(), { pair: { ...s1.pair, organization: who.selected } }));
			await refuses(() => direct("associations.end", who.session, c.S1.o, ending(s1)));
			await refuses(() => direct("associations.end", who.session, c.p.o, ending(s1)));
			assert.deepEqual(await S.call("associations.getHistory", who, { plant: c.p.o, pair: s1.pair }), {
				status: "unavailable",
			});
			assert.deepEqual(await S.call("privacy.getSharing", who, { plant: c.p.o, organization: c.S1.o }), {
				status: "unavailable",
			});
			assert.deepEqual(
				await S.tx((t) =>
					readAnswerableInvitation(t, who.session, who.selected, {
						invitationId: pending.invitationId,
						proof: S.proofs.get(pending.invitationId),
					}),
				),
				{ status: "unavailable" },
			);
		}
		await refuses(() => end(by, s1, randomUUID(), { pair: n1.pair }));
		await refuses(() => end(by, s1, randomUUID(), { revision: "9" }), "stale_revision");
		for (const confirmed of [false, undefined, "yes"])
			await unchanged(() =>
				assert.rejects(
					S.call("associations.end", by, S.command({ ...ending(s1).input, confirmed })),
					(e: Error) => e.name === "ZodError",
				),
			);
		assert.deepEqual(await activeOf(c), ["N1", "S1"]);

		const before = { links: await links(), orgs: await orgs() };
		const touched = await changed(async () =>
			assert.deepEqual(Q.mutationResult.parse(await end(by, s1, key, { reason: "Retained domain reason" })), {
				status: "committed",
			}),
		);
		assert.deepEqual(touched, ENDED_TABLES, "no plant record, seat, invitation, consent or account changes");
		const others = (list: Record<string, unknown>[], id: string) =>
			list.filter((r) => (r.row as { id: string }).id !== id);
		assert.deepEqual(others(await links(), s1.id), others(before.links, s1.id));
		assert.deepEqual(others(await orgs(), c.S1.o.id), others(before.orgs, c.S1.o.id));
		const consent = (list: Record<string, unknown>[]) => {
			const {
				ended_at: _e,
				revision: _r,
				...kept
			} = list.map((l) => l.row as Record<string, unknown>).find((r) => r.id === s1.id)!;
			return kept;
		};
		assert.deepEqual(consent(await links()), consent(before.links), "the ended link keeps its history and choices");
		assert.equal(await recorded(key), 1);
		assert.deepEqual(await events(s1.id, "affiliation.ended"), [
			{
				action: "affiliation.ended",
				actor_id: by.account,
				before: "1",
				after: "2",
				reason: "Retained domain reason",
				metadata: {
					pair: s1.pair,
					sourceInvitationId: (await one(sql`SELECT invitation_id FROM affiliation WHERE id=${s1.id}`)).invitation_id,
				},
			},
		]);
		assert.deepEqual(await jobs(s1.id), [
			{ tenant_id: c.p.o.id, producer_key: "affiliation/approved/1", state: "ready" },
			{ tenant_id: c.p.o.id, producer_key: "affiliation/ended/2", state: "ready" },
		]);
		assert.deepEqual(await activeOf(c), ["N1"]);
		assert.deepEqual([await listed(c.S1.owner), await listed(c.N1.owner)], [[], [c.p.o.id]]);
		assert.equal((await rows(sql`SELECT id FROM plant WHERE id=${c.p.o.id}`)).length, 1);
		for (const who of [c.p.owner, c.p.admin, c.p.member, c.S1.owner, c.S1.admin]) assert.equal(await liveSeats(who), 1);
		const shown = await history(c.p.owner, { plant: c.p.o });
		assert.deepEqual(
			shown.items.filter((i) => i.pair.organization.id === c.S1.o.id).map((i) => [i.event, i.actor, i.reason]),
			[
				["approved", { kind: "account", accountId: c.S1.owner.account }, { status: "available", value: null }],
				["ended", { kind: "account", accountId: by.account }, { status: "available", value: "Retained domain reason" }],
			],
		);
		assert.deepEqual(
			await unchanged(() => end(by, s1, key, { reason: "Retained domain reason" })),
			{ status: "committed" },
			"the same request returns the same outcome",
		);
		assert.deepEqual(await end(by, s1), { status: "committed" });
		assert.equal((await events(s1.id, "affiliation.ended")).length, 1, "ending it again adds no event");
		assert.equal((await jobs(s1.id)).length, 2);
		await refuses(() => end(by, s1, key), "request_conflict");

		assert.equal((await approve(pending, c.S2.owner)).pair.organization.id, c.S2.o.id);
		assert.deepEqual(await activeOf(c), ["N1", "S2"], "a new approval replaces no other link");
	});

test("AC:AF-020 Evry's review names the exact link and what ending it does, and ends nothing by itself", async () => {
	const c = await church();
	const s1 = await join(c, "S1");
	await join(c, "N1");
	const write = RELATIONSHIP_COMMANDS["associations.end"];
	const actor = evryActor(await as(c.p.owner));
	const [found] = await unchanged(async () => {
		const query = await write.review(actor, { organizationId: c.S1.o.id }, {
			db: S.runtime,
			mail: null,
			native: null,
			conversationId: null,
		} as never);
		return (await S.runtime.execute(query!)).rows as { review: Record<string, unknown>; args: unknown }[];
	});
	assert.deepEqual(found!.review, {
		target: { kind: "connection", id: s1.id, label: "First Church" },
		changes: [{ field: "connection", before: "connected", after: "ended" }],
		notes: [
			"First Church stops seeing what you share now: People totals, Meetings, Tasks, Ministry teams, Wiki, Activity updates, Plant Intelligence findings.",
			"They are told the connection ended. To connect again, either side sends a new invitation.",
		],
	});
	assert.deepEqual(found!.args, {
		expectedRevision: "1",
		input: { relationshipId: s1.id, pair: s1.pair, confirmed: true, reason: null },
	});
	assert.deepEqual(await activeOf(c), ["N1", "S1"]);
});

function worker(refuse = false) {
	return createNotificationWorker({
		mail: createMailService({
			db: S.runtime,
			encryptionKey: randomBytes(32),
			addressKey: randomBytes(32),
			from: "links@example.test",
			authorize: refuse
				? async () => {
						throw Error("synthetic notice outage");
					}
				: authorizeNotificationMail,
			transport: {
				async send() {
					return { kind: "refused", retryable: true };
				},
				async lookup() {
					return { kind: "unknown" };
				},
			},
		}),
	});
}
async function runNotices(id: string, refuse = false) {
	await S.db.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()+interval '1 day' WHERE subject_record_id<>${id} AND state='ready'`,
	);
	await S.db.execute(
		sql`UPDATE job SET next_attempt_at=clock_timestamp()-interval '1 second', eligible_at=clock_timestamp()-interval '1 second' WHERE subject_record_id=${id} AND state='retry_wait'`,
	);
	const error = console.error;
	if (refuse) console.error = () => {};
	try {
		await worker(refuse).run(S.runtime, new Date().toISOString());
	} finally {
		console.error = error;
	}
}
const notices = (id: string) =>
	rows(sql`SELECT n.recipient_id AS recipient, n.title, n.safe_body AS body, m.state AS mail FROM notice n
		LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${id} AND split_part(n.logical_key,'/',5)='ended'`);

test("AC:ORG55-002 AC:AF-020 AC:TARGET-IDN-021 both sides ending one link at once, with retries and a failed notice, end it once and keep the notice for a retry", async () => {
	const c = await church();
	const s1 = await join(c, "S1");
	const n1 = await join(c, "N1");
	const keys = [randomUUID(), randomUUID()] as const;
	let rival!: Promise<unknown>;
	await S.write(c.p.admin, async (tx) => {
		const held = await S.api["associations.end"](tx, c.p.admin.session, c.p.admin.selected, ending(s1, keys[0]));
		assert.deepEqual(held, { status: "committed" });
		rival = end(c.S1.admin, s1, keys[1]);
		await S.waitingOnLock();
	});
	assert.deepEqual(await rival, { status: "committed" });
	for (const [who, key] of [
		[c.p.admin, keys[0]],
		[c.S1.admin, keys[1]],
	] as const)
		assert.deepEqual(await unchanged(() => end(who, s1, key)), { status: "committed" });
	await refuses(() => end(c.S1.owner, n1));
	await refuses(() => end(c.p.admin, s1, randomUUID(), { pair: n1.pair }));
	await refuses(() => end(c.p.admin, n1, randomUUID(), { revision: "2" }), "stale_revision");
	assert.deepEqual(await activeOf(c), ["N1"]);
	assert.equal((await events(s1.id, "affiliation.ended")).length, 1);
	assert.equal((await events(n1.id, "affiliation.ended")).length, 0);
	for (const who of [c.p.owner, c.p.admin, c.p.member]) assert.equal(await liveSeats(who), 1);

	await runNotices(s1.id, true);
	assert.deepEqual(await notices(s1.id), []);
	assert.deepEqual(
		(await jobs(s1.id)).find((j) => j.producer_key === "affiliation/ended/2"),
		{
			tenant_id: c.p.o.id,
			producer_key: "affiliation/ended/2",
			state: "retry_wait",
		},
	);
	assert.deepEqual(await activeOf(c), ["N1"], "a failed notice does not undo the end");
	await runNotices(s1.id);
	const told = [c.p.owner, c.p.admin].map((a) => a.account).sort();
	const sent = await notices(s1.id);
	assert.deepEqual(sent.map((n) => n.recipient).sort(), told);
	for (const n of sent)
		assert.deepEqual(
			[n.title, n.body, n.mail],
			["Connection ended: First Church", "Your church's connection with First Church has ended.", "pending"],
		);
	await runNotices(s1.id);
	assert.equal((await notices(s1.id)).length, told.length);
});

test("AC:GAP-IDN-027 an organization Admin ending its own link twice ends it once, beside an unprivileged caller, a foreign seat and an unavailable source", async () => {
	const p = await S.tenant("plant"),
		owner = await S.identity(p),
		a = await staffed("sending_church", "Org A"),
		b = await staffed("sending_network", "Org B");
	const linkA = await approve(await request(owner, p, a.o, a.owner.email), a.owner);
	const linkB = await approve(await request(owner, p, b.o, b.owner.email), b.owner);
	const active = async () => (await history(owner, { plant: p })).activeRelationships.map((r) => r.id).sort();
	const both = [linkA.id, linkB.id].sort();

	await refuses(() => direct("associations.end", randomUUID(), a.o, ending(linkA)));
	await unchanged(() => assert.rejects(direct("associations.end", null, a.o, ending(linkA))));

	const foreign = await S.identity(await S.tenant("plant"), "member");
	const foreignKey = randomUUID();
	for (let repeat = 0; repeat < 2; repeat++) {
		await refuses(() => end(foreign, linkA, foreignKey));
		await refuses(() => end(foreign, { ...linkA, id: randomUUID() as never }, foreignKey));
		assert.equal(await recorded(foreignKey), 0);
	}

	const away = () => S.db.execute(sql`ALTER TABLE affiliation RENAME TO affiliation_away`);
	const back = () => S.db.execute(sql`ALTER TABLE IF EXISTS affiliation_away RENAME TO affiliation`);
	const told: string[] = [];
	let outage: "none" | "starts" | "read" = "none";
	const scripted = scriptedQualifiedModel();
	assert.ok(scripted.status === "qualified" && typeof scripted.model === "object");
	const model = scripted.model;
	const evry = harness(S.runtime, new Date(), nativePorts(), {
		model: {
			...scripted,
			model: Object.assign(Object.create(model), {
				async doStream(call: never) {
					told.push(JSON.stringify((call as { prompt: unknown }).prompt));
					return model.doStream(call);
				},
			}),
		},
		accessCheck: async () => {
			if (outage === "read") {
				outage = "none";
				await back();
			}
			if (outage === "starts" && told.length) {
				outage = "read";
				await away();
			}
		},
	});
	const sources = async () => {
		const { affiliation, notice, mail, seat, proposal } = await state();
		const domain = await rows(sql`SELECT id FROM audit_event WHERE action NOT LIKE 'evry.%' ORDER BY id`);
		return { affiliation, notice, mail, seat, proposal, domain };
	};
	const ASK = "End our connection with Org A";
	const offered = await evry.ask(evryActor(await as(owner)), ASK);
	assert.deepEqual(
		offered.proposals.map((card) => card.operation),
		["associations.end"],
	);
	assert.equal(told.join().includes("source_unavailable"), false);
	const key = randomUUID();
	for (let repeat = 0; repeat < 2; repeat++) {
		const relations = await sources();
		told.length = 0;
		outage = "starts";
		const asked = await evry.ask(evryActor(await as(owner)), ASK).finally(back);
		assert.equal(outage, "none", "the source failed while Evry read it");
		assert.deepEqual(asked.proposals, []);
		assert.match(told[1]!, /source_unavailable/);
		assert.deepEqual(await sources(), relations);
		await away();
		const kept = await S.db.execute(
			sql`SELECT md5(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id)) AS h FROM audit_event x`,
		);
		try {
			await assert.rejects(
				end(a.admin, linkA, key),
				(e: Error & { cause?: { code?: string } }) => !(e instanceof OrganizationRefusal) && e.cause?.code === "42P01",
			);
			assert.deepEqual(
				(await S.db.execute(sql`SELECT md5(string_agg(to_jsonb(x)::text,'|' ORDER BY x.id)) AS h FROM audit_event x`))
					.rows,
				kept.rows,
			);
		} finally {
			await back();
		}
		assert.deepEqual(await active(), both, "the approvals committed before stay");
		assert.deepEqual(await actions(linkA.id), ["affiliation.approved"]);
	}

	assert.deepEqual(await end(a.admin, linkA, key), { status: "committed" });
	assert.deepEqual(await unchanged(() => end(a.admin, linkA, key)), { status: "committed" });
	assert.deepEqual(await active(), [linkB.id]);
	assert.equal(await liveSeats(a.admin), 1);
	assert.equal(await recorded(key), 1);
	assert.deepEqual(await actions(linkA.id), ["affiliation.approved", "affiliation.ended"]);
	await runNotices(linkA.id);
	assert.deepEqual(
		(await notices(linkA.id)).map((n) => n.recipient),
		[owner.account],
	);
	for (const n of [a.admin, b.admin]) {
		const found = await listed(n);
		assert.deepEqual(found, n === a.admin ? [] : [p.id]);
	}
});

const SUBJECTS: ["plant" | "sending_church" | "discovery", "sending_church" | "sending_network"][] = [
	["plant", "sending_church"],
	["plant", "sending_network"],
	["sending_church", "sending_network"],
	["discovery", "sending_church"],
	["discovery", "sending_network"],
];
async function subjectOf(kind: (typeof SUBJECTS)[number][0]) {
	if (kind !== "discovery") {
		const s = await staffed(kind);
		return {
			subject: s.o as Tenant | Identity,
			by: s.owner,
			scope: { [kind === "plant" ? "plant" : "sendingChurch"]: s.o },
		};
	}
	const d = await S.identity();
	await S.db.execute(sql`INSERT INTO discovery(account_id) VALUES(${d.account})`);
	return { subject: d, by: d, scope: { discoveryAccountId: d.account } };
}
for (const [kind, receiving] of SUBJECTS)
	test(`AC:TARGET-IDN-020 AC:TARGET-IDN-021 a ${kind} to ${receiving} link is approved only by the exact addressed organization, ended by either side, and keeps its own history`, async () => {
		for (const side of ["subject", "organization"] as const) {
			const { subject, by, scope } = await subjectOf(kind);
			const org = await staffed(receiving);
			const wrong = await staffed(receiving);
			const before = await seats();
			const i = await request(by, subject, org.o, org.admin.email);
			assert.deepEqual(i.pair, pairOf(subject, org.o));
			for (const who of [...ROLES.map((r) => wrong[r]), org.member, org.owner, by])
				await refuses(() => S.call("associations.acceptInvitation", who, acceptance(i)));
			const link = await approve(i, org.admin);
			assert.deepEqual(link.pair, i.pair);
			assert.deepEqual(
				(await history(by, scope)).activeRelationships.map((r) => r.id),
				[link.id],
			);
			for (const who of [...ROLES.map((r) => wrong[r]), org.member]) await refuses(() => end(who, link));
			const ender = side === "subject" ? by : org.admin;
			const key = randomUUID();
			assert.deepEqual(await end(ender, link, key), { status: "committed" });
			assert.deepEqual(await unchanged(() => end(ender, link, key)), { status: "committed" });
			const told = await history(by, scope);
			assert.deepEqual(told.activeRelationships, []);
			assert.deepEqual(
				told.items.map((x) => [x.event, x.pair, x.sourceInvitationId, x.actor]),
				[
					["approved", i.pair, i.invitationId, { kind: "account", accountId: org.admin.account }],
					["ended", i.pair, i.invitationId, { kind: "account", accountId: ender.account }],
				],
			);
			assert.ok(told.items.every((x) => x.occurredAt && x.recordedAt));
			assert.deepEqual(await actions(link.id), ["affiliation.approved", "affiliation.ended"]);
			assert.equal(await seats(), before);
		}
	});

test("AC:TARGET-IDN-020 another affiliate cannot approve this link, competing decisions settle once, and a failed write keeps nothing", async () => {
	const c = await church();
	for (const n of ["S2", "N1", "N2"] as const) await join(c, n);
	const i = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	const key = randomUUID();
	const kept = await links();
	for (const who of [c.S2.admin, c.S2.owner, c.S2.member, c.N1.member, c.N2.admin])
		await refuses(() => S.call("associations.acceptInvitation", who, acceptance(i, key)));
	await failing("audit_event", () =>
		refuses(() => S.call("associations.acceptInvitation", c.S2.admin, acceptance(i, key))),
	);
	for (const table of ["affiliation", "audit_event", "job"])
		await failing(table, () => breaks(() => S.call("associations.acceptInvitation", c.S1.admin, acceptance(i, key))));
	assert.equal(await recorded(key), 0);
	assert.deepEqual(await activeOf(c), ["N1", "N2", "S2"]);
	assert.deepEqual(await links(), kept);
	assert.deepEqual(await rows(sql`SELECT state FROM invitation WHERE id=${i.invitationId}`), [{ state: "pending" }]);

	const outcome = (p: Promise<unknown>) =>
		p.then(
			(v) => (v as { status: string }).status,
			(e: Error) => e.message,
		);
	const revoke = (x: Pending) =>
		S.call("associations.revokeInvitation", c.p.admin, S.command({ invitationId: x.invitationId }));
	let rival!: Promise<string>;
	await S.write(c.p.admin, async (tx) => {
		await S.api["associations.revokeInvitation"](
			tx,
			c.p.admin.session,
			c.p.admin.selected,
			S.command({ invitationId: i.invitationId }),
		);
		rival = outcome(S.call("associations.acceptInvitation", c.S1.admin, acceptance(i)));
		await S.waitingOnLock();
	});
	assert.equal(await rival, "stale_revision");
	assert.deepEqual(await activeOf(c), ["N1", "N2", "S2"]);
	assert.deepEqual(await links(), kept, "the losing acceptance changes no link");

	const again = await request(c.p.admin, c.p.o, c.S1.o, c.S1.admin.email);
	let link!: Link;
	await S.write(c.S1.admin, async (tx) => {
		const r = await S.api["associations.acceptInvitation"](
			tx,
			c.S1.admin.session,
			c.S1.admin.selected,
			acceptance(again),
		);
		if (r.status !== "accepted") throw Error(r.status);
		link = r.relationship;
		rival = outcome(revoke(again));
		await S.waitingOnLock();
	});
	assert.equal(await rival, "stale_revision");
	assert.deepEqual(await activeOf(c), ["N1", "N2", "S1", "S2"]);
	assert.deepEqual(await actions(link.id), ["affiliation.approved"]);
	const keptIds = new Set(kept.map((l) => (l.row as { id: string }).id));
	assert.deepEqual(
		(await links()).filter((l) => keptIds.has((l.row as { id: string }).id)),
		kept,
	);

	const queue = async () => (await jobs(link.id)).map((j) => [j.tenant_id, j.producer_key, j.state]);
	assert.deepEqual(await queue(), [[c.p.o.id, "affiliation/approved/1", "ready"]]);
	await runNotices(link.id, true);
	assert.deepEqual(await queue(), [[c.p.o.id, "affiliation/approved/1", "retry_wait"]]);
	assert.deepEqual(await activeOf(c), ["N1", "N2", "S1", "S2"], "a failed notice does not undo the approval");
	await runNotices(link.id);
	assert.deepEqual(await queue(), [[c.p.o.id, "affiliation/approved/1", "succeeded"]]);

	const strangers = ["nobody-" + randomUUID() + "@example.test", (await S.identity()).email];
	const shape = async (email: string) => {
		const p = await S.tenant("plant");
		const r = await request(await S.identity(p), p, c.S1.o, email);
		return { ...r, invitationId: null, expiresAt: null, pair: null };
	};
	assert.deepEqual(
		await shape(strangers[0]!),
		await shape(strangers[1]!),
		"a request does not tell whether an account exists",
	);
});

test("AC:TARGET-IDN-021 ending one of two links removes only its access, once, refuses a foreign Admin, keeps nothing on a failed write, and a later approval restores only its own choices", async () => {
	const c = await church();
	const s1 = await join(c, "S1");
	const n1 = await join(c, "N1");
	const foreign = await S.identity(await S.tenant("plant"), "admin");
	assert.notEqual(await page(c.S1.admin, c), null);
	const key = randomUUID();
	for (const who of [foreign, c.S1.member, c.p.member, c.N2.admin]) await refuses(() => end(who, s1));
	for (const table of ["audit_event", "job"]) await failing(table, () => breaks(() => end(c.p.admin, s1, key)));
	assert.equal(await recorded(key), 0);
	assert.deepEqual(await actions(s1.id), ["affiliation.approved"]);
	assert.notEqual(await page(c.S1.admin, c), null);

	assert.deepEqual(await end(c.p.admin, s1, key), { status: "committed" });
	assert.deepEqual(await unchanged(() => end(c.p.admin, s1, key)), { status: "committed" });
	assert.deepEqual(await activeOf(c), ["N1"]);
	for (const role of ROLES) assert.equal(await page(c.S1[role], c), null);
	assert.deepEqual((await page(c.N1.admin, c))!.plant.name, "Harvest");
	assert.deepEqual(await actions(s1.id), ["affiliation.approved", "affiliation.ended"]);
	assert.equal(await recorded(key), 1);
	assert.equal(await liveSeats(c.p.admin), 1);
	assert.deepEqual(
		(await history(c.p.member, { plant: c.p.o })).items.filter((x) => x.event === "ended").map((x) => x.reason),
		[{ status: "withheld" }],
	);

	await S.db.execute(sql`UPDATE affiliation SET share_people=false WHERE id=${s1.id}`);
	const back = await join(c, "S1");
	assert.equal(back.id, s1.id);
	await refuses(() => end(c.p.admin, s1, randomUUID()), "stale_revision");
	assert.deepEqual((await page(c.S1.admin, c))!.sections.people, { status: "withheld" });
	assert.deepEqual(await end(c.N1.owner, n1), { status: "committed" });
	assert.deepEqual(await activeOf(c), ["S1"], "each side ended its own link");
	assert.deepEqual(
		(await history(c.p.owner, { plant: c.p.o })).items
			.filter((x) => x.pair.organization.id === c.S1.o.id)
			.map((x) => x.event),
		["approved", "ended", "approved"],
	);
});

test("AC:TARGET-IDN-027 with no signed-in actor, a spent session or a forged reference nothing ends a link, and no other operation ends one", async () => {
	const c = await church();
	const s1 = await join(c, "S1");
	const n1 = await join(c, "N1");
	const identity = await I.fixture();
	try {
		for (const cookie of [undefined, "everyfield.session_token=forged.value"]) {
			const response = await identity.req("get-session", undefined, cookie);
			assert.deepEqual(await response.json(), { status: "unauthenticated" });
		}
	} finally {
		await identity.close();
	}
	for (const token of ["", "forged"]) assert.equal(await readRequestViewer(S.runtime, token), null);
	const expired = await S.identity(c.S1.o, "admin");
	await S.db.execute(
		sql`UPDATE auth_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.session}`,
	);
	const signedOut = await S.identity(c.p.o, "admin");
	await S.db.execute(sql`DELETE FROM auth_session WHERE id=${signedOut.session}`);
	for (const selected of [c.S1.o, c.p.o])
		for (const session of [randomUUID(), expired.session, signedOut.session])
			await refuses(() => direct("associations.end", session, selected, ending(s1)));
	for (const session of [null, undefined, ""])
		await unchanged(() =>
			assert.rejects(direct("associations.end", session, c.S1.o, ending(s1)), { name: "ZodError" }),
		);
	await refuses(() => direct("associations.end", c.S1.admin.session, c.p.o, ending(s1)));

	for (const by of [c.S1.admin, c.p.admin]) {
		await refuses(() => end(by, s1, randomUUID(), { pair: n1.pair }));
		await refuses(() => end(by, { ...s1, id: n1.id }, randomUUID()));
		for (const input of [
			{ plantId: c.p.o.id, sendingChurchId: null },
			{ ...ending(s1).input, organizationId: null },
			{ ...ending(s1).input, pair: { ...pairOf(c.p.o, c.S1.o), organization: null } },
			{ ...ending(s1).input, pair: { ...pairOf(c.p.o, c.S1.o), accountId: c.p.owner.account } },
		])
			await unchanged(() => assert.rejects(S.call("associations.end", by, S.command(input)), { name: "ZodError" }));
	}
	await unchanged(() =>
		assert.rejects(
			S.call("organizations.updateProfile", c.S1.admin, S.command({ plantId: null, sendingNetworkId: null })),
			{ name: "ZodError" },
		),
	);
	assert.deepEqual(await activeOf(c), ["N1", "S1"]);
	const removes = /disassociat|dissociat|unlink|sever|detach|associations\.(end|leave|remove|clear)/i;
	assert.deepEqual(
		Object.keys(S.api).filter((n) => removes.test(n)),
		["associations.end"],
	);
	assert.deepEqual(
		Object.keys(REVIEWED_WRITES).filter((n) => removes.test(n)),
		["associations.end"],
	);
	assert.deepEqual(
		Object.values(READ_DOMAINS)
			.flat()
			.filter((r) => removes.test(r.operation))
			.map((r) => r.operation),
		[],
	);
	const key = randomUUID();
	assert.deepEqual(await end(c.S1.admin, s1, key), { status: "committed" });
	assert.deepEqual(await activeOf(c), ["N1"]);
	assert.equal(await recorded(key), 1);
	assert.deepEqual(
		(await events(s1.id, "affiliation.ended")).map((e) => e.actor_id),
		[c.S1.admin.account],
	);
});

test("AC:ORG55-003 after one link ends, that organization's Wiki body, page and lists are gone and the other's stay", async () => {
	const c = await church();
	const s1 = await join(c, "S1");
	await join(c, "N1");
	const GLOBAL = "00000000-0000-0000-0000-000000000000";
	const [section, release, churchArticle, networkArticle] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
	const hash = () => randomBytes(32).toString("hex");
	const item = (id: string, kind: string, key: string) =>
		S.db.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},${kind},${key},${GLOBAL})`,
		);
	await item(section, "section", "framework/links");
	await S.db
		.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},${"release-" + release},'memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	for (const [id, slug] of [
		[churchArticle, "links/church"],
		[networkArticle, "links/network"],
	] as const) {
		await item(id, "article", slug);
		await S.db
			.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
			VALUES(${randomUUID()},${id},${GLOBAL},${release},1,${slug},${slug},${slug},'GLOBAL','safe_mdx',1,1,${hash()},clock_timestamp(),true,1,${section})`);
	}
	await S.db
		.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
	const wiki = createWikiProducer();
	for (const [org, articleId, body] of [
		[c.S1, churchArticle, "PRIVATE-S1"],
		[c.N1, networkArticle, "PRIVATE-N1"],
	] as const)
		ok(
			await wiki.publishOrganizationArticle(S.runtime, await as(org.admin), {
				requestKey: randomUUID(),
				expectedRevision: "0",
				input: { articleId, organizationId: org.o.id, body },
			}),
		);
	const body = async (who: Identity, articleId: string, organizationId?: string) => {
		const view = ok(
			await wiki.getArticle(S.runtime, await as(who), {
				articleId,
				...(organizationId ? { source: { kind: "organization", organizationId } } : {}),
			}),
		) as { article: { body: string } | null; errorCode: string | null };
		return [view.article?.body ?? null, view.errorCode];
	};
	for (const role of ROLES) {
		assert.deepEqual(await body(c.p[role], churchArticle), ["PRIVATE-S1", null]);
		assert.deepEqual(await body(c.p[role], churchArticle, c.S1.o.id), ["PRIVATE-S1", null]);
	}
	const cached = await page(c.S1.admin, c);
	assert.equal(cached!.plant.name, "Harvest");
	assert.equal(cached!.sections.wiki.status, "empty");
	const survivor = await page(c.N1.admin, c);
	const kept = await rows(sql`SELECT to_jsonb(x) AS row FROM account x ORDER BY id`);

	assert.deepEqual(await end(c.p.admin, s1), { status: "committed" });
	for (const role of ROLES) {
		assert.deepEqual(await body(c.p[role], churchArticle), ["GLOBAL", null]);
		assert.deepEqual(await body(c.p[role], churchArticle, c.S1.o.id), [null, "content_access_denied"]);
		assert.deepEqual(await body(c.p[role], networkArticle), ["PRIVATE-N1", null]);
		assert.equal(await page(c.S1[role], c), null);
		assert.deepEqual(await listed(c.S1[role]), []);
		assert.deepEqual(await S.call("privacy.getSharing", c.S1[role], { plant: c.p.o, organization: c.S1.o }), {
			status: "unavailable",
		});
		assert.deepEqual(await listed(c.N1[role]), [c.p.o.id]);
	}
	const still = await page(c.N1.admin, c);
	assert.deepEqual(still!.sections.wiki, survivor!.sections.wiki);
	assert.deepEqual(await body(c.S1.admin, churchArticle), ["PRIVATE-S1", null], "the organization keeps its own text");
	await runNotices(s1.id);
	const told = await notices(s1.id);
	assert.equal(told.length, 2);
	assert.equal(/PRIVATE|@example|Dana/.test(JSON.stringify(told)), false);
	assert.deepEqual(await rows(sql`SELECT to_jsonb(x) AS row FROM account x ORDER BY id`), kept);
	assert.equal((await rows(sql`SELECT id FROM plant WHERE id=${c.p.o.id}`)).length, 1);
	for (const role of ROLES) assert.equal(await liveSeats(c.p[role]), 1);
});
