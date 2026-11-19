"use server";

import { feedSubject } from "@everyfield/contracts/notifications";
import type { RequestActor } from "@everyfield/domain/access";
import { newRequestKey, type Outcome, type OptOut, type Reply } from "./model.ts";
import { call, notificationActor, optOutReady, type Mount } from "./server.ts";

type Marked = { markedIds: string[] };
type Envelope = { requestKey: string; expectedRevision: string };
type Marker = (m: Mount, actor: RequestActor) => Promise<Reply<Marked>>;

async function mark(run: Marker): Promise<Outcome<Marked>> {
	const actor = await notificationActor();
	if (!actor) return { status: "refused", code: "access_denied" };
	return call((m) => run(m, actor));
}

export async function markRead(envelope: Envelope, noticeId: string): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markRead(m.db, actor, { ...envelope, input: { noticeId } }));
}

export async function markSelectedRead(envelope: Envelope, noticeIds: string[]): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markSelectedRead(m.db, actor, { ...envelope, input: { noticeIds } }));
}

export async function markAllVisibleRead(envelope: Envelope, cutoff: string): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markAllVisibleRead(m.db, actor, { ...envelope, input: { cutoff } }));
}
export async function markSubjectRead(raw: unknown): Promise<Outcome<Marked>> {
	const subject = feedSubject.safeParse(raw);
	if (!subject.success) return { status: "refused", code: "invalid_input" };
	return mark(async (m, actor) => {
		const page = await m.producer.readFeedPage(m.db, actor, { unread: true });
		if (page.status !== "ok") return page;
		const noticeIds = page.value.feed.items
			.filter((i) => i.subject?.kind === subject.data.kind && i.subject.id === subject.data.id)
			.map((i) => i.id);
		if (!noticeIds.length) return { status: "ok", value: { markedIds: [] } };
		return m.producer.markSelectedRead(m.db, actor, {
			requestKey: newRequestKey(),
			expectedRevision: page.value.revision,
			input: { noticeIds },
		});
	});
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
