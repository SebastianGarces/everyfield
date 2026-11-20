import "server-only";

import type { Database } from "@everyfield/db/client";
import { applyMailCallback } from "@everyfield/domain/jobs";

export async function settleCaptured(db: Database, ids: readonly string[]): Promise<void> {
	for (const id of ids) {
		const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: id } });
		await applyMailCallback(db, new TextEncoder().encode(body), `settle-${id}`);
	}
}
