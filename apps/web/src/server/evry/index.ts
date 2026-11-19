import "server-only";
import type { Database } from "@everyfield/db/client";
import { EvryRefusal, evryActor, projectError, type EvryActor } from "@everyfield/evry";
import { after } from "next/server";
import { privateHeaders } from "../platform/boundary";
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";
import { tasksMount } from "../../features/tasks/mount.ts";
import { runEffects, runTurns } from "./worker";

export async function requestActor(): Promise<EvryActor> {
	const viewer = await getViewer();
	if (viewer.status !== "active" || !viewer.authority) throw new EvryRefusal("access_denied");
	return evryActor(viewer.authority);
}

const status = {
	not_found: 404,
	access_denied: 403,
	invalid_input: 400,
	run_active: 409,
	review_changed: 409,
	review_expired: 409,
	review_closed: 409,
	photo_unavailable: 409,
} as const;
export function errorResponse(error: unknown) {
	const projected = projectError(error);
	return Response.json(
		{ error: projected },
		{ status: status[projected.code as keyof typeof status] ?? 503, headers: privateHeaders },
	);
}

export async function evryResponse(body: (db: Database, actor: EvryActor) => Promise<unknown>) {
	try {
		return Response.json(await body(requestDatabase(), await requestActor()), { headers: privateHeaders });
	} catch (error) {
		return errorResponse(error);
	}
}

export function drainTurns() {
	after(() => runTurns(requestDatabase(), 4));
}

export function drainEffects() {
	after(async () => {
		await runEffects(requestDatabase(), tasksMount().reminders, 4);
	});
}

export { evryMail } from "./worker";
