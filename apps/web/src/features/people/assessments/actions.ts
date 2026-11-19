"use server";

import { requestDatabase } from "@/server/database";
import * as c from "@everyfield/contracts/people";
import {
	assessments,
	commitments,
	interviews,
	saveCommitmentDocument,
	signCommitmentDocument,
} from "@everyfield/domain/people";
import { z } from "zod";
import { boundary, invalid, outcome, receipt, type Receipt } from "../boundary.ts";
import type { Outcome } from "../../../components/save/model.ts";
import { write } from "../server.ts";
import { privateStorage } from "@everyfield/db/schema";
import { peopleContext } from "../fields/server.ts";
import type { Assessment, Commitment, Commitments, CommitmentStatus, Interview } from "./model.ts";
import { HISTORY_PAGE } from "./server.ts";
import { transient } from "../../../server/platform/transient.ts";

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

export async function signCommitmentUpload(
	input: unknown,
): Promise<Outcome<z.infer<typeof c.commitmentDocumentUpload>>> {
	return boundary(c.signCommitmentDocumentRequest, input, async (v, request) => {
		const storage = privateStorage();
		if (!storage) return { status: "refused", code: "storage_unavailable" };
		const db = requestDatabase();
		const signed = await guarded(() =>
			signCommitmentDocument(db, storage, peopleContext(v), v.authority.actor.accountId, request),
		);
		return outcome(signed, (r) => r);
	});
}

export async function saveCommitmentWithDocument(
	requestKey: string,
	input: unknown,
): Promise<Outcome<CommitmentSaved>> {
	return boundary(c.saveCommitmentDocumentRequest, { requestKey, input }, async (v, request) => {
		const storage = privateStorage();
		if (!storage) return { status: "refused", code: "storage_unavailable" };
		const db = requestDatabase();
		const saved = await guarded(() => saveCommitmentDocument(db, storage, v.authority, request));
		return outcome(saved, (r) => ({
			commitment: r.commitment,
			person: r.person,
			current: r.current,
			receipt: receipt(r),
		}));
	});
}
const guarded = <T>(body: () => Promise<T>) =>
	transient({ component: "people", outcome: "write_failed" }, body, { status: "failed" } as const);

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
