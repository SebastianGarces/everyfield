import { brandError } from "@everyfield/contracts/branding";
import { sql, type SQL } from "@everyfield/db/query";
import "server-only";
import { z } from "zod";
import { liveRead, type RequestActor } from "../access/session.ts";
import { plantViewer, type PlantViewer } from "../documents/access.ts";
import { defineRefusals, type Deny } from "../operations/refusals.ts";

const refusals = defineRefusals(brandError);
export const deny: Deny<typeof brandError> = refusals.deny;
export const { settle } = refusals;
export function parse<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
	const found = schema.safeParse(raw);
	if (found.success) return found.data;
	deny("invalid_input", {
		issues: found.error.issues
			.slice(0, 50)
			.map((issue) => ({ path: issue.path.join(".").slice(0, 200), problem: issue.message.slice(0, 200) })),
	});
}

export type Scope = PlantViewer & { admin: SQL; seat: SQL };
export function scopeOf(authority: RequestActor): Scope {
	const viewer = plantViewer(authority);
	if (!viewer) deny("access_denied");
	const seat = liveRead(viewer.access, false);
	return { ...viewer, admin: viewer.access.role === "member" ? sql`false` : seat, seat };
}
