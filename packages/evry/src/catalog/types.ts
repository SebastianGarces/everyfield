import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { MailPort, NativePorts } from "../proposals/types.ts";
import type { WriteTx } from "@everyfield/domain/access";

export type SourceRow = {
	kind:
		| "person"
		| "retired_person"
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

type AccountWording<I> = { description: string; input?: z.ZodType<I> };

export function worded<I, T extends { description: string; input: z.ZodType<I>; account?: AccountWording<I> }>(
	actor: EvryActor,
	tool: T,
): T {
	if (actor.owner.kind !== "account" || !tool.account) return tool;
	return { ...tool, description: tool.account.description, input: tool.account.input ?? tool.input };
}

export type ReadAdapter<I> = {
	operation: string;
	description: string;
	account?: AccountWording<I>;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	load?(input: I, files: ConversationFiles): Promise<unknown>;
	invoke(
		tx: WriteTx,
		actor: EvryActor,
		input: I,
		native: NativePorts | null,
		loaded?: unknown,
		mail?: MailPort | null,
	): Promise<SourceResult>;
};

export type ConversationFiles = { read(attachmentId: string): Promise<Uint8Array> };
