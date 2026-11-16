import { owner as ownerOf } from "@everyfield/contracts/common";
import { sql, type SQL } from "@everyfield/db/query";
import { liveRead } from "../access/session.ts";
import type { Command } from "./core.ts";

export function communicationAccess(actor: Command["actor"], session: string, admin: boolean): SQL {
	const owner = ownerOf.parse({ kind: "plant", id: actor.plantId });
	return sql`${liveRead({ session, owner, seatId: actor.seatId, role: actor.role }, admin)}
		AND EXISTS (SELECT 1 FROM live_session(${session}::uuid) i
		JOIN account a ON a.id = i.account_id AND a.id = ${actor.accountId}::uuid AND a.auth_user_id IS NOT NULL
		JOIN seat st ON st.account_id = a.id AND st.id = ${actor.seatId}::uuid AND st.plant_id = ${actor.plantId}::uuid
			AND st.ended_at IS NULL AND st.accepted_at <= clock_timestamp() AND st.role = ${actor.role}
			AND (${admin}::boolean = false OR st.role <> 'member')
		WHERE i.registration_state = 'active' AND i.expires_at > clock_timestamp())`;
}
