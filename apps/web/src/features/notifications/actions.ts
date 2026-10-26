"use server";

import type { RequestActor } from "@everyfield/domain/access";
import type { Outcome, OptOut, Reply } from "./model.ts";
import { call, notificationActor, notificationsMount, type Mount } from "./server.ts";

// Server actions behind the feed's and the bell's marks and the email opt-out page: the browser boundary. The producer
// parses every input with the WP-030 contract and rechecks the recipient inside its statement. Reads go through
// read.ts, a GET handler, so a read never waits behind a mark.

type Marked = { markedIds: string[] };
type Envelope = { requestKey: string; expectedRevision: string };
type Marker = (m: Mount, actor: RequestActor) => Promise<Reply<Marked>>;

/**
 * One mark. The envelope carries the account revision the screen read with the feed. Marking never changes it, so a
 * retry after a lost answer sends the same envelope and the producer replays it instead of marking twice.
 */
async function mark(run: Marker): Promise<Outcome<Marked>> {
	const actor = await notificationActor();
	if (!actor) return { status: "refused", code: "access_denied" };
	return call((m) => run(m, actor));
}

/** Mark one entry read. Reading does not complete the work it is about (REQ-NTF-003). */
export async function markRead(envelope: Envelope, noticeId: string): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markRead(m.db, actor, { ...envelope, input: { noticeId } }));
}

/** Mark the entries a filtered page shows, up to 50. Only the caller's own visible entries change. */
export async function markSelectedRead(envelope: Envelope, noticeIds: string[]): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markSelectedRead(m.db, actor, { ...envelope, input: { noticeIds } }));
}

/** Mark every visible entry up to `cutoff`, the newest one shown. Later arrivals stay unread. */
export async function markAllVisibleRead(envelope: Envelope, cutoff: string): Promise<Outcome<Marked>> {
	return mark((m, actor) => m.producer.markAllVisibleRead(m.db, actor, { ...envelope, input: { cutoff } }));
}
// Email opt-out (REQ-NTF-012): the signed token is the only authority, so these need no session. Opening the page
// only describes the token; these explicit posts change the choice.

async function optOut(run: (m: Mount) => Promise<Reply<OptOut>>): Promise<Outcome<OptOut>> {
	if (!notificationsMount()?.optOut) return { status: "refused", code: "unavailable" };
	return call(run);
}

/** Turn off email for the token's one category. In-app notifications stay as they are. */
export async function applyEmailOptOut(token: string): Promise<Outcome<OptOut>> {
	return optOut((m) => m.producer.applyEmailOptOut(m.db, { token }));
}

/** Turn that email back on with the one-hour undo token the opt-out returned. */
export async function undoEmailOptOut(token: string): Promise<Outcome<OptOut>> {
	return optOut((m) => m.producer.undoEmailOptOut(m.db, { token }));
}
