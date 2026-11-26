import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mock } from "node:test";
import { sql, type SQL } from "../../../packages/db/src/query.ts";
import { tenantId } from "../../../packages/contracts/src/common/index.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import {
	authorizeTaskReminders,
	createTaskWriter,
	reminderRecipients,
	type TaskContext,
	type TaskReply,
	type TaskWriter,
	taskReader,
	withTaskWrite,
} from "../../../packages/domain/src/tasks/index.ts";
import { createMailService, type MailPayload, type TransportOutcome } from "../../../packages/domain/src/jobs/mail.ts";
import { createNotificationService } from "../../../packages/domain/src/jobs/notifications.ts";
import { claimDue } from "../../../packages/domain/src/jobs/queue.ts";
import { taskReminders } from "../../../apps/web/src/features/tasks/reminders.ts";
import { type Actor, fixture, ok, type Workspace } from "../../support/fixture.mts";
import { pinSchemaClock } from "../../support/test-database.mts";

export type Who = { actor: RequestActor };
type Row = Record<string, unknown>;
type Answer<F> = F extends (...args: never[]) => Promise<infer V> ? V : never;
type Value<F> = F extends (...args: never[]) => Promise<TaskReply<infer V>> ? V : never;
type Writes = {
	[K in keyof TaskWriter]: (
		tx: WriteTx,
		context: TaskContext,
		raw: unknown,
	) => Promise<TaskReply<Value<TaskWriter[K]>>>;
};
type Reader = typeof taskReader;
type Reads = {
	[K in keyof Reader]: (tx: WriteTx, who: RequestActor, raw: unknown) => Promise<Answer<Reader[K]>>;
};

export const rejectsWithFault = (attempt: Promise<unknown>) =>
	assert.rejects(attempt, (e: Error) => /injected fault/.test(String(e.cause ?? e)));

export async function clockedWorld(prefix: string, start: string) {
	const database = await fixture({ prefix, max: 8, clock: new Date(start) });
	mock.timers.enable({ apis: ["Date"], now: Date.parse(start) });
	const db = database.pools.runtime,
		{ admin } = database;
	const rows = async <R extends Row = Row>(q: SQL) => (await admin.execute<R>(q)).rows;
	await admin.execute(sql`UPDATE auth_session SET expires_at='2026-11-12T16:00:00Z'`);
	const sent: MailPayload[] = [];
	const provider = {
		keys: [] as string[],
		answer: (): TransportOutcome => ({ kind: "accepted", id: randomUUID() }),
	};
	const mail = createMailService({
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "tasks@example.test",
		authorize: authorizeTaskReminders,
		transport: {
			async send(payload, key) {
				sent.push(payload);
				provider.keys.push(key);
				return provider.answer();
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
				inputs[0]?.owner.id ?? randomUUID(),
				inputs.map((i) => i.recipient),
			);
			return inputs.map((i) => {
				const address = found.get(i.recipient);
				return address === undefined ? null : { address };
			});
		},
	});
	const writer: Writes = createTaskWriter({ reminders: taskReminders(notifications) });
	const reads: Reads = taskReader;
	async function resolve(a: Actor) {
		const actor = await gatedTransaction(db, (tx) => RequestActor.resolve(tx, a.session));
		assert.ok(actor instanceof RequestActor);
		return { ...a, actor };
	}
	const write = <K extends keyof Writes>(who: Who, op: K, input: object, w: Writes = writer) =>
		withTaskWrite(db, who.actor, (tx, ctx) => w[op](tx, ctx, input));
	const read = <K extends keyof Reads>(who: Who, op: K, input: object | undefined) =>
		gatedTransaction(db, (tx) => reads[op](tx, who.actor, input));
	const command = <K extends keyof Writes>(who: Who, op: K, t: { id: string; revision: string }, input: object = {}) =>
		write(who, op, {
			requestKey: randomUUID(),
			expectedRevision: t.revision,
			input: { taskId: t.id, ...input },
		});
	const create = async (who: Who, input: object) =>
		ok(await write(who, "create", { requestKey: randomUUID(), input: { title: "Task", ...input } })).task;
	async function at(instant: string, clock: "running" | "stopped" = "running") {
		await pinSchemaClock(admin, database.schema, new Date(instant), clock);
		mock.timers.setTime(Date.parse(instant));
	}
	const claim = () => claimDue(db, ["mail"], 100);
	async function dispatch(claims?: Awaited<ReturnType<typeof claim>>) {
		for (const c of claims ?? (await claim())) await mail.dispatch(c);
	}
	const reminders = async (task: string) =>
		(
			await rows<{ to: string; kind: string; at: string; cancelled: boolean; mail: string | null }>(
				sql`SELECT n.recipient_id AS to, split_part(n.logical_key,'/',2) AS kind, n.cancelled_at IS NOT NULL AS cancelled,
					to_char(n.eligible_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at, m.state AS mail
				FROM notice n LEFT JOIN mail m ON m.notice_id=n.id WHERE n.source_record_id=${task}
				ORDER BY n.cancelled_at IS NOT NULL, n.eligible_at, n.recipient_id, n.logical_key`,
			)
		).map((n) => [n.to, n.kind, n.at, n.cancelled ? `${n.mail} (withdrawn)` : n.mail]);
	const live = async (task: string) => (await reminders(task)).filter((n) => !String(n[3]).endsWith("(withdrawn)"));
	return {
		...database,
		db,
		admin,
		plant: { kind: "plant" as const, id: tenantId.parse(database.tenant.id) },
		owner: await resolve(database.actors.owner),
		adminActor: await resolve(database.actors.admin),
		member: await resolve(database.actors.member),
		plantOf: () => database.plant(),
		async seated(workspace: Workspace, role: "owner" | "admin" | "member") {
			const a = await database.actor(workspace, role);
			await admin.execute(sql`UPDATE auth_session SET expires_at='2026-11-12T16:00:00Z' WHERE id=${a.session}`);
			return resolve(a);
		},
		sent,
		provider,
		mail,
		rows,
		write,
		read,
		command,
		create,
		at,
		claim,
		dispatch,
		reminders,
		live,
		async close() {
			mock.timers.reset();
			await database.close();
		},
	};
}
