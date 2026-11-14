import * as C from "@everyfield/contracts/organizations";
import type { Database } from "@everyfield/db/client";
import { sql } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { reviewShared } from "../access/pipeline.ts";
import type { RequestActor } from "../access/session.ts";
import { eligibleSeat } from "./pipeline.ts";
import { answer, one, parse, refuse, seatOf, write, type Executor } from "./seat.ts";

// Kept answers sent for review (T-385, D-1507, D-1509, D-1511). An Owner or Admin sends some questions of a pipeline
// import's kept-answers note, under a group name, to a current seat of the same organization. The send holds the
// question titles only; its reviewer reads the note's live answers to them while the send is shared (reviewShared) and
// reads nothing else of the person. Each write runs the established way with a body-free audit row (ids, actor and
// change kind); the send also queues the reviewer's notification job, keyed `review/<send>`, in the same statement.

/**
 * Each kept question's answer in a kept-answers note body, as the import wrote it ("Answers from …", then each question
 * title on its own line after a blank line, with its answer below) and as its author may have edited it since. A
 * question whose title line the note no longer holds, or whose answer is now empty, has none.
 */
export function keptAnswers(body: string, questions: readonly string[]): Map<string, string> {
	const titles = new Set(questions);
	const lines = body.split("\n");
	const answers = new Map<string, string>();
	let current: string | null = null;
	let text: string[] = [];
	const close = () => {
		const value = text.join("\n").trim();
		if (current !== null && value && !answers.has(current)) answers.set(current, value);
	};
	lines.forEach((line, i) => {
		if (titles.has(line.trim()) && (i === 0 || lines[i - 1]!.trim() === "")) {
			close();
			current = line.trim();
			text = [];
		} else if (current !== null) text.push(line);
	});
	close();
	return answers;
}

const prior = z.object({
	note: z.string().nullable(),
	seat: z.string(),
	group: z.string(),
	questions: z.array(z.string()),
});

/**
 * Sends the chosen questions of a kept-answers note to a current seat of the organization, under a group name. The
 * note must be live with kept answers that hold every chosen question, on a live pipeline person. The browser names the
 * send's ID: a repeat of the same send answers as the first did and writes nothing, and the same ID for another send
 * is a conflict. Owner or Admin.
 */
async function sendAnswers(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.sendAnswersRequest, raw);
		const o = w.organization;
		const questions = sql.param(input.questions);
		const r = await one(
			w,
			z.object({
				found: z.boolean(),
				questions: z.boolean(),
				seat: z.boolean(),
				added: z.boolean(),
				prior: prior.nullable(),
			}),
			sql`WITH n AS (SELECT n.id,n.person_id,n.questions FROM person_note n
 JOIN person p ON p.id=n.person_id AND p.tenant_id=n.tenant_id
 JOIN pipeline_person pp ON pp.person_id=p.id AND pp.organization_id=n.tenant_id
 WHERE n.id=${input.noteId}::uuid AND n.tenant_id=${o}::uuid AND n.plant_id IS NULL AND n.removed_at IS NULL
  AND n.questions IS NOT NULL AND p.state='live'
  AND NOT EXISTS(SELECT FROM organization_person_removal x WHERE x.person_record_id=p.id AND x.organization_id=p.tenant_id)),
q AS (SELECT n.* FROM n WHERE ${questions}::text[] <@ n.questions),
ok AS (SELECT q.* FROM q WHERE ${eligibleSeat(w, input.reviewerSeatId)}),
r AS (INSERT INTO answer_review (id,organization_id,person_id,note_id,reviewer_seat_id,sender_id,group_name,questions,sent_at,revision)
 SELECT ${input.reviewId}::uuid,${o}::uuid,ok.person_id,ok.id,${input.reviewerSeatId}::uuid,${w.actor}::uuid,${input.groupName},
  ARRAY(SELECT u.q FROM unnest(ok.questions) WITH ORDINALITY u(q,i) WHERE u.q=ANY(${questions}::text[]) ORDER BY u.i),
  clock_timestamp(),1 FROM ok ON CONFLICT (id) DO NOTHING RETURNING id,person_id),
a AS (${w.audit({ action: "people.updated", kind: "create", subject: sql`r.person_id`, after: sql`1`, metadata: { category: "answer_review", reviewId: input.reviewId } })}
 FROM r RETURNING id),
j AS (INSERT INTO job (tenant_id,kind,subject_record_id,producer_key,source_revision,state,eligible_at,attempt_count,max_attempts,
  claim_generation)
 SELECT ${o}::uuid,'notification',r.id,'review/'||r.id::text,1,'ready',clock_timestamp(),0,4,0 FROM r
 ON CONFLICT (kind,subject_record_id,producer_key) DO NOTHING RETURNING id)
SELECT EXISTS(SELECT FROM n) AS found,EXISTS(SELECT FROM q) AS questions,${eligibleSeat(w, input.reviewerSeatId)} AS seat,EXISTS(SELECT FROM a) AND EXISTS(SELECT FROM j) AS added,
 (SELECT jsonb_build_object('note',x.note_id,'seat',x.reviewer_seat_id,'group',x.group_name,'questions',x.questions)
  FROM answer_review x WHERE x.id=${input.reviewId}::uuid AND x.organization_id=${o}::uuid) AS prior`,
		);
		if (r.prior) {
			const same =
				r.prior.note === input.noteId &&
				r.prior.seat === input.reviewerSeatId &&
				r.prior.group === input.groupName &&
				[...r.prior.questions].sort().join("\n") === [...input.questions].sort().join("\n");
			if (!same) refuse({ code: "conflict" });
			return { reviewId: input.reviewId };
		}
		if (!r.found) refuse();
		if (!r.questions) refuse({ code: "invalid_input", field: "questions" });
		if (!r.seat) refuse({ code: "invalid_input", field: "reviewerSeatId" });
		if (!r.added) refuse({ code: "conflict" });
		return { reviewId: input.reviewId };
	});
}

/**
 * Withdraws a send: its reviewer no longer reads it, and their notice and its email stop. A repeat changes nothing.
 * Owner or Admin.
 */
async function withdrawReview(db: Database, authority: RequestActor, raw: unknown) {
	return write(db, authority, true, async (w) => {
		const input = parse(C.withdrawReviewRequest, raw);
		const r = await one(
			w,
			z.object({ found: z.boolean() }),
			sql`WITH x AS (SELECT r.id,r.withdrawn_at FROM answer_review r WHERE r.id=${input.reviewId}::uuid
 AND r.organization_id=${w.organization}::uuid FOR UPDATE),
u AS (UPDATE answer_review t SET withdrawn_at=clock_timestamp(),revision=t.revision+1 FROM x
 WHERE t.id=x.id AND x.withdrawn_at IS NULL RETURNING t.person_id,t.revision),
a AS (${w.audit({ action: "people.updated", kind: "remove", subject: sql`u.person_id`, before: sql`u.revision-1`, after: sql`u.revision`, metadata: { category: "answer_review", reviewId: input.reviewId } })}
 FROM u RETURNING id)
SELECT EXISTS(SELECT FROM x) AS found,(SELECT count(*) FROM a) AS audited`,
		);
		if (!r.found) refuse();
		return { reviewId: input.reviewId };
	});
}

export const reviewWriter = { sendAnswers, withdrawReview };

/** The sends to the viewer's account in this organization, newest first, under `r`, with its person `p`. */
const mine = (organization: string, accountId: string) => sql`answer_review r
 JOIN seat s ON s.id=r.reviewer_seat_id AND s.organization_id=r.organization_id
 JOIN person p ON p.id=r.person_id AND p.tenant_id=r.organization_id
 WHERE r.organization_id=${organization}::uuid AND s.account_id=${accountId}::uuid`;
const sendColumns = (seatId: string) => sql`r.id,p.display_name AS person,r.group_name,
 (SELECT i.display_name FROM seat_identity(r.sender_id) i) AS sender,(r.sent_at AT TIME ZONE o.timezone)::date::text AS sent_on,
 (${reviewShared} AND r.reviewer_seat_id=${seatId}::uuid) AS shared`;
const sendRow = z.object({
	id: z.string(),
	person: z.string(),
	group_name: z.string(),
	sender: z.string().nullable(),
	sent_on: z.string(),
	shared: z.boolean(),
});
const sendOf = (s: z.infer<typeof sendRow>) => ({
	id: s.id,
	person: s.person,
	groupName: s.group_name,
	sender: s.sender,
	sentOn: s.sent_on,
});

/**
 * The viewer's Sent for review page: every send to them in this organization, newest first, with the person, group
 * name, sender and day. A send is shared only while reviewShared holds for the seat the viewer holds now. Any current
 * seat. One statement.
 */
export async function readAnswerReviews(db: Executor, authority: RequestActor) {
	return answer(async () => {
		const seat = seatOf(authority) ?? refuse();
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed),
o AS (SELECT o.timezone FROM organization o JOIN g ON g.allowed WHERE o.id=${seat.organization}::uuid)
SELECT g.allowed,coalesce((SELECT jsonb_agg(x ORDER BY x.at DESC,x.id DESC) FROM (
 SELECT ${sendColumns(seat.seatId)},r.sent_at AS at FROM o CROSS JOIN ${mine(seat.organization, seat.accountId)}
 ORDER BY r.sent_at DESC,r.id DESC LIMIT 200) x),'[]'::jsonb) AS items FROM g`);
		const row = z.object({ allowed: z.boolean(), items: z.array(sendRow) }).parse(r.rows[0]);
		if (!row.allowed) refuse();
		return C.reviewList.parse({ items: row.items.map((s) => ({ ...sendOf(s), shared: s.shared })) });
	});
}

/**
 * One send as its reviewer opens it: the chosen questions in the note's order with the note's current answers, or
 * null for a question the note no longer holds. Not shared: the send without any question. Anyone but the send's
 * reviewer gets `unavailable`, as for a send that does not exist. One statement.
 */
export async function readAnswerReview(db: Executor, authority: RequestActor, raw: unknown) {
	return answer(async () => {
		const seat = seatOf(authority) ?? refuse();
		const { reviewId } = parse(z.strictObject({ reviewId: z.uuid() }), raw);
		const r = await db.execute(sql`WITH g AS (SELECT ${seat.live} AS allowed),
o AS (SELECT o.timezone FROM organization o JOIN g ON g.allowed WHERE o.id=${seat.organization}::uuid),
x AS (SELECT ${sendColumns(seat.seatId)},r.questions,r.note_id FROM o CROSS JOIN ${mine(seat.organization, seat.accountId)}
 AND r.id=${reviewId}::uuid)
SELECT g.allowed,(SELECT to_jsonb(x) FROM x) AS send,
 (SELECT jsonb_build_object('body',n.body,'questions',n.questions) FROM x JOIN person_note n ON n.id=x.note_id
  AND n.tenant_id=${seat.organization}::uuid WHERE x.shared) AS note FROM g`);
		const row = z
			.object({
				allowed: z.boolean(),
				send: sendRow.extend({ questions: z.array(z.string()) }).nullable(),
				note: z.object({ body: z.string(), questions: z.array(z.string()) }).nullable(),
			})
			.parse(r.rows[0]);
		if (!row.allowed || !row.send) refuse();
		const send = row.send!;
		if (!send.shared || !row.note) return C.answerReview.parse({ ...sendOf(send), shared: false });
		const answers = keptAnswers(row.note.body, row.note.questions);
		return C.answerReview.parse({
			...sendOf(send),
			shared: true,
			answers: send.questions.map((question) => ({ question, answer: answers.get(question) ?? null })),
		});
	});
}
