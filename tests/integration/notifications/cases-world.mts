import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { owner } from "../../../packages/contracts/src/common/index.ts";
import { sql } from "../../../packages/db/src/query.ts";
import type { WriteTx } from "../../../packages/domain/src/access/session.ts";
import { authorizeDigestMail, createDigestWorker } from "../../../packages/domain/src/jobs/digest.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type AuthorizeMail,
	type MailPayload,
} from "../../../packages/domain/src/jobs/mail.ts";
import { authorizeNoticeMail, authorizeNotificationMail } from "../../../packages/domain/src/jobs/notice-mail.ts";
import { seatedNotificationService } from "../../../packages/domain/src/jobs/seated-notifications.ts";
import { enqueueJob } from "../../../packages/domain/src/jobs/queue.ts";
import {
	meetingsWriter,
	withMeetingsWrite,
	type MeetingsContext,
} from "../../../packages/domain/src/meetings/index.ts";
import { createNotificationProducer } from "../../../packages/domain/src/notifications/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import { timezoneOperations } from "../../../packages/domain/src/settings/index.ts";
import { authorizePhaseNotices } from "../../../packages/domain/src/phases/index.ts";
import { authorizeTaskReminders, createTaskWriter } from "../../../packages/domain/src/tasks/index.ts";
import { createNotificationWorker } from "../../../apps/web/src/features/notifications/worker.ts";
import { taskReminders } from "../../../apps/web/src/features/tasks/reminders.ts";
import { scheduledJobs } from "../../../apps/web/src/server/jobs/scheduled.ts";
import { ok, seeds } from "../../support/fixture.mts";
import { clockedWorld, type Who } from "../tasks/world.mts";

type Json = ReturnType<typeof JSON.parse>;
type Step = {
	given: Record<string, Json>;
	clock: { now: string; zone: string };
	action: { operation: string; arguments: Record<string, Json> };
	expected: { result: Record<string, Json>; event: null };
};
export type Case = Step & { id: string; subcases?: (Step & { name: string })[] };
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: Case[] };
export const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);
export const iso = (instant: string) => new Date(instant).toISOString();
export const day = (date: string) => ({ kind: "local_date", date });
export const command = (input: object, expectedRevision = "1", requestKey: string = randomUUID()) => ({
	requestKey,
	expectedRevision,
	input,
});

export async function casesWorld(prefix: string, start: string) {
	const w = await clockedWorld(prefix, start);
	const { db, admin, rows } = w;
	const outbox: MailPayload[] = [];
	const config = {
		db,
		encryptionKey: randomBytes(32),
		addressKey: randomBytes(32),
		from: "cases@example.test",
		transport: {
			async send(payload) {
				outbox.push(payload);
				return { kind: "accepted", id: randomUUID() };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	} satisfies Omit<Parameters<typeof createMailService>[0], "authorize">;
	const mailFor = (authorize: AuthorizeMail) => createMailService({ ...config, authorize });
	const mail = mailFor(authorizeNoticeMail);
	const mails = {
		tasks: mailFor(authorizeTaskReminders),
		phases: mailFor(authorizePhaseNotices),
		notifications: mailFor(authorizeNotificationMail),
		digests: mailFor(authorizeDigestMail),
	};
	const pass = (name: "notice" | "digest") => (limit: number, until: number) =>
		runDueMail(db, name === "digest" ? mails.digests : mail, MAIL_PASSES[name], limit, until);
	const worker = createNotificationWorker({ mail: mails.notifications });
	const run = scheduledJobs({
		db,
		storage: null,
		cleanup: null,
		effects: null,
		mail: null,
		digests: createDigestWorker({ mail: mails.digests, origin: "https://everyfield.test" }),
		notifications: worker,
		mountMail: { notice: pass("notice"), digest: pass("digest") },
		now: () => new Date(),
	});
	async function tick(at?: string) {
		if (at) await w.at(at);
		const response = await run();
		const body = await response.json();
		assert.equal(response.status, 200, JSON.stringify(body));
	}
	const writer = createTaskWriter({ reminders: taskReminders(seatedNotificationService(mails.tasks)) });
	const task = async (who: Who, input: object) =>
		ok(await w.write(who, "create", { requestKey: randomUUID(), input: { title: "Task", ...input } }, writer)).task;
	const change = async (
		who: Who,
		op: "edit" | "complete" | "changeStatus",
		t: { id: string; revision: string },
		input: object = {},
	) => ok(await w.write(who, op, command({ taskId: t.id, ...input }, t.revision), writer)).task;
	const meetings = <R,>(op: (tx: WriteTx, context: MeetingsContext, raw: unknown) => Promise<R>, raw: object) =>
		withMeetingsWrite(db, w.adminActor.actor, (tx, ctx) => op(tx, ctx, raw) as never) as Promise<R>;
	const schedule = async (input: object) =>
		ok(await meetings(meetingsWriter.schedule, { requestKey: randomUUID(), input: { type: "orientation", ...input } }))
			.meeting;
	async function person(name: string, fields: { account?: string; email?: string } = {}) {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,source,stage,adult_classification,
			commitment_state,pipeline_position,state,created_at,linked_account_id,email) VALUES(${id},${w.plant.id},${w.plant.id},
			${name},'other','prospect','adult','unknown',0,'live',clock_timestamp(),${fields.account ?? null},${fields.email ?? null})`);
		return id;
	}
	const zones = timezoneOperations({
		replan: (tx, i) =>
			enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "digest",
				subject: i.owner.id,
				key: `settings/${i.kind}/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			}),
	});
	const plant = owner.parse(w.plant) as Extract<ReturnType<typeof owner.parse>, { kind: "plant" }>;
	const context = { session: w.adminActor.session, selected: plant };
	const previewZone = async (timeZone: string) =>
		ok(await gatedTransaction(db, (tx) => zones.previewPlantTimezone(tx, context, { plant, timeZone } as never)));
	const setZone = async (request: ReturnType<typeof command>) =>
		gatedTransaction(db, (tx) => zones.setPlantTimezone(tx, context, request as never));
	const feed = createNotificationProducer({ optOutKey: randomBytes(32), now: () => new Date() });
	const one = async (query: ReturnType<typeof sql>) =>
		(await rows(query))[0] ?? assert.fail("the query returned no row");
	const count = async (query: ReturnType<typeof sql>) => Number((await one(query)).n);
	const revisionOf = async (account: string) =>
		String((await one(sql`SELECT revision::text AS r FROM account WHERE id=${account}`)).r);
	return {
		...w,
		newPlant: seeds(admin).plant,
		plant,
		mail,
		mails,
		outbox,
		worker,
		tick,
		task,
		change,
		meetings,
		schedule,
		person,
		previewZone,
		setZone,
		feed,
		meetingRead: <R,>(
			op: (executor: typeof db, actor: typeof w.adminActor.actor, raw: unknown) => Promise<R>,
			input: object,
		) => op(db, w.adminActor.actor, input),
		one,
		count,
		revisionOf,
		async organization(kind: "sending_church" | "sending_network", name: string) {
			return (await w.organization(kind, { name, timezone: "America/Chicago" })) as Extract<
				ReturnType<typeof owner.parse>,
				{ kind: "organization" }
			>;
		},
		async affiliate(plantId: string, organizationId: string, activity = false) {
			const id = randomUUID();
			await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,
				share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
				VALUES(${id},${plantId},${organizationId},clock_timestamp(),false,false,false,false,false,${activity},false)`);
			return id;
		},
	};
}
export type CasesWorld = Awaited<ReturnType<typeof casesWorld>>;
