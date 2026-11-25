import "../../../platform/setup.mts";
import { openedDeletion } from "../../../../support/deletion-cookie.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "../../../../../packages/db/src/schema/storage.ts";
import { eq, sql, type SQL } from "../../../../../packages/db/src/query.ts";
import * as t from "../../../../../packages/db/src/schema/tables.ts";
import { accountId, tenantId } from "../../../../../packages/contracts/src/common/values.ts";
import { RequestActor, readViewer } from "../../../../../packages/domain/src/access/session.ts";
import {
	communicationWriter,
	type DeliveryTransport,
	runDueScheduled,
	withCommunicationWrite,
} from "../../../../../packages/domain/src/communication/index.ts";
import { feedbackWriter } from "../../../../../packages/domain/src/feedback/index.ts";
import { supersedeDigests } from "../../../../../packages/domain/src/jobs/digest.ts";
import { createMailService, MAIL_PASSES, runDueMail } from "../../../../../packages/domain/src/jobs/mail.ts";
import { queueJobs } from "../../../../../packages/domain/src/jobs/queue.ts";
import { gatedTransaction } from "../../../../../packages/domain/src/operations/writes.ts";
import {
	createOrganizationAdapter,
	readAnswerableInvitation,
	type OrganizationEffects,
} from "../../../../../packages/domain/src/organizations/index.ts";
import { readAvatar } from "../../../../../packages/domain/src/settings/avatar.ts";
import { createLifecycleCleanup, deletionOperations } from "../../../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../../../packages/domain/src/settings/deletion.ts";
import {
	BackupDirectory,
	COPY_OPERATION,
	createEncryptedCopy,
	openEncryptedCopy,
} from "../../../../../ops/maintenance/copy.mts";
import { answerRsvpToken, describeRsvpToken } from "../../../../../packages/domain/src/meetings/index.ts";
import { newRsvpToken, rsvpLink, rsvpTokenDigest } from "../../../../../packages/domain/src/meetings/tokens.ts";
import { connectionLink } from "../../../../../packages/domain/src/proofs.ts";
import { openDrillTarget } from "../../../../../ops/maintenance/drill.mts";
import {
	readCurrentManifest,
	restoreWithCurrentManifest,
	type RestoreDeps,
	type Snapshot,
} from "../../../../../ops/maintenance/restore.mts";
import { testDatabase } from "../../../../support/test-database.mts";
import { type Actor, ok, seeds, type Workspace } from "../../../../support/fixture.mts";
import { MAILING } from "../../../communication/church-address.mts";
import {
	closedTo,
	dropTarget,
	freezeClock,
	objectStore,
	operator,
	readyFile,
	schemaExists,
	snapshot,
	type Store,
} from "./support.mts";

const IMAGE_AT = new Date("2026-09-06T12:00:00.000Z");
const A_REQUESTED = new Date("2026-09-06T15:00:00.000Z");
const A_PURGED = new Date("2026-10-07T00:00:00.000Z");
const COPIED = new Date("2026-10-12T16:00:00.000Z");
const P_REQUESTED = new Date("2026-10-12T18:00:00.000Z");
const NOW = new Date("2026-10-13T16:00:00.000Z");
const EXPIRES = "2026-10-14T00:00:00Z";
const PRIVATE = "A's private note about the launch budget";
const LOOPBACK = new URL("postgres://ci@127.0.0.1:5432/everyfield_ci");

const database = await testDatabase({
	prefix: "wp056rst",
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	max: 6,
	clock: IMAGE_AT,
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools;
const seed = seeds(admin);
const live: Store = new Map();
const targets: string[] = [];
const rows = async <R extends Record<string, unknown> = Record<string, unknown>>(query: SQL) =>
	(await admin.execute<R>(query)).rows;
const command = (input: object, expectedRevision = "1") => ({ input, expectedRevision, requestKey: randomUUID() });
async function at(when: Date) {
	await freezeClock(admin, schema, when);
	mock.timers.setTime(when.getTime());
}
const deletions = deletionOperations({
	queue: (tx, i) =>
		queueJobs(tx, [
			{
				tenant: i.subject.id,
				kind: "lifecycle_purge",
				subject: i.witnessId,
				key: "purge/" + i.requestId,
				revision: i.revision,
				eligibleAt: i.eligibleAt,
			},
		]),
	workspaceNotice: async () => {},
});
const proofs = new Map<string, string>();
const effects: OrganizationEffects = {
	invitation: async (_tx, v) =>
		void proofs.set(
			v.invitationId,
			connectionLink("https://app.example.test", "/connections/respond", v.invitationId, v.proof).split("#")[1]!,
		),
	invalidate: (_tx, v) => supersedeDigests(v.sourceId),
};
const organizations = createOrganizationAdapter(effects, { candidates: () => sql`SELECT NULL::uuid WHERE false` });
const keys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
function delivery(pool: typeof db) {
	const sent = { mail: [] as string[], batches: [] as string[] };
	const service = createMailService({
		db: pool,
		...keys,
		authorize: async (_tx, mails) => new Set(mails.map((m) => m.id)),
		transport: {
			send: async (payload) => {
				sent.mail.push(payload.to);
				return { kind: "accepted", id: "cap-" + randomUUID() };
			},
			lookup: async () => ({ kind: "unknown" }),
		},
	});
	const transport: DeliveryTransport = {
		paused: false,
		send: async (batch) => {
			sent.batches.push(...batch.messages.map((m) => m.to));
			return { outcome: "ids", ids: batch.messages.map(() => "cap-" + randomUUID()) };
		},
		cancel: async (ids) => ids.map(() => ({ outcome: "unknown" })),
		reschedule: async () => {
			throw new Error("provider_timeout");
		},
	};
	const run = async () => {
		const until = Number.MAX_SAFE_INTEGER;
		for (let pass = 0; pass < 2; pass++) {
			for (const prefixes of Object.values(MAIL_PASSES)) await runDueMail(pool, service, prefixes, 50, until);
			await runDueScheduled(pool, transport, keys, 50, until);
		}
		return sent;
	};
	return { service, run, sent };
}
const actorOf = async (who: Actor, pool = db) => {
	const actor = await RequestActor.resolve(pool, who.session);
	assert.ok(actor instanceof RequestActor);
	return actor;
};

async function asOwner<K extends keyof typeof organizations>(
	pool: typeof db,
	session: Actor["session"],
	operation: K,
	input: object,
	owner: Workspace = g,
) {
	return gatedTransaction(pool, async (tx) => {
		assert.ok(await RequestActor.claimWrite(tx, session, owner as never));
		return organizations[operation](tx, session, owner as never, command(input));
	});
}
const answerable = (pool: typeof db, session: Actor["session"]) =>
	gatedTransaction(pool, (tx) =>
		readAnswerableInvitation(tx, session, v as never, { invitationId, proof: invitationProof }),
	).then((reply) => reply.status);

let p: Workspace & { kind: "plant" }, g: Workspace & { kind: "plant" };
let o: Workspace & { kind: "organization" }, n: Workspace & { kind: "organization" };
let a: Actor, pOwner: Actor, gOwner: Actor, oOwner: Actor, nOwner: Actor, foreign: Actor;
let avatar: Awaited<ReturnType<typeof readyFile>>, gFile: Awaited<ReturnType<typeof readyFile>>;
let x: string, mailE: string, scheduledF: string, copy: Snapshot;
let v: Workspace & { kind: "organization" }, vOwner: Actor, invitationId: string, invitationProof: string, rsvp: string;
let resetLink: string, dir: string;
let cancelProof: Awaited<ReturnType<typeof openedDeletion>>;
let aRequest: { subject: { kind: "account"; id: ReturnType<typeof accountId.parse> }; requestId: string };

async function link(plant: { id: string }, organization: { id: string }) {
	const [row] = await rows<{
		id: string;
	}>(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,
		share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${plant.id},${organization.id},clock_timestamp(),true,true,true,true,true,true,true) RETURNING id`);
	return row!.id;
}
const enqueue = (pool: typeof db, name: string, logicalKey: string) =>
	gatedTransaction(pool, (tx) =>
		delivery(pool).service.enqueue(tx, {
			owner: { kind: "plant", id: tenantId.parse(g.id) },
			purpose: "relationship_receipt",
			logicalKey,
			recipient: null,
			address: `${name}@example.test`,
			content: { subject: name, text: name },
			operation: null,
			notice: null,
			eligibleAt: IMAGE_AT.toISOString(),
		}),
	);
async function schedule(name: string) {
	const author = await actorOf(gOwner);
	const personId = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${personId},${g.id},${g.id},${name},${`${name}@example.test`},'other','prospect','unknown','unknown',0,'live',
		clock_timestamp())`);
	const saved = ok(
		await withCommunicationWrite(db, author, (tx, ctx) =>
			communicationWriter.saveDraft(tx, ctx, {
				requestKey: randomUUID(),
				input: {
					subject: "Welcome",
					bodyHtml: "<p>Welcome.</p>",
					audience: { groups: [], teamIds: [], personIds: [personId] },
				},
			}),
		),
	);
	const accepted = ok(
		await withCommunicationWrite(db, author, (tx, ctx) =>
			communicationWriter.scheduleReviewed(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: saved.revision,
				input: {
					communicationId: saved.communicationId,
					scheduledAt: new Date(IMAGE_AT.getTime() + 86_400_000).toISOString(),
				},
			}),
		),
	);
	ok(
		await communicationWriter.handOffScheduled(
			db,
			author,
			{
				requestKey: randomUUID(),
				expectedRevision: accepted.revision,
				input: { communicationId: saved.communicationId },
			},
			{
				paused: false,
				send: async () => ({ outcome: "unknown" }),
				cancel: async () => [],
				reschedule: async () => {},
			} as never,
			keys,
		),
	);
	const [row] = await rows<{ id: string }>(
		sql`UPDATE mail SET scheduled_at=${IMAGE_AT.toISOString()}::timestamptz + interval '1 hour'
			WHERE purpose='communication' AND logical_key LIKE ${`communication/${saved.communicationId}/%`} RETURNING id`,
	);
	return row!.id;
}

before(async () => {
	mock.timers.enable({ apis: ["Date"], now: IMAGE_AT.getTime() });
	await at(IMAGE_AT);
	p = await seed.plant({ name: "Harvest Point" });
	g = await seed.plant({ name: "Grace Hill", ...MAILING });
	o = await seed.organization("sending_church", { name: "Sending Church O" });
	n = await seed.organization("sending_network", { name: "Network N" });
	a = await seed.actor(p, "admin", { email: "alex@example.test" });
	pOwner = await seed.actor(p, "owner");
	gOwner = await seed.actor(g, "owner");
	oOwner = await seed.actor(o, "owner");
	nOwner = await seed.actor(n, "owner");
	foreign = await seed.actor(g, "member");
	ok(
		await feedbackWriter.submit(
			db,
			await actorOf(a),
			{ requestKey: randomUUID(), category: "bug", description: PRIVATE, page: "Documents", address: "/documents" },
			{ appVersion: null },
		),
	);
	avatar = await readyFile(admin, live, a.id, Buffer.from("A's avatar bytes"), "avatar");
	await admin.update(t.account).set({ avatar_object_id: avatar.id }).where(eq(t.account.id, a.id));
	gFile = await readyFile(admin, live, g.id, Buffer.from("%PDF-1.7 launch plan"));
	x = await link(g, o);
	await link(g, n);
	resetLink = `reset-password:${randomBytes(16).toString("hex")}`;
	await admin.execute(sql`INSERT INTO auth_verification(identifier,value,expires_at)
		VALUES(${resetLink},${gOwner.user},'2027-01-01T00:00:00Z')`);
	await admin.execute(sql`INSERT INTO identity_proof(account_id,purpose,token_hash,proposed_email,expires_at)
		VALUES(${gOwner.id}::uuid,'email_change',${randomBytes(32).toString("hex")},'new@example.test','2027-01-01T00:00:00Z')`);
	v = await seed.organization("sending_network", { name: "Invited network V" });
	vOwner = await seed.actor(v, "owner");
	const invited = await asOwner(db, gOwner.session, "associations.invite", {
		pair: { kind: "plant", subject: g, organization: v },
		recipientEmail: vOwner.email,
	});
	assert.ok("invitationId" in invited);
	invitationId = invited.invitationId;
	invitationProof = proofs.get(invitationId)!;
	await admin.execute(sql`UPDATE invitation SET created_at=${COPIED.toISOString()}::timestamptz - interval '1 day'
		WHERE id=${invitationId}::uuid`);
	const token = newRsvpToken();
	rsvp = rsvpLink(keys.origin, token).split("/rsvp/")[1]!;
	const [guest, meeting] = [randomUUID(), randomUUID()];
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at)
		VALUES(${guest},${g.id},${g.id},'Rae Guest','other','prospect','unknown','unknown',1,'live',clock_timestamp())`);
	await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,
		status,attendance_revision) VALUES(${meeting},${g.id},'vision_meeting','Vision night','2026-10-20','18:00',
		'America/Chicago','2026-10-20T23:00:00Z','1','planning',1)`);
	await admin.execute(sql`INSERT INTO participation(plant_id,meeting_id,person_id,roster_member,presence,rsvp,rsvp_source,
		rsvp_token_hash,rsvp_token_expires_at,rsvp_token_open) VALUES(${g.id},${meeting},${guest},false,'absent','pending','invitation',
		${rsvpTokenDigest(token)},'2026-10-20T23:00:00Z',true)`);
	mailE = await enqueue(db, "send-e", "onboarding/" + randomUUID());
	await enqueue(db, "control", "onboarding/" + randomUUID());
	scheduledF = await schedule("scheduled-f");
	await schedule("scheduled-control");
	await grantAccess();
	await admin.execute(sql`UPDATE auth_session SET expires_at='2027-01-01T00:00:00Z'`);
	const image = await snapshot(admin, live, { createdAt: IMAGE_AT });

	await withdrawAccess();
	await admin.execute(sql`UPDATE mail SET state='unknown' WHERE id=${mailE}::uuid`);
	await admin.execute(sql`UPDATE mail SET state='cancelled', scheduled_at=NULL WHERE id=${scheduledF}::uuid`);
	const pair = { kind: "plant", subject: g, organization: o };
	const ended = await gatedTransaction(db, async (tx) => {
		assert.ok(await RequestActor.claimWrite(tx, gOwner.session, g as never));
		return organizations["associations.end"](
			tx,
			gOwner.session,
			g as never,
			command({ relationshipId: x, pair, confirmed: true, reason: null }),
		);
	});
	assert.deepEqual(ended, { status: "committed" });

	await at(A_REQUESTED);
	const [account] = await admin.select().from(t.account).where(eq(t.account.id, a.id));
	const subject = { kind: "account" as const, id: accountId.parse(a.id) };
	const requested = ok(
		await gatedTransaction(db, (tx) =>
			deletions.requestAccountDeletion(
				tx,
				{ session: a.session, selected: subject },
				command({ confirmed: true }, account!.revision),
			),
		),
	);
	aRequest = { subject, requestId: requested.requestId };
	cancelProof = await openedDeletion(
		gatedTransaction(admin, (tx) =>
			issueRestrictedDeletionSession(tx, aRequest, async () => ({ accountId: a.id, provenAt: new Date() })),
		),
		aRequest,
	);
	await at(A_PURGED);
	const purge = createLifecycleCleanup(cleanup, {
		authorize: async () => true,
		async removeOwnedResources() {
			live.delete(avatar.key);
			for (const state of ["cleanup", "purged"])
				await admin.execute(sql`UPDATE file_object SET state=${state},
					purged_at=CASE WHEN ${state}='purged' THEN clock_timestamp() END WHERE tenant_id=${a.id}::uuid`);
			return true;
		},
	});
	assert.equal((await purge({ ...aRequest, revision: requested.revision })).status, "purged");

	await at(P_REQUESTED);
	await admin.execute(sql`UPDATE auth_session SET expires_at='2027-01-01T00:00:00Z'`);
	const [plantRow] = await admin.select().from(t.plant).where(eq(t.plant.id, p.id));
	ok(
		await gatedTransaction(db, (tx) =>
			deletions.requestWorkspaceDeletion(
				tx,
				{ session: pOwner.session, selected: { kind: "plant", id: tenantId.parse(p.id) } },
				command({ plant: p, confirmed: true }, plantRow!.revision),
			),
		),
	);
	const plain = {
		...image,
		manifest: {
			...image.manifest,
			createdAt: COPIED.toISOString(),
			expiresAt: "2026-10-14T00:00:00.000Z",
			subjects: [{ id: a.id, expiresAt: "2026-10-14T00:00:00.000Z" }],
		},
	};
	dir = await mkdtemp(join(tmpdir(), "wp056-restore-"));
	const key = createSecretKey(randomBytes(32));
	await mkdir(join(dir, "backup"), { mode: 0o700 });
	const store = new BackupDirectory(join(dir, "backup"));
	const sealed = await createEncryptedCopy(
		{ store, clock: () => P_REQUESTED },
		{
			capability: {
				authority: "authorized_restricted_backup_operator",
				verified: true,
				operation_ids: [COPY_OPERATION],
				environment: "isolated-test",
			},
			key,
			source: { snapshot: plain },
		},
	);
	assert.ok(sealed.copy_encrypted, JSON.stringify(sealed));
	assert.equal(sealed.effective_expires_at, EXPIRES);
	await assert.rejects(openEncryptedCopy(store, sealed.location, createSecretKey(randomBytes(32))));
	copy = await openEncryptedCopy(store, sealed.location, key);
	await at(NOW);
});
after(async () => {
	mock.timers.reset();
	if (dir) await rm(dir, { recursive: true, force: true });
	for (const name of targets) await dropTarget(admin, name);
	await database.close();
});

type Resident = { actor: Actor; link: string };
let withdrawn: { seat: Actor; demoted: Actor; left: Resident; grant: string; totals: string };
let retained: { seat: Actor; resident: Resident };
async function resident(): Promise<Resident> {
	const actor = await seed.actor(g, "member");
	const [person, invitation, id] = [randomUUID(), randomUUID(), randomUUID()];
	const [joined] = await rows<{ id: string }>(sql`INSERT INTO affiliation(account_id,organization_id,accepted_at,
		share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${actor.id}::uuid,${o.id}::uuid,clock_timestamp(),false,false,false,false,false,false,false) RETURNING id`);
	await admin.execute(sql`INSERT INTO person(id,tenant_id,organization_id,display_name,source,state,linked_account_id,
		created_at,revision) VALUES(${person}::uuid,${o.id}::uuid,${o.id}::uuid,'Resident','other','live',${actor.id}::uuid,
		clock_timestamp(),1)`);
	await admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,token_hash,state,created_at,
		accepted_account_id,resident_person_id) VALUES(${invitation}::uuid,${o.id}::uuid,'residency_link',${actor.email},
		${randomUUID()},'accepted',clock_timestamp(),${actor.id}::uuid,${person}::uuid)`);
	await admin.execute(sql`INSERT INTO residency_link(id,organization_id,person_id,account_id,affiliation_id,invitation_id,
		accepted_at,consent_revision,revision,share_foundations,share_milestones) VALUES(${id}::uuid,${o.id}::uuid,
		${person}::uuid,${actor.id}::uuid,${joined!.id}::uuid,${invitation}::uuid,clock_timestamp(),1,1,true,true)`);
	return { actor, link: id };
}
async function grantAccess() {
	const operatorSeat = await seed.actor(g, "member");
	const [grant] = await rows<{ id: string }>(sql`INSERT INTO platform_grant(account_id,capability)
		VALUES(${operatorSeat.id}::uuid,'feedback_triage') RETURNING id`);
	const [joined] = await rows<{ id: string }>(sql`INSERT INTO affiliation(sending_church_id,organization_id,accepted_at,
		share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${o.id}::uuid,${n.id}::uuid,clock_timestamp(),false,false,false,false,false,false,false) RETURNING id`);
	const [totals] = await rows<{
		id: string;
	}>(sql`INSERT INTO pipeline_sharing(id,organization_id,relationship_id,network_id,
		share_pipeline_totals,revision) VALUES(gen_random_uuid(),${o.id}::uuid,${joined!.id}::uuid,${n.id}::uuid,true,1)
		RETURNING id`);
	withdrawn = {
		seat: await seed.actor(g, "admin"),
		demoted: await seed.actor(g, "admin"),
		left: await resident(),
		grant: grant!.id,
		totals: totals!.id,
	};
	retained = { seat: await seed.actor(g, "admin"), resident: await resident() };
}
const seatId = async (who: Actor) =>
	(await rows<{ id: string }>(sql`SELECT id FROM seat WHERE account_id=${who.id}::uuid`))[0]?.id;
const accessIn = async (target: string) =>
	(
		await rows(sql`SELECT
	(SELECT ended_at IS NULL FROM ${within(target, "seat")} WHERE account_id=${withdrawn.seat.id}::uuid) AS seat,
	(SELECT role FROM ${within(target, "seat")} WHERE account_id=${withdrawn.demoted.id}::uuid) AS demoted,
	(SELECT role FROM ${within(target, "seat")} WHERE account_id=${retained.seat.id}::uuid AND ended_at IS NULL) AS kept,
	(SELECT revoked_at IS NULL FROM ${within(target, "platform_grant")} WHERE id=${withdrawn.grant}::uuid) AS granted,
	(SELECT share_pipeline_totals FROM ${within(target, "pipeline_sharing")} WHERE id=${withdrawn.totals}::uuid) AS totals,
	(SELECT json_build_array(ended_at IS NULL,share_foundations,share_milestones) FROM ${within(target, "residency_link")}
		WHERE id=${withdrawn.left.link}::uuid) AS "left",
	(SELECT json_build_array(ended_at IS NULL,share_foundations,share_milestones) FROM ${within(target, "residency_link")}
		WHERE id=${retained.resident.link}::uuid) AS resident,
	(SELECT json_build_array(share_people,share_activity) FROM ${within(target, "affiliation")}
		WHERE plant_id=${g.id}::uuid AND organization_id=${n.id}::uuid) AS sharing`)
	)[0];
async function withdrawAccess() {
	assert.deepEqual(
		await gatedTransaction(db, (tx) =>
			organizations["residency.leave"](
				tx,
				withdrawn.left.actor.session,
				{ kind: "account", id: withdrawn.left.actor.id } as never,
				command({ linkId: withdrawn.left.link, expectedConsentRevision: "1" }),
			),
		),
		{ status: "committed" },
	);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${withdrawn.seat.id}::uuid`);
	await admin.execute(sql`UPDATE seat SET role='member' WHERE account_id=${withdrawn.demoted.id}::uuid`);
	await admin.execute(sql`UPDATE platform_grant SET revoked_at=clock_timestamp() WHERE id=${withdrawn.grant}::uuid`);
	await admin.execute(sql`UPDATE pipeline_sharing SET share_pipeline_totals=false WHERE id=${withdrawn.totals}::uuid`);
	await admin.execute(sql`UPDATE affiliation SET share_people=false
		WHERE plant_id=${g.id}::uuid AND organization_id=${n.id}::uuid`);
}

async function liveState() {
	return { image: (await snapshot(admin, live, { createdAt: NOW })).image.toString(), files: [...live.keys()] };
}
async function restore(
	overrides: Record<string, unknown> = {},
	{ target = `${schema}_r${targets.length}`, objects }: { target?: string; objects?: RestoreDeps["objects"] } = {},
) {
	targets.push(target);
	const store: Store = new Map();
	let reads = 0;
	const result = await restoreWithCurrentManifest(
		{ admin, source: schema, targetSchema: target, objects: objects ?? objectStore(store), clock: () => NOW },
		{
			capability: operator,
			target: "isolated",
			snapshot: copy,
			current: () => {
				reads++;
				return readCurrentManifest(admin);
			},
			...overrides,
		},
	);
	return { result, store, target, reads };
}
const open = (target: string) =>
	openDrillTarget(
		{ admin, connection: LOOPBACK, neon: () => ({ endpoints: [], branches: [] }) },
		{
			capability: {
				authority: "authorized_restricted_recovery_operator",
				verified: true,
				operation_ids: ["maintenance.openDrillTarget"],
				environment: "isolated-drill",
			},
			target,
		},
	);
const within = (target: string, table: string) => sql.raw(`${target}.${table}`);
const signIn = async (target: string, who: Actor) => {
	const session = randomUUID();
	await admin.execute(sql`INSERT INTO ${within(target, "auth_session")}(id,user_id,token,expires_at)
		VALUES(${session}::uuid,${who.user}::uuid,${session},'2027-01-01T00:00:00Z')`);
	return session as typeof who.session;
};
async function xActive(pool: typeof db, session: typeof a.session, organization: Workspace) {
	const read = await gatedTransaction(pool, (tx) =>
		organizations["privacy.getSharing"](tx, session, organization as never, { plant: g, organization }),
	);
	return !("status" in read);
}
const witnessOf = async (target: string, subject: string) =>
	(
		await rows<{ state: string; copy_expires_at: string | Date | null }>(
			sql`SELECT state, copy_expires_at FROM ${within(target, "lifecycle_witness")} WHERE opaque_subject_id=${subject}::uuid`,
		)
	)[0];
const short = (value: string | Date) => new Date(value).toISOString().replace(".000Z", "Z");
const expiryOf = (result: Awaited<ReturnType<typeof restore>>["result"]) =>
	result.subjects.find((s) => s.id === a.id)?.copy_expiry ?? null;

test("AC:EVRY-INTERNAL-RESTOREWITHCURRENTMANIFEST a stored copy restores only with intact files under the current witnesses, and brings back no access, body, mail or link ended since", async (step) => {
	await step.test("the image holds A, P, X, E and F as they were, and the current witness disagrees", async () => {
		const image = JSON.parse(copy.image.toString()).tables as Record<string, Record<string, unknown>[]>;
		const row = (table: string, id: string) => image[table]!.find((r) => r.id === id)!;
		assert.equal(image.lifecycle_witness!.length, 0);
		assert.ok(image.feedback!.some((f) => f.description === PRIVATE));
		assert.ok(copy.objects.has(avatar.id));
		assert.equal(row("affiliation", x).ended_at, null);
		assert.equal(await answerable(db, vOwner.session), "pending");
		assert.equal((await describeRsvpToken(db, { token: rsvp })).state, "pending");
		assert.equal(row("mail", mailE).state, "pending");
		assert.equal(row("mail", scheduledF).state, "scheduled");
		assert.deepEqual(
			[image.auth_verification!.length, image.identity_proof!.map((proof) => proof.superseded_at)],
			[1, [null]],
		);
		assert.ok(image.auth_session!.some((s) => s.id === a.session));
		assert.ok(
			image.auth_session!.every((s) => new Date(s.expires_at as string) > NOW),
			"only the restore can end these sessions",
		);
		assert.deepEqual(
			[row("seat", (await seatId(withdrawn.seat))!).ended_at, row("platform_grant", withdrawn.grant).revoked_at],
			[null, null],
		);
		assert.equal(row("residency_link", withdrawn.left.link).share_milestones, true);
		assert.equal((await witnessOf(schema, a.id))!.state, "purged");
		assert.equal((await witnessOf(schema, p.id))!.state, "pending_deletion");
		assert.equal(await xActive(db, oOwner.session, o), false);
		assert.equal(await xActive(db, nOwner.session, n), true);
	});

	await step.test("a file whose checksum is wrong keeps the target closed and empty", async () => {
		const before = await liveState();
		const damaged = new Map(copy.objects).set(gFile.id, Buffer.from("%PDF-1.7 launch plaX"));
		const { result, store, target } = await restore({ snapshot: { ...copy, objects: damaged } });
		const opened = await open(target);
		const created = await schemaExists(admin, target);
		const runtime = database.connect("runtime", { schema: target, max: 1 });
		const workers = delivery(runtime);
		await assert.rejects(workers.run());
		const journal = await rows<{ state: string }>(sql`SELECT state FROM mail WHERE id=${scheduledF}::uuid`);
		assert.deepEqual(
			{
				normalAccessEligible: result.restore_success || result.service_opened || opened.opened,
				A_body: created || JSON.stringify(result).includes(PRIVATE) ? "restored" : null,
				P_access: created,
				X_active: created,
				sendE_replayed: workers.sent.mail.length + workers.sent.batches.length > 0,
				scheduledF: journal[0]!.state,
				expires_at: expiryOf(result),
			},
			{
				normalAccessEligible: false,
				A_body: null,
				P_access: false,
				X_active: false,
				sendE_replayed: false,
				scheduledF: "cancelled",
				expires_at: EXPIRES,
			},
		);
		assert.equal(result.refusal, "file_mismatch");
		assert.equal(result.file, gFile.id);
		assert.equal(result.customer_data_gate, "blocked");
		assert.equal(store.size, 0);
		assert.deepEqual(await liveState(), before);
	});

	const complete = await restore();
	await step.test(
		"checksum-complete-current-witness: the isolated target opens with everything current applied",
		async () => {
			const { result, store, target } = complete;
			assert.equal(result.restore_success, true, JSON.stringify(result));
			assert.equal(result.service_opened, false);
			const runtime = database.connect("runtime", { schema: target, max: 3 });
			assert.equal(await closedTo(runtime, target), true);
			const opened = await open(target);
			const oldSessions = [];
			for (const who of [a, pOwner, gOwner, oOwner, foreign])
				oldSessions.push((await readViewer(runtime, who.session)) !== null);
			const sessions = { p: await signIn(target, pOwner), g: await signIn(target, gOwner), a: await signIn(target, a) };
			const sent = await delivery(runtime).run();
			const [bodies] = await rows<{
				bodies: number;
				email: string | null;
				passwords: number;
				links: number;
				ready: number;
			}>(sql`SELECT
			(SELECT count(*)::int FROM ${within(target, "feedback")} WHERE description=${PRIVATE} OR account_id=${a.id}::uuid) AS bodies,
			(SELECT email FROM ${within(target, "auth_user")} WHERE id=${a.user}::uuid) AS email,
			(SELECT count(*)::int FROM ${within(target, "auth_account")} WHERE user_id=${a.user}::uuid) AS passwords,
			(SELECT count(*)::int FROM ${within(target, "auth_verification")} WHERE identifier=${resetLink})
				+ (SELECT count(*)::int FROM ${within(target, "identity_proof")} WHERE superseded_at IS NULL AND consumed_at IS NULL) AS links,
			(SELECT count(*)::int FROM ${within(target, "file_object")} WHERE id=${avatar.id}::uuid AND state<>'purged') AS ready`);
			assert.deepEqual([bodies!.email, bodies!.passwords, bodies!.ready], [`removed-${a.id}@removed.invalid`, 0, 0]);
			const storage = {
				bucket: "synthetic-only",
				client: Object.assign(new S3Client({ region: "us-east-1", endpoint: "https://example.invalid" }), {
					send: async () => assert.fail("no removed file is requested"),
				}),
			};
			const invitedSession = await signIn(target, vOwner);
			const oldInvitation = [
				await answerable(runtime, invitedSession),
				await asOwner(
					runtime,
					invitedSession,
					"associations.acceptInvitation",
					{ invitationId, proof: invitationProof, decision: "accept" },
					v,
				).catch((error: Error) => error.message),
			];
			const oldRsvp = [
				(await describeRsvpToken(runtime, { token: rsvp })).state,
				JSON.stringify(await answerRsvpToken(runtime, { token: rsvp, rsvp: "confirmed" })),
			];
			assert.deepEqual(oldInvitation, ["unavailable", "unavailable"]);
			assert.equal(oldRsvp[0], "unavailable");
			assert.match(oldRsvp[1]!, /"code":"token_closed"/);
			const [answered] = await rows<{ rsvp: string }>(
				sql`SELECT rsvp FROM ${within(target, "participation")} WHERE plant_id=${g.id}::uuid`,
			);
			assert.equal(answered!.rsvp, "pending");
			const avatarUrl = await readAvatar(
				runtime,
				storage,
				{ session: sessions.a, selected: aRequest.subject },
				{ accountId: a.id, versionId: avatar.id },
			).then(
				() => "read",
				() => null,
			);
			const cancelled = await gatedTransaction(database.connect("admin", { schema: target, max: 1 }), (tx) =>
				deletions.cancelAccountDeletion(tx, cancelProof, command({ ...aRequest })),
			).then(
				(reply) => reply.status,
				() => "refused",
			);
			const witness = await witnessOf(target, a.id);
			const [f] = await rows<{ state: string }>(
				sql`SELECT state FROM ${within(target, "mail")} WHERE id=${scheduledF}::uuid`,
			);
			assert.deepEqual(
				{
					normalAccessEligible: opened.opened && (await readViewer(runtime, sessions.g))?.accountId === gOwner.id,
					A_body: bodies!.bodies === 0 && (await readViewer(runtime, sessions.a)) === null ? null : "restored",
					P_access: (await RequestActor.resolve(runtime, sessions.p)) instanceof RequestActor,
					X_active: await xActive(runtime, await signIn(target, oOwner), o),
					sendE_replayed: sent.mail.includes("send-e@example.test"),
					scheduledF: f!.state,
					expires_at: short(witness!.copy_expires_at!),
					A_bytes: store.get(avatar.key) ?? null,
					old_sessions_valid: oldSessions.some(Boolean),
					old_urls_valid:
						avatarUrl !== null ||
						cancelled === "ok" ||
						bodies!.links > 0 ||
						oldInvitation[0] !== "unavailable" ||
						oldRsvp[0] !== "unavailable",
				},
				{
					normalAccessEligible: true,
					A_body: null,
					P_access: false,
					X_active: false,
					sendE_replayed: false,
					scheduledF: "cancelled",
					expires_at: EXPIRES,
					A_bytes: null,
					old_sessions_valid: false,
					old_urls_valid: false,
				},
			);
			const resent = await asOwner(runtime, sessions.g, "associations.resendInvitation", { invitationId });
			assert.ok("invitationId" in resent, "the Owner can send a working link again");
			const old = invitationProof;
			invitationProof = proofs.get(invitationId)!;
			assert.notEqual(invitationProof, old);
			assert.equal(await answerable(runtime, invitedSession), "pending");
			assert.equal(await xActive(runtime, await signIn(target, nOwner), n), true, "a link still active is restored");
			assert.deepEqual(sent, { mail: ["control@example.test"], batches: ["scheduled-control@example.test"] });
			assert.deepEqual(store.get(gFile.key), live.get(gFile.key));
			assert.equal(witness!.state, "purged");
			assert.equal((await witnessOf(target, p.id))!.state, "pending_deletion");
			assert.equal(expiryOf(result), EXPIRES);
			assert.equal(
				(await rows<{ state: string }>(sql`SELECT state FROM mail WHERE id=${mailE}::uuid`))[0]!.state,
				"unknown",
			);
		},
	);

	await step.test(
		"access, sharing and grants withdrawn since the copy stay withdrawn, and the rest is kept",
		async () => {
			assert.deepEqual(await accessIn(complete.target), {
				seat: false,
				demoted: "member",
				kept: "admin",
				granted: false,
				totals: false,
				left: [false, false, false],
				resident: [true, true, true],
				sharing: [false, true],
			});
			const runtime = database.connect("runtime", { schema: complete.target, max: 1 });
			for (const [who, works] of [
				[withdrawn.seat, false],
				[retained.seat, true],
			] as const) {
				const session = await signIn(complete.target, who);
				assert.equal(
					await gatedTransaction(runtime, async (tx) =>
						RequestActor.claimWrite(tx, session, g as never).then((write) => write !== null),
					),
					works,
				);
			}
		},
	);

	await step.test(
		"foreign-context-refused: no member, forged operator or app login restores, reads or learns anything",
		async () => {
			const before = await liveState();
			const capabilities = [
				{ account: foreign.id, session: foreign.session, context: g.id },
				{ account: foreign.id, session: foreign.session, context: g.id, role: "member" },
				{ ...operator, authority: "member" },
				{ ...operator, account: foreign.id },
				{ ...operator, verified: false },
				await actorOf(foreign),
				undefined,
			];
			for (const capability of capabilities) {
				const { result, store, target, reads } = await restore({ capability });
				assert.deepEqual(
					[result.refusal, result.restore_success, result.service_opened],
					["operator_unavailable", false, false],
				);
				assert.deepEqual([result.subjects, result.file, result.target, reads, store.size], [[], null, null, 0, 0]);
				assert.equal(await schemaExists(admin, target), false);
			}
			const target = `${schema}_r${targets.length}`;
			targets.push(target);
			const asApp = await restoreWithCurrentManifest(
				{ admin: db, source: schema, targetSchema: target, objects: objectStore(new Map()), clock: () => NOW },
				{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(admin) },
			);
			assert.equal(asApp.restore_success, false);
			assert.equal(await schemaExists(admin, target), false);
			assert.deepEqual(await liveState(), before);
		},
	);

	await step.test(
		"required-boundary-failure: an unreadable journal or file store writes nothing new and keeps the finished restore",
		async () => {
			const before = await liveState();
			const finished = async () =>
				rows(sql`SELECT (SELECT count(*)::int FROM ${within(complete.target, "person")}) AS people,
				(SELECT count(*)::int FROM ${within(complete.target, "mail")}) AS mail, obj_description(oid,'pg_namespace') AS mark
				FROM pg_namespace WHERE nspname=${complete.target}`);
			const restored = await finished();
			const offline = async () => {
				throw Error("journal_timeout");
			};
			for (const [overrides, refusal] of [
				[{ current: offline }, "witness_unreadable"],
				[{ current: async () => null }, "witness_missing"],
				[{ snapshot: { ...copy, objects: new Map() } }, "file_missing"],
			] as const) {
				const { result, store, target } = await restore(overrides);
				assert.deepEqual([result.refusal, result.restore_success, result.service_opened], [refusal, false, false]);
				assert.equal(store.size, 0);
				assert.equal(await schemaExists(admin, target), false);
			}
			assert.deepEqual(await finished(), restored);
			assert.deepEqual(await liveState(), before);
		},
	);

	await step.test(
		"a restore interrupted while it stores files leaves nothing behind, and the same restore then completes",
		async () => {
			const target = `${schema}_resume`;
			const interrupted = await restore(
				{},
				{ target, objects: { put: async () => assert.fail("storage_interrupted") } },
			);
			assert.deepEqual([interrupted.result.refusal, interrupted.result.restore_success], ["restore_failed", false]);
			assert.equal(await schemaExists(admin, target), false);
			assert.equal((await open(target)).opened, false);
			const resumed = await restore({}, { target });
			assert.equal(resumed.result.restore_success, true, JSON.stringify(resumed.result));
			assert.equal(
				short((await witnessOf(target, a.id))!.copy_expires_at!),
				EXPIRES,
				"a second restore never resets the expiry",
			);
			assert.deepEqual([...resumed.store.keys()], [gFile.key]);
			const again = await restore({}, { target });
			assert.equal(again.result.refusal, "target_not_fresh");
			assert.equal((await witnessOf(target, p.id))!.state, "pending_deletion");
		},
	);
});
