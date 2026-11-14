import * as c from "@everyfield/contracts/launch";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer, type PlantViewer } from "../documents/access.ts";

type Code = c.LaunchError["code"];
class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code, details: object = {}): never {
	throw new Refusal(code, details);
}
const RETRY: Record<Code, c.LaunchError["retry"]> = {
	invalid_input: "never",
	invalid_reason: "never",
	access_denied: "never",
	idempotency_conflict: "never",
	conflict: "refresh",
	stale_review: "refresh",
};
export async function settle<T>(body: () => Promise<T>): Promise<c.LaunchReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			status: "refused",
			error: c.launchError.parse({
				code: error.code,
				details: error.details,
				correlationId: randomUUID(),
				retry: RETRY[error.code],
			}),
		};
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (!found.success) deny("invalid_input");
	return found.data;
}

/**
 * The church plant of the request. `live` is the C13 condition that the session and exact seat still hold, any role;
 * `admin` adds Owner or Admin. Launch administration is Owner and Admin (launch.md); a Member reads the plan only, so
 * their `admin` is false and every administration statement reads and writes nothing.
 */
export type Scope = PlantViewer & { live: SQL; admin: SQL };
export function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	return {
		...viewer,
		live: liveRead(viewer.access),
		admin: viewer.access.role === "member" ? sql`false` : liveRead(viewer.access, true),
	};
}
