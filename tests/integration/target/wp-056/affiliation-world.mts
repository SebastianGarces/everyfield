import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import * as Q from "../../../../packages/contracts/src/organizations/index.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { createMailService, MAIL_PASSES, runDueMail } from "../../../../packages/domain/src/jobs/mail.ts";
import { authorizeNotificationMail } from "../../../../packages/domain/src/jobs/notice-mail.ts";
import { createLaunchReader } from "../../../../packages/domain/src/launch/index.ts";
import { createNotificationProducer } from "../../../../packages/domain/src/notifications/index.ts";
import { getPlant, listPlants, readLocationHistory } from "../../../../packages/domain/src/oversight/index.ts";
import { createNotificationWorker } from "../../../../apps/web/src/features/notifications/worker.ts";
import * as S from "../../organizations/support.mts";

export { S };
export type Owner = Awaited<ReturnType<typeof S.tenant>>;
export type Identity = Awaited<ReturnType<typeof S.identity>>;
export type Kind = "sending_church" | "sending_network";
export const rows = async <T extends Record<string, unknown>>(query: SQL) =>
	(await S.db.execute(query)).rows as unknown as T[];
export const one = async <T extends Record<string, unknown>>(query: SQL) => {
	const [row] = await rows<T>(query);
	assert.ok(row);
	return row;
};

export async function as(who: Pick<Identity, "session">) {
	const found = await RequestActor.resolve(S.runtime, who.session);
	assert.ok(found instanceof RequestActor);
	return found;
}

export const footprint = () =>
	one(sql`SELECT (SELECT count(*)::int FROM audit_event) audit, (SELECT count(*)::int FROM job) jobs,
		(SELECT count(*)::int FROM notice) notices, (SELECT count(*)::int FROM mail) mail,
		(SELECT count(*)::int FROM seat) seats, (SELECT md5(coalesce(string_agg(a::text,'' ORDER BY a.id),'')) FROM affiliation a) links,
		(SELECT md5(coalesce(string_agg(p::text,'' ORDER BY p.id),'')) FROM plant p) plants,
		(SELECT md5(coalesce(string_agg(o::text,'' ORDER BY o.id),'')) FROM organization o) organizations`);
export async function silent<T>(body: () => Promise<T>): Promise<T> {
	const before = await footprint();
	const value = await body();
	assert.deepEqual(await footprint(), before, "no row, event, job, notice or mail changed");
	return value;
}

let serial = 0;
export async function org(kind: Kind, name: string) {
	const o = await S.tenant(kind, `${name} ${++serial}`);
	return { o, owner: await S.identity(o), admin: await S.identity(o, "admin"), member: await S.identity(o, "member") };
}
export type Org = Awaited<ReturnType<typeof org>>;

export async function world() {
	const p = await S.tenant("plant", `Harvest Point ${++serial}`);
	const foreignPlant = await S.tenant("plant", "Foreign plant");
	return {
		p,
		owner: await S.identity(p),
		admin: await S.identity(p, "admin"),
		member: await S.identity(p, "member"),
		foreign: await S.identity(foreignPlant),
		S1: await org("sending_church", "Sending One"),
		S2: await org("sending_church", "Sending Two"),
		N1: await org("sending_network", "Network One"),
		N2: await org("sending_network", "Network Two"),
	};
}
export type World = Awaited<ReturnType<typeof world>>;

export const pairOf = (w: Pick<World, "p">, side: Org) => ({ kind: "plant", subject: w.p, organization: side.o });
const revisionOf = async (p: Owner) =>
	String((await one<{ r: string }>(sql`SELECT revision::text r FROM plant WHERE id=${p.id}`)).r);

export async function invite(w: World, side: Org) {
	return Q.invitationResult.parse(
		await S.call(
			"associations.invite",
			w.owner,
			S.command({ pair: pairOf(w, side), recipientEmail: side.admin.email }, await revisionOf(w.p)),
		),
	);
}
export const acceptance = (invitationId: string) =>
	S.command({ invitationId, proof: S.proofs.get(invitationId), decision: "accept" });
export async function connect(w: World, side: Org) {
	const i = await invite(w, side);
	const accepted = Q.acceptedInvitationResult.parse(
		await S.call("associations.acceptInvitation", side.admin, acceptance(i.invitationId)),
	);
	assert.ok(accepted.status === "accepted");
	return { id: accepted.relationship.id, revision: accepted.relationship.revision, pair: accepted.relationship.pair };
}
export type Link = Awaited<ReturnType<typeof connect>>;
export const linkNow = (link: Link) =>
	one<{ ended: boolean; revision: string; consent: string }>(
		sql`SELECT ended_at IS NOT NULL AS ended, revision::text, consent_revision::text AS consent FROM affiliation WHERE id=${link.id}`,
	);
export async function endCommand(link: Link, revision?: string) {
	const current = revision ?? (await linkNow(link)).revision;
	return S.command({ relationshipId: link.id, pair: link.pair, confirmed: true, reason: null }, current);
}
export async function share(w: World, side: Org, link: Link, category: string, enabled: boolean, who = w.owner) {
	const now = await linkNow(link);
	return S.call(
		"privacy.setSharing",
		who,
		S.command(
			{
				plant: w.p,
				organization: side.o,
				relationshipId: link.id,
				category,
				enabled,
				expectedConsentRevision: now.consent,
			},
			now.revision,
		),
	);
}
export const sharing = async (w: World, side: Org, who: Identity) =>
	Q.sharingResult.parse(await S.call("privacy.getSharing", who, { plant: w.p, organization: side.o }));

export async function activeOrganizations(w: World) {
	const h = Q.relationshipHistoryResult.parse(await S.call("associations.getHistory", w.owner, { plant: w.p }));
	assert.ok(h.status === "available");
	return { orgs: h.activeRelationships.map((r) => r.pair.organization.id).sort(), items: h.items };
}

const launches = createLaunchReader();
export const feedApi = createNotificationProducer({ optOutKey: randomBytes(32), now: () => new Date() });
export async function bodies(w: World, side: Org, authority: RequestActor) {
	const digest = await feedApi.readOversightDigest(S.runtime, authority, {
		organizationId: side.o.id,
		organizationKind: side.o.kind === "organization" ? side.o.organizationKind : "sending_church",
		period: "current",
	});
	return {
		row: (await listPlants(S.runtime, authority))?.plants.find((r) => r.plantId === w.p.id) ?? null,
		page: await getPlant(S.runtime, authority, w.p.id),
		summary: await launches.readPublishedSummary(S.runtime, authority, w.p.id),
		places: await readLocationHistory(S.runtime, authority, w.p.id),
		digest: digest.status === "ok" && digest.value.plants.includes(w.p.id),
		sharing: (await sharing(w, side, side.admin)) as { status?: string; view?: string },
	};
}
export const NO_BODY = {
	row: null,
	page: null,
	summary: null,
	places: null,
	digest: false,
	sharing: { status: "unavailable" },
};

export async function endOnce(w: World, side: Org, link: Link, actor: Identity, remaining: Org[]) {
	const before = await one<{ plants: number; seats: number; events: number }>(
		sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM seat WHERE plant_id=${w.p.id} AND ended_at IS NULL) seats,
			(SELECT count(*)::int FROM audit_event WHERE action='affiliation.ended' AND kind='remove') events`,
	);
	const others = () => rows(sql`SELECT * FROM affiliation WHERE plant_id=${w.p.id} AND id<>${link.id} ORDER BY id`);
	const kept = await others();
	const first = await endCommand(link);
	await silent(async () => {
		for (const who of [w.member, w.foreign, side.member, w.N2.owner, w.N2.admin, w.S2.admin])
			await assert.rejects(
				S.call("associations.end", who, { ...first, requestKey: randomUUID() }),
				/^Error: unavailable$/,
			);
		await assert.rejects(S.call("associations.end", actor, await endCommand(link, "99")), /^Error: stale_revision$/);
	});
	const result = await S.call("associations.end", actor, first);
	assert.deepEqual(result, { status: "committed" });
	await silent(async () => {
		assert.deepEqual(
			await S.call("associations.end", actor, first),
			result,
			"the same request answers the same receipt",
		);
	});
	assert.deepEqual(await S.call("associations.end", actor, await endCommand(link)), { status: "committed" });
	assert.equal((await linkNow(link)).ended, true);
	assert.deepEqual(await others(), kept, "every other link and its consent is unchanged");
	const { orgs, items } = await activeOrganizations(w);
	assert.deepEqual(orgs, remaining.map((r) => r.o.id).sort());
	assert.deepEqual(
		items.filter((i) => i.event === "ended").map((i) => i.pair),
		[pairOf(w, side)],
	);
	assert.deepEqual(
		await one(sql`SELECT (SELECT count(*)::int FROM plant) plants,(SELECT count(*)::int FROM seat WHERE plant_id=${w.p.id} AND ended_at IS NULL) seats,
			(SELECT count(*)::int FROM audit_event WHERE action='affiliation.ended' AND kind='remove') events`),
		{ ...before, events: before.events + 1 },
	);
	assert.deepEqual(
		await rows(
			sql`SELECT tenant_id,actor_id,subject_id FROM audit_event WHERE action='affiliation.ended' AND subject_id=${link.id}`,
		),
		[{ tenant_id: actor.selected.kind === "plant" ? w.p.id : side.o.id, actor_id: actor.account, subject_id: link.id }],
	);
	assert.deepEqual(
		await rows(
			sql`SELECT count(*)::int n FROM job WHERE subject_record_id=${link.id} AND producer_key LIKE 'affiliation/ended/%'`,
		),
		[{ n: 1 }],
	);
	assert.deepEqual(
		await rows(sql`SELECT role, ended_at FROM seat WHERE account_id=${actor.account}`),
		[{ role: roleOf(await as(actor)), ended_at: null }],
		"the actor's own seat stays active",
	);
	return first;
}
const roleOf = (a: RequestActor) => (a.actor.context.kind === "seat" ? a.actor.context.role : null);

type Transport = NonNullable<Parameters<typeof createMailService>[0]["transport"]>;
export function noticeMail(send: Extract<Transport, { send: unknown }>["send"]) {
	const mail = createMailService({
		db: S.runtime,
		...mailKeys,
		from: "links@example.test",
		authorize: authorizeNotificationMail,
		transport: { send, lookup: async () => ({ kind: "unknown" }) },
	});
	const worker = createNotificationWorker({ mail });
	return {
		plan: () => worker.run(S.runtime, new Date().toISOString()),
		deliver: () => runDueMail(S.runtime, mail, MAIL_PASSES.notice, 100, Infinity),
	};
}
const mailKeys = { encryptionKey: randomBytes(32), addressKey: randomBytes(32) };
export const notices = (link: Link) =>
	rows<{ recipient: string; occurrence: string; title: string; body: string; mail: string | null }>(
		sql`SELECT n.recipient_id AS recipient, split_part(n.logical_key,'/',5) AS occurrence, n.title, n.safe_body AS body, m.state AS mail
			FROM notice n LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${link.id} ORDER BY n.source_revision, n.recipient_id`,
	);
export const jobs = async (link: Link) =>
	(
		await rows(
			sql`SELECT producer_key, state, error_code FROM job WHERE kind='notification' AND subject_record_id=${link.id} ORDER BY source_revision`,
		)
	).map((r) => [r.producer_key, r.state, r.error_code]);

export async function person(w: Pick<World, "p">, name: string, fields: { stage?: string } = {}) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,phone,street,source,stage,
		adult_classification,commitment_state,pipeline_position,state,created_at)
		VALUES(${id},${w.p.id},${w.p.id},${name},'alex.lead@example.test','555-0101','12 Private Lane','other',
		${fields.stage ?? "leader"},'adult','unknown','1','live',clock_timestamp())`);
	return id;
}
export async function teamRoles(w: Pick<World, "p">, holders: (string | null)[]) {
	const team = await one<{ id: string }>(
		sql`INSERT INTO team(plant_id,name,state,sort_order) VALUES(${w.p.id},'Leadership','active',0) RETURNING id`,
	);
	const ids: string[] = [];
	for (const [n, holder] of holders.entries()) {
		const role = await one<{ id: string }>(sql`INSERT INTO team_role(plant_id,team_id,name,leadership,sort_order)
			VALUES(${w.p.id},${team.id},${`Role ${n}`},true,${n}) RETURNING id`);
		ids.push(role.id);
		if (holder)
			await S.db.execute(
				sql`INSERT INTO team_tenure(plant_id,role_id,person_id,started_on) VALUES(${w.p.id},${role.id},${holder},'2026-01-01')`,
			);
	}
	return { teamId: team.id, roles: ids };
}
export async function lead(w: World, assignment: { teamId: string; roleId: string; personId: string }) {
	const op = await one<{ id: string }>(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_id)
		VALUES(${w.p.id},${w.owner.account},'identity.domain_accepted','create',${w.p.id}) RETURNING id`);
	const value = { answer: "yes", assignment, savedAt: "2026-01-01T00:00:00.000Z" };
	await S.db
		.execute(sql`INSERT INTO onboarding_setup(plant_id,account_id,creation_operation_id,lead,journey,launch,people_step)
		VALUES(${w.p.id},${w.owner.account},${op.id},${JSON.stringify(value)}::jsonb,'{"status":"pending"}'::jsonb,
		'{"status":"pending"}'::jsonb,'pending')`);
}
export async function meeting(w: Pick<World, "p">, attended: string[]) {
	const id = randomUUID();
	await S.db
		.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision,finalized_at) VALUES(${id},${w.p.id},'vision_meeting','Vision night','2026-09-01','18:00',
		'America/Chicago','2026-09-01T23:00:00Z','1','completed',1,clock_timestamp())`);
	for (const who of attended)
		await S.db.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence)
			VALUES(${w.p.id},${id},${who},true,'attended')`);
	return id;
}
export async function task(w: Pick<World, "p">) {
	const id = randomUUID();
	await S.db.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind)
		VALUES(${id},${w.p.id},'Call the venue','general','medium','not_started',clock_timestamp(),'undated')`);
	return id;
}
export const activity = (w: Pick<World, "p" | "owner">) =>
	S.db.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id)
		VALUES(${w.p.id},${w.owner.account},'tasks.changed','edit','record',${w.p.id})`);
