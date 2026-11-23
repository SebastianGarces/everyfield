import "server-only";

import type { Database } from "@everyfield/db/client";
import { applyMailCallback } from "@everyfield/domain/jobs";
import { logFailure } from "@everyfield/domain/log";

export async function settleCaptured(db: Database, ids: readonly string[]): Promise<void> {
	for (const id of ids) {
		const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: id } });
		try {
			await applyMailCallback(db, new TextEncoder().encode(body), `settle-${id}`);
		} catch (error) {
			logFailure({ component: "mail-capture", outcome: "settle_failed" }, error);
		}
	}
}
