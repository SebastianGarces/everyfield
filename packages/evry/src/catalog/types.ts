import type { Transaction } from "@everyfield/db/client";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { NativePorts } from "../proposals/types.ts";

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
		| "record"
		| "merge"
		| "correction"
		| "notice"
		| "setting"
		| "digest"
		| "team"
		| "role"
		| "training"
		| "meeting"
		| "responsibility"
		| "template"
		| "task"
		| "tally"
		| "history"
		| "follow_up"
		| "contact"
		| "account"
		| "phase"
		| "criterion"
		| "signal"
		| "venue"
		| "item"
		| "seat"
		| "invitation"
		| "connection"
		| "step"
		| "relationship"
		| "stage"
		| "milestone"
		| "date"
		| "article"
		| "document";
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
	load?(input: I, files: ConversationFiles): Promise<unknown>;
	invoke(
		tx: Transaction,
		actor: EvryActor,
		input: I,
		native: NativePorts | null,
		loaded?: unknown,
	): Promise<SourceResult>;
};

export type ConversationFiles = { read(attachmentId: string): Promise<Uint8Array> };
