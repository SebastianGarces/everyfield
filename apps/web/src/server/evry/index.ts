import "server-only";
import { EvryRefusal, evryActor, projectError, type EvryActor } from "@everyfield/evry";
import { after } from "next/server";
import { privateHeaders } from "../platform/boundary";
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";
import { tasksMount } from "../tasks";
import { runEffects, runTurns } from "./worker";

export function evryDatabase() {
	const pool = requestDatabase();
	if (!pool) throw new EvryRefusal("unknown");
	return pool;
}

export async function requestActor(): Promise<EvryActor> {
	const viewer = await getViewer();
	if (!viewer || viewer.status !== "active" || !viewer.authority) throw new EvryRefusal("access_denied");
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

export async function evryResponse(body: (db: ReturnType<typeof evryDatabase>, actor: EvryActor) => Promise<unknown>) {
	try {
		return Response.json(await body(evryDatabase(), await requestActor()), { headers: privateHeaders });
	} catch (error) {
		return errorResponse(error);
	}
}

export function drainTurns() {
	after(() => runTurns(evryDatabase(), 4));
}

export function drainEffects() {
	after(async () => {
		const reminders = tasksMount()?.reminders;
		if (reminders) await runEffects(evryDatabase(), reminders, 4);
	});
}

export { evryMail } from "./worker";
