import assert from "node:assert/strict";
import { withPeopleWrite } from "../../../../packages/domain/src/people/index.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { sql, type SQL } from "../../../../packages/db/src/query.ts";
import { RequestActor, type WriteTx } from "../../../../packages/domain/src/access/session.ts";
import { communicationWriter } from "../../../../packages/domain/src/communication/index.ts";
import { documentsReader, documentsWriter } from "../../../../packages/domain/src/documents/index.ts";
import {
	createAssessmentJob,
	createAssessments,
	createFacts,
	runAssessmentBatch,
} from "../../../../packages/domain/src/intelligence/index.ts";
import { authorizeDigestMail, createDigestWorker } from "../../../../packages/domain/src/jobs/digest.ts";
import { createMailService, type MailPayload } from "../../../../packages/domain/src/jobs/mail.ts";
import { claimDue } from "../../../../packages/domain/src/jobs/queue.ts";
import { createNotificationService } from "../../../../packages/domain/src/jobs/notifications.ts";
import {
	createAttendanceWriter,
	meetingsWriter,
	withMeetingsWrite,
	type MeetingsContext,
} from "../../../../packages/domain/src/meetings/index.ts";
import { gatedTransaction } from "../../../../packages/domain/src/operations/writes.ts";
import { requestIntelligenceRefresh } from "../../../../packages/domain/src/oversight/index.ts";
import { reminderRecipients } from "../../../../packages/domain/src/tasks/index.ts";
import { evryActor, invokeRead, READ_DOMAINS } from "../../../../packages/evry/src/index.ts";
import type { ReadAdapter } from "../../../../packages/evry/src/catalog/types.ts";
import { scriptedAssessmentDrafter } from "../../../../packages/evry-scripted/src/scripted-assessment.ts";
import { scheduledJobs } from "../../../../apps/web/src/server/jobs/scheduled.ts";
import { taskReminders } from "../../../../apps/web/src/features/tasks/reminders.ts";
import { ok, type Actor } from "../../../support/fixture.mts";
import { MAILING } from "../../communication/church-address.mts";
import { writeAs } from "../../communication/communication-support.mts";
import { resendRecorder } from "../../communication/resend-recorder.mts";
import { MemoryClient } from "../../documents/storage.mts";
import { church, ZONE, type ChurchPlant } from "../../intelligence/assessment-church.mts";

export type Row = Record<string, unknown>;
type Seat = {
	id: string;
	actor: RequestActor;
	ctx: { session: string; selected: { kind: "plant"; id: string } };
};
export const key = () => randomUUID();
const DAY = 86_400_000;

const FROZEN = [
	"mail",
	"mail_attempt",
	"mail_request",
	"mail_request_member",
	"job",
	"notice",
	"communication",
	"assessment_run",
	"network_intelligence_run",
	"network_intelligence_plant",
	"launch_summary",
	"generated_document",
	"file_object",
	"audit_event",
] as const;
type Frozen = (typeof FROZEN)[number];

export async function world(prefix: string, reminderTime?: string) {
	const c = await church(prefix, { max: 8 });
	const { database, admin, db, one, rows } = c;
	await c.release("methodology-2026.11");
	const org = await c.network("Hill Country Network");
	const director = (await RequestActor.resolve(db, org.director.session)) as RequestActor;
	const p = await c.plant("Grace Harbor", { network: org });
	await admin.execute(sql`UPDATE plant SET street=${MAILING.street},city=${MAILING.city},
		state_province=${MAILING.state_province},country=${MAILING.country} WHERE id=${p.id}`);
	await admin.execute(sql`UPDATE affiliation SET share_people=true,share_meetings=true,share_tasks=true,
		share_ministry_teams=true,share_activity=true WHERE id=${p.affiliation}`);
	async function seated(account: Actor): Promise<Seat> {
		return {
			id: account.id,
			actor: (await RequestActor.resolve(db, account.session)) as RequestActor,
			ctx: { session: account.session, selected: { kind: "plant", id: p.id } },
		};
	}
	const boss = await seated(
		await database.actor(p, "admin", {
			user: { name: "Adam Admin" },
			account: { personal_timezone: "America/Chicago" },
		}),
	);
	const bossPerson = await c.person(p, "Adam Admin");
	await admin.execute(sql`UPDATE person SET linked_account_id=${boss.id},stage='leader' WHERE id=${bossPerson.id}`);

	const sent: MailPayload[] = [];
	const optOutKey = randomBytes(32);
	const mail = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "digests@example.test",
		authorize: authorizeDigestMail,
		unsubscribe: { origin: "https://everyfield.test", keys: { current: optOutKey } },
		transport: {
			async send(payload) {
				sent.push(payload);
				return { kind: "accepted", id: key() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const notifications = createNotificationService({
		mail,
		async eligible(tx, inputs) {
			const found = await reminderRecipients(
				tx,
				p.id,
				inputs.map((i) => i.recipient),
			);
			return inputs.map((i) => (found.has(i.recipient) ? { address: found.get(i.recipient)! } : null));
		},
	});
	const asOf =
		reminderTime &&
		new Date(
			(
				await one<{ ms: number }>(
					sql`SELECT (extract(epoch FROM (${`${c.today} ${reminderTime}`}::timestamp AT TIME ZONE ${ZONE}))*1000)::float8 AS ms`,
				)
			).ms,
		).toISOString();
	const reminders = taskReminders(
		asOf
			? {
					...notifications,
					syncTaskReminders: (tx, inputs) =>
						notifications.syncTaskReminders(
							tx,
							inputs.map((i) => ({ ...i, asOf })),
						),
				}
			: notifications,
	);
	const attendance = createAttendanceWriter({ reminders });

	const people = <T,>(op: (tx: WriteTx, ctx: never, raw: never) => Promise<T>, raw: unknown, who: Seat = boss) =>
		withPeopleWrite(db, who.actor, (tx) => op(tx, who.ctx as never, raw as never) as never) as Promise<T>;
	const meeting = <T,>(
		op: (tx: WriteTx, ctx: MeetingsContext, raw: unknown) => Promise<T>,
		raw: unknown,
		who: Seat = boss,
	) => withMeetingsWrite(db, who.actor, (tx, ctx) => op(tx, ctx, raw) as never) as Promise<T>;
	const read = <T,>(op: (tx: WriteTx, actor: RequestActor, raw: never) => Promise<T>, raw: unknown = {}, who = boss) =>
		gatedTransaction(db, (tx) => op(tx, who.actor, raw as never));
	const revision = async (table: string, id: string, column = "revision") =>
		(
			await one<{ r: string }>(
				sql`SELECT ${sql.identifier(column)}::text AS r FROM ${sql.identifier(table)} WHERE id=${id}`,
			)
		).r;

	async function held(daysAgo: number, attendeeIds: string[], type = "vision_meeting") {
		const { id } = ok(
			await meeting(meetingsWriter.schedule, {
				requestKey: key(),
				input: { type, date: c.day(-daysAgo), time: "09:00" },
			}),
		).meeting;
		for (const to of ["in_progress", "completed"])
			ok(
				await meeting(meetingsWriter.changeStatus, {
					requestKey: key(),
					expectedRevision: await revision("meeting", id),
					input: { meetingId: id, to },
				}),
			);
		ok(
			await meeting(attendance.finalizeAttendance, {
				requestKey: key(),
				expectedRevision: await revision("meeting", id, "attendance_revision"),
				input: { meetingId: id, attendeeIds, followUpAssigneeIds: [boss.id], evaluationAssigneeIds: [] },
			}),
		);
		return id;
	}

	const operations = new Map<string, ReadAdapter<unknown>>(
		Object.values(READ_DOMAINS)
			.flat()
			.map((a) => [a.operation, a as ReadAdapter<unknown>]),
	);
	async function evry(operation: string, input: unknown = {}, who: RequestActor = boss.actor) {
		const adapter = operations.get(operation);
		assert.ok(adapter, operation);
		return invokeRead(db, evryActor(who), adapter, adapter.input.parse(input));
	}

	const shown = async (operation: string, input: unknown, fields: readonly string[], who: RequestActor = boss.actor) =>
		(await evry(operation, input, who)).rows.map((r) => [r.label, ...fields.map((f) => r.fields[f] ?? null)]);

	const assessments = createAssessments();
	const facts = createFacts();
	const job = createAssessmentJob();
	async function assess() {
		ok(await assessments.requestRefresh(db, boss.actor, { requestId: key() }));
		await runAssessmentBatch(job, db, scriptedAssessmentDrafter(), 5);
		const view = ok(await assessments.readAssessment(db, boss.actor, {}));
		assert.ok(view.current && !view.newest);
		return view.current;
	}
	const stale = async () => ok(await facts.readFactsSinceRun(db, boss.actor, {})).outOfDateRunId;
	const factsNow = async () => ok(await facts.readFacts(db, boss.actor, {}));

	const storage = { client: new MemoryClient(), bucket: "private" };
	const keys = {
		encryptionKey: Buffer.alloc(32, 7),
		addressKey: Buffer.alloc(32, 9),
		from: "news@example.test",
		origin: "https://app.example.test",
	};
	const resend = resendRecorder({ VERCEL_ENV: "production" });
	type AudienceInput = { groups?: string[]; teamIds?: string[]; personIds?: string[] };
	async function reviewed(audience: AudienceInput) {
		const saved = ok(
			await writeAs(db, boss.actor, "saveDraft", {
				requestKey: key(),
				input: {
					subject: "Next Sunday",
					bodyHtml: "<p>Hello {{name}}.</p>",
					audience: { groups: [], teamIds: [], personIds: [], ...audience },
				},
			}),
		);
		const scheduled = ok(
			await writeAs(db, boss.actor, "scheduleReviewed", {
				requestKey: key(),
				expectedRevision: saved.revision,
				input: { communicationId: saved.communicationId, scheduledAt: new Date(Date.now() + 7 * DAY).toISOString() },
			}),
		);
		return { communicationId: saved.communicationId, revision: scheduled.revision };
	}
	async function message(audience: AudienceInput) {
		const { communicationId, revision: expectedRevision } = await reviewed(audience);
		ok(
			await communicationWriter.sendReviewed(
				db,
				boss.actor,
				{ requestKey: key(), expectedRevision, input: { communicationId } },
				resend.transport,
				keys,
			),
		);
		return communicationId;
	}
	async function schedule(audience: AudienceInput) {
		const { communicationId, revision: expectedRevision } = await reviewed(audience);
		ok(
			await communicationWriter.handOffScheduled(
				db,
				boss.actor,
				{ requestKey: key(), expectedRevision, input: { communicationId } },
				resend.transport,
				keys,
			),
		);
		return communicationId;
	}
	const audience = async (input: AudienceInput) =>
		ok(await read(communicationWriter.readAudience as never, { groups: [], teamIds: [], personIds: [], ...input })) as {
			recipients: { displayName: string; guardianOf: string[] }[];
			childExclusions: { displayName: string }[];
			guardianRoutes: { displayName: string; guardians: { displayName: string }[] }[];
		};

	const clock = { at: new Date() };
	const tick = scheduledJobs({
		db,
		storage: null,
		cleanup: null,
		effects: null,
		digests: createDigestWorker({ mail, origin: "https://everyfield.test" }),
		mail: null,
		now: () => clock.at,
	});
	async function digests() {
		for (const days of [0, 8]) {
			clock.at = new Date(Date.now() + days * DAY);
			const response = await tick();
			assert.equal(response.status, 200);
		}
		await admin.execute(
			sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state='ready'`,
		);
		for (let claim = (await claimDue(db, ["mail"]))[0]; claim; claim = (await claimDue(db, ["mail"]))[0])
			await mail.dispatch(claim);
	}

	const document = (input: Row) =>
		documentsWriter.generate(
			db,
			boss.actor,
			{ requestKey: key(), format: "pdf", overrides: {}, ...input },
			storage as never,
		);

	async function publish(audienceInput: Parameters<typeof message>[0]) {
		await digests();
		const communicationId = await message(audienceInput);
		const run = await assess();
		const runId = key();
		ok(await requestIntelligenceRefresh(db, director, { runId }));
		return { communicationId, run, networkRunId: runId };
	}

	const SENT: Partial<Record<Frozen, SQL>> = {
		mail: sql`SELECT x::text AS t FROM mail x WHERE x.accepted_at IS NOT NULL`,
		job: sql`SELECT x::text AS t FROM job x WHERE x.kind IN ('mail','digest') AND x.state='succeeded'`,
		notice: sql`SELECT (x.id,x.recipient_id,x.title,x.safe_body,x.purpose,x.category,x.logical_key,x.created_at,
			x.source_record_id,x.source_revision)::text AS t FROM notice x`,
	};
	const stored = async (table: Frozen) =>
		new Set(
			(await rows<{ t: string }>(SENT[table] ?? sql`SELECT x::text AS t FROM ${sql.identifier(table)} x`)).map(
				(r) => r.t,
			),
		);
	let frozenAt = "";
	async function freeze(expected: readonly Frozen[]) {
		frozenAt = (await one<{ t: string }>(sql`SELECT clock_timestamp()::text AS t`)).t;
		const before = new Map<Frozen, Set<string>>();
		for (const table of FROZEN) before.set(table, await stored(table));
		for (const table of expected) assert.ok(before.get(table)!.size > 0, `${table} holds something already sent`);
		const bytes = new Map([...storage.client.objects].map(([k, v]) => [k, Buffer.from(v)]));
		const mails = JSON.stringify(sent);
		const posts = JSON.stringify(resend.requests);
		return async () => {
			for (const table of FROZEN) {
				const now = await stored(table);
				assert.deepEqual(
					[...before.get(table)!].filter((row) => !now.has(row)),
					[],
					`${table} keeps every stored row byte for byte`,
				);
			}
			for (const [k, v] of bytes) assert.ok(storage.client.objects.get(k)?.equals(v), "stored bytes are unchanged");
			assert.equal(JSON.stringify(sent), mails, "no mail is sent again");
			assert.equal(JSON.stringify(resend.requests), posts, "no message is sent again");
		};
	}

	async function check(table: readonly Feature[], when: "before" | "after") {
		for (const f of table) {
			const got = await f.read();
			assert.deepEqual(got, f[when], `${f.name}, ${when} the correction`);
		}
	}
	const auditOf = (where: SQL) =>
		rows<{ actor_id: string; before: Row | null; after: Row | null; reason: string | null; recent: boolean }>(
			sql`SELECT actor_id,before_value AS before,after_value AS after,reason,
				occurred_at BETWEEN ${frozenAt}::timestamptz AND clock_timestamp() AS recent
				FROM audit_event WHERE tenant_id=${p.id} AND ${where} ORDER BY occurred_at,id`,
		);
	return {
		...c,
		org,
		director,
		p: p as ChurchPlant,
		boss,
		sent,
		resend,
		attendance,
		people,
		meeting,
		read,
		revision,
		held,
		evry,
		shown,
		stale,
		factsNow,
		audience,
		schedule,
		keys,
		document,
		documentsReader,
		publish,
		freeze,
		check,
		auditOf,
	};
}
export const sorted = <T,>(list: readonly T[]) =>
	[...list].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export type Feature = { name: string; read: () => Promise<unknown>; before: unknown; after: unknown };
export type World = Awaited<ReturnType<typeof world>>;
