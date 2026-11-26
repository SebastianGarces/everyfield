import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { transaction } from "../../../packages/domain/src/jobs/transaction.ts";
import { createMailService, MAIL_PASSES, runDueMail } from "../../../packages/domain/src/jobs/mail.ts";
import { authorizeNotificationMail } from "../../../packages/domain/src/jobs/notice-mail.ts";
import { checkpoint, claimDue, finishClaim, finishJob, recoverLease } from "../../../packages/domain/src/jobs/queue.ts";
import { createNotificationWorker } from "../../../apps/web/src/features/notifications/worker.ts";
import { meetingsWorld, type MeetingsWorld } from "./meetings-world.mts";

type Case = {
	id: string;
	clock: { now: string };
	action: { arguments: { limit: number } };
	expected: {
		result: {
			old_generation_finalization: boolean;
			duplicate_sends: number;
			obsolete_reminder_status: string;
			accepted_result_fabricated: boolean;
		};
	};
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "CASE-NTF-002") ?? assert.fail("no CASE-NTF-002");

let w: MeetingsWorld;
before(async () => {
	w = await meetingsWorld("reminder_cases", new Date(c.clock.now));
});
after(() => w?.close());

test("AC:CASE-NTF-002 two ticks claim each reminder once, a worker whose lease ends after the email service took it can save nothing, and a cancelled meeting's reminders stop with the taken one left unknown", async () => {
	const guest = await w.person("Grace Guest", { account: w.actors.member.id });
	const m = await w.schedule({ date: "2026-10-23", guests: [guest] });
	const effects = new Map<string, string>();
	const calls: string[] = [];
	const taking = { reached: Promise.withResolvers<void>(), answer: Promise.withResolvers<void>() };
	const mail = createMailService({
		db: w.db,
		encryptionKey: Buffer.alloc(32, 3),
		addressKey: Buffer.alloc(32, 4),
		from: "meetings@example.test",
		authorize: authorizeNotificationMail,
		transport: {
			async send(payload, key) {
				calls.push(key);
				effects.set(key, payload.to);
				taking.reached.resolve();
				await taking.answer.promise;
				return { kind: "accepted", id: "prov-" + key };
			},
			async lookup() {
				return { kind: "unknown" };
			},
		},
	});
	const due = (at: string) =>
		w.admin.execute(sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second'
			WHERE kind='notification' AND subject_record_id=${m.id} AND state='ready' AND eligible_at<=${at}::timestamptz`);
	await due("2026-10-20T15:00:00Z");
	const worker = createNotificationWorker({ mail });
	const [one, two] = await Promise.all([
		worker.run(w.db, "2026-10-20T15:00:00Z"),
		worker.run(w.db, "2026-10-20T15:00:00Z"),
	]);
	assert.equal(one + two, 2, "two ticks handle the announcement and the one current reminder once between them");
	const reminders = () =>
		w.rows<{
			recipient: string;
			state: string;
			provider: string | null;
			accepted: Date | null;
			withdrawn: boolean;
			job: string;
		}>(
			sql`SELECT n.recipient_id AS recipient, m.state, m.provider_message_id AS provider, m.accepted_at AS accepted,
				n.cancelled_at IS NOT NULL AS withdrawn, j.state AS job FROM notice n JOIN mail m ON m.notice_id=n.id
				JOIN job j ON j.id=m.job_id WHERE n.source_record_id=${m.id} ORDER BY n.recipient_id=${w.actors.member.id} DESC`,
		);
	assert.deepEqual(
		(await reminders()).map((r) => [r.recipient, r.state]),
		[
			[w.actors.member.id, "pending"],
			[w.actors.admin.id, "pending"],
		],
	);
	await w.admin
		.execute(sql`UPDATE job j SET eligible_at=clock_timestamp()-interval '1 second' FROM mail x JOIN notice n ON n.id=x.notice_id
		WHERE j.subject_record_id=x.id AND n.source_record_id=${m.id}`);
	const { limit } = c.action.arguments;
	const groups = await Promise.all([claimDue(w.db, ["mail"], limit), claimDue(w.db, ["mail"], limit)]);
	const claims = groups.flat();
	assert.deepEqual([claims.length, new Set(claims.map((x) => x.id)).size], [2, 2], "each due reminder has one owner");
	const taken = await w.one<{ id: string }>(sql`SELECT x.id FROM mail x JOIN notice n ON n.id=x.notice_id
		WHERE n.source_record_id=${m.id} AND n.recipient_id=${w.actors.member.id}`);
	const stale = claims.find((x) => x.subject_record_id === taken.id)!;
	const waiting = claims.find((x) => x.subject_record_id !== taken.id)!;

	const dispatched = mail.dispatch(stale);
	await taking.reached.promise;
	await w.admin.execute(sql`UPDATE job SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${stale.id}`);
	assert.equal(await recoverLease(w.db), 1);
	await w.status(m.id, "cancelled");
	taking.answer.resolve();
	assert.deepEqual(await dispatched, { kind: "unknown" }, "the old worker's answer is not saved");
	const sent = calls.length;
	assert.deepEqual([sent, effects.size], [1, 1]);
	const [member] = await reminders();
	assert.deepEqual(
		[member!.state, member!.provider, member!.accepted, member!.job],
		["unknown", null, null, "reconcile"],
	);

	const { value, added, tables } = await w.changes(async () => [
		await transaction(w.db, (tx) => finishClaim(tx, stale, { state: "succeeded" })),
		await finishJob(w.db, stale, { state: "succeeded" }),
		await transaction(w.db, (tx) => checkpoint(tx, stale, "external")),
		(await mail.dispatch(stale)).kind !== "not_dispatched",
	]);
	assert.deepEqual(value, Array(4).fill(c.expected.result.old_generation_finalization));
	assert.deepEqual([added, tables], [{ audits: [], jobs: [], notices: 0, mail: 0 }, []], "nothing is written");

	assert.deepEqual(await mail.dispatch(waiting), { kind: "not_dispatched" });
	await due("2026-10-24T00:00:00Z");
	await worker.run(w.db, "2026-10-22T15:00:00Z");
	await w.admin.execute(sql`UPDATE job SET next_attempt_at=NULL WHERE subject_record_id=${taken.id}`);
	await runDueMail(w.db, mail, MAIL_PASSES.notice, 50, Infinity);
	assert.equal(calls.length - sent, c.expected.result.duplicate_sends);
	const [kept, obsolete] = await reminders();
	assert.deepEqual(
		[obsolete!.state, obsolete!.job],
		[c.expected.result.obsolete_reminder_status, c.expected.result.obsolete_reminder_status],
	);
	assert.deepEqual(
		(
			await w.rows(sql`SELECT DISTINCT state FROM job WHERE kind='notification' AND subject_record_id=${m.id}
				AND split_part(producer_key,'/',2)='day_1'`)
		).map((r) => r.state),
		["superseded"],
		"the reminder not yet due is withdrawn too",
	);
	assert.equal(
		kept!.state !== "unknown" || kept!.accepted !== null || kept!.provider !== null,
		c.expected.result.accepted_result_fabricated,
	);
	assert.equal(
		await w.count(sql`SELECT count(*)::int AS n FROM audit_event a WHERE a.subject_id=${taken.id}`),
		0,
		"no outcome is recorded for the taken reminder",
	);
	assert.equal(await w.count(sql`SELECT count(*)::int AS n FROM notice WHERE source_record_id=${m.id}`), 2);
});
