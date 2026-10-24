import { requestDatabase } from "@/server/database";
import { getViewer } from "@/server/request-context";
import type { WikiReply } from "@everyfield/contracts/wiki";
import type { Database } from "@everyfield/db/client";
import type { RequestActor } from "@everyfield/domain/access";
import { createWikiProducer } from "@everyfield/domain/wiki";
import "server-only";

// The wiki reads and writes reach the WP-034 producer here. Screens stay in WP-034/ui. This mount is the API seam
// the statement census calls. Each producer statement binds the session to the actor (C13).

type Producer = ReturnType<typeof createWikiProducer>;
export type Mount = { db: Database; producer: Producer };
export type Outcome<T> = { status: "ok"; value: T } | { status: "refused"; code: string } | { status: "lost" };

const MOUNT: unique symbol = Symbol.for("everyfield.web.wiki");
const slot = globalThis as { [MOUNT]?: { url: string; mount: Mount } };

export function wikiMount(): Mount | null {
	const db = requestDatabase();
	const url = process.env.IDENTITY_DATABASE_URL;
	if (!db || !url) return null;
	if (slot[MOUNT]?.url !== url) slot[MOUNT] = { url, mount: { db, producer: createWikiProducer() } };
	return slot[MOUNT].mount;
}

/** The request's verified actor, or null when signed out. */
export async function wikiActor(): Promise<RequestActor | null> {
	return (await getViewer())?.authority ?? null;
}

const outcome = <T>(reply: WikiReply<T>): Outcome<T> =>
	reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };

/** One producer call. A database failure reads as lost, never as an empty corpus. */
export async function call<T>(run: (m: Mount) => Promise<WikiReply<T>>): Promise<Outcome<T>> {
	const mount = wikiMount();
	if (!mount) return { status: "lost" };
	try {
		return outcome(await run(mount));
	} catch (error) {
		console.error(JSON.stringify({ component: "wiki", outcome: "failed", error: String(error) }));
		return { status: "lost" };
	}
}
