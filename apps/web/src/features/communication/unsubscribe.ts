import "server-only";

import { requestDatabase } from "../../server/database.ts";
import type { Database } from "@everyfield/db/client";
import type { CommunicationReply } from "@everyfield/domain/communication";
import { parseKeyRing, type OptOutKeyRing } from "@everyfield/domain/notifications";
import type { Outcome } from "./model.ts";
import { serverEnv } from "../../server/config.ts";
import { LOST, transient } from "../../server/platform/transient.ts";

type UnsubscribeMount = { db: Database; ring: OptOutKeyRing };

function unsubscribeMount(): UnsubscribeMount | null {
	const ring = parseKeyRing(serverEnv().NOTIFICATION_OPT_OUT_KEYS);
	return ring && { db: requestDatabase(), ring };
}

export async function unsubscribeCall<T>(
	run: (m: UnsubscribeMount) => Promise<CommunicationReply<T>>,
): Promise<Outcome<T>> {
	const mount = unsubscribeMount();
	if (!mount) return { status: "refused", code: "unavailable" };
	return transient(
		{ component: "communication", outcome: "unsubscribe_failed" },
		async () => {
			const reply = await run(mount);
			return reply.status === "ok" ? reply : { status: "refused", code: reply.error.code };
		},
		LOST,
	);
}
