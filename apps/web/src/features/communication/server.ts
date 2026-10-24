import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { Transaction } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import {
	communicationWriter,
	withCommunicationWrite,
	type CommunicationContext,
	type CommunicationReply,
} from "@everyfield/domain/communication";
import "server-only";

export type CommunicationViewer = {
	authority: RequestActor;
	accountId: string;
	role: "owner" | "admin" | "member";
};

type RefusalDetails = Extract<CommunicationReply<unknown>, { status: "refused" }>["error"]["details"];

export type Outcome<T> =
	{ status: "ok"; value: T } | { status: "refused"; code: string; details: RefusalDetails } | { status: "lost" };

const denied = { status: "refused", code: "access_denied", details: {} } as const;

export async function communicationViewer(): Promise<CommunicationViewer | null> {
	const viewer = await getViewer();
	const authority = viewer?.authority;
	if (!authority) return null;
	const context = authority.actor.context;
	if (context.kind !== "seat" || context.owner.kind !== "plant") return null;
	return { authority, accountId: authority.actor.accountId, role: context.role };
}

const outcome = <T>(reply: CommunicationReply<T>): Outcome<T> =>
	reply.status === "ok"
		? { status: "ok", value: reply.value }
		: { status: "refused", code: reply.error.code, details: reply.error.details };

export async function read<T>(
	viewer: CommunicationViewer,
	run: (tx: Transaction) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await db.transaction(run));
	} catch (error) {
		console.error(JSON.stringify({ component: "communication", outcome: "read_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function write<T>(
	viewer: CommunicationViewer,
	run: (tx: Transaction, context: CommunicationContext) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const db = requestDatabase();
	if (!db) return { status: "lost" };
	try {
		return outcome(await withCommunicationWrite(db, viewer.authority, run));
	} catch (error) {
		console.error(JSON.stringify({ component: "communication", outcome: "write_failed", error: String(error) }));
		return { status: "lost" };
	}
}

export async function boundary<T>(run: (viewer: CommunicationViewer) => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const viewer = await communicationViewer();
	return viewer ? run(viewer) : denied;
}

export { communicationWriter };
