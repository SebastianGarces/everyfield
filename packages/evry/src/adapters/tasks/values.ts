import { z } from "zod";

export const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const localDue = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/)
	.describe("Church-local date (2026-11-16) or date and time (2026-11-16T09:00)");
export const dueOf = (value: string | null | undefined) =>
	!value
		? ({ kind: "undated" } as const)
		: value.length === 10
			? ({ kind: "local_date", date: value } as const)
			: ({ kind: "resolved_instant", local: value } as const);
