import { z } from "zod";

// The compact input values the Tasks and Follow-up tools share. Every tool schema is sent with every model call, so
// they stay short: the native command parses each value again with its own contract.

/** A record id from an earlier result. A short pattern: the native read or command checks the record itself. */
export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** The church's local date, or date and time, a task is due: "2026-11-16" or "2026-11-16T09:00". */
export const localDue = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
	.describe("Church-local date (2026-11-16) or date and time (2026-11-16T09:00)");
/** The native due input for a local due value, or undated. */
export const dueOf = (value: string | null | undefined) =>
	!value
		? ({ kind: "undated" } as const)
		: value.length === 10
			? ({ kind: "local_date", date: value } as const)
			: ({ kind: "resolved_instant", local: value } as const);
