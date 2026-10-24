"use server";

import type { Outcome } from "./server.ts";
import { call, wikiActor } from "./server.ts";

// Server actions for the wiki writes. The producer parses each envelope and rechecks the actor inside its statement.
// Reads go through read.ts, a GET handler, so a read never waits behind a write.

type Envelope = { requestKey: string; expectedRevision: string; input: unknown };

async function write<T>(run: (actor: NonNullable<Awaited<ReturnType<typeof wikiActor>>>) => Promise<Outcome<T>>) {
	const actor = await wikiActor();
	if (!actor) return { status: "refused", code: "access_denied" } as const;
	return run(actor);
}

export async function updateProgress(envelope: Envelope): Promise<Outcome<unknown>> {
	return write((actor) => call(({ db, producer }) => producer.updateProgress(db, actor, envelope)));
}

export async function recordView(envelope: Envelope): Promise<Outcome<unknown>> {
	return write((actor) => call(({ db, producer }) => producer.recordView(db, actor, envelope)));
}

export async function setBookmark(envelope: Envelope): Promise<Outcome<unknown>> {
	return write((actor) => call(({ db, producer }) => producer.setBookmark(db, actor, envelope)));
}

export async function setSourceOrder(envelope: Envelope): Promise<Outcome<unknown>> {
	return write((actor) => call(({ db, producer }) => producer.setSourceOrder(db, actor, envelope)));
}
