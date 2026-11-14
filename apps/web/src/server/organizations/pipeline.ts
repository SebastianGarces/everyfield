import type { PipelineReply } from "@everyfield/contracts/organizations";
import type { PeopleContext, PeopleReply, PeopleWriteContext } from "@everyfield/contracts/people";
import type { RequestActor } from "@everyfield/domain/access";
import type { Database, Transaction } from "@everyfield/db/client";
import {
	readPipelineBoard,
	readPipelineExport,
	readPipelineGoals,
	readPipelinePersonRecord,
} from "@everyfield/domain/organizations";
import { PeopleReadContext, withPeopleWrite } from "@everyfield/domain/people";
import "server-only";
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";

// The organization pipeline mount (WP-098a). Pages and actions take the request's one actor (D59); every read and
// write rechecks the seat inside its own statement or transaction. A database failure reads as "lost", never a crash.

export type PipelineAnswer<T> = PipelineReply<T> | { status: "lost" };

/** The request actor when it holds a seat in an organization; who else is asking otherwise. */
export async function pipelineActor(): Promise<
	{ kind: "signed_out" } | { kind: "unavailable" } | { kind: "seat"; authority: RequestActor }
> {
	const v = await getViewer();
	if (!v) return { kind: "unavailable" };
	if (v.status === "unauthenticated") return { kind: "signed_out" };
	const authority = v.authority;
	const context = authority?.actor.context;
	if (!authority || context?.kind !== "seat" || context.owner.kind !== "organization") return { kind: "unavailable" };
	return { kind: "seat", authority };
}

async function guarded<T>(run: () => Promise<PipelineReply<T>>): Promise<PipelineAnswer<T>> {
	try {
		return await run();
	} catch (error) {
		console.error(JSON.stringify({ component: "pipeline", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function loadPipelineBoard(authority: RequestActor, query: unknown) {
	const db = requestDatabase();
	if (!db) return { status: "lost" } as const;
	return guarded(() => readPipelineBoard(db, authority, query));
}

export async function loadPipelineGoals(authority: RequestActor) {
	const db = requestDatabase();
	if (!db) return { status: "lost" } as const;
	return guarded(() => readPipelineGoals(db, authority));
}

export async function loadPipelinePerson(authority: RequestActor, personId: string) {
	const db = requestDatabase();
	if (!db) return { status: "lost" } as const;
	return guarded(() => readPipelinePersonRecord(db, authority, { personId }));
}

/** One pipeline write as the request's actor. */
export async function pipelineWrite<T>(
	run: (db: Database, authority: RequestActor) => Promise<PipelineReply<T>>,
): Promise<PipelineAnswer<T>> {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", refusal: { code: "unavailable" } };
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	return guarded(() => run(db, who.authority));
}

export async function loadPipelineExport(authority: RequestActor) {
	const db = requestDatabase();
	if (!db) return { status: "lost" } as const;
	return guarded(() => readPipelineExport(db, authority));
}

type PeopleAnswer<T> = PeopleReply<T> | { status: "lost" };
/** Runs `run` as the request's organization seat; a missing seat is refused, any thrown failure reads as "lost". */
async function asSeat<T>(
	run: (db: Database, authority: RequestActor) => Promise<PeopleReply<T>>,
): Promise<PeopleAnswer<T>> {
	const who = await pipelineActor();
	if (who.kind !== "seat") return { status: "refused", error: { code: "unavailable" } } as PeopleReply<T>;
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return await run(db, who.authority);
	} catch (error) {
		console.error(JSON.stringify({ component: "pipeline", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}
/** One People read on the organization's own people, in its own transaction (the duplicate review, REQ-MUL-017). */
export const pipelinePeopleRead = <T>(run: (tx: Transaction, ctx: PeopleContext) => Promise<PeopleReply<T>>) =>
	asSeat((db, authority) => db.transaction((tx) => run(tx, new PeopleReadContext(authority))));
/** One People write on the organization's own people: a merge or its undo, through the People producer. */
export const pipelinePeopleWrite = <T>(run: (tx: Transaction, ctx: PeopleWriteContext) => Promise<PeopleReply<T>>) =>
	asSeat((db, authority) => withPeopleWrite(db, authority, run));
