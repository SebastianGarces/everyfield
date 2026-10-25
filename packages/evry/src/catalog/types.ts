import type { Transaction } from "@everyfield/db/client";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";

/**
 * One returned row. Only these fields reach the model; the id lets a later read or selection name it again.
 * Selection re-checks `person` rows only. A household, tag, skill, activity, file or import row is not a person.
 */
export type SourceRow = {
	kind: "person" | "household" | "tag" | "skill" | "activity" | "file" | "import";
	id: string;
	label: string;
	fields: Record<string, string | null>;
};

/** A bounded, source-bound read result: the rows, the exact total, whether more exist and what was left out. */
export type SourceResult = {
	operation: string;
	status: "available" | "not_found";
	rows: SourceRow[];
	total: number | null;
	page: number;
	next: number | null;
	completeness: "complete" | "partial";
	exclusions: string[];
};

/** A reviewed adapter from one model-tool read operation to its native domain read. */
export type ReadAdapter<I> = {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	/** Current authority decides availability. Being in the catalog grants nothing. */
	allowed(actor: EvryActor): boolean;
	invoke(tx: Transaction, actor: EvryActor, input: I): Promise<SourceResult>;
};
