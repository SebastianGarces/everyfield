import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { claimUnknownMail, MAIL_PASSES, runDueMail } from "../../../packages/domain/src/jobs/mail.ts";
import { applyMailCallback } from "../../../packages/domain/src/jobs/webhook.ts";
import { ok } from "../../support/fixture.mts";
import { untouched } from "../../support/recorded.mts";
import { clockedWorld } from "./world.mts";

type Case = {
	id: string;
	given: { execution: { logical_key: string; prior_outcomes: string[]; repeat: number } };
	clock: { now: string };
	expected: { result: { logical_intents: number; unknown_blind_resends: number } };
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: Case[] };
const c = cases.find((x) => x.id === "B03-011") ?? assert.fail("no B03-011");
const { prior_outcomes: outcomes, repeat, logical_key: logical } = c.given.execution;

let w: Awaited<ReturnType<typeof clockedWorld>>;
afterEach(() => w?.close());

const DUE = "2026-10-13T14:00:00Z";
const pass = () => runDueMail(w.db, w.mail, MAIL_PASSES.notice, 50, Infinity);
const mailsOf = (task: string, kind: string) =>
	w.rows<{
		id: string;
		state: string;
		notice: string;
		provider: string | null;
		delivered: boolean;
		requests: number;
	}>(
		sql`SELECT m.id, m.state, n.id AS notice, m.provider_message_id AS provider, m.delivered_at IS NOT NULL AS delivered,
			(SELECT count(*)::int FROM mail_request_member mem WHERE mem.mail_id=m.id) AS requests
			FROM notice n JOIN mail m ON m.notice_id=n.id
			WHERE n.source_record_id=${task} AND split_part(n.logical_key,'/',2)=${kind} ORDER BY n.created_at, n.id`,
	);
const delivered = (messageId: string) =>
	applyMailCallback(
		w.db,
		Buffer.from(JSON.stringify({ type: "email.delivered", created_at: DUE, data: { email_id: messageId } })),
		randomUUID(),
	);

for (const outcome of [...outcomes, "unknown, retried first"])
	test(`AC:B03-011 ${outcome}: rescheduling or retrying after a reminder went out moves later reminders but never makes or sends a second one for that person and slot, and an unknown one is never sent blind`, async () => {
		assert.deepEqual(
			[logical.split(":").slice(2), outcomes, repeat],
			[["2026-10-13", "A"], ["accepted", "unknown", "delivered"], 2],
		);
		w = await clockedWorld("reminder_cases", "2026-10-12T16:00:00Z");
		const t = await w.create(w.owner, {
			title: outcome,
			assigneeIds: [w.adminActor.id],
			due: { kind: "local_date", date: "2026-10-13" },
		});
		assert.deepEqual(
			(await w.reminders(t.id)).map((n) => [n[1], n[2]]),
			[
				["task_due", DUE],
				["task_overdue", "2026-10-14T14:00:00Z"],
			],
		);
		await w.at("2026-10-13T14:01:00Z");
		const unknown = outcome.startsWith("unknown");
		w.provider.answer = () => (unknown ? { kind: "unknown" } : { kind: "accepted", id: randomUUID() });
		const start = w.sent.length;
		assert.equal(await pass(), 1, outcome);
		const [first, ...more] = await mailsOf(t.id, "task_due");
		assert.deepEqual([first!.state, more.length, w.sent.length - start], [unknown ? "unknown" : "accepted", 0, 1]);
		const key = w.provider.keys.at(-1);
		const bytes = w.sent.at(-1);
		if (outcome === "delivered")
			assert.deepEqual(await delivered(first!.provider!), { stored: true, result: "applied" });

		await w.at(c.clock.now);
		let allowed = 1;
		if (outcome === "unknown, retried first") {
			for (let n = 0; n < repeat; n++) {
				await w.admin.execute(
					sql`UPDATE job SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE subject_record_id=${first!.id}`,
				);
				await pass();
			}
			allowed = 4;
			assert.deepEqual(
				[w.provider.keys.slice(start), w.sent.slice(start)],
				[Array(allowed).fill(key), Array(allowed).fill(bytes)],
				"retries inside the provider window repeat one request, at most four tries in all",
			);
		}
		let task = t;
		const dates = ["2026-10-15", "2026-10-16"];
		for (let n = 0; n < repeat; n++) {
			task = ok(
				await w.command(w.adminActor, "edit", task, {
					patch: { due: { kind: "local_date", date: dates[n]! } },
				}),
			).task;
			assert.deepEqual(
				(await w.live(t.id)).filter((r) => r[1] === "task_overdue").map((r) => r[2]),
				[`2026-10-${16 + n}T14:00:00Z`],
				"the later reminder moves",
			);
			const due = await mailsOf(t.id, "task_due");
			assert.deepEqual(
				[due.length, due[0]!.id, due[0]!.requests],
				[c.expected.result.logical_intents, first!.id, 1],
				"one reminder for this person and slot",
			);
			const before = due[0]!;
			await untouched(w.admin, async () => {
				assert.deepEqual(await w.mail.reconcileUnknownOutcome(first!.id), { kind: "unknown" });
			});
			await w.admin.execute(
				sql`UPDATE job SET next_attempt_at=NULL WHERE subject_record_id=${first!.id} AND state='reconcile'`,
			);
			await pass();
			const [claimed] = await claimUnknownMail(w.db, MAIL_PASSES.notice);
			if (claimed) assert.deepEqual(await w.mail.dispatch(claimed), { kind: "not_dispatched" });
			assert.deepEqual(
				w.sent.length - start - allowed,
				c.expected.result.unknown_blind_resends,
				`${outcome}: nothing is sent again`,
			);
			assert.deepEqual((await mailsOf(t.id, "task_due"))[0], before, "its outcome stays as it was");
		}
		const [last] = await mailsOf(t.id, "task_due");
		assert.deepEqual(
			[last!.state, last!.delivered],
			[unknown ? "unknown" : outcome === "delivered" ? "sent" : "accepted", outcome === "delivered"],
		);
		w.provider.answer = () => ({ kind: "accepted", id: randomUUID() });
		await w.at("2026-10-15T14:01:00Z");
		await pass();
		await w.at("2026-10-16T13:59:00Z");
		await pass();
		assert.equal(w.sent.length - start, allowed, "the new due day brings no second due reminder");
	});
