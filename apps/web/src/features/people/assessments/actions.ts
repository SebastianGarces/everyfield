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
	return boundary(async (v) =>
		outcome(await write(v, (tx, ctx) => assessments.createAssessment(tx, ctx, { requestKey, input })), (r) => ({
			assessment: r.assessment,
			person: r.person,
			receipt: receipt(r),
		})),
	);
}

export async function recordInterview(requestKey: string, input: unknown): Promise<Outcome<InterviewSaved>> {
	return boundary(async (v) =>
		outcome(await write(v, (tx, ctx) => interviews.createInterview(tx, ctx, { requestKey, input })), (r) => ({
			interview: r.interview,
			person: r.person,
			receipt: receipt(r),
		})),
	);
}

export async function recordCommitment(requestKey: string, input: unknown): Promise<Outcome<CommitmentSaved>> {
	return boundary(async (v) =>
		outcome(await write(v, (tx, ctx) => commitments.createCommitment(tx, ctx, { requestKey, input })), (r) => ({
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
	return boundary(async (v) => {
		const storage = privateStorage();
		if (!storage) return { status: "refused", code: "storage_unavailable" };
		const db = requestDatabase();
		const signed = await guarded(() =>
			signCommitmentDocument(db, storage, peopleContext(v), v.authority.actor.accountId, input),
		);
		return outcome(signed, (r) => r);
	});
}

export async function saveCommitmentWithDocument(
	requestKey: string,
	input: unknown,
): Promise<Outcome<CommitmentSaved>> {
	return boundary(async (v) => {
		const storage = privateStorage();
		if (!storage) return { status: "refused", code: "storage_unavailable" };
		const db = requestDatabase();
		const saved = await guarded(() => saveCommitmentDocument(db, storage, v.authority, { requestKey, input }));
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
	change: unknown,
	requestKey: string,
	expectedRevision: string,
	input: unknown,
): Promise<Outcome<LifecycleSaved>> {
	const run =
		change === "withdraw"
			? commitments.withdrawCommitment
			: change === "reactivate"
				? commitments.reactivateCommitment
				: null;
	if (!run) return invalid;
	return boundary(async (v) =>
		outcome(await write(v, (tx, ctx) => run(tx, ctx, { requestKey, expectedRevision, input })), (r) => ({
			current: r.current,
			receipt: receipt(r),
		})),
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
	return boundary(async (v) =>
		outcome(
			await write(v, async (tx, ctx) => {
				const done = await commitments.correctCommitmentLifecycle(tx, ctx, { requestKey, expectedRevision, input });
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
