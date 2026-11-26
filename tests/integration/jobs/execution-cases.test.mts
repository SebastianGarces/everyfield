import { AsyncResource } from "node:async_hooks";
import "../platform/setup.mts";
import test, { after, before, mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tenantId } from "../../../packages/contracts/src/common/values.ts";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { documentsWriter } from "../../../packages/domain/src/documents/index.ts";
import { feedbackWriter } from "../../../packages/domain/src/feedback/index.ts";
import { cancelUnsubscribedHeld } from "../../../packages/domain/src/communication/index.ts";
import {
	ASSESSMENT_TIMING,
	createAssessmentJob,
	createAssessments,
	runAssessmentBatch,
	type Drafter,
} from "../../../packages/domain/src/intelligence/index.ts";
import { authorizeDigestMail, createDigestWorker, planDigests } from "../../../packages/domain/src/jobs/digest.ts";
import { runDueFeedbackPublication } from "../../../packages/domain/src/jobs/feedback-publication.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailTransport,
} from "../../../packages/domain/src/jobs/mail.ts";
import {
	checkpoint,
	claimDue,
	claimSchema,
	enqueueJob,
	finishClaim,
	finishJob,
	queueJobs,
	scanPage,
	type JobKind,
} from "../../../packages/domain/src/jobs/queue.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { createLifecycleCleanup, deletionOperations } from "../../../packages/domain/src/settings/index.ts";
import { issueRestrictedDeletionSession } from "../../../packages/domain/src/settings/deletion.ts";
import { runDueWikiEmbedding } from "../../../packages/domain/src/wiki/embedding.ts";
import { scriptedAssessmentDrafter } from "../../../packages/evry-scripted/src/scripted-assessment.ts";
import { approvedWiki, type WikiSource } from "../../../packages/reference/src/starter/manifest/approved.ts";
import { localEmbedding } from "../../../packages/reference/src/starter/verify/embed.ts";
import { referenceService } from "../../../packages/reference/src/starter/verify/service.ts";
import { WikiRefusal } from "../../../packages/reference/src/starter/verify/snapshot.ts";
import { createNotificationWorker } from "../../../apps/web/src/features/notifications/worker.ts";
import { githubIssues } from "../../../apps/web/src/server/jobs/github.ts";
import { createResendTransport } from "../../../apps/web/src/server/jobs/resend.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { cronRoute } from "../../../apps/web/src/server/platform/cron.ts";
import { readiness } from "../../../ops/maintenance/readiness.mts";
import { openedDeletion } from "../../support/deletion-cookie.mts";
import { fakeGitHub } from "../../support/fake-github.mts";
import { fixture, ok, raced, refused, seeds, waitingOnLock, type Actor } from "../../support/fixture.mts";
import { NOTHING, recorded, untouched } from "../../support/recorded.mts";
import { setServerEnv } from "../../support/server-env.mts";
import { testDatabase } from "../../support/test-database.mts";
import { MemoryClient } from "../documents/storage.mts";
import { church, type StoredRun } from "../intelligence/assessment-church.mts";
import { freezeClock, readyFile, type Store } from "../target/sql/knowledge/support.mts";

type Case = ReturnType<typeof JSON.parse>;
const { cases }: { cases: Case[] } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/execution.json", import.meta.url), "utf8"),
);
const caseOf = (id: string): Case => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const subcaseOf = (id: string, name: string): Case =>
	caseOf(id).subcases.find((s: Case) => s.name === name) ?? assert.fail(`no subcase ${name}`);

setServerEnv();
const NOW = caseOf("EXEC-001").clock.now as string;
const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const later = (ms: number) => iso(Date.parse(NOW) + ms);
const secret = "cron-" + randomUUID();

mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
const database = await fixture({
	prefix: "execcases",
	max: 8,
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	clock: new Date(Date.parse(NOW) - 60 * MINUTE),
	plant: { name: "Harvest Point" },
});
const { admin, schema } = database;
const { runtime: db, cleanup } = database.pools as Record<"runtime" | "cleanup", typeof database.admin>;
const P = database.tenant;
const A = database.actors.admin;
const Q = await database.plant({ name: "Other Plant", timezone: "America/New_York" });
const B = await database.actor(Q, "admin", { email: "casey@example.test" });

async function at(when: string | number) {
	const instant = new Date(when);
	await freezeClock(admin, schema, instant);
	mock.timers.setTime(instant.getTime());
}
before(() => at(NOW));
after(async () => {
	mock.timers.reset();
	await database.close();
});

const rows = async <T extends Record<string, unknown>>(query: SQL) => (await admin.execute<T>(query)).rows;
const one = async <T extends Record<string, unknown>>(query: SQL) =>
	(await rows<T>(query))[0] ?? assert.fail("the query returned no row");
const count = async (query: SQL) => Number((await one<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${query}`)).n);
async function subject(tenant = P.id) {
	const id = randomUUID();
	await admin.execute(sql`INSERT INTO document(id,tenant_id,kind,title) VALUES(${id},${tenant},'native','Synthetic')`);
	return id;
}
async function enqueued(kind: JobKind, { tenant = P.id, due = later(-60 * MINUTE), id = "" } = {}) {
	const record = id || (await subject(tenant));
	return transaction(db, (tx) =>
		enqueueJob(tx, {
			tenant,
			kind,
			subject: record,
			key: kind === "notification" ? "meeting/announcement" : record,
			revision: "1",
			eligibleAt: due,
		}),
	);
}
const jobRow = (id: string) =>
	one<{
		state: string;
		attempt_count: number;
		claim_generation: string;
		lease_owner: string | null;
		checkpoint_key: string | null;
		error_code: string | null;
	}>(sql`SELECT state,attempt_count,claim_generation::text AS claim_generation,lease_owner,checkpoint_key,error_code
		FROM job WHERE id=${id}`);

function mailer(transport: MailTransport, authorize?: Parameters<typeof createMailService>[0]["authorize"]) {
	return createMailService({
		db,
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: Buffer.alloc(32, 9),
		from: "no-reply@example.test",
		authorize: authorize ?? (async (_tx, list) => new Set(list.map((m) => m.id))),
		transport,
	});
}
const sender = (send: MailTransport["send"]): MailTransport => ({
	send,
	lookup: async () => ({ kind: "unknown" }),
});
const accepting = () => sender(async () => ({ kind: "accepted", id: randomUUID() }));
async function queuedMail(
	logicalKey: string,
	{ tenant = P, recipient = A, due = later(-60 * MINUTE) }: { tenant?: typeof P; recipient?: Actor; due?: string } = {},
) {
	const id = await transaction(db, (tx) =>
		mailer(accepting()).enqueue(tx, {
			owner: { kind: "plant", id: tenant.id },
			purpose: "notification",
			logicalKey,
			recipient: recipient.id,
			address: recipient.email,
			content: { subject: "Synthetic", text: "safe" },
			operation: null,
			notice: null,
			eligibleAt: due,
		}),
	);
	const { job_id } = await one<{ job_id: string }>(sql`SELECT job_id FROM mail WHERE id=${id}`);
	return { id, job: job_id };
}
const mailRow = (id: string) =>
	one<{ state: string; provider_message_id: string | null }>(
		sql`SELECT state,provider_message_id FROM mail WHERE id=${id}`,
	);
const passOf = (transport: MailTransport, name: keyof typeof MAIL_PASSES = "notice") => {
	const service = mailer(transport);
	return (limit: number, until: number) => runDueMail(db, service, MAIL_PASSES[name], limit, until);
};

type Config = Parameters<typeof scheduledJobs>[0];
type Body = {
	status: string;
	failed: string[];
	steps: Record<string, { status: string; count?: unknown }>;
	digests: number;
	purged: number;
};
const route = (config: Partial<Config> = {}) =>
	cronRoute(
		secret,
		scheduledJobs({
			db,
			storage: null,
			cleanup: null,
			effects: null,
			digests: null,
			mail: null,
			now: () => new Date(),
			...config,
		}),
	);
const URL_ = "http://localhost/api/cron/jobs";
const bearer = { authorization: `Bearer ${secret}` };
async function tick(config: Partial<Config> = {}, request = new Request(URL_, { headers: bearer })) {
	const response = await route(config)(request);
	assert.equal(response.status, 200);
	const body = (await response.json()) as Body;
	assert.deepEqual([body.status, body.failed], ["ok", []]);
	return body;
}
const quietly = async <T,>(run: () => Promise<T>) => {
	const original = console.error;
	console.error = () => {};
	try {
		return await run();
	} finally {
		console.error = original;
	}
};

const origin = "https://app.everyfield.test";
const digests = createDigestWorker({ mail: mailer(accepting(), authorizeDigestMail), origin });
const notifications = createNotificationWorker({ mail: mailer(accepting()) });

test("AC:EXEC-001 a tick without the scheduler's exact secret claims nothing, and one with it ignores every forged operation, kind and subject", async () => {
	const c = caseOf("EXEC-001");
	const sub = subcaseOf("EXEC-001", "valid-schedule-cannot-select-subject");
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at)
		VALUES(${person},${Q.id},${Q.id},'Casey','other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	const waiting = async () => {
		const mail = await queuedMail(`notice/${randomUUID()}`);
		return { mail, notification: await enqueued("notification") };
	};
	const J = await waiting();
	const config = { notifications, mountMail: { notice: passOf(accepting()) } };

	const attempts: [string, Record<string, string>][] = [
		["no credential", {}],
		["an empty bearer", { authorization: "Bearer " }],
		["the secret with no scheme", { authorization: secret }],
		["another secret", { authorization: `Bearer ${"x".repeat(secret.length)}` }],
		["a longer secret", { authorization: `Bearer ${secret}x` }],
		["a person's session", { authorization: `Bearer ${A.session}`, cookie: `session=${A.session}` }],
	];
	await untouched(admin, async () => {
		for (const [name, headers] of attempts) {
			const response = await route(config)(new Request(URL_, { headers }));
			assert.equal(response.status, 401, name);
			assert.deepEqual(await response.json(), { status: c.expected.result.error_code }, name);
		}
		for (const unset of [undefined, ""]) {
			const closed = cronRoute(unset, async () => assert.fail("a route with no secret ran the jobs"));
			assert.equal((await closed(new Request(URL_, { headers: { authorization: "Bearer " } }))).status, 503);
		}
	});
	assert.equal(await count(sql`job WHERE attempt_count>0 OR lease_owner IS NOT NULL`), c.expected.result.jobs_claimed);

	const plain = await recorded(admin, () => tick(config));
	assert.equal((await mailRow(J.mail.id)).state, "accepted");
	assert.equal((await jobRow(J.notification)).attempt_count, 1);

	const again = await waiting();
	const { forged_operation, forged_subject } = sub.given.execution;
	assert.equal(forged_subject, "Q");
	const ofQ = () =>
		rows(sql`SELECT 'person' AS at,to_jsonb(x) AS row FROM person x WHERE tenant_id=${Q.id}
			UNION ALL SELECT 'plant',to_jsonb(x) FROM plant x WHERE id=${Q.id}
			UNION ALL SELECT 'seat',to_jsonb(x) FROM seat x WHERE plant_id=${Q.id}
			UNION ALL SELECT 'job',to_jsonb(x) FROM job x WHERE tenant_id=${Q.id}
			UNION ALL SELECT 'audit',to_jsonb(x) FROM audit_event x WHERE tenant_id=${Q.id}
			UNION ALL SELECT 'notice',to_jsonb(x) FROM notice x WHERE tenant_id=${Q.id}
			UNION ALL SELECT 'mail',to_jsonb(x) FROM mail x WHERE tenant_id=${Q.id} ORDER BY 1`);
	const before = await ofQ();
	const forged = await recorded(admin, () =>
		tick(
			config,
			new Request(
				`${URL_}?operation=${forged_operation}&kind=lifecycle_purge&subject=${Q.id}&tenant=${Q.id}&personId=${person}`,
				{
					method: "POST",
					headers: {
						...bearer,
						"content-type": "application/json",
						"x-operation": forged_operation,
					},
					body: JSON.stringify({
						operation: forged_operation,
						subject: Q.id,
						input: { personId: person },
					}),
				},
			),
		),
	);
	const expected = sub.expected.result;
	assert.deepEqual(forged.value, plain.value, "the same registered steps ran, with the same counts");
	assert.equal(
		JSON.stringify(forged.value).includes(forged_operation) ? forged_operation : null,
		expected.selected_business_operation,
	);
	assert.deepEqual(
		forged.added.audits.filter((action) => !action.startsWith("mail.")),
		[],
	);
	assert.deepEqual(forged.added, plain.added);
	assert.deepEqual(await ofQ(), before);
	assert.equal(await count(sql`audit_event WHERE tenant_id=${Q.id}`), expected.arbitrary_subject_effects);
	assert.equal((await mailRow(again.mail.id)).state, "accepted");
});

test("AC:EXEC-002 two ticks racing for one due job have one active worker, and a worker that lost its claim can neither save progress nor publish", async () => {
	const c = caseOf("EXEC-002");
	const stale = subcaseOf("EXEC-002", "expired-worker-cannot-publish");
	const due = c.given.J.due_at as string;

	const first = await queuedMail(`notice/${randomUUID()}`, { due });
	const sends: string[] = [];
	const counting = sender(async (_payload, key) => {
		sends.push(key);
		return { kind: "accepted", id: "once-" + sends.length };
	});
	const both = () => tick({ mountMail: { notice: passOf(counting) } });
	const ticks = await raced(admin, db, sql`LOCK TABLE job IN ACCESS EXCLUSIVE MODE`, [both, both]);
	assert.deepEqual(ticks.map((body) => body.steps["notice-mail"]!.count).sort(), [0, 1]);
	assert.equal(sends.length, 1);
	assert.deepEqual([(await jobRow(first.job)).attempt_count, (await mailRow(first.id)).state], [1, "accepted"]);

	const J = await queuedMail(`notice/${randomUUID()}`, { due });
	const unclaimed = await jobRow(J.job);
	assert.deepEqual([unclaimed.state, unclaimed.claim_generation], [c.given.J.state, "0"]);
	const held = () => {
		const reached = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const seen: string[] = [];
		const transport = (id: string) =>
			sender(async (_payload, key) => {
				seen.push(key);
				reached.resolve();
				await release.promise;
				return { kind: "accepted", id };
			});
		return { reached, release, seen, transport };
	};
	const firstHeld = held(),
		secondHeld = held();
	const worker1 = tick({ mountMail: { notice: passOf(firstHeld.transport("from-worker-1")) } });
	let worker2: typeof worker1 | null = null;
	try {
		await firstHeld.reached.promise;
		const owned = claimSchema.parse((await rows(sql`SELECT * FROM job WHERE id=${J.job}`))[0]);
		const rival = await tick({
			mountMail: { notice: passOf(sender(async () => assert.fail("a second worker sent"))) },
		});
		assert.equal(rival.steps["notice-mail"]!.count, 0);
		const active = () =>
			count(
				sql`job WHERE id=${J.job} AND state='claimed' AND lease_until>clock_timestamp() AND lease_owner IS NOT NULL`,
			);
		assert.equal(await active(), c.expected.result.active_workers);
		const identities = new Map([
			[unclaimed.claim_generation, c.given.J.worker_identity],
			[String(Number(unclaimed.claim_generation) + 1), stale.given.J.worker_identity],
		]);
		assert.equal(identities.get(owned.claim_generation), c.expected.result.current_worker_identity);
		assert.equal((await jobRow(J.job)).lease_owner, owned.lease_owner);

		await at(Date.parse(stale.given.J.lease_until) + 1000);
		await tick({ notifications });
		assert.deepEqual([(await jobRow(J.job)).state, (await mailRow(J.id)).state], ["reconcile", "unknown"]);
		await at(Date.parse(stale.given.J.lease_until) + 6 * MINUTE);
		worker2 = tick({
			mountMail: { notice: passOf(secondHeld.transport("from-worker-2")) },
			notifications,
		});
		await secondHeld.reached.promise;
		const replaced = await jobRow(J.job);
		assert.equal(replaced.state, stale.given.J.state);
		assert.equal(await active(), c.expected.result.active_workers);
		assert.notEqual(replaced.lease_owner, owned.lease_owner);
		assert.notEqual(replaced.claim_generation, owned.claim_generation);

		await untouched(admin, async () => {
			const saved = await transaction(db, (tx) => checkpoint(tx, owned, stale.given.execution.checkpoint));
			assert.equal(saved, stale.expected.result.checkpoint_changed);
			const applied = [
				await transaction(db, (tx) => finishClaim(tx, owned, { state: "succeeded" })),
				await finishJob(db, owned, { state: "succeeded" }),
			];
			const labels = new Map([["false,false", "stale_claim"]]);
			assert.equal(labels.get(applied.join()), stale.expected.result.error_code);
			firstHeld.release.resolve();
			await worker1;
		});
		assert.deepEqual(await jobRow(J.job), replaced);
		assert.equal((await mailRow(J.id)).provider_message_id !== null, stale.expected.result.published);
	} finally {
		firstHeld.release.resolve();
		secondHeld.release.resolve();
		await Promise.allSettled([worker1, worker2]);
	}
	assert.deepEqual(await mailRow(J.id), {
		state: "accepted",
		provider_message_id: "from-worker-2",
	});
	assert.equal((await jobRow(J.job)).state, "succeeded");
	assert.deepEqual(secondHeld.seen, firstHeld.seen, "the replay keeps the first request's identity");
	assert.equal(await count(sql`audit_event WHERE subject_id=${J.id} AND action='mail.accepted'`), 1);
	await at(NOW);
});

async function owedDigest() {
	await admin.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,cadence,unsubscribe_revision)
		VALUES(${B.id},'planter_digest','in_app',true,'weekly',1) ON CONFLICT DO NOTHING`);
	await admin.execute(sql`INSERT INTO digest_coverage(tenant_id,recipient_id,purpose,cadence,timezone,covered_through)
		VALUES(${Q.id},${B.id},'planter','weekly','America/New_York','2026-10-05'::date)`);
	const task = randomUUID();
	await admin.execute(sql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,due_kind,due_date)
		VALUES(${task},${Q.id},'Book the venue','general','medium','not_started',clock_timestamp(),'date_only','2026-10-10'::date)`);
	await admin.execute(sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${Q.id},${task},${B.id})`);
}
class Bucket extends S3Client {
	store: Store = new Map();
	down = false;
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	override async send(command: { input: { Key?: string } }) {
		assert.equal(command.constructor.name, "DeleteObjectCommand");
		if (this.down) throw Error("provider_timeout");
		this.store.delete(String(command.input.Key));
		return {};
	}
}
const client = new Bucket();
const storage = { bucket: "synthetic-only", client };
const deletion = deletionOperations({
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
const command = (input: object, expectedRevision: string) => ({
	input,
	expectedRevision,
	requestKey: randomUUID(),
});
async function doomed(requestedAt: string) {
	await at(requestedAt);
	const plant = await database.plant({ name: "Closing Church" });
	const ref = { kind: "plant" as const, id: tenantId.parse(plant.id) };
	const owner = await database.actor(plant, "owner");
	const member = await database.actor(plant, "admin");
	const person = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at)
		VALUES(${person},${plant.id},${plant.id},'Alex','other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	const file = await readyFile(admin, client.store, plant.id, Buffer.from("a photo"), "person_photo");
	await admin.execute(sql`UPDATE person SET photo_object_id=${file.id} WHERE id=${person}`);
	const request = async () => {
		const { revision } = await one<{ revision: string }>(
			sql`SELECT revision::text AS revision FROM plant WHERE id=${plant.id}`,
		);
		const session = await freshSession(owner);
		return ok(
			await gatedTransaction(db, (tx) =>
				deletion.requestWorkspaceDeletion(
					tx,
					{ session, selected: ref },
					command({ plant: ref, confirmed: true }, revision),
				),
			),
		);
	};
	const proofOf = (requestId: string) => {
		const asked = { subject: ref, requestId };
		return openedDeletion(
			gatedTransaction(admin, (tx) =>
				issueRestrictedDeletionSession(tx, asked, async () => ({
					accountId: owner.id,
					provenAt: new Date(),
				})),
			),
			asked,
		);
	};
	const witness = () =>
		one<{
			id: string;
			state: string;
			request_id: string;
			revision: string;
			cancel_until: string | Date;
		}>(
			sql`SELECT id,state,request_id,request_revision::text AS revision,cancel_until
				FROM lifecycle_witness WHERE opaque_subject_id=${plant.id}`,
		);
	const purgeJob = async () => {
		const { id, revision } = await witness();
		return (
			await one<{ id: string }>(
				sql`SELECT id FROM job WHERE kind='lifecycle_purge' AND subject_record_id=${id} AND source_revision=${revision}::bigint`,
			)
		).id;
	};
	const content = () => count(sql`person WHERE plant_id=${plant.id}`);
	return { plant, ref, owner, member, file, request, proofOf, witness, purgeJob, content };
}
async function freshSession(who: Actor) {
	const session = randomUUID();
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${session},${who.user},${randomUUID()},'2027-01-01T00:00:00Z')`);
	return session as Actor["session"];
}
async function normalAccess(plant: { id: string }, who: Actor) {
	const actor = await RequestActor.resolve(db, await freshSession(who));
	return (
		actor instanceof RequestActor &&
		actor.actor.context.kind === "seat" &&
		JSON.stringify(actor.actor).includes(plant.id)
	);
}

test("AC:EXEC-003 one church's endless mail and digest backlog keeps another church's digest, a due deletion, reference work and held-mail cancellations moving", async () => {
	const c = caseOf("EXEC-003");
	const { result } = c.expected;
	const closing = await doomed("2026-09-13T15:00:00Z");
	await closing.request();
	await at(c.clock.now);
	await owedDigest();

	const section = randomUUID(),
		article = randomUUID(),
		version = randomUUID(),
		release = randomUUID();
	const hash = () => randomBytes(32).toString("hex");
	const GLOBAL = "00000000-0000-0000-0000-000000000000";
	const network = await database.organization("sending_network", { name: "Harvest Network" });
	await admin.execute(sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id)
		VALUES(${section},'section','core',${GLOBAL}),(${article},'article','network/follow-up',${network.id})`);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,
			approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},'R1','memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',
			${hash()},'v','synthetic',1536,${GLOBAL},0)`);
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,
			expected_prior_number) VALUES(${randomUUID()},${release},1,clock_timestamp(),'synthetic','test',0)`);
	await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,revision_number,title,slug,excerpt,body,content_type,
			phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id)
		VALUES(${version},${article},${network.id},1,'Follow-up','network/follow-up','Follow-up','Call every guest within two days.',
			'safe_nodes',null,1,${hash()},clock_timestamp(),true,1,${section})`);
	await admin.execute(sql`INSERT INTO article_editor_state(id,organization_id,article_id,state,current_revision_id,revision)
		VALUES(${randomUUID()},${network.id},${article},'published',${version},1)`);
	const embedding = await enqueued("wiki_embedding", { tenant: network.id, id: version });

	const unsubscribed = randomUUID(),
		communication = randomUUID(),
		heldMail = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at)
		VALUES(${unsubscribed},${Q.id},${Q.id},'Opted Out','out@example.test','other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	await admin.execute(sql`INSERT INTO person_email_opt_out(id,plant_id,person_id,opted_out_at)
		VALUES(${randomUUID()},${Q.id},${unsubscribed},clock_timestamp())`);
	await admin.execute(sql`INSERT INTO record(id,kind,tenant_id) VALUES(${communication},'communication',${Q.id})`);
	await admin.execute(sql`INSERT INTO mail(id,tenant_id,recipient_person_id,purpose,logical_key,payload_hash,audience_hash,state,
			provider_message_id,scheduled_at,accepted_at,created_at)
		VALUES(${heldMail},${Q.id},${unsubscribed},'communication',${`communication/${communication}/${unsubscribed}`},${hash()},${hash()},
			'accepted','held-1',${later(24 * 60 * MINUTE)}::timestamptz,clock_timestamp(),clock_timestamp())`);

	const backlog: string[] = [];
	for (let i = 0; i < 30; i++) backlog.push((await queuedMail(`notice/${randomUUID()}`)).id);
	const digestsOfP: string[] = [];
	for (let i = 0; i < 25; i++) digestsOfP.push(await enqueued("digest"));
	await planDigests(db, c.clock.now);
	const { id: digestQ } = await one<{ id: string }>(
		sql`SELECT id FROM job WHERE kind='digest' AND subject_record_id=${B.id}`,
	);
	assert.equal((await jobRow(digestQ)).state, "ready");

	const cancelled: string[][] = [];
	let sent = 0;
	const slow = sender(async () => {
		if (++sent % 2 === 0) mock.timers.setTime(Date.now() + 61_000);
		return { kind: "accepted", id: randomUUID() };
	});
	const config = {
		digests,
		notifications,
		storage,
		cleanup,
		mountMail: { notice: passOf(slow) },
		wikiEmbedding: (limit: number, until: number) =>
			runDueWikiEmbedding(
				db,
				{
					profile: "synthetic",
					dimensions: 1536,
					embedMany: async (texts: readonly string[]) => ({
						vectors: texts.map(() => Array.from({ length: 1536 }, (_, i) => (i ? 0 : 1))),
						totalTokens: 5,
					}),
				} as never,
				limit,
				until,
			),
		messageCancels: () =>
			cancelUnsubscribedHeld(
				db,
				{
					paused: false,
					send: async () => assert.fail("nothing is sent"),
					reschedule: async () => assert.fail("nothing is rescheduled"),
					cancel: async (ids: readonly string[]) => {
						cancelled.push([...ids]);
						return ids.map(() => ({ outcome: "done" as const }));
					},
				} as never,
				50,
			),
	} satisfies Partial<Config>;
	const pendingMail = () => count(sql`mail WHERE id=ANY(${sql.param(backlog)}::uuid[]) AND state='pending'`);

	const firstTick = await tick(config);
	assert.equal(await pendingMail(), 28, "the slow backlog used the tick's whole window");
	const retained = await jobRow(digestQ);
	assert.deepEqual([retained.state, retained.attempt_count], ["ready", 0]);
	assert.equal(["ready", "succeeded"].includes(retained.state), result.Q_job_retained);
	assert.equal(firstTick.purged, 1);
	assert.equal((await closing.witness()).state, "purged");
	assert.equal((await jobRow(embedding)).state, "succeeded");
	const heldAfter = await mailRow(heldMail);
	assert.deepEqual(
		cancelled.length === 1 && cancelled[0]![0] === "held-1" && heldAfter.state === "refused",
		result.cancellation_slot_reserved,
		"a cancellation runs in the tick whose mail window is used up",
	);
	assert.equal(firstTick.steps["message-cancels"]!.count, 1);

	await at(later(MINUTE));
	const newer: string[] = [];
	for (let i = 0; i < 25; i++) newer.push(await enqueued("digest", { due: later(30_000) }));
	for (let i = 0; i < 5; i++) await queuedMail(`notice/${randomUUID()}`, { due: later(30_000) });
	await tick(config);
	const served = await jobRow(digestQ);
	assert.equal(served.state !== "succeeded", result.tail_starved);
	assert.equal(await count(sql`job WHERE id=${digestQ}`), 1, "the owed job is never dropped");
	assert.deepEqual(
		(await rows(sql`SELECT title FROM notice WHERE recipient_id=${B.id}`)).map((n) => String(n.title).slice(0, 27)),
		["Church digest: 1 open item,"],
	);
	assert.equal(await count(sql`job WHERE id=ANY(${sql.param(digestsOfP)}::uuid[]) AND state='succeeded'`), 25);
	const waiting = await count(sql`job WHERE id=ANY(${sql.param(newer)}::uuid[]) AND state='ready'`);
	assert.ok(waiting > 0 && waiting < 25, "newer work of the busy church did not pass the older owed digest");
	assert.equal(await pendingMail(), 26);
	await admin.execute(sql`UPDATE job SET state='cancelled' WHERE state='ready'`);
	await at(NOW);
});

test("AC:EXEC-004 a tick that reaches its deadline in a slow provider call claims nothing more, keeps its place and leaves the call's outcome unknown", async () => {
	const c = caseOf("EXEC-004");
	const { result } = c.expected;
	const { elapsed_seconds, cursor } = c.given.execution;
	const J1 = await queuedMail(`notice/${randomUUID()}`, { due: later(-61 * MINUTE) });
	const J2 = await queuedMail(`notice/${randomUUID()}`, { due: c.given.J2.due_at });
	const next = await enqueued("notification", { due: c.given.J2.due_at });
	const keys: string[] = [];
	const slow = sender(async (_payload, key) => {
		keys.push(key);
		await at(later(elapsed_seconds * 1000));
		throw new DOMException("The operation timed out", "TimeoutError");
	});
	const pages = [randomUUID(), randomUUID()].sort();
	const scan = await enqueued("object_cleanup");
	const labels: Record<string, string> = { [pages[0]!]: "page-2", [pages[1]!]: "page-3" };
	await admin.execute(sql`UPDATE job SET checkpoint_key=${pages[0]} WHERE id=${scan}`);
	const [scanning] = await claimDue(db, ["object_cleanup"]);
	assert.equal(scanning!.id, scan);
	await assert.rejects(
		transaction(db, (tx) =>
			scanPage(tx, scanning!, {
				size: 2,
				load: async (_tx, from) => {
					assert.equal(from, pages[0]);
					return [pages[1]!];
				},
				process: async () => {
					throw Error("route_deadline");
				},
			}),
		),
		/route_deadline/,
	);
	await quietly(() => tick({ mountMail: { notice: passOf(slow), digest: passOf(slow, "notice") }, notifications }));

	assert.equal(keys.length, 1, "one call was in flight when the deadline passed");
	const inflight = await jobRow(J1.job);
	assert.deepEqual([inflight.state, inflight.error_code], ["reconcile", "provider_unknown"]);
	assert.equal((await mailRow(J1.id)).state, result.inflight_external_outcome);
	const unstarted = await jobRow(J2.job);
	assert.equal(unstarted.attempt_count, result.new_claims);
	assert.equal(
		unstarted.state === "ready" && unstarted.lease_owner === null && unstarted.claim_generation === "0",
		result.unstarted_claims_released,
	);
	assert.equal((await mailRow(J2.id)).state, "pending");
	assert.equal((await jobRow(next)).state, "superseded", "a step before the slow call had run");

	await admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${scan}`);
	await tick();
	const stopped = await jobRow(scan);
	assert.deepEqual([stopped.state, stopped.lease_owner, stopped.error_code], ["retry_wait", null, "lease_expired"]);
	assert.equal(labels[stopped.checkpoint_key!], cursor);
	assert.equal(labels[stopped.checkpoint_key!], result.cursor);

	const seen: string[] = [];
	await tick({
		mountMail: {
			notice: passOf(
				sender(async (_payload, key) => {
					seen.push(key);
					return { kind: "accepted", id: randomUUID() };
				}),
			),
		},
	});
	assert.deepEqual([seen.length, seen[0]], [2, keys[0]], "the unknown call is replayed under its own key");
	assert.equal((await mailRow(J2.id)).state, "accepted", "the next tick starts at the first job left");
	assert.deepEqual([(await jobRow(J1.job)).attempt_count, (await jobRow(J2.job)).attempt_count], [2, 1]);
	await admin.execute(sql`UPDATE job SET state='cancelled',next_attempt_at=NULL WHERE id=${scan}`);
	await at(NOW);
});

test("AC:EXEC-005 three refusals the provider calls retryable back off, a permanent denial ends the job, and an unknown reply is never blindly resent", async () => {
	const c = caseOf("EXEC-005");
	const { result } = c.expected;
	const { provider_responses, RetryAfter, repeat } = c.given.execution;
	const J = await queuedMail(`notice/${randomUUID()}`);
	const calls: { key: string | null; body: string }[] = [];
	const provider = createResendTransport(
		"synthetic",
		async (_url, init) => {
			calls.push({
				key: new Headers(init?.headers).get("idempotency-key"),
				body: String(init?.body),
			});
			return provider_responses[calls.length - 1] === "retryable"
				? new Response("{}", { status: 429, headers: { "retry-after": String(RetryAfter) } })
				: new Response("{}", { status: 403, headers: { "retry-after": String(RetryAfter) } });
		},
		{ VERCEL_ENV: "production" },
	);
	const config = { mountMail: { notice: passOf(provider) } };
	let now = Date.parse(c.clock.now);
	for (const [n, wait] of [300, 600, 1200].entries()) {
		for (let i = 0; i < repeat; i++) await tick(config);
		assert.equal(calls.length, n + 1);
		const job = await one(
			sql`SELECT state,attempt_count,extract(epoch FROM next_attempt_at-clock_timestamp())::int AS wait FROM job WHERE id=${J.job}`,
		);
		assert.deepEqual(job, { state: "retry_wait", attempt_count: n + 1, wait });
		assert.ok(wait >= RetryAfter);
		await at(now + wait * 1000 - 1);
		await tick(config);
		assert.equal(calls.length, n + 1, "nothing is sent before its backoff ends");
		now += wait * 1000;
		await at(now);
	}
	for (let i = 0; i < repeat; i++) await tick(config);
	await at(now + 24 * 60 * MINUTE);
	await tick(config);
	assert.equal(calls.length, provider_responses.length);
	assert.equal(new Set(calls.map((call) => JSON.stringify(call))).size, 1, "every attempt is the same request");
	const attempts = await rows<{ retryable: boolean; outcome: string }>(
		sql`SELECT a.outcome,a.retryable FROM mail_attempt a JOIN mail_request_member m ON m.request_id=a.request_id
			WHERE m.mail_id=${J.id} ORDER BY a.attempt_number`,
	);
	assert.deepEqual(
		attempts.map((a) => a.outcome),
		["refused", "refused", "refused", "refused"],
	);
	assert.equal(attempts.filter((a) => a.retryable).length, result.retryable_attempts);
	const denied = attempts.findIndex((a) => !a.retryable);
	assert.equal(attempts.length - denied - 1, result.permanent_retry_count);
	const done = await jobRow(J.job);
	assert.deepEqual([done.state, done.error_code], [result.terminal_status, "provider_refused"]);
	assert.equal((await mailRow(J.id)).state, "refused");

	const first = await queuedMail(`notice/${randomUUID()}`);
	const immediate: string[] = [];
	await tick({
		mountMail: {
			notice: passOf(
				sender(async (_payload, key) => {
					immediate.push(key);
					return { kind: "refused", retryable: false };
				}),
			),
		},
	});
	await at(Date.now() + 60 * MINUTE);
	await tick({
		mountMail: {
			notice: passOf(sender(async () => assert.fail("a permanent denial was retried"))),
		},
	});
	assert.deepEqual([immediate.length, (await jobRow(first.job)).state], [1, "failed"]);

	const lost = await queuedMail(`notice/${randomUUID()}`);
	const replays: (string | null)[] = [];
	const dropped = createResendTransport(
		"synthetic",
		async (_url, init) => {
			replays.push(new Headers(init?.headers).get("idempotency-key"));
			throw Error("socket closed");
		},
		{ VERCEL_ENV: "production" },
	);
	await quietly(() => tick({ mountMail: { notice: passOf(dropped) } }));
	assert.equal((await mailRow(lost.id)).state, "unknown");
	const { provider_key } = await one<{ provider_key: string }>(
		sql`SELECT r.provider_key FROM mail_request r JOIN mail_request_member m ON m.request_id=r.id WHERE m.mail_id=${lost.id}`,
	);
	const before = replays.length;
	await at(Date.now() + 24 * 60 * MINUTE);
	for (let i = 0; i < repeat; i++) await tick({ mountMail: { notice: passOf(dropped) } });
	assert.equal(replays.length, before, "past the provider's window an unknown send waits for evidence");
	assert.equal(replays.filter((key) => key !== provider_key).length, result.unknown_blind_replays);
	assert.deepEqual([(await jobRow(lost.job)).state, (await mailRow(lost.id)).state], ["reconcile", "unknown"]);
	await at(NOW);
});

test("AC:EXEC-006 one catch-up digest covers three missed days past its 100 lines, and a church that stops sharing after it was queued is in none of it", async () => {
	const c = caseOf("EXEC-006");
	const { result } = c.expected;
	const { missed_dates, live_Q_permission } = c.given.execution;
	await at("2026-10-10T12:30:00Z");
	const N1 = await database.organization("sending_network", {
		name: "Catch-up Network",
		timezone: "America/Chicago",
	});
	const reader = await database.actor(N1, "admin");
	await admin.execute(sql`INSERT INTO notification_preference(account_id,category,channel,enabled,unsubscribe_revision)
		VALUES(${reader.id},'oversight_digest','email',true,1)`);
	const link = async (plant: { id: string }, share: boolean) =>
		(
			await one<{
				id: string;
			}>(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
					share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${plant.id},${N1.id},clock_timestamp(),false,false,false,false,false,${share},false) RETURNING id`)
		).id;
	const activity = (plant: { id: string }, day: string) =>
		admin.execute(sql`INSERT INTO audit_event(tenant_id,actor_token,action,kind,subject_type,subject_id,occurred_at)
			VALUES(${plant.id},'synthetic','people.updated','edit','record',${plant.id},${`${day}T15:00:00Z`}::timestamptz)`);
	const open = [];
	for (let i = 0; i < 35; i++) {
		const plant = await database.plant({ name: `Open Church ${String(i).padStart(2, "0")}` });
		await link(plant, true);
		open.push(plant);
	}
	const closing = await database.plant({ name: "Closing Door Church" });
	const toClosing = await link(closing, c.given.execution.compiled_Q_permission);
	assert.equal(c.given["P-N1"].share_activity, false);
	const quiet = await database.plant({ name: "Quiet Church" });
	await link(quiet, c.given["P-N1"].share_activity);
	await tick({ digests });
	for (const day of missed_dates) for (const plant of [...open, closing, quiet]) await activity(plant, day);

	await at(c.clock.now);
	await planDigests(db, c.clock.now);
	const owed = () =>
		rows<{ state: string }>(sql`SELECT state FROM job WHERE kind='digest' AND subject_record_id=${reader.id}`);
	assert.deepEqual(await owed(), [{ state: "ready" }]);
	await admin.execute(
		sql`UPDATE affiliation SET share_activity=${live_Q_permission},revision=revision+1 WHERE id=${toClosing}`,
	);
	const sent: { to: string; subject: string; text: string }[] = [];
	const digestMail = mailer(
		sender(async (payload) => {
			sent.push(payload);
			return { kind: "accepted", id: randomUUID() };
		}),
		authorizeDigestMail,
	);
	const config = {
		digests: createDigestWorker({ mail: digestMail, origin }),
		mountMail: {
			digest: (limit: number, until: number) => runDueMail(db, digestMail, MAIL_PASSES.digest, limit, until),
		},
	};
	await tick(config);
	await tick(config);
	assert.deepEqual(await owed(), [{ state: "succeeded" }]);
	const notices = () =>
		rows<{ title: string; safe_body: string }>(
			sql`SELECT title,safe_body FROM notice WHERE recipient_id=${reader.id} ORDER BY created_at`,
		);
	const delivered = await notices();
	assert.equal(delivered.length, result.digests);
	assert.equal(delivered[0]!.title, "Oversight digest: 105 activities, Oct 10, 2026 to Oct 12, 2026");
	const lines = delivered[0]!.safe_body.split(/(?<=\.) /);
	assert.equal(lines.length, 101);
	assert.equal(lines[100], "5 more activities in Everyfield.");
	assert.equal(lines[0], "Open Church 00: 1 activity on Oct 10, 2026.");
	const bodyOf = (name: string, texts: readonly string[]) => texts.find((text) => text.includes(name)) ?? null;
	const texts = () => sent.map((m) => m.subject + m.text);
	assert.equal(bodyOf("Closing Door", [...delivered.map((n) => n.safe_body), ...texts()]), result.Q_body);
	assert.equal(bodyOf("Quiet Church", [...delivered.map((n) => n.safe_body), ...texts()]), null);
	const mine = sent.filter((m) => m.to === reader.email);
	assert.equal(mine.length, result.digests);
	assert.equal(mine.filter((m) => !m.subject.includes("Oct 10, 2026 to Oct 12, 2026")).length, result.stale_day_mails);
	assert.deepEqual(
		await rows(sql`SELECT covered_through::text AS through FROM digest_coverage WHERE recipient_id=${reader.id}`),
		[{ through: "2026-10-12" }],
	);

	await admin.execute(sql`UPDATE affiliation SET share_activity=true,revision=revision+1 WHERE id=${toClosing}`);
	await activity(closing, "2026-10-13");
	await at(later(24 * 60 * MINUTE));
	await tick({ digests: config.digests });
	const compiled = (await notices())[1]!;
	assert.equal(compiled.safe_body, "Closing Door Church: 1 activity on Oct 13, 2026.");
	await admin.execute(sql`UPDATE affiliation SET share_activity=false,revision=revision+1 WHERE id=${toClosing}`);
	await tick(config);
	assert.equal(sent.filter((m) => m.to === reader.email).length, 1);
	assert.equal(bodyOf("Closing Door", texts()), result.Q_body, "an email compiled before the change is never sent");
	assert.deepEqual(
		await rows(sql`SELECT state FROM mail WHERE recipient_account_id=${reader.id} ORDER BY created_at`),
		[{ state: "accepted" }, { state: "cancelled" }],
	);
	await at(NOW);
});

test("AC:EXEC-007 a time-only assessment is its own run; a 45-second timeout, a lost claim or a changed source publishes nothing and the earlier result stays", async (t) => {
	const c = caseOf("EXEC-007");
	const { result } = c.expected;
	const started = Date.parse(c.clock.now) - 8 * 24 * 60 * MINUTE;
	mock.timers.setTime(started);
	const world = await church("exec007", { clock: new Date(started) });
	t.after(async () => {
		await world.database.close();
		await at(NOW);
	});
	const goTo = AsyncResource.bind(async (ms: number) => {
		await freezeClock(world.admin, world.database.schema, new Date(ms));
		mock.timers.setTime(ms);
	});
	await goTo(started);
	const job = createAssessmentJob({ clock: { now: () => new Date().toISOString() as never } });
	const assessments = createAssessments({
		clock: { now: () => new Date().toISOString() as never },
	});
	await world.release("R1");
	const p = await world.harvest("Harvest Point", {});
	const runs = () =>
		world.rows<StoredRun>(sql`SELECT id,outcome,reason,demand,demand_key,source_revision,reference_activation,result,attempts
			FROM assessment_run WHERE plant_id=${p.id} ORDER BY captured_at,id`);
	const published = async () => ok(await assessments.readAssessment(world.db, p.actor, {})).current?.runId;
	const schedule = async () => {
		await job.scheduleAssessments(world.db);
		await world.admin.execute(
			sql`UPDATE job SET state='cancelled' WHERE kind='assessment' AND subject_record_id<>${p.id}`,
		);
		return world.rows<{
			producer_key: string;
		}>(sql`SELECT producer_key FROM job WHERE kind='assessment'
			AND subject_record_id=${p.id} AND state='ready'`);
	};
	await world.admin.execute(sql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '30 days'`);
	await goTo(started + MINUTE);
	assert.equal((await schedule()).length, 1);
	assert.equal(await runAssessmentBatch(job, world.db, scriptedAssessmentDrafter(), 5), 1);
	const R0 = (await runs())[0]!;
	assert.equal(await published(), R0.id);
	assert.deepEqual(await schedule(), [], "nothing changed, so nothing is owed yet");

	let now = Date.parse(c.clock.now);
	await goTo(now);
	assert.deepEqual(
		(await schedule()).map((owed) => owed.producer_key),
		["time/2026-10-13"],
	);
	const scripted = scriptedAssessmentDrafter();
	const timeouts: number[] = [];
	let expire = new AbortController();
	const timer = mock.method(AbortSignal, "timeout", (ms: number) => {
		timeouts.push(ms);
		expire = new AbortController();
		return expire.signal;
	});
	t.after(() => timer.mock.restore());
	let call = 0;
	const reclaim = AsyncResource.bind(() => runAssessmentBatch(job, world.db, worker5, 1));
	const worker4: Drafter = {
		id: scripted.id,
		async draft(request, signal) {
			if (++call === 1) {
				await goTo((now += c.given["case-input"].provider_timeout_seconds * 1000));
				expire.abort(new DOMException("The operation timed out", "TimeoutError"));
				signal.throwIfAborted();
			}
			await goTo((now += ASSESSMENT_TIMING.leaseMs + 1000));
			assert.equal(await reclaim(), 1, "another worker owns the job now");
			return scripted.draft(request, signal);
		},
	};
	const worker5 = scriptedAssessmentDrafter({ busy: [{ status: 503 }] });
	assert.equal(await runAssessmentBatch(job, world.db, worker4, 1), 1);
	assert.deepEqual([...new Set(timeouts)], [result.provider_timeout_seconds * 1000]);
	assert.equal(call, 2);
	const time = (await runs())[1]!;
	assert.equal(time.demand, "time");
	assert.equal(
		time.id !== R0.id && time.demand_key !== R0.demand_key && time.source_revision === R0.source_revision,
		result.time_only_demand_has_new_identity,
	);
	assert.deepEqual([time.outcome, time.reason, time.result, time.attempts], ["deferred", "busy", null, 3]);
	assert.equal(time.outcome !== "published" && (await published()) === R0.id, result.expired_worker_cannot_publish);
	const audits = () =>
		world.rows(
			sql`SELECT 1 FROM audit_event WHERE action='intelligence.assessed' AND event_key=${"assessment:" + time.id}`,
		);
	assert.equal((await audits()).length, 0);

	await goTo((now += 5 * MINUTE));
	const racing = scriptedAssessmentDrafter({
		during: AsyncResource.bind(async () => {
			await world.committed(p, "Joined Mid-Draft", 0);
		}),
	});
	assert.equal(await runAssessmentBatch(job, world.db, racing, 1), 1);
	const settled = (await runs())[1]!;
	assert.deepEqual([settled.outcome, settled.reason, settled.result], ["superseded", "changed_input", null]);
	assert.equal(settled.result !== null, result.stale_publication);
	const labels = new Map([[R0.id, "R0"]]);
	assert.equal(labels.get((await published())!), result.prior_result);
	assert.deepEqual(await world.rows(sql`SELECT 1 FROM assessment_insight WHERE run_id=${time.id}`), []);
	assert.equal(
		(
			await world.rows(
				sql`SELECT 1 FROM job WHERE kind='assessment' AND producer_key=${"followup/" + time.id} AND state='ready'`,
			)
		).length,
		1,
		"the changed source is owed a new run",
	);
});

test("AC:EXEC-008 a candidate release whose embedding times out after some chunks, or whose manifest was replaced, is never promoted and R1 stays active", async (t) => {
	const c = caseOf("EXEC-008");
	const { result } = c.expected;
	const { active_release, candidate, missing_chunk } = c.given.execution;
	const store = await testDatabase({ prefix: "exec008", roles: {}, clock: new Date(c.clock.now) });
	t.after(() => store.close());
	const publisher = await seeds(store.admin).actor(null);
	await store.admin.execute(
		sql`INSERT INTO platform_grant(account_id,capability) VALUES(${publisher.id},'reference_publish')`,
	);
	const caller = { actorId: publisher.id, userId: publisher.user, sessionId: publisher.session };
	const source: WikiSource = {
		version: "wiki-starter-2026-10-03",
		manifestPath: "docs/reference/bootstrap/manifest.json",
		payloadPath: "docs/reference/bootstrap/global-seed-payload.json",
		manifestSha256: "b60b368d7c0ae901c26e429bcda314502e7e836bf97ad57525d9c8816724e68b",
		payloadSha256: "7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59",
		articles: 96,
		sections: 21,
		systemTemplates: 7,
	};
	const promote = (release: string, expectedActivation: string) => ({
		release,
		manifestSha256: source.manifestSha256,
		payloadSha256: source.payloadSha256,
		requestKey: randomUUID(),
		expectedActivation,
		target: approvedWiki.target,
	});
	let embedded = 0;
	const missing = Number(missing_chunk.slice(1));
	const service = referenceService(store.admin, {
		source,
		embed: (text: string) => {
			if (++embedded === missing) throw new DOMException("The operation timed out", "TimeoutError");
			return localEmbedding(text);
		},
	});
	await service.installApprovedWiki(caller, { ...promote(active_release, "0"), kind: "install" });
	const releases = async () => (await store.admin.execute(sql`SELECT release_key FROM reference_release`)).rows;
	const stays = async () => {
		const active = await service.exportApprovedWiki(caller);
		assert.equal(active.activeRelease, result.active_release);
		assert.deepEqual([active.activationNumber, active.partialActivation], ["1", false]);
		const stored = await releases();
		assert.equal(
			stored.some((row) => row.release_key === candidate),
			result.R2_promoted,
		);
		const { rows: passages } = await store.admin.execute(sql`SELECT count(*)::int AS n FROM passage`);
		assert.deepEqual(passages, [{ n: 0 }], "no chunk of the incomplete candidate is kept");
	};
	const failed = await untouched(store.admin, () => service.rebuildEmbeddings(caller, promote(candidate, "1")));
	assert.deepEqual([failed.activated, failed.reason, embedded], [result.R2_promoted, "embedding_failed", missing]);
	await stays();

	await untouched(store.admin, async () => {
		for (const replaced of [{ manifestSha256: "ab".repeat(32) }, { payloadSha256: "ab".repeat(32) }])
			await assert.rejects(
				service.rebuildEmbeddings(caller, { ...promote(candidate, "1"), ...replaced }),
				(error: unknown) => error instanceof WikiRefusal && error.code === "digest_conflict",
			);
		await assert.rejects(
			service.rebuildEmbeddings(caller, promote(candidate, "0")),
			(error: unknown) => error instanceof WikiRefusal && error.code === "revision_conflict",
		);
	});
	await stays();

	const complete = await service.rebuildEmbeddings(caller, promote(candidate, "1"));
	assert.deepEqual([complete.activated, complete.activeRelease, complete.activationNumber], [true, candidate, "2"]);
	await assert.rejects(
		store.admin
			.execute(sql`INSERT INTO job(tenant_id,kind,producer_key,state,eligible_at,attempt_count,max_attempts,claim_generation)
			VALUES(${P.id},'reference_generation','k','ready',now(),0,4,0)`),
	);
});

test("AC:EXEC-009 a render or import that times out leaves the ready file current, and cleanup racing a finalization never deletes a referenced file", async () => {
	const c = caseOf("EXEC-009");
	const { result } = c.expected;
	const { ready_file, new_render } = c.given.execution;
	assert.equal(new_render, "timeout");
	const bytes = new MemoryClient();
	const documents = { bucket: "synthetic-only", client: bytes };
	const actor = await RequestActor.resolve(db, A.session);
	assert.ok(actor instanceof RequestActor);
	const render = (requestKey: string) =>
		documentsWriter.generate(
			db,
			actor,
			{ templateId: "commitment-card", format: "pdf", overrides: {}, requestKey },
			documents,
		);
	const history = async () => ok(await documentsWriter["history.list"](db, actor, {})).entries.map((e) => e.id);
	const D1 = ok(await render(ready_file));
	const file = await one<{ id: string; key: string }>(sql`SELECT f.id,f.opaque_key AS key FROM generated_document g
		JOIN file_object f ON f.id=g.object_id WHERE g.id=${D1.id}`);
	const stored = Buffer.from(bytes.objects.get(file.key)!);
	const labels = new Map([[D1.id, ready_file]]);
	const stays = async () => {
		assert.equal(labels.get((await history())[0]!), result.current_file);
		const kept = bytes.objects.get(file.key)?.equals(stored) === true;
		assert.equal(!kept, result.ready_file_deleted);
		assert.deepEqual(await rows(sql`SELECT state FROM file_object WHERE id=${file.id}`), [{ state: "ready" }]);
		assert.ok(ok(await documentsWriter.download(db, actor, { documentId: D1.id }, documents)).url.includes(file.key));
	};
	const timeout = async () => {
		throw new DOMException("The operation timed out", "TimeoutError");
	};
	const statuses = new Map([["refused", "failed"]]);
	bytes.beforePut = timeout;
	const timedOut = await render("EXEC-009-timeout");
	assert.equal(statuses.get(timedOut.status), result.new_status);
	refused(timedOut);
	bytes.beforePut = timeout;
	const ownedBefore = await count(sql`document WHERE tenant_id=${P.id}`);
	const imported = await documentsWriter.importTextOrWord(
		db,
		actor,
		{
			title: "Values",
			format: "text",
			bytes: Buffer.from("We serve."),
			expectedRevision: "0",
			requestKey: "EXEC-009-import",
		},
		documents,
	);
	assert.equal(statuses.get(imported.status), result.new_status);
	refused(imported);
	assert.equal(await count(sql`document WHERE tenant_id=${P.id}`), ownedBefore);
	const unfinished = () =>
		rows<{ state: string }>(
			sql`SELECT state FROM file_object WHERE tenant_id=${P.id} AND upload_key LIKE '%EXEC-009-%' ORDER BY upload_key`,
		);
	assert.deepEqual(await unfinished(), [{ state: "pending" }, { state: "pending" }]);
	assert.equal((await history()).length, 1);
	await stays();

	const config = { storage: documents } satisfies Partial<Config>;
	const job = await transaction(db, (tx) =>
		enqueueJob(tx, {
			tenant: P.id,
			kind: "object_cleanup",
			subject: file.id,
			key: `cleanup/${file.id}`,
			revision: null,
			eligibleAt: NOW,
		}),
	);
	await tick(config);
	assert.deepEqual(
		[(await jobRow(job)).state, (await jobRow(job)).error_code],
		["superseded", "nothing_to_delete"],
		"a cleanup of a file still in use deletes nothing",
	);
	await stays();

	const finalizing = await readyFile(admin, bytes.objects as Store, P.id, Buffer.from("%PDF-1.7 finalized"));
	const [raceTick] = await raced(
		admin,
		db,
		sql`INSERT INTO generated_document(tenant_id,creator_account_id,template_id,template_version,saved_template_name,
				renderer_version,format,object_id,inputs,download_name,generated_at)
			SELECT tenant_id,creator_account_id,template_id,template_version,saved_template_name,renderer_version,format,
				${finalizing.id}::uuid,inputs,download_name,generated_at-interval '1 day'
			FROM generated_document WHERE id=${D1.id}`,
		[() => tick(config)],
	);
	assert.deepEqual(raceTick.steps["documents-orphans"]!.count, { purged: 0, unknown: 0 });
	assert.ok(bytes.objects.has(finalizing.key), "the file that was being finalized is kept");
	await stays();

	const putting = Promise.withResolvers<void>(),
		finish = Promise.withResolvers<void>();
	await at(later(5 * MINUTE));
	bytes.beforePut = async () => {
		putting.resolve();
		await finish.promise;
	};
	const late = render("EXEC-009-late");
	await putting.promise;
	for (const minutes of [16, 21]) {
		await at(later(minutes * MINUTE));
		await tick(config);
	}
	finish.resolve();
	refused(await late);
	assert.deepEqual(await unfinished(), [{ state: "purged" }, { state: "purged" }, { state: "purged" }]);
	assert.equal((await history()).length, 2);
	await stays();
	await at(NOW);
});

test("AC:EXEC-010 a feedback issue whose create timed out and whose reference finds two issues waits for a person, creating none and publishing nothing raw", async (t) => {
	const c = caseOf("EXEC-010");
	const { result } = c.expected;
	const REPO = "everyfield-test/feedback";
	const { repository_id, matches } = c.given.provider;
	const github = await fakeGitHub({ [REPO]: repository_id, "everyfield-test/moved": 20 });
	t.after(() => github.stop());
	const actor = await RequestActor.resolve(db, A.session);
	assert.ok(actor instanceof RequestActor);
	const raw = "RAW-CANARY Daniel says save fails";
	const { id } = ok(
		await feedbackWriter.submit(
			db,
			actor,
			{
				requestKey: randomUUID(),
				category: "bug",
				description: raw,
				page: "Documents",
				address: "/documents",
				browser: "Chrome",
				screenWidth: 1440,
				screenHeight: 900,
				theme: "dark",
			},
			{ appVersion: "v3" },
		),
	) as { id: string };
	const run = (repository = { id: String(repository_id), name: REPO }) =>
		quietly(() =>
			tick({
				feedbackPublication: (limit, until) =>
					runDueFeedbackPublication(
						db,
						{
							repository,
							issues: githubIssues({ api: github.api, token: "test-token" }, fetch, 2_000),
							operatorMail: null,
						},
						limit,
						until,
					),
			}),
		);
	const row = () =>
		one<{
			publication_state: string;
			held_reason: string | null;
			reference: string;
			repository_id: string;
			issue_url: string | null;
			publication_payload: { title: string; body: string };
		}>(sql`SELECT publication_state,held_reason,reference,repository_id::text AS repository_id,issue_url,publication_payload
			FROM feedback WHERE id=${id}`);
	const job = () =>
		one<{ state: string; error_code: string | null }>(
			sql`SELECT state,error_code FROM job WHERE subject_record_id=${id}`,
		);

	github.behavior.createReplyLost = true;
	await run();
	github.behavior.createReplyLost = false;
	const frozen = await row();
	assert.deepEqual([frozen.publication_state, frozen.repository_id], ["unknown", String(repository_id)]);
	assert.deepEqual(await job(), { state: "retry_wait", error_code: "github_unknown" });
	const marked = github.issues.filter((i) => i.body.includes(frozen.reference));
	assert.equal(marked.length, 1);
	const [found] = marked;
	Object.assign(found!, { number: matches[0] });
	github.issues.push({ ...found!, number: matches[1] });
	const created = github.issues.length;
	const asked = github.requests.length;

	await at(later(6 * MINUTE));
	await run({ id: "20", name: "everyfield-test/moved" });
	assert.deepEqual(
		github.requests.slice(asked).map((r) => r.method),
		["GET"],
	);
	assert.match(decodeURIComponent(github.requests[asked]!.path), new RegExp(`repo:${REPO}`));
	const held = await row();
	const labels = new Map([["held/ambiguous", "reconcile"]]);
	assert.equal(labels.get(`${held.publication_state}/${held.held_reason}`), result.status);
	assert.equal(github.issues.length - created, result.created_issues);
	assert.equal(held.issue_url, result.public_raw_fallback);
	assert.deepEqual([held.repository_id, held.publication_payload], [frozen.repository_id, frozen.publication_payload]);

	await at(later(24 * 60 * MINUTE));
	await untouched(admin, () => run());
	assert.equal(github.requests.length, asked + 1, "nothing is asked or created again until a person decides");
	const outside = JSON.stringify([github.issues, github.requests]);
	assert.equal(outside.includes("RAW-CANARY") || outside.includes(A.email) ? raw : null, result.public_raw_fallback);
	await at(NOW);
});

test("AC:EXEC-011 at the deletion deadline the purge wins over a cancellation and an old cancellation changes nothing; a second earlier it purges nothing", async () => {
	const c = caseOf("EXEC-011");
	const sub = subcaseOf("EXEC-011", "before-deadline");
	const DAY = 24 * 60 * MINUTE;
	const requestedFor = (deadline: string) => iso(Date.parse(deadline) - 30 * DAY);
	const config = { storage, cleanup, notifications };

	async function secondRequest(deadline: string) {
		const w = await doomed(iso(Date.parse(requestedFor(deadline)) - MINUTE));
		const R1 = await w.request();
		const oldProof = await w.proofOf(R1.requestId);
		const oldCancel = command({ subject: w.ref, requestId: R1.requestId }, R1.revision);
		const cancelOld = () => gatedTransaction(db, (tx) => deletion.cancelWorkspaceDeletion(tx, oldProof, oldCancel));
		ok(await cancelOld());
		assert.equal((await w.witness()).state, "cancelled");
		assert.equal(await normalAccess(w.plant, w.member), true);
		await at(requestedFor(deadline));
		const R2 = await w.request();
		assert.equal(Date.parse(R2.cancelUntil), Date.parse(deadline));
		await untouched(admin, async () => refused(await cancelOld(), "proof_invalid"));
		await at(Date.parse(deadline) - MINUTE);
		const proof = await w.proofOf(R2.requestId);
		const cancelWith = (requestId: string, revision: string) =>
			gatedTransaction(db, (tx) =>
				deletion.cancelWorkspaceDeletion(tx, proof, command({ subject: w.ref, requestId }, revision)),
			);
		return {
			...w,
			R2,
			cancelOld,
			cancelOldWithNewProof: () => cancelWith(R1.requestId, R1.revision),
			cancelNew: () => cancelWith(R2.requestId, R2.revision),
		};
	}
	type Request = Awaited<ReturnType<typeof secondRequest>>;
	async function collide(w: Request, first: "cancel" | "purge", purge: () => Promise<unknown>) {
		const locked = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		const { id } = await w.witness();
		const gate = admin.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM lifecycle_witness WHERE id=${id} FOR UPDATE`);
			locked.resolve();
			await release.promise;
		});
		await locked.promise;
		const start = {
			cancel: () => ({ done: w.cancelNew(), pool: db }),
			purge: () => ({ done: purge(), pool: cleanup }),
		};
		const running: Record<string, Promise<unknown>> = {};
		try {
			for (const name of first === "cancel" ? (["cancel", "purge"] as const) : (["purge", "cancel"] as const)) {
				const { done, pool } = start[name]();
				done.catch(() => {});
				running[name] = done;
				assert.equal(await waitingOnLock(pool), true);
			}
		} finally {
			release.resolve();
			await gate;
		}
		const [cancel, purged] = await Promise.allSettled([running.cancel, running.purge]);
		assert.ok(cancel.status === "fulfilled");
		return { cancel: cancel.value as Awaited<ReturnType<Request["cancelNew"]>>, purge: purged };
	}

	for (const first of ["cancel", "purge"] as const) {
		const due = await secondRequest(c.given.R2.deadline);
		await at(c.clock.now);
		assert.equal(await normalAccess(due.plant, due.member), false, "a pending deletion already hides the church");
		client.down = true;
		try {
			const { added } = await recorded(admin, () =>
				quietly(async () => {
					const { cancel, purge } = await collide(due, first, () => tick(config));
					assert.equal(cancel.status, "refused", first);
					assert.equal(purge.status, "fulfilled", first);
				}),
			);
			assert.deepEqual([added.audits, added.notices, added.mail], [NOTHING.audits, 0, 0]);
			const { result } = c.expected;
			const witness = await due.witness();
			assert.deepEqual([witness.state, witness.request_id], [result.status, due.R2.requestId], first);
			for (const who of [due.member, due.owner]) assert.equal(await normalAccess(due.plant, who), result.normal_access);
			await untouched(admin, async () => {
				for (const reply of [await due.cancelOld(), await due.cancelOldWithNewProof()])
					assert.equal(reply.status === "ok", result.old_cancel_applied);
				assert.equal((await due.cancelNew()).status, "refused");
			});
			assert.equal((await due.witness()).state, result.status);
			assert.equal((await jobRow(await due.purgeJob())).error_code, "removal_unconfirmed");
			assert.ok(client.store.has(due.file.key));
		} finally {
			client.down = false;
		}
	}

	for (const first of ["cancel", "purge"] as const) {
		const early = await secondRequest(sub.given.R2.deadline);
		await at(sub.clock.now);
		const people = await early.content();
		assert.equal((await tick(config)).purged, 0, "R1's own job finds R1 cancelled and purges nothing");
		assert.equal(people, 1);
		const purgeNow = createLifecycleCleanup(cleanup, {
			authorize: async () => true,
			removeOwnedResources: async () => assert.fail("nothing is removed before the deadline"),
		});
		const eligible = async () => {
			const { revision } = await early.witness();
			return purgeNow({ subject: early.ref, requestId: early.R2.requestId, revision });
		};
		await untouched(admin, async () => {
			assert.equal((await tick(config)).purged, sub.expected.result.purged_rows);
			const labels = new Map([["deadline_passed", "not_eligible"]]);
			const refusal = await eligible().catch((error: { code: string }) => labels.get(error.code));
			assert.equal(refusal, sub.expected.result.error_code);
			refused(await early.cancelOld(), "proof_invalid");
			refused(await early.cancelOldWithNewProof(), "proof_invalid");
		});
		assert.equal(people - (await early.content()), sub.expected.result.purged_rows);
		assert.deepEqual(
			[(await early.witness()).state, (await jobRow(await early.purgeJob())).attempt_count],
			[sub.given.R2.state === "pending" ? "pending_deletion" : "", 0],
		);

		const beforeDeadline = await collide(early, first, eligible);
		ok(beforeDeadline.cancel);
		assert.equal(beforeDeadline.purge.status, "rejected");
		assert.equal((await early.witness()).state, "cancelled");
		assert.equal(await early.content(), people);
		assert.equal(await normalAccess(early.plant, early.member), true);
		await at(later(MINUTE));
		assert.equal((await tick(config)).purged, 0, "the cancelled request's own job purges nothing");
		assert.deepEqual([(await early.witness()).state, await early.content()], ["cancelled", people]);
	}
	await at(NOW);
});

test("AC:EXEC-012 with no approved schedule or paid tier readiness stays blocked, names what is missing, claims no measured latency and commits no spending", async () => {
	const c = caseOf("EXEC-012");
	const { result } = c.expected;
	const { schedule_configured, paid_tier_approved } = c.given.execution;
	const { environment, operation_ids, authority, verified } = c.given["caller-capability"];
	const capability = { authority, verified, operation_ids, environment };
	const now = new Date(c.clock.now);
	const proven = {
		key_exclusion: { denied: { app: true, build: true, preview: true }, verified_at: c.clock.now },
		coherent_restore: { live_recovery_proven: true, verified_at: c.clock.now },
	};
	const approval = {
		approved: true,
		approved_at: c.clock.now,
		monthly_usd: { low: 5, expected: 10, high: 20 },
	};
	const schedule = {
		host: "restricted-host-1",
		schedule: "daily 03:00 UTC",
		verified_at: c.clock.now,
	};
	const burst = {
		maxDuration: 300,
		crons: ["* * * * *"],
		p95_ms: 1200,
		expected_rate: 40,
		high_burst: 400,
		handlers: 1,
	};
	await untouched(admin, async () => {
		const attempts: [string, Record<string, unknown>, string[]][] = [
			["nothing", {}, ["cost_approval", "host_schedule", "key_exclusion", "coherent_restore"]],
			["the case's facts", { ...proven, host_schedule: null, cost_approval: null }, ["cost_approval", "host_schedule"]],
			["deployment settings and burst figures", { ...proven, ...burst }, ["cost_approval", "host_schedule"]],
			[
				"figures in place of approvals",
				{
					...proven,
					host_schedule: burst,
					cost_approval: { approved: paid_tier_approved, ...burst },
				},
				["cost_approval", "host_schedule"],
			],
			[
				"a refused paid tier",
				{
					...proven,
					host_schedule: schedule,
					cost_approval: { ...approval, approved: paid_tier_approved },
				},
				["cost_approval"],
			],
			[
				"an unconfigured schedule",
				{ ...proven, cost_approval: approval, host_schedule: schedule_configured },
				["host_schedule"],
			],
		];
		for (const [name, evidence, missing] of attempts) {
			const report = readiness({ capability, evidence, now });
			if (report.refusal !== null) return assert.fail(report.refusal);
			assert.equal(report.customer_data_gate, result.readiness, name);
			assert.equal(
				/ms|latency|duration|rate|burst|1200|p95/.test(JSON.stringify(report)) ? burst.p95_ms : null,
				result.measured_latency_claim,
				name,
			);
			assert.deepEqual(report.missing, missing, name);
			assert.deepEqual(
				report,
				{
					refusal: null,
					customer_data_gate: "blocked",
					build_gate_from_backup: false,
					missing,
					daily_fallback_eligible: false,
					second_provider_gate: false,
					live_evidence_verified: false,
					checked_at: "2026-10-13T16:00:00Z",
				},
				name,
			);
			if (name !== "an unconfigured schedule")
				assert.equal(!report.missing.includes("cost_approval"), result.paid_commitment, name);
		}
		assert.deepEqual(
			readiness({
				capability: { account: A.id, session: A.session, context: P.id },
				evidence: {},
				now,
			}),
			{ refusal: "operator_unavailable" },
		);
	});
});
