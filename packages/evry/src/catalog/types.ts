import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { NativePorts } from "../proposals/types.ts";
import type { WriteTx } from "@everyfield/domain/access";

export type SourceRow = {
	kind:
		| "person"
		| "household"
		| "tag"
		| "skill"
		| "activity"
		| "file"
		| "import"
		| "message"
		| "notice"
		| "setting"
		| "digest"
		| "team"
		| "role"
		| "training"
		| "meeting"
		| "responsibility"
		| "template"
		| "venue"
		| "item"
		| "seat"
		| "invitation"
		| "connection"
		| "step"
		| "relationship"
		| "stage"
		| "milestone";
	id: string;
	label: string;
	fields: Record<string, string | number | boolean | null>;
};

export type SourceResult = {
	operation: string;
	status: "available" | "not_found";
	rows: SourceRow[];
	total: number | null;
	page: number;
	next: number | null;
	completeness: "complete" | "partial";
	exclusions: string[];
	facts?: Record<string, string | number | boolean | null>;
};

export type ReadAdapter<I> = {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	invoke(tx: WriteTx, actor: EvryActor, input: I, native: NativePorts | null): Promise<SourceResult>;
};
