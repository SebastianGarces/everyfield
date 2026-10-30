import { brandError, type BrandError, type BrandReply } from "@everyfield/contracts/branding";
import { sql, type SQL } from "@everyfield/db/query";
import { randomUUID } from "node:crypto";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer, type PlantViewer } from "../documents/access.ts";

type Code = BrandError["code"];

export class Refusal extends Error {
	readonly code: Code;
	readonly details: object;
	constructor(code: Code, details: object = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}
export function deny(code: Code = "unavailable", details: object = {}): never {
	throw new Refusal(code, details);
}
export async function settle<T>(body: () => Promise<T>): Promise<BrandReply<T>> {
	try {
		return { status: "ok", value: await body() };
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		return {
			status: "refused",
			error: brandError.parse({
				code: error.code,
				details: error.details,
				correlationId: randomUUID(),
				retry: error.code === "conflict" ? "refresh" : "never",
			}),
		};
	}
}
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (found.success) return found.data;
	deny("invalid_input", {
		issues: found.error.issues
			.slice(0, 50)
			.map((issue) => ({ path: issue.path.join(".").slice(0, 200), problem: issue.message.slice(0, 200) })),
	});
}

/** The church plant the request is for, with the SQL condition that its live seat still holds (C13). */
export type Scope = PlantViewer & { admin: SQL; seat: SQL };
/**
 * Owner and Admin seats read and change the kit. Any active seat resolves a theme. Both conditions run inside the
 * statement that reads or writes (C13); a Member's `admin` condition is false, so the statement returns nothing.
 */
export function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	// liveRead matches the seat's exact role, so a Member's claimed role also closes the Owner or Admin condition.
	const seat = liveRead(viewer.access, false);
	return { ...viewer, admin: viewer.access.role === "member" ? sql`false` : seat, seat };
}

/** An integer-like SQL parameter never reaches a column name: slots come from the closed enum. */
export const identifier = (name: string) => sql.identifier(name);
