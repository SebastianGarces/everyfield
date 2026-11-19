import type { PipelineReply } from "@everyfield/contracts/organizations";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database, Transaction } from "@everyfield/db/client";
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
import { getViewer } from "../../server/request-context";
import { logFailure } from "@everyfield/domain/log";

export type PipelineAnswer<T> = PipelineReply<T> | { status: "lost" };

export async function pipelineActor(): Promise<
	{ kind: "signed_out" } | { kind: "unavailable" } | { kind: "seat"; authority: RequestActor }
> {
	const v = await getViewer();
	if (v.status === "unauthenticated") return { kind: "signed_out" };
	const authority = v.authority;
	const context = authority?.actor.context;
	if (!authority || context?.kind !== "seat" || context.owner.kind !== "organization") return { kind: "unavailable" };
	return { kind: "seat", authority };
}

async function guarded<R>(run: () => Promise<R>): Promise<R | { status: "lost" }> {
	try {
		return await run();
	} catch (error) {
		logFailure({ component: "pipeline", outcome: "failed" }, error);
		return { status: "lost" };
	}
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
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } };
	const db = requestDatabase();
	return guarded(() => run(db, who.authority));
}

export async function loadPipelineExport(authority: RequestActor) {
	const db = requestDatabase();
	return guarded(() => readPipelineExport(db, authority));
}

type PeopleAnswer<T> = PeopleReply<T> | { status: "lost" };
async function asSeat<T>(
	run: (db: Database, authority: RequestActor) => Promise<PeopleReply<T>>,
): Promise<PeopleAnswer<T>> {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", error: { code: "unavailable" } } as PeopleReply<T>;
	return asAuthority(who.authority, run);
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
		db.transaction((tx) => peopleMerge.getMergeReview(tx, new PeopleReadContext(authority), input)),
	);
export const pipelinePeopleRead = <T>(run: (tx: Transaction, ctx: PeopleContext) => Promise<PeopleReply<T>>) =>
	asSeat((db, authority) => db.transaction((tx) => run(tx, new PeopleReadContext(authority))));
export const pipelinePeopleWrite = <T>(run: (tx: Transaction, ctx: PeopleWriteContext) => Promise<PeopleReply<T>>) =>
	asSeat((db, authority) => withPeopleWrite(db, authority, run));
