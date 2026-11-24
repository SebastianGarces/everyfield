import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/node_modules/drizzle-orm/index.js";
import { invokeRead } from "../../../../../packages/evry/src/catalog/invoke.ts";
import {
	forPerson,
	getMessage,
	meetingRecipientTracking,
	resendCandidates,
} from "../../../../../packages/evry/src/adapters/communication/reads/index.ts";
import type { ReadAdapter } from "../../../../../packages/evry/src/catalog/types.ts";
import { ACTOR_SPECS, goldenChurch, MEETINGS, PLANT } from "../../../evals/golden-church.mts";

const church = await goldenChurch();
after(church.close);

const CHILD = "marked as a child";
const ROUTED = "sent to a parent or guardian instead";
const AT = "2026-11-08T15:00:00.000Z";
const LATER = "2026-11-13T15:00:00.000Z";
type Mail = {
	state: string;
	refusal?: "unsubscribed" | "child" | "guardian";
	accepted?: true;
	scheduled?: true;
	delivered?: true;
	opened?: true;
	bounced?: true;
	copy?: true;
};
const CASES: readonly (readonly [name: string, mail: Mail, result: string])[] = [
	["Ada Guardian", { state: "sent", accepted: true, delivered: true, copy: true }, "delivered"],
	["Bea Opened", { state: "accepted", accepted: true, delivered: true, opened: true }, "opened"],
	["Cal Sent", { state: "sent", accepted: true }, "sent"],
	["Dee Waiting", { state: "scheduled", scheduled: true }, "waiting"],
	["Eli Checking", { state: "unknown" }, "checking"],
	["Fay Bounced", { state: "accepted", accepted: true, bounced: true }, "bounced"],
	["Gus Cancelled", { state: "cancelled" }, "cancelled"],
	["Hal Failed", { state: "failed" }, "failed"],
	["Ivy Refused", { state: "refused" }, "failed"],
	["Jo Unsubscribed", { state: "refused", refusal: "unsubscribed" }, "unsubscribed"],
	["Kit Child", { state: "refused", refusal: "child" }, CHILD],
	["Lu Child", { state: "refused", refusal: "guardian" }, ROUTED],
];
const EXPECTED = CASES.map(([name, , result]) => [name, result]);
const personIds = new Map(CASES.map(([name]) => [name, randomUUID()]));
const mailIds = new Map(CASES.map(([name]) => [name, randomUUID()]));
const message = randomUUID();

await church.admin
	.execute(sql`INSERT INTO communication(id,plant_id,author_id,revision,state,subject,body_html,body_text,audience,meeting_id,scheduled_at,created_at)
	VALUES(${message},${PLANT},${ACTOR_SPECS.owner.account},2,'scheduled','Family night','<p>Hi</p>','Hi',
		'{"groups":["prospects"],"teamIds":[],"personIds":[]}'::jsonb,${MEETINGS.training},${AT},${AT})`);
for (const [i, [name, m]] of CASES.entries()) {
	const person = personIds.get(name)!;
	const adult = m.refusal === "child" || m.refusal === "guardian" ? "child" : "unknown";
	await church.admin
		.execute(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,email,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${person},${PLANT},${PLANT},${name},${`${name.replace(" ", ".")}@example.test`},'other',${AT},'prospect',${adult},'unknown',${950 + i},'live')`);
	const guardians = m.refusal === "guardian" ? sql`ARRAY[${mailIds.get("Ada Guardian")!}::uuid]` : sql`NULL::uuid[]`;
	await church.admin
		.execute(sql`INSERT INTO mail(id,tenant_id,purpose,communication_id,recipient_person_id,logical_key,payload_hash,audience_hash,
			state,refusal,guardian_mail_ids,guardian_copy,accepted_at,sent_at,scheduled_at,delivered_at,opened_at,bounced_at,created_at)
		VALUES(${mailIds.get(name)!},${PLANT},'communication',${message},${person},${`communication/${message}/${person}`},'seed','seed',
			${m.state},${m.refusal ?? null},${guardians},${m.copy ?? false},${m.accepted ? AT : null}::timestamptz,${m.accepted ? AT : null}::timestamptz,
			${m.scheduled ? LATER : null}::timestamptz,${m.delivered ? AT : null}::timestamptz,${m.opened ? AT : null}::timestamptz,
			${m.bounced ? AT : null}::timestamptz,${AT})`);
}

const read = async (adapter: unknown, input: Record<string, unknown>) =>
	(await invokeRead(church.db, church.actors.owner, adapter as ReadAdapter<unknown>, input)).rows;
const people = (rows: Awaited<ReturnType<typeof read>>) =>
	rows.filter((r) => r.kind === "person").map((r) => [r.label, r.fields.result]);

test("INV-communication-child-result: one email's results name a left-out child and a routed child apart from failed, each counted once, and the adult who got the copy keeps their own delivery", async () => {
	const rows = await read(getMessage, { communicationId: message });
	assert.deepEqual(people(rows), EXPECTED);
	const adult = rows.find((r) => r.label === "Ada Guardian");
	assert.equal(adult?.fields.deliveredAt, "Sun 2026-11-08 09:00");
	const counts = String(rows[0]!.fields.results).split(", ").toSorted();
	assert.deepEqual(
		counts,
		[
			"bounced 1",
			"cancelled 1",
			"checking 1",
			"delivered 1",
			"failed 2",
			`${CHILD} 1`,
			"opened 1",
			"sent 1",
			`${ROUTED} 1`,
			"unsubscribed 1",
			"waiting 1",
		].toSorted(),
	);
});

test("INV-communication-child-result: each person's own emails give the same result", async () => {
	for (const [name, result] of EXPECTED) {
		const rows = await read(forPerson, { personId: personIds.get(name!)! });
		assert.deepEqual(
			rows.filter((r) => r.kind === "message").map((r) => [r.id, r.fields.result]),
			[[message, result]],
			name,
		);
	}
});

test("INV-communication-child-result: the meeting's tracking and the resend candidates give the same results", async () => {
	assert.deepEqual(people(await read(meetingRecipientTracking, { meetingId: MEETINGS.training })), EXPECTED);
	for (const selection of ["delivered_nonopeners", "proven_failed"] as const)
		assert.deepEqual(
			people(await read(resendCandidates, { communicationId: message, selection })),
			EXPECTED,
			selection,
		);
});
