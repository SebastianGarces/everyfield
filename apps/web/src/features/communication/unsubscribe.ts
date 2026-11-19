import "server-only";

import { requestDatabase } from "../../server/database.ts";
import type { Database } from "@everyfield/db/client";
import type { CommunicationReply } from "@everyfield/domain/communication";
import { parseKeyRing, type OptOutKeyRing } from "@everyfield/domain/notifications";
import type { Outcome } from "./model.ts";
import { logFailure } from "@everyfield/domain/log";

type UnsubscribeMount = { db: Database; ring: OptOutKeyRing };

function unsubscribeMount(): UnsubscribeMount | null {
	const db = requestDatabase();
	const ring = parseKeyRing(process.env.NOTIFICATION_OPT_OUT_KEYS);
	return db && ring ? { db, ring } : null;
}

export async function unsubscribeCall<T>(
	run: (m: UnsubscribeMount) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const mount = unsubscribeMount();
	if (!mount) return { status: "refused", code: "unavailable" };
	try {
		const reply = await run(mount);
		return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
	} catch (error) {
		logFailure({ component: "communication", outcome: "unsubscribe_failed" }, error);
		return { status: "lost" };
	}
}
