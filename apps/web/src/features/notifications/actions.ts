"use server";

import type { RequestActor } from "@everyfield/domain/access";
import { type Outcome, type OptOut, type Reply } from "./model.ts";
import { viewerActor } from "@/server/request-context";
import { call, optOutReady, type Mount } from "./server.ts";
import { markSubject, subjectReadRequest, type Marked } from "./subject.ts";

type Marker = (m: Mount, actor: RequestActor) => Promise<Reply<Marked>>;

async function mark(run: Marker): Promise<Outcome<Marked>> {
	const actor = await viewerActor();
	if (!actor) return { status: "refused", code: "access_denied" };
	return call((m) => run(m, actor));
}

export async function markRead(command: unknown): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markRead(m.db, actor, command));
}

export async function markSelectedRead(command: unknown): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markSelectedRead(m.db, actor, command));
}

export async function markAllVisibleRead(command: unknown): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markAllVisibleRead(m.db, actor, command));
}
export async function markSubjectRead(raw: unknown): Promise<Outcome<Marked>> {
	const request = subjectReadRequest.safeParse(raw);
	if (!request.success) return { status: "refused", code: "invalid_input" };
	return mark((m, actor) => markSubject(m, actor, request.data));
}

async function optOut(run: (m: Mount) => Promise<Reply<OptOut>>): Promise<Outcome<OptOut>> {
	if (!optOutReady()) return { status: "refused", code: "unavailable" };
	return call(run);
}

export async function applyEmailOptOut(token: string): Promise<Outcome<OptOut>> {
	return optOut((m) => m.producer.applyEmailOptOut(m.db, { token }));
}

export async function undoEmailOptOut(token: string): Promise<Outcome<OptOut>> {
	return optOut((m) => m.producer.undoEmailOptOut(m.db, { token }));
}
