import "../../platform/setup.mts";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect, isDeepStrictEqual as isEqual } from "node:util";
import test, { after, before, mock } from "node:test";
import { owner } from "../../../../packages/contracts/src/common/index.ts";
import { plantOwner } from "../../../../packages/contracts/src/people/values.ts";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor } from "../../../../packages/domain/src/access/session.ts";
import { setFlag } from "../../../../packages/domain/src/flags/values.ts";
import { nativeFromText } from "../../../../packages/contracts/src/documents/native.ts";
import { S3Client } from "../../../../packages/db/src/schema/storage.ts";
import { documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import { createFacts, createPrivateCare } from "../../../../packages/domain/src/intelligence/index.ts";
import { runDuePurges } from "../../../../packages/domain/src/jobs/lifecycle-purge.ts";
import { supersedeDigests } from "../../../../packages/domain/src/jobs/digest.ts";
import { enqueueJob, queueJobs } from "../../../../packages/domain/src/jobs/queue.ts";
import { relationshipCommands } from "../../../../packages/domain/src/organizations/relationships.ts";
import { createLaunchWriter } from "../../../../packages/domain/src/launch/index.ts";
import { deletionOperations, type DeletionSubject } from "../../../../packages/domain/src/settings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { peopleReader, peopleWriter, withPeopleWrite } from "../../../../packages/domain/src/people/index.ts";
import { dashboardReader } from "../../../../packages/domain/src/dashboard/index.ts";
import { feedbackWriter } from "../../../../packages/domain/src/feedback/index.ts";
import { getPlant, listPlants } from "../../../../packages/domain/src/oversight/index.ts";
import { fixture, ok, refused, type Actor } from "../../../support/fixture.mts";
import { failingWrite, NOTHING, recorded, untouched } from "../../../support/recorded.mts";
import { readCurrentManifest, restoreWithCurrentManifest } from "../../../../ops/maintenance/restore.mts";
import { resendWebhook } from "../../../../apps/web/src/server/jobs/webhook-route.ts";
import type { DeliveryTransport } from "../../../../packages/domain/src/communication/delivery.ts";
import { MAILING } from "../../communication/church-address.mts";
import { deliverAs, readAs, writeAs } from "../../communication/communication-support.mts";
import {
	dropTarget,
	freezeClock,
	objectStore,
	operator,
	readyFile,
	snapshot,
	type Store,
} from "../sql/knowledge/support.mts";

type Case = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: unknown };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../../docs/acceptance/schema.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
const str = (value: unknown) => (typeof value === "string" ? value : assert.fail(JSON.stringify(value)));
const strings = (value: unknown) => (Array.isArray(value) ? value.map(str) : assert.fail(JSON.stringify(value)));

const world = await fixture({
	prefix: "auditcases",
	max: 6,
	roles: { runtime: ["runtime"], cleanup: ["cleanup"] },
	plant: { name: "P", timezone: "America/Chicago" },
	clock: new Date(caseOf("AUDIT-001").clock.now),
});
before(() => mock.timers.enable({ apis: ["Date"], now: new Date(caseOf("AUDIT-001").clock.now).getTime() }));
const targets: string[] = [];
after(async () => {
	mock.timers.reset();
	for (const name of targets) await dropTarget(admin, name);
	await world.close();
});
const { admin } = world;
const db = world.pools.runtime;
const P = world.tenant;
const Q = await world.plant({ name: "Q", timezone: "America/New_York" });
const A = await world.actor(P, "admin", { email: "alex@example.test" });
const B = await world.actor(Q, "admin", { email: "casey@example.test" });
await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id IN (${A.id},${B.id})`);

const rows = async (query: SQL) => (await admin.execute(query)).rows;
const one = async (query: SQL) => (await rows(query))[0] ?? assert.fail("the query returned no row");
const actorOf = async (who: Actor) => {
	const found = await RequestActor.resolve(db, who.session);
	assert.ok(found instanceof RequestActor);
	return found;
};
const refusal = (value: unknown) => inspect(value, { depth: 6 });
const auditText = async () =>
	(await rows(sql`SELECT coalesce(string_agg(to_jsonb(a)::text, ' '), '') AS text FROM audit_event a`))[0]!
		.text as string;
async function create(who: RequestActor, displayName: string) {
	return ok(
		await withPeopleWrite(db, who, (tx, ctx) =>
			peopleWriter.createPerson(tx, ctx, { requestKey: randomUUID(), input: { displayName } }),
		),
	).person;
}
const update = (who: RequestActor, requestKey: string, personId: string, revision: string, patch: object) =>
	withPeopleWrite(db, who, (tx, ctx) =>
		peopleWriter.updatePerson(tx, ctx, { requestKey, expectedRevision: revision, input: { personId, patch } }),
	);

const DAY = 86_400_000;
const live: Store = new Map();
async function at(when: string | Date) {
	const instant = new Date(when);
	await freezeClock(admin, world.schema, instant);
	mock.timers.setTime(instant.getTime());
}
class Bucket extends S3Client {
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
		live.delete(str(command.input.Key));
		return {};
	}
}
const storage = { bucket: "synthetic-only", client: new Bucket() };
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
async function askDeletion(who: Actor, subject: DeletionSubject) {
	const { revision } = await one(
		subject.kind === "account"
			? sql`SELECT revision::text AS revision FROM account WHERE id=${subject.id}`
			: sql`SELECT revision::text AS revision FROM plant WHERE id=${subject.id}`,
	);
	const context = { session: who.session, selected: subject };
	const raw = (input: object) => ({ input, expectedRevision: revision, requestKey: randomUUID() });
	return ok(
		await gatedTransaction(db, (tx) =>
			subject.kind === "account"
				? deletions.requestAccountDeletion(tx, context, raw({ confirmed: true }))
				: deletions.requestWorkspaceDeletion(tx, context, raw({ plant: subject, confirmed: true })),
		),
	);
}
const { cleanup } = world.pools as typeof world.pools & { cleanup: typeof admin };
const purgeDue = () => runDuePurges(db, cleanup, storage, 10);
const witnessOf = (id: string) =>
	one(sql`SELECT state,live_purged_at IS NOT NULL AS purged FROM lifecycle_witness WHERE opaque_subject_id=${id}`);
const holding = async (needle: string) => {
	const tables = await rows(sql`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
		WHERE n.nspname=current_schema() AND c.relkind='r' ORDER BY 1`);
	const found: string[] = [];
	for (const { name } of tables) {
		const hit = await one(
			sql`SELECT count(*)::int AS n FROM ${sql.identifier(str(name))} x WHERE x::text LIKE ${"%" + needle + "%"}`,
		);
		if (Number(hit.n)) found.push(str(name));
	}
	return found;
};

test("AC:AUDIT-001 a person rename faulted at its history, receipt, audit or effect write commits nothing; then it commits once with one event, its replay adds none and a no-op control changes no field", async () => {
	const c = caseOf("AUDIT-001");
	const args = c.action.arguments;
	const { result } = c.expected;
	assert.equal(args.mutation, "person_name_change");
	assert.equal(args.fault, "required_write_before_commit");
	const alex = await actorOf(A);
	const jamie = await create(alex, "Jamie");
	const faults: Record<string, Parameters<typeof failingWrite>[1]> = {
		history: { on: "audit_event", event: "INSERT", when: "NEW.after_value ? 'display_name'" },
		receipt: { on: "audit_event", event: "INSERT", when: "NEW.request_key IS NOT NULL AND NEW.result IS NOT NULL" },
		audit: { on: "record", event: "INSERT", when: "NEW.kind='audit_event'", atCommit: true },
		effect_intent: {
			on: "plant",
			event: "UPDATE",
			when: "NEW.material_revision IS DISTINCT FROM OLD.material_revision",
		},
	};
	assert.deepEqual(Object.keys(faults), strings(args.required_faults));
	const state = () =>
		one(sql`SELECT (SELECT display_name||'@'||revision FROM person WHERE id=${jamie.id}) AS person,
			(SELECT material_revision::text FROM plant WHERE id=${P.id}) AS material,
			(SELECT count(*)::int FROM audit_event WHERE subject_id=${jamie.id} AND action='people.updated') AS events`);
	const start = await state();
	const writes: number[] = [];
	const events: number[] = [];
	const error = console.error;
	console.error = () => undefined;
	try {
		for (const name of strings(args.required_faults)) {
			const thrown = await failingWrite(admin, faults[name]!, () =>
				untouched(admin, () =>
					update(alex, str(args.request_key), jamie.id, jamie.revision, { displayName: "Jamie Lee" }).then(
						(value) => value,
						(e: unknown) => e,
					),
				),
			);
			assert.match(refusal(thrown), /injected fault/, name);
			const now = await state();
			writes.push(now.person === start.person && now.material === start.material ? 0 : 1);
			events.push(Number(now.events) - Number(start.events));
		}
	} finally {
		console.error = error;
	}
	assert.deepEqual(writes, result.mutation_writes_by_fault);
	assert.deepEqual(events, result.successful_event_rows_by_fault);

	const first = await recorded(admin, () =>
		update(alex, str(args.request_key), jamie.id, jamie.revision, { displayName: "Jamie Lee" }),
	);
	const changed = ok(first.value);
	assert.deepEqual(first.added, { audits: ["people.updated"], jobs: [], notices: 0, mail: 0 });
	const receipt = await one(sql`SELECT id,actor_id,tenant_id,subject_id,before_value,after_value,request_key,
		result IS NOT NULL AS answered,(SELECT count(*)::int FROM record r WHERE r.id=a.id AND r.kind='audit_event') AS bound
		FROM audit_event a WHERE subject_id=${jamie.id} AND action='people.updated'`);
	assert.deepEqual(receipt, {
		id: changed.receiptId,
		actor_id: A.id,
		tenant_id: P.id,
		subject_id: jamie.id,
		before_value: { display_name: "Jamie" },
		after_value: { display_name: "Jamie Lee" },
		request_key: args.request_key,
		answered: true,
		bound: 1,
	});
	assert.equal(Number((await state()).material), Number(start.material) + 1);
	const replays: number[] = [];
	for (let n = 1; n < Number(args.repeat); n++) {
		const again = await untouched(admin, () =>
			update(alex, str(args.request_key), jamie.id, jamie.revision, { displayName: "Jamie Lee" }),
		);
		assert.deepEqual(ok(again), changed);
		replays.push(Number((await state()).events) - Number(start.events) - 1);
	}
	assert.deepEqual(replays, [result.replay_new_successful_events]);

	const control = await recorded(admin, () =>
		update(alex, randomUUID(), jamie.id, changed.person.revision, { displayName: "Jamie Lee" }),
	);
	assert.equal(ok(control.value).person.displayName, "Jamie Lee");
	const noop = await one(sql`SELECT before_value,after_value FROM audit_event WHERE id=${ok(control.value).receiptId}`);
	assert.deepEqual(noop, { before_value: {}, after_value: {} }, "a no-op names no changed field");
	assert.equal(c.expected.event, null);
});

test("AC:AUDIT-002 forged scope, subject, actor, origin, approval, execution, organization kind, double owner and a model-named actor are refused with nothing written; the human and service controls name their own actor and owner and no secret", async () => {
	const c = caseOf("AUDIT-002");
	const { result } = c.expected;
	const secret = str(c.given["behavior-inputs"]?.secret);
	assert.deepEqual([c.action.arguments.actor, c.action.arguments.subject], [result.attributed_actor, result.subject]);
	await admin.execute(sql`UPDATE auth_session SET token=${secret + "-" + randomUUID()} WHERE id=${A.session}`);
	const alex = await actorOf(A);
	const casey = await actorOf(B);
	const mine = await create(alex, "Robin");
	const theirs = await create(casey, "Quinn");
	const plantCtx = { session: A.session, selected: { kind: "plant" as const, id: P.id } };
	const attempt = (ctx: object, input: object, envelope: object = {}) =>
		gatedTransaction(db, (tx) =>
			peopleWriter.updatePerson(tx, ctx as never, {
				requestKey: randomUUID(),
				expectedRevision: mine.revision,
				input,
				...envelope,
			}),
		);
	const patch = { displayName: "Robin " + secret };
	const forged: [string, () => Promise<unknown>, string][] = [
		[
			"scope",
			() => attempt({ ...plantCtx, selected: { kind: "plant", id: Q.id } }, { personId: mine.id, patch }),
			"unavailable",
		],
		["subject", () => attempt(plantCtx, { personId: theirs.id, patch }), "unavailable"],
		["actor", () => attempt(plantCtx, { personId: mine.id, patch, actorId: B.id }), "invalid_input"],
		["actor envelope", () => attempt(plantCtx, { personId: mine.id, patch }, { actorId: B.id }), "invalid_input"],
		["origin", () => attempt(plantCtx, { personId: mine.id, patch }, { origin: { kind: "evry" } }), "invalid_input"],
		["approval", () => attempt(plantCtx, { personId: mine.id, patch }, { approvalId: randomUUID() }), "invalid_input"],
		[
			"execution",
			() => attempt(plantCtx, { personId: mine.id, patch }, { executionId: randomUUID() }),
			"invalid_input",
		],
		[
			"model actor",
			() => attempt(plantCtx, { personId: mine.id, patch: { ...patch, actor: { kind: "model", id: "evry" } } }),
			"invalid_input",
		],
		[
			"organization kind",
			() =>
				attempt(
					{ ...plantCtx, selected: { kind: "organization", id: P.id, organizationKind: "sending_church" } },
					{ personId: mine.id, patch },
				),
			"unavailable",
		],
	];
	for (const [name, run, code] of forged) {
		const answer = await untouched(admin, run);
		refused(answer, code);
		assert.equal(refusal(answer).includes(secret), false, name);
	}
	const append = (id: SQL, tenant: string, subject: string) =>
		db.execute(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
			VALUES(${id},${tenant}::uuid,${A.id}::uuid,'people.updated','edit','person',${subject}::uuid,'{}')`);
	for (const [id, tenant] of [
		[theirs.id, P.id],
		[mine.id, Q.id],
	] as const)
		await untouched(admin, () =>
			assert.rejects(append(sql`${id}::uuid`, tenant, mine.id), (e: Error) =>
				/record_subtype_owner_mismatch/.test(String((e.cause as Error | undefined)?.message)),
			),
		);
	await untouched(admin, () =>
		assert.rejects(
			setFlag(db, {
				flag: "overview-role-subtitle",
				scope: { kind: "workspace", id: A.id },
				value: true,
				operator: A.id,
			}),
		),
	);

	const human = await recorded(admin, () =>
		update(alex, randomUUID(), mine.id, mine.revision, { displayName: "Robin Lee" }),
	);
	assert.deepEqual(human.added.audits, ["people.updated"]);
	const row = await one(sql`SELECT actor_id,actor_token,system_cause,tenant_id,subject_type,subject_id,request_identity
		FROM audit_event WHERE id=${ok(human.value).receiptId}`);
	assert.deepEqual(
		[row.actor_id, row.tenant_id, row.subject_type, row.subject_id, row.system_cause],
		[A.id, P.id, "person", mine.id, null],
	);
	const identity = row.request_identity as { actorId: string; owner: { kind: string; id: string } };
	assert.deepEqual([identity.actorId, identity.owner], [A.id, { kind: "plant", id: P.id }]);
	assert.match(str(row.actor_token), /^[a-f0-9]{64}$/);
	const names = { [A.id]: "A", [P.id]: "P" };
	assert.deepEqual([names[str(row.actor_id)], names[str(row.tenant_id)]], [result.attributed_actor, result.subject]);

	const flags = await recorded(admin, () =>
		setFlag(db, {
			flag: "overview-role-subtitle",
			scope: { kind: "workspace", id: P.id },
			value: true,
			operator: { cause: "bin/flag" },
		}),
	);
	assert.deepEqual(flags.added.audits, ["flags.changed"]);
	assert.deepEqual(
		await one(sql`SELECT actor_id,actor_token,system_cause,tenant_id FROM audit_event WHERE action='flags.changed'`),
		{ actor_id: null, actor_token: null, system_cause: "bin/flag", tenant_id: P.id },
	);
	const text = await auditText();
	assert.equal(text.includes(secret) ? secret : null, result.secret_in_event);
	assert.equal(c.expected.event, null);
});

test("AC:AUDIT-003 a closed people.updated audit keeps a 2048-byte diff, refuses 2049 bytes with the change rolled back, and holds no credential, private note or whole row", async () => {
	const c = caseOf("AUDIT-003");
	const { result } = c.expected;
	const input = c.given["case-input"]!;
	const care = c.given["private-A"]!;
	assert.equal(c.action.arguments.action, "people.updated");
	const credential = str(input.credential);
	const privateNote = str(care.note);
	assert.ok(privateNote.startsWith(str(input.private_note)));
	await admin.execute(sql`UPDATE auth_session SET token=${credential + "-" + randomUUID()} WHERE id=${A.session}`);
	const alex = await actorOf(A);
	const week = ok(
		await createPrivateCare().save(db, alex, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: {
				answers: { spiritual: str(care.answer).toLowerCase(), family: "steady", financial: "steady", pace: "steady" },
				note: privateNote,
			},
		}),
	).week;
	assert.equal(week.startsOn, care.week);
	const sam = await create(alex, "Sam");
	await untouched(admin, async () =>
		refused(
			await update(alex, randomUUID(), sam.id, sam.revision, { displayName: "Sam", password: credential }),
			"invalid_input",
		),
	);

	const ctx = { session: A.session, selected: plantOwner.parse(P) };
	const sized = (bytes: number) => {
		const wide = Math.floor((bytes - 9) / 4);
		const value = "é".repeat(wide) + "a".repeat(bytes - 9 - 2 * wide);
		return JSON.stringify({ x: value });
	};
	const saveWithDiff = (bytes: number, revision: string) =>
		gatedTransaction(db, async (tx) => {
			const saved = ok(
				await peopleWriter.updatePerson(tx, ctx, {
					requestKey: randomUUID(),
					expectedRevision: revision,
					input: { personId: sam.id, patch: { displayName: `Sam ${bytes}`, street: "1 Canary Way" } },
				}),
			);
			await tx.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,command_id,metadata)
				VALUES(${P.id}::uuid,${A.id}::uuid,'people.updated','edit','person',${sam.id}::uuid,${saved.receiptId}::uuid,
				jsonb_build_object('diff',${sized(bytes)}::jsonb))`);
			return saved;
		});
	const person = () => one(sql`SELECT display_name,revision::text AS revision FROM person WHERE id=${sam.id}`);
	const accepted: number[] = [];
	let revision = sam.revision;
	for (const bytes of input.diff_utf8_bytes as number[]) {
		const before = await person();
		const outcome = await saveWithDiff(bytes, revision).then(
			(saved) => saved,
			(e: Error) => e,
		);
		if (outcome instanceof Error) {
			assert.equal((outcome.cause as { constraint?: string }).constraint, "audit_projection");
			assert.equal(result.oversize_error, "audit_diff_too_large");
			assert.deepEqual(await person(), before);
			assert.equal(
				Number((await one(sql`SELECT count(*)::int AS n FROM audit_event WHERE subject_id=${sam.id}`)).n),
				1 + accepted.length * 2,
			);
			assert.equal(result.oversize_mutation_writes, 0);
			continue;
		}
		revision = outcome.person.revision;
		const stored = await one(sql`SELECT octet_length(convert_to((metadata->'diff')::text,'UTF8')) AS n
			FROM audit_event WHERE subject_id=${sam.id} AND metadata ? 'diff' ORDER BY recorded_at DESC LIMIT 1`);
		accepted.push(Number(stored.n));
	}
	assert.deepEqual(accepted, result.accepted_diff_sizes);
	await untouched(admin, () =>
		assert.rejects(
			db.execute(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,metadata)
				VALUES(${P.id}::uuid,${A.id}::uuid,'people.dumped','edit','person',${sam.id}::uuid,'{}')`),
			(e: Error) => (e.cause as { constraint?: string }).constraint === "audit_action",
		),
	);

	const changes = await rows(sql`SELECT before_value,after_value,metadata FROM audit_event
		WHERE subject_id=${sam.id} AND action='people.updated' AND NOT metadata ? 'diff'`);
	assert.equal(changes.length, accepted.length);
	for (const change of changes) {
		assert.deepEqual(Object.keys(change.before_value as object).sort(), ["display_name", "street"]);
		assert.deepEqual(Object.keys(change.after_value as object).sort(), ["display_name", "street"]);
		assert.deepEqual(change.metadata, {});
	}
	const dumps = await rows(sql`SELECT id FROM audit_event WHERE action='people.updated' AND
		(before_value ? 'tenant_id' OR after_value ? 'tenant_id' OR metadata ? 'tenant_id' OR metadata ? 'row')`);
	assert.equal(dumps.length ? dumps : null, result.whole_row_dump);
	const text = await auditText();
	assert.equal(text.includes(credential) ? credential : null, result.credential_in_audit);
	assert.equal(text.includes(str(input.private_note)) ? privateNote : null, result.private_note_in_audit);
	assert.equal(text.includes(str(week.id)), false, "nor the private week's identity");
	assert.equal(c.expected.event, null);
});

test("AC:AUDIT-004 a check-in saved, read and corrected writes no audit row, count or Plant Intelligence bump, no other reader or model context sees it, and the account purge receipt names no private-care count", async () => {
	const c = caseOf("AUDIT-004");
	const input = c.given["case-input"]!;
	const { result } = c.expected;
	const note = `${str(input.note)}-${c.id}`;
	await at(c.clock.now);
	const church = await world.plant({ name: "Care church", timezone: "America/Chicago" });
	const owner = await world.actor(church, "owner");
	const author = await world.actor(church, "admin");
	await admin.execute(
		sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id IN (${owner.id},${author.id})`,
	);
	const me = await actorOf(author);
	const them = await actorOf(owner);
	const care = createPrivateCare();
	const material = async () =>
		Number((await one(sql`SELECT material_revision::text AS m FROM plant WHERE id=${church.id}`)).m);
	const start = await material();
	const strained = { spiritual: "strained", family: "steady", financial: "strained", pace: "strained" };
	const saved = await recorded(admin, async () =>
		ok(
			await care.save(db, me, { requestKey: randomUUID(), expectedRevision: "0", input: { answers: strained, note } }),
		),
	);
	assert.deepEqual(saved.added, NOTHING);
	const week = saved.value.week;
	assert.equal(week.startsOn, input.week);
	const reads = await untouched(admin, async () => [
		ok(await care.readCurrent(db, me, {})),
		ok(await care.readHistory(db, me, { page: 1 })),
		ok(await care.readTrends(db, me, {})),
	]);
	assert.ok(JSON.stringify(reads).includes(note), "the author reads their own note");
	const corrected = await recorded(admin, async () =>
		ok(
			await care.correct(db, me, {
				requestKey: randomUUID(),
				expectedRevision: ok(await care.readCurrent(db, me, {})).revision,
				input: { weekId: week.id, answers: { ...strained, pace: "steady" }, note: note + " corrected" },
			}),
		),
	);
	assert.deepEqual(corrected.added, NOTHING);
	const others = await untouched(admin, async () => [
		await care.readCurrent(db, them, {}),
		await care.readHistory(db, them, { page: 1 }),
		await care.correct(db, them, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { weekId: week.id, answers: strained, note: "forged" },
		}),
		ok(await createFacts().readFacts(db, them, {})),
		ok(await createFacts().readFacts(db, me, {})),
	]);
	for (const answer of others) {
		const text = JSON.stringify(answer);
		assert.equal(text.includes(note) || text.includes(str(week.id)), false, text.slice(0, 200));
	}
	assert.equal((await material()) - start, result.PI_revision_bumps);

	const audit = async () =>
		rows(sql`SELECT to_jsonb(a)::text AS row FROM audit_event a WHERE a.tenant_id IN (${church.id},${author.id})
			OR a.actor_id=${author.id} OR a.subject_id=${author.id}`);
	const careLike = (list: Record<string, unknown>[]) =>
		list.filter((r) => /CARE-CANARY|private|care|week|strained/i.test(str(r.row)) || str(r.row).includes(str(week.id)));
	assert.equal(careLike(await audit()).length ? "body" : null, result.broad_audit_body);
	assert.deepEqual(await holding(note), ["private_week", "private_week_revision"]);
	assert.equal(
		(await holding(str(week.id))).some((t) => !t.startsWith("private_")) ? "existence" : null,
		result.broad_audit_existence,
	);

	await askDeletion(author, { kind: "account", id: author.id } as DeletionSubject);
	await at(new Date(Date.parse(c.clock.now) + 31 * DAY));
	assert.equal(await purgeDue(), 1);
	assert.deepEqual(await witnessOf(author.id), { state: "purged", purged: true });
	assert.deepEqual(await holding(note), []);
	const receipts = await rows(sql`SELECT action,metadata,before_value,after_value,reason FROM audit_event
		WHERE subject_id=${author.id} OR tenant_id=${author.id} OR action LIKE 'deletion.%' OR action LIKE 'account.%'`);
	const counts = receipts.filter((r) => /care|week|private|check/i.test(JSON.stringify(r)));
	assert.equal(counts.length ? counts : null, result.purge_private_care_counts);
	assert.equal(careLike(await audit()).length ? "counts" : null, result.broad_audit_counts);
	assert.equal(c.expected.event, null);
});

test("AC:AUDIT-005 the church Admin, an affiliated organization Admin with sharing on, a platform admin and a scoped operator read the same pages, activity cursors and lists before and after a check-in, and a wrong context is refused", async () => {
	const c = caseOf("AUDIT-005");
	const input = c.given["behavior-inputs"]!;
	const { result } = c.expected;
	assert.equal(input.private_author, "A");
	const note = `${str(input.note)}-${c.id}`;
	await at(new Date(Date.parse(c.clock.now) + 5 * 3_600_000));
	const church = await world.plant({ name: "Oversight church", timezone: "America/Chicago" });
	const author = await world.actor(church, "admin");
	const churchAdmin = await world.actor(church, "admin");
	const S5 = await world.organization("sending_church", { name: "S5" });
	const orgAdmin = await world.actor(S5, "admin");
	await admin.execute(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,
		share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${church.id},${S5.id},clock_timestamp(),true,true,true,true,true,true,true)`);
	const platform = await world.actor(null, "owner", { account: { registration_kind: "planter" } });
	const investigator = await world.actor(null, "owner", { account: { registration_kind: "planter" } });
	await admin.execute(sql`INSERT INTO platform_grant(account_id,capability) VALUES(${platform.id},'feedback_triage'),
		(${investigator.id},'recovery_operator'),(${investigator.id},'assessment_operator')`);
	await admin.execute(sql`UPDATE account SET personal_timezone='America/Chicago' WHERE id=${author.id}`);
	const me = await actorOf(author);
	const staff = await actorOf(churchAdmin);
	const org = await actorOf(orgAdmin);
	const operator = await actorOf(platform);
	const scoped = await actorOf(investigator);
	const robin = await create(staff, "Robin");
	for (let n = 0; n < 3; n++)
		ok(
			await withPeopleWrite(db, staff, (tx, ctx) =>
				peopleWriter.addNote(tx, ctx, {
					requestKey: randomUUID(),
					expectedRevision: String(Number(robin.revision) + n),
					input: { personId: robin.id, body: `Visit ${n}` },
				}),
			),
		);
	const activity = (page: number, selected = church.id) =>
		gatedTransaction(db, (tx) =>
			peopleReader.getActivities(
				tx,
				{ session: churchAdmin.session, selected: plantOwner.parse({ kind: "plant", id: selected }) },
				{
					personId: robin.id,
					limit: 2,
					page,
				},
			),
		);
	const withoutCorrelation = (answer: { status: string; error?: object }) =>
		answer.error ? { ...answer, error: { ...answer.error, correlationId: null } } : answer;
	const surfaces = async () => ({
		church: {
			metrics: await dashboardReader.readMetrics(db, staff),
			actions: await dashboardReader.readAvailableActions(db, staff),
			pages: [ok(await activity(1)), ok(await activity(2))],
			wrong: withoutCorrelation(await activity(1, Q.id)),
		},
		organization: { plants: await listPlants(db, org), plant: await getPlant(db, org, church.id) },
		platform: {
			triage: await feedbackWriter["admin.list"](db, operator, {}),
			plant: await getPlant(db, operator, church.id),
			metrics: await dashboardReader.readMetrics(db, operator),
		},
		investigator: {
			triage: await feedbackWriter["admin.list"](db, scoped, {}),
			plant: await getPlant(db, scoped, church.id),
		},
	});
	const before = await surfaces();
	assert.equal(before.church.pages[0]!.items.length, 2);
	refused(before.church.wrong, "unavailable");
	assert.notEqual(before.organization.plant, null, "the organization reads the affiliated church");
	assert.deepEqual([before.platform.plant, before.investigator.plant], [null, null]);
	const care = createPrivateCare();
	const week = ok(
		await care.save(db, me, {
			requestKey: randomUUID(),
			expectedRevision: "0",
			input: { answers: { spiritual: "strained", family: "strained", financial: "steady", pace: "steady" }, note },
		}),
	).week;
	ok(
		await care.correct(db, me, {
			requestKey: randomUUID(),
			expectedRevision: ok(await care.readCurrent(db, me, {})).revision,
			input: {
				weekId: week.id,
				answers: { spiritual: "steady", family: "strained", financial: "steady", pace: "steady" },
				note,
			},
		}),
	);
	const after = await surfaces();
	const text = JSON.stringify(after);
	assert.equal(text.includes(note) || text.includes(str(week.id)) ? "body" : null, result.generic_audit_body);
	assert.equal(isEqual(after, before) ? null : "existence", result.generic_audit_existence);
	assert.equal(c.expected.event, null);
});

test("AC:AUDIT-006 deleting the account keeps its shared evidence under a token local to each church, purges its own audit, links and email, and a deleted church leaves its organization's own ending receipt", async () => {
	const c = caseOf("AUDIT-006");
	const input = c.given["case-input"]!;
	const careNote = str(c.given["private-A"]!.note);
	const { result } = c.expected;
	assert.deepEqual([input.deleted_account, input.shared_owner, input.private_owner], ["A", "P", "A"]);
	await at(new Date(Date.parse(c.clock.now) + 3_600_000));
	const alex = await actorOf(A);
	const care = createPrivateCare();
	const current = ok(await care.readCurrent(db, alex, {}));
	ok(
		await care.save(db, alex, {
			requestKey: randomUUID(),
			expectedRevision: current.revision,
			input: {
				answers: { spiritual: "strained", family: "steady", financial: "steady", pace: "steady" },
				note: careNote,
			},
		}),
	);
	const document = ok(
		await documentsWriter.saveNative(db, alex, {
			title: "Launch plan",
			body: nativeFromText("Launch plan"),
			expectedRevision: "0",
		}),
	);
	const taylor = await create(alex, "Taylor");
	const note = ok(
		await withPeopleWrite(db, alex, (tx, ctx) =>
			peopleWriter.addNote(tx, ctx, {
				requestKey: randomUUID(),
				expectedRevision: taylor.revision,
				input: { personId: taylor.id, body: "Met at the park" },
			}),
		),
	);
	ok(
		await createLaunchWriter({ notices: async () => undefined }).schedule(db, alex, {
			requestKey: randomUUID(),
			expectedRevision: "1",
			input: { date: "2027-03-08", reason: null },
		}),
	);
	await admin.execute(sql`UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=${A.id} AND ended_at IS NULL`);
	await world.seat(A, Q, "admin");
	const session = randomUUID();
	await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
		VALUES(${session},${A.user},${randomUUID()},clock_timestamp()+interval '1 day')`);
	const inQ = await actorOf({ ...A, session: session as Actor["session"] });
	const morgan = await create(inQ, "Morgan");

	const S1 = await world.organization("sending_church", { name: "S1" });
	const sending = await world.actor(S1, "admin");
	const R = await world.plant({ name: "Ridgeline Removed Church" });
	const ownerR = await world.actor(R, "owner");
	const link = await one(sql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,
		share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
		VALUES(${R.id},${S1.id},clock_timestamp(),true,true,true,true,true,true,true) RETURNING id,revision::text AS revision`);
	const organizations = relationshipCommands({
		invitation: async () => assert.fail("no invitation is sent"),
		invalidate: (_tx, v) => supersedeDigests(v.sourceId),
	});
	const S1owner = owner.parse(S1);
	assert.deepEqual(
		await gatedTransaction(db, async (tx) => {
			assert.ok(await RequestActor.claimWrite(tx, sending.session, S1owner));
			return organizations["associations.end"](tx, sending.session, S1owner, {
				requestKey: randomUUID(),
				expectedRevision: str(link.revision),
				input: {
					relationshipId: str(link.id),
					pair: { kind: "plant", subject: plantOwner.parse(R), organization: S1owner },
					confirmed: true,
					reason: null,
				},
			});
		}),
		{ status: "committed" },
	);

	const audits = (where: SQL) =>
		rows(sql`SELECT id,tenant_id,actor_id,actor_token,action FROM audit_event WHERE ${where} ORDER BY id`);
	const shared = await audits(sql`actor_id=${A.id} AND tenant_id IN (${P.id},${Q.id})`);
	assert.ok(shared.some((r) => r.tenant_id === P.id) && shared.some((r) => r.tenant_id === Q.id));
	assert.ok((await audits(sql`tenant_id=${A.id}`)).length === 0);
	await askDeletion(A, { kind: "account", id: A.id } as DeletionSubject);
	assert.ok((await audits(sql`tenant_id=${A.id}`)).length > 0, "the account has its own audit");
	const ending = await audits(sql`tenant_id=${S1.id} AND action='affiliation.ended'`);
	assert.equal(ending.length, 1);
	await askDeletion(ownerR, R as DeletionSubject);

	await at(new Date(Date.parse(c.clock.now) + 31 * DAY + 2 * 3_600_000));
	assert.equal(await purgeDue(), 2);
	assert.deepEqual(await witnessOf(A.id), { state: "purged", purged: true });
	assert.deepEqual(await witnessOf(R.id), { state: "purged", purged: true });

	const kept = await audits(
		sql`id IN (${sql.join(
			shared.map((r) => sql`${r.id}::uuid`),
			sql`,`,
		)})`,
	);
	const evidence = await one(sql`SELECT
		(SELECT count(*)::int FROM document WHERE id=${document.id} AND tenant_id=${P.id}) AS documents,
		(SELECT count(*)::int FROM person_note WHERE id=${note.noteId} AND author_id IS NULL) AS notes,
		(SELECT count(*)::int FROM launch WHERE plant_id=${P.id} AND target_date='2027-03-08') AS launches,
		(SELECT count(*)::int FROM person WHERE id IN (${taylor.id},${morgan.id})) AS people`);
	assert.equal(
		kept.length === shared.length &&
			kept.every((r) => r.actor_id === null && /^[a-f0-9]{64}$/.test(str(r.actor_token))) &&
			isEqual(evidence, { documents: 1, notes: 1, launches: 1, people: 2 }),
		result.shared_evidence_retained,
	);
	assert.equal(
		(await audits(sql`tenant_id=${A.id}`)).length === 0 && (await holding(careNote)).length === 0,
		result.private_audit_purged,
	);

	const linked = (await holding(A.id)).filter(
		(t) => !["account", "auth_user", "job", "lifecycle_witness", "record", "tenant", "seat"].includes(t),
	);
	const live =
		await one(sql`SELECT (SELECT count(*)::int FROM seat WHERE account_id=${A.id} AND ended_at IS NULL) AS seats,
		(SELECT count(*)::int FROM auth_session s JOIN account a ON a.auth_user_id=s.user_id WHERE a.id=${A.id}) AS sessions`);
	assert.equal(linked.length || live.seats || live.sessions ? { linked, ...live } : null, result.live_actor_link);

	const tokens = new Map<string, Set<unknown>>();
	for (const r of kept) tokens.set(str(r.actor_token), (tokens.get(str(r.actor_token)) ?? new Set()).add(r.tenant_id));
	const crossing = [...tokens].filter(([, tenants]) => tenants.size > 1);
	const stored: string[] = [];
	for (const token of tokens.keys()) stored.push(...(await holding(token)).filter((t) => t !== "audit_event"));
	const byTenant = (tenant: string) => kept.filter((r) => r.tenant_id === tenant).map((r) => r.actor_token);
	assert.equal(
		byTenant(P.id).some((t) => byTenant(Q.id).includes(t)) || crossing.length || stored.length ? "map" : null,
		result.cross_scope_tombstone_map,
	);
	assert.equal((await holding(A.email)).length ? A.email : null, result.retained_actor_email);

	assert.deepEqual(await audits(sql`tenant_id=${R.id}`), []);
	const receipt = await rows(
		sql`SELECT tenant_id,action,to_jsonb(a)::text AS row FROM audit_event a WHERE id=${ending[0]!.id}`,
	);
	assert.equal(receipt.length, 1, "the organization keeps its own ending receipt");
	assert.equal(str(receipt[0]!.row).includes("Ridgeline"), false);
	assert.equal(c.expected.event, null);
});

test("AC:AUDIT-008 a write whose audit insert fails commits nothing and its retry commits once; a copy taken before an account and church purge restores under the current witness with no actor link, private audit, schedule or object revived and the original copy expiry", async () => {
	const c = caseOf("AUDIT-008");
	const input = c.given["behavior-inputs"]!;
	const { result } = c.expected;
	assert.equal(input.fault, "audit_insert");
	const requestKey = str(input.request_key);
	const backupAt = new Date(Date.parse(c.clock.now) + 2 * 3_600_000);
	await at(backupAt);
	const E = await world.actor(P, "admin", { email: "eden@example.test" });
	const T = await world.plant({ name: "Thornbury Church" });
	const ownerT = await world.actor(T, "owner");
	const eden = await actorOf(E);
	const quinn = await create(eden, "Quinn");
	const rename = () => update(eden, requestKey, quinn.id, quinn.revision, { displayName: "Quinn Ray" });
	const error = console.error;
	console.error = () => undefined;
	try {
		const thrown = await failingWrite(admin, { on: "audit_event", event: "INSERT" }, () =>
			untouched(admin, () =>
				rename().then(
					(v) => v,
					(e: unknown) => e,
				),
			),
		);
		assert.match(refusal(thrown), /injected fault/);
	} finally {
		console.error = error;
	}
	const domain = async () =>
		str((await one(sql`SELECT display_name FROM person WHERE id=${quinn.id}`)).display_name) === "Quinn Ray";
	assert.equal(await domain(), result.fault_domain_committed);
	const answers = [];
	for (let n = 0; n < Number(input.repeat); n++) answers.push(ok(await rename()));
	assert.deepEqual(answers[1], answers[0]);
	const events = await rows(sql`SELECT id FROM audit_event WHERE request_key=${requestKey}`);
	assert.equal(events.length, result.replay_events);
	assert.equal(await domain(), true);

	const store = live;
	const avatar = await readyFile(admin, store, E.id, Buffer.from("E's photo"), "avatar");
	await admin.execute(sql`UPDATE account SET avatar_object_id=${avatar.id} WHERE id=${E.id}`);
	await admin.transaction((tx) =>
		enqueueJob(tx, {
			tenant: T.id,
			kind: "digest",
			subject: T.id,
			key: `audit-case/digest/${T.id}`,
			revision: "1",
			eligibleAt: new Date(Date.parse(c.clock.now) + 40 * 86_400_000).toISOString(),
		}),
	);
	await askDeletion(E, { kind: "account", id: E.id } as DeletionSubject);
	await askDeletion(ownerT, T as DeletionSubject);
	const purgedAt = new Date(Date.parse(c.clock.now) + 31 * DAY + 3 * 3_600_000);
	const copiedAt = new Date(purgedAt.getTime() - DAY);
	await at(copiedAt);
	const copy = await snapshot(admin, store, { createdAt: copiedAt });
	assert.ok(copy.objects.has(avatar.id));
	const old = JSON.parse(copy.image.toString("utf8")) as { tables: Record<string, Record<string, unknown>[]> };
	assert.ok(
		old.tables.audit_event!.some((r) => r.actor_id === E.id && r.tenant_id === P.id),
		"the copy has live actor links",
	);
	assert.ok(
		old.tables.audit_event!.some((r) => r.tenant_id === E.id),
		"and the account's own audit",
	);
	assert.ok(
		old.tables.job!.some((r) => r.tenant_id === T.id && r.kind === "digest"),
		"and the church's schedule",
	);

	await at(purgedAt);
	assert.equal(await purgeDue(), 2);
	assert.equal(live.has(avatar.key), false);
	const expiry = async (id: string) =>
		String(
			(await one(sql`SELECT copy_expires_at FROM lifecycle_witness WHERE opaque_subject_id=${id}`)).copy_expires_at,
		);
	const witnessed = { E: await expiry(E.id), T: await expiry(T.id) };

	const later = new Date(purgedAt.getTime() + 3_600_000);
	await at(later);
	const target = `${world.schema.slice(0, 50)}_t${targets.length}`;
	targets.push(target);
	const restoredStore: Store = new Map();
	const restored = await restoreWithCurrentManifest(
		{ admin, source: world.schema, targetSchema: target, objects: objectStore(restoredStore), clock: () => later },
		{ capability: operator, target: "isolated", snapshot: copy, current: () => readCurrentManifest(admin) },
	);
	assert.equal(restored.restore_success, true, JSON.stringify(restored));
	const there = (table: string) => sql.raw(`${target}.${table}`);
	const back = await one(sql`SELECT
		(SELECT count(*)::int FROM ${there("audit_event")} WHERE actor_id=${E.id}) AS links,
		(SELECT count(*)::int FROM ${there("audit_event")} WHERE tenant_id IN (${E.id},${T.id})) AS private,
		(SELECT count(*)::int FROM ${there("audit_event")} WHERE tenant_id=${P.id} AND actor_id IS NULL AND actor_token IS NOT NULL
			AND id IN (${sql.join(
				old.tables
					.audit_event!.filter((r) => r.actor_id === E.id && r.tenant_id === P.id)
					.map((r) => sql`${str(r.id)}::uuid`),
				sql`,`,
			)})) AS tokens,
		(SELECT count(*)::int FROM ${there("job")} WHERE tenant_id=${T.id} AND kind<>'lifecycle_purge') AS schedules,
		(SELECT count(*)::int FROM ${there("plant")} p WHERE id=${T.id} AND to_jsonb(p)<>(SELECT to_jsonb(l) FROM plant l WHERE l.id=p.id)) AS churches,
		(SELECT count(*)::int FROM ${there("plant")} WHERE name='Thornbury Church') AS names,
		(SELECT count(*)::int FROM ${there("person")} WHERE id=${quinn.id} AND display_name='Quinn Ray') AS shared,
		(SELECT count(*)::int FROM ${there("auth_user")} WHERE email=${E.email}) AS emails`);
	assert.deepEqual(back, {
		links: 0,
		private: 0,
		tokens: old.tables.audit_event!.filter((r) => r.actor_id === E.id && r.tenant_id === P.id).length,
		schedules: 0,
		churches: 0,
		names: 0,
		shared: 1,
		emails: 0,
	});
	assert.equal(restoredStore.has(avatar.key), false, "the purged account's object is not restored");
	const witnesses =
		await rows(sql`SELECT opaque_subject_id AS id,state,copy_expires_at::text AS expiry FROM ${there("lifecycle_witness")}
		WHERE opaque_subject_id IN (${E.id},${T.id}) ORDER BY opaque_subject_id`);
	for (const w of witnesses) {
		assert.equal(w.state, "purged");
		assert.equal(new Date(str(w.expiry)).getTime(), new Date(w.id === E.id ? witnessed.E : witnessed.T).getTime());
	}
	assert.equal(witnesses.length, 2);
	assert.equal(c.expected.event, null);
});

const mailKeys = {
	encryptionKey: Buffer.alloc(32, 7),
	addressKey: Buffer.alloc(32, 9),
	from: "news@example.test",
	origin: "https://app.example.test",
};
const webhookSecret = "whsec_" + randomBytes(32).toString("base64");
function providerEvent(messageId: string, kind: string, eventKey: string, createdAt: string) {
	const raw = JSON.stringify({ type: "email." + kind, created_at: createdAt, data: { email_id: messageId } });
	const stamp = String(Math.floor(Date.now() / 1000));
	const signature = createHmac("sha256", Buffer.from(webhookSecret.slice(6), "base64"))
		.update(eventKey + "." + stamp + "." + raw)
		.digest("base64");
	return new Request("https://example.test/api/webhooks/resend", {
		method: "POST",
		body: raw,
		headers: { "svix-id": eventKey, "svix-timestamp": stamp, "svix-signature": "v1," + signature },
	});
}

test("AC:AUDIT-007 the runtime login cannot update, delete or append an invalid audit row; a rolled-back command and a later denial add no success event; accepted, delivered, then a late accepted leaves the mail delivered with no duplicate event", async () => {
	const c = caseOf("AUDIT-007");
	const input = c.given["case-input"]!;
	const { result } = c.expected;
	assert.equal(input.runtime_role, "ordinary");
	const sentAt = new Date(Date.parse(c.clock.now) + 4 * 3_600_000);
	await at(sentAt);
	const church = await world.plant({ name: "Mail church", ...MAILING });
	const sender = await world.actor(church, "owner");
	const member = await world.actor(church, "member");
	const owner = await actorOf(sender);
	const login = await one(sql`SELECT current_user AS name`);
	assert.notEqual((await db.execute(sql`SELECT current_user AS name`)).rows[0]!.name, login.name);

	const personId = randomUUID();
	await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,stage,adult_classification,
		commitment_state,pipeline_position,state,created_at) VALUES(${personId},${church.id},${church.id},'Robin',
		'robin@example.test','other','prospect','unknown','unknown',0,'live',clock_timestamp())`);
	const draft = (requestKey: string, who = owner) =>
		writeAs(db, who, "saveDraft", {
			requestKey,
			input: {
				subject: "Welcome",
				bodyHtml: "<p>Welcome Robin.</p>",
				audience: { groups: [], teamIds: [], personIds: [personId] },
			},
		});
	const rolledBack = randomUUID();
	const error = console.error;
	console.error = () => undefined;
	try {
		const thrown = await failingWrite(admin, { on: "audit_event", event: "INSERT", atCommit: false }, () =>
			untouched(admin, () =>
				draft(rolledBack).then(
					(v) => v,
					(e: unknown) => e,
				),
			),
		);
		assert.match(refusal(thrown), /injected fault|unavailable/);
	} finally {
		console.error = error;
	}
	const denied = await untouched(admin, async () => draft(randomUUID(), await actorOf(member)));
	assert.equal(denied.status, "refused");
	const successes = await rows(sql`SELECT id FROM audit_event WHERE request_key=${rolledBack}`);
	assert.equal(successes.length, result.rollback_success_events);

	const saved = ok(await draft(randomUUID()));
	const target = await one(sql`SELECT id FROM audit_event WHERE tenant_id=${church.id} LIMIT 1`);
	const attempts: Record<string, SQL> = {
		UPDATE: sql`UPDATE audit_event SET reason='changed' WHERE id=${target.id}`,
		DELETE: sql`DELETE FROM audit_event WHERE id=${target.id}`,
		invalid_append: sql`INSERT INTO audit_event(tenant_id,system_cause,action,kind,subject_id,metadata)
			VALUES(${church.id},'provider_callback','not-an-action','outcome',${church.id},'{}')`,
	};
	const allowed: boolean[] = [];
	for (const name of strings(input.attempts))
		allowed.push(
			await untouched(admin, () =>
				db.execute(attempts[name]!).then(
					() => true,
					(e: Error) => (assert.match(String((e.cause as { code?: string }).code), /^(42501|23514)$/), false),
				),
			),
		);
	assert.deepEqual(allowed, result.allowed_audit_mutations);
	const scheduledAt = new Date(Math.ceil((Date.now() + 7 * DAY) / 3_600_000) * 3_600_000).toISOString();
	const scheduled = ok(
		await writeAs(db, owner, "scheduleReviewed", {
			requestKey: randomUUID(),
			expectedRevision: saved.revision,
			input: { communicationId: saved.communicationId, scheduledAt },
		}),
	);
	const messageId = "prov-" + randomUUID();
	const carrier: DeliveryTransport = {
		paused: false,
		send: async (batch) => ({ outcome: "ids", ids: batch.messages.map(() => messageId) }),
		cancel: async (ids) => ids.map(() => ({ outcome: "unknown" })),
		reschedule: async () => assert.fail("nothing is rescheduled"),
	};
	ok(
		await deliverAs(
			db,
			owner,
			"dispatchAttempt",
			{
				requestKey: randomUUID(),
				expectedRevision: scheduled.revision,
				input: { communicationId: saved.communicationId },
			},
			carrier,
			mailKeys,
		),
	);
	const status = async () =>
		ok(await readAs(db, owner, "getDetail", { id: saved.communicationId }, mailKeys)).recipients.map(
			(row) => row.deliveryStatus,
		);
	const states: string[] = [];
	for (const [n, kind] of strings(input.provider_events).entries()) {
		const answer = await resendWebhook(
			providerEvent(messageId, kind, randomUUID(), new Date(Date.now() + n * 60_000).toISOString()),
			() => db,
			webhookSecret,
		);
		assert.equal(answer.status, 200, kind);
		states.push(...(await status()));
	}
	assert.deepEqual(states, ["accepted", "delivered", result.effective_provider_status]);
	const events = await rows(sql`SELECT a.action,a.event_key FROM audit_event a JOIN mail m ON m.id=a.subject_id
		WHERE m.provider_message_id=${messageId} ORDER BY a.recorded_at`);
	assert.deepEqual(
		events.map((r) => str(r.action)).sort(),
		strings(input.provider_events)
			.map((kind) => (kind === "delivered" ? "mail.delivered" : "mail.reconciled"))
			.sort(),
	);
	const keys = events.map((r) => r.event_key);
	const duplicates =
		keys.length - new Set(keys).size + Math.max(0, events.filter((r) => r.action === "mail.delivered").length - 1);
	assert.equal(duplicates, result.duplicate_business_events);
	assert.equal(c.expected.event, null);
});
