import { requestDatabase } from "@/server/database";
import { seatOf, type Viewer } from "@/server/request-context";
import { readLeadPlanter } from "@everyfield/domain/settings";
import "server-only";
import type { LeadRead } from "./port";
import { LOST, transient } from "../../server/platform/transient.ts";

export async function readLead(session: Viewer): Promise<LeadRead> {
	const seat = seatOf(session);
	if (!seat) return { status: "denied" };
	const db = requestDatabase();
	return transient(
		{ component: "settings", outcome: "lead_read_failed" },
		async () => {
			const r = await readLeadPlanter(db, seat.authority);
			return r ? { status: "ok", ...r } : { status: "denied" };
		},
		LOST,
	);
}
