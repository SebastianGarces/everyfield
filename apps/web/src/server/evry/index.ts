import "server-only";
import { EvryRefusal, evryActor, projectError, type EvryActor } from "@everyfield/evry";
import { after } from "next/server";
import { privateHeaders } from "../platform/boundary";
import { requestDatabase } from "../database";
import { getViewer } from "../request-context";
import { phasesMount } from "../phases";
import { tasksMount } from "../tasks";
import { runEffects, runTurns } from "./worker";

// The thin web door to the Evry kernel: one cached viewer per request (D60), the shared pool, sanitized errors and
// the turn worker on the WP-031 queue. Domain behavior lives in @everyfield/evry.

/** The shared web pool; without one Evry is unavailable. */
export function evryDatabase() {
	const pool = requestDatabase();
	if (!pool) throw new EvryRefusal("unknown");
	return pool;
}

/** The request's verified conversation owner, or access_denied. */
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
/** Every failure leaves as a projected error only: a code, a correlation id and whether a retry helps. */
export function errorResponse(error: unknown) {
	const projected = projectError(error);
	return Response.json(
		{ error: projected },
		{ status: status[projected.code as keyof typeof status] ?? 503, headers: privateHeaders },
	);
}

/** Runs one Evry operation for the request's verified actor and answers JSON. */
export async function evryResponse(body: (db: ReturnType<typeof evryDatabase>, actor: EvryActor) => Promise<unknown>) {
	try {
		return Response.json(await body(evryDatabase(), await requestActor()), { headers: privateHeaders });
	} catch (error) {
		return errorResponse(error);
	}
}

/** After the response, runs the turns this request queued (worker.ts). The scheduled runner takes any it misses. */
export function drainTurns() {
	after(() => runTurns(evryDatabase(), 4));
}

/**
 * The ports an Evry effect needs: the tasks mount's reminder port and the phases mount's notice port. Without both the
 * effects wait in the queue.
 */
export function evryEffectPorts() {
	const reminders = tasksMount()?.reminders;
	const phaseNotices = phasesMount()?.notices;
	return reminders && phaseNotices ? { reminders, phaseNotices } : null;
}

/** After the response, runs the approved effects this request queued (worker.ts). */
export function drainEffects() {
	after(async () => {
		const ports = evryEffectPorts();
		if (ports) await runEffects(evryDatabase(), ports, 4);
	});
}

/** The email service for a request that previews or checks a Communication effect. */
export { evryMail } from "./worker";
