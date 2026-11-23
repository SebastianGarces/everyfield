import type { Lost } from "@everyfield/contracts/common";
import type { PipelineReply } from "@everyfield/contracts/organizations";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { RequestActor, WriteTx } from "@everyfield/domain/access";
import type { Database } from "@everyfield/db/client";
import {
	readAnswerReview,
	readAnswerReviews,
	readPipelineBoard,
	readPipelineChoices,
	readPipelineExport,
	readPipelineGoals,
	readPipelinePersonRecord,
} from "@everyfield/domain/organizations";
import { PeopleReadContext, peopleMerge, withPeopleWrite } from "@everyfield/domain/people";
import "server-only";
import { requestDatabase } from "../../server/database";
import { organizationSeat } from "../../server/request-context";
import { LOST, transient } from "../../server/platform/transient.ts";
import { gatedTransaction } from "@everyfield/domain/operations";

export type PipelineAnswer<T> = PipelineReply<T> | Lost;

async function guarded<R>(run: () => Promise<R>): Promise<R | Lost> {
	return transient({ component: "pipeline", outcome: "failed" }, () => run(), LOST);
}

export async function loadPipelineBoard(authority: RequestActor, query: unknown) {
	const db = requestDatabase();
	return guarded(() => readPipelineBoard(db, authority, query));
}

export async function loadPipelineChoices(authority: RequestActor) {
	const db = requestDatabase();
	return guarded(() => readPipelineChoices(db, authority));
}

export async function loadPipelineGoals(authority: RequestActor) {
	const db = requestDatabase();
	return guarded(() => readPipelineGoals(db, authority));
}

export async function loadPipelinePerson(authority: RequestActor, personId: string) {
	const db = requestDatabase();
	return guarded(() => readPipelinePersonRecord(db, authority, { personId }));
}

export async function loadAnswerReviews(authority: RequestActor) {
	const db = requestDatabase();
	return guarded(() => readAnswerReviews(db, authority));
}
export async function loadAnswerReview(authority: RequestActor, reviewId: string) {
	const db = requestDatabase();
	return guarded(() => readAnswerReview(db, authority, { reviewId }));
}

export async function pipelineWrite<T>(
	run: (db: Database, authority: RequestActor) => Promise<PipelineReply<T>>,
): Promise<PipelineAnswer<T>> {
	const seat = await organizationSeat();
	if (!seat) return { status: "refused", refusal: { code: "unavailable" } };
	const db = requestDatabase();
	return guarded(() => run(db, seat.authority));
}

export async function loadPipelineExport(authority: RequestActor) {
	const db = requestDatabase();
	return guarded(() => readPipelineExport(db, authority));
}

type PeopleAnswer<T> = PeopleReply<T> | Lost;
async function asSeat<T>(
	run: (db: Database, authority: RequestActor) => Promise<PeopleReply<T>>,
): Promise<PeopleAnswer<T>> {
	const seat = await organizationSeat();
	if (!seat) return { status: "refused", error: { code: "unavailable" } } as PeopleReply<T>;
	return asAuthority(seat.authority, run);
}
async function asAuthority<T>(
	authority: RequestActor,
	run: (db: Database, authority: RequestActor) => Promise<PeopleReply<T>>,
): Promise<PeopleAnswer<T>> {
	const db = requestDatabase();
	return guarded(() => run(db, authority));
}
export const loadMergeReview = (authority: RequestActor, input: unknown) =>
	asAuthority(authority, (db) =>
		gatedTransaction(db, (tx) => peopleMerge.getMergeReview(tx, new PeopleReadContext(authority), input)),
	);
export const pipelinePeopleRead = <T>(run: (tx: WriteTx, ctx: PeopleContext) => Promise<PeopleReply<T>>) =>
	asSeat((db, authority) => gatedTransaction(db, (tx) => run(tx, new PeopleReadContext(authority))));
export const pipelinePeopleWrite = <T>(run: (tx: WriteTx, ctx: PeopleWriteContext) => Promise<PeopleReply<T>>) =>
	asSeat((db, authority) => withPeopleWrite(db, authority, run));
