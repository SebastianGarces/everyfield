"use server";

import { requestDatabase } from "@/server/database";
import * as c from "@everyfield/contracts/people";
import {
	assessments,
	commitments,
	interviews,
	peopleReader,
	saveCommitmentDocument,
	signCommitmentDocument,
} from "@everyfield/domain/people";
import { z } from "zod";
import { boundary, invalid, outcome, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../model.ts";
import { read, write } from "../server.ts";
import { privateStorage } from "@everyfield/db/schema";
import { peopleContext } from "../fields/server.ts";
import type {
	Assessment,
	Assessments,
	Commitment,
	Commitments,
	CommitmentStatus,
	Interview,
	Interviews,
} from "./model.ts";
import { HISTORY_PAGE } from "./server.ts";

// Server actions for the 4 C's, interviews and commitments (REQ-PPL-012, 013, 014, 026). Each parses the browser's input
// with the WP-014 contract, runs one producer write in one transaction and answers with what changed, so the page shows
// the record, the stage and the Activity entry from the answer and never reloads. A database failure reads as "lost":
// the browser sends the same request key again, and the producer returns the first result instead of acting twice.

type RecordedPerson = z.infer<typeof c.recordedPerson>;
export type AssessmentSaved = { assessment: Assessment; person: RecordedPerson; receipt: Receipt };
export type InterviewSaved = { interview: Interview; person: RecordedPerson; receipt: Receipt };
export type CommitmentSaved = {
	commitment: Commitment;
	person: RecordedPerson;
	current: CommitmentStatus;
	receipt: Receipt;
};
export type LifecycleSaved = { current: CommitmentStatus; receipt: Receipt };
export type CorrectionSaved = { commitments: Commitments; receipt: Receipt };

export async function recordAssessment(requestKey: string, input: unknown): Promise<Outcome<AssessmentSaved>> {
	return boundary(c.createAssessmentRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => assessments.createAssessment(tx, ctx, request)), (r) => ({
			assessment: r.assessment,
			person: r.person,
			receipt: receipt(r),
		})),
	);
}

export async function recordInterview(requestKey: string, input: unknown): Promise<Outcome<InterviewSaved>> {
	return boundary(c.createInterviewRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => interviews.createInterview(tx, ctx, request)), (r) => ({
			interview: r.interview,
			person: r.person,
			receipt: receipt(r),
		})),
	);
}

export async function recordCommitment(requestKey: string, input: unknown): Promise<Outcome<CommitmentSaved>> {
	return boundary(c.createCommitmentRequest, { requestKey, input }, async (v, request) =>
		outcome(await write(v, (tx, ctx) => commitments.createCommitment(tx, ctx, request)), (r) => ({
			commitment: r.commitment,
			person: r.person,
			current: r.current,
			receipt: receipt(r),
		})),
	);
}

/**
 * Design B, step 1 (RT-2): a five-minute URL that puts this one file straight into the private bucket. The browser sends
 * the file's exact bytes to `url` with `headers` and then calls saveCommitmentWithDocument. No bytes reach this server.
 */
export async function signCommitmentUpload(
	input: unknown,
): Promise<Outcome<z.infer<typeof c.commitmentDocumentUpload>>> {
	return boundary(c.signCommitmentDocumentRequest, input, async (v, request) => {
		const storage = privateStorage();
		const db = requestDatabase();
		if (!storage || !db) return { status: "refused", code: "storage_unavailable" };
		const signed = await signCommitmentDocument(
			db,
			storage,
			peopleContext(v),
			v.authority.actor.accountId,
			request,
		).catch(lost);
		return outcome(signed, (r) => r);
	});
}

/**
 * Design B, step 2 (RT-2): the card with the document the browser uploaded, saved by the same write as recordCommitment
 * after the server has checked the file. A lost answer is retried with the same request key; the first saved card
 * answers.
 */
export async function saveCommitmentWithDocument(
	requestKey: string,
	input: unknown,
): Promise<Outcome<CommitmentSaved>> {
	return boundary(c.saveCommitmentDocumentRequest, { requestKey, input }, async (v, request) => {
		const storage = privateStorage();
		const db = requestDatabase();
		if (!storage || !db) return { status: "refused", code: "storage_unavailable" };
		const saved = await saveCommitmentDocument(db, storage, v.authority, request).catch(lost);
		return outcome(saved, (r) => ({
			commitment: r.commitment,
			person: r.person,
			current: r.current,
			receipt: receipt(r),
		}));
	});
}
const lost = (error: unknown) => {
	console.error(JSON.stringify({ component: "people", outcome: "write_failed", error: String(error) }));
	return { status: "failed" } as const;
};

/** Withdraws or reactivates the person's commitment on a date. The stage stays (REQ-PPL-014). */
export async function changeCommitment(
	change: "withdraw" | "reactivate",
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<LifecycleSaved>> {
	const schema = change === "withdraw" ? c.withdrawCommitmentRequest : c.reactivateCommitmentRequest;
	return boundary(schema, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(
			await write(v, (tx, ctx) =>
				change === "withdraw"
					? commitments.withdrawCommitment(tx, ctx, request)
					: commitments.reactivateCommitment(tx, ctx, request),
			),
			(r) => ({ current: r.current, receipt: receipt(r) }),
		),
	);
}

/**
 * Corrects one card's date or kind, or voids it. A correction can move the first acquisition and the current state
 * (REQ-PPL-026), and its answer names neither, so the first history page is read again in the same transaction.
 */
export async function correctCommitment(
	requestKey: string,
	expectedRevision: string,
	personId: string,
	input: unknown,
): Promise<Outcome<CorrectionSaved>> {
	const person = c.personRequest.safeParse({ personId });
	if (!person.success) return invalid;
	return boundary(c.correctCommitmentRequest, { requestKey, expectedRevision, input }, async (v, request) =>
		outcome(
			await write(v, async (tx, ctx) => {
				const done = await commitments.correctCommitmentLifecycle(tx, ctx, request);
				if (done.status !== "ok") return done;
				const page = { personId: person.data.personId, limit: HISTORY_PAGE, page: 1 };
				const now = await commitments.getCommitments(tx, ctx, page);
				return now.status === "ok"
					? { status: "ok", value: { commitments: now.value, receipt: receipt(done.value) } }
					: now;
			}),
			(r) => r,
		),
	);
}

// History pages after the first, which loads with the person page.

export async function loadAssessments(personId: string, page: number): Promise<Outcome<Assessments>> {
	return boundary(c.personRecordsRequest, { personId, page, limit: HISTORY_PAGE }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => assessments.getAssessments(tx, ctx, request)), (r) => r),
	);
}
export async function loadInterviews(personId: string, page: number): Promise<Outcome<Interviews>> {
	return boundary(c.personRecordsRequest, { personId, page, limit: HISTORY_PAGE }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => interviews.getInterviews(tx, ctx, request)), (r) => r),
	);
}
export async function loadCommitments(personId: string, page: number): Promise<Outcome<Commitments>> {
	return boundary(c.personRecordsRequest, { personId, page, limit: HISTORY_PAGE }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => commitments.getCommitments(tx, ctx, request)), (r) => r),
	);
}

/** Live people of this church whose name, email or phone match: the witness a card can name (REQ-PPL-014). */
export async function findWitnesses(search: string): Promise<Outcome<{ id: string; name: string; detail: string }[]>> {
	return boundary(c.listPeopleRequest, { search, limit: 8 }, async (v, request) =>
		outcome(await read(v, (tx, ctx) => peopleReader.listPeople(tx, ctx, request)), (r) =>
			r.items.map((p) => ({ id: p.id, name: p.displayName, detail: p.email ?? p.phone ?? "" })),
		),
	);
}
