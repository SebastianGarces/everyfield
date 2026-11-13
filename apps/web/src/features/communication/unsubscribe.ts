import "server-only";

import { requestDatabase } from "../../server/database.ts";
import type { Database } from "@everyfield/db/client";
import type { CommunicationReply } from "@everyfield/domain/communication";
import { parseKeyRing, type OptOutKeyRing } from "@everyfield/domain/notifications";
import type { Outcome } from "./model.ts";

// The Messages Unsubscribe page and its one-click endpoint reach the domain here (REQ-NTF-016). The token in the link
// is the only authority: nothing here reads a session, an account or an address. The token is sealed with the
// NOTIFICATION_OPT_OUT_KEYS ring under a Messages subkey, so a deployment without that ring has no Unsubscribe page.

type UnsubscribeMount = { db: Database; ring: OptOutKeyRing };

function unsubscribeMount(): UnsubscribeMount | null {
	const db = requestDatabase();
	const ring = parseKeyRing(process.env.NOTIFICATION_OPT_OUT_KEYS);
	return db && ring ? { db, ring } : null;
}

/** One domain call. No mount is `unavailable`; a database failure reads as lost, never as a change. */
export async function unsubscribeCall<T>(
	run: (m: UnsubscribeMount) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const mount = unsubscribeMount();
	if (!mount) return { status: "refused", code: "unavailable" };
	try {
		const reply = await run(mount);
		return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
	} catch (error) {
		console.error(
			JSON.stringify({
				component: "communication",
				outcome: "unsubscribe_failed",
				error: error instanceof Error ? error.name : "error",
			}),
		);
		return { status: "lost" };
	}
}
