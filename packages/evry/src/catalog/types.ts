import type { Transaction } from "@everyfield/db/client";
import type { z } from "zod";
import type { EvryActor } from "../context/actor.ts";

/**
 * One returned row. Only these fields reach the model; the id lets a later read or selection name it again.
 * Selection re-checks `person` rows only. A household, tag, skill, activity, file, import, message or date row is not a person.
 */
export type SourceRow = {
	kind: "person" | "household" | "tag" | "skill" | "activity" | "file" | "import" | "message" | "date";
	id: string;
	label: string;
	/** `you: true` marks the signed-in user's own person row (see person-row.ts); no other row carries it. */
	fields: Record<string, string | boolean | null>;
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
	/**
	 * Reads what the input names outside the read's transaction, such as a file attached in this conversation; its
	 * answer reaches `invoke` as `loaded`. A read with no conversation's files refuses as attachment_elsewhere.
	 */
	load?(input: I, files: ConversationFiles): Promise<unknown>;
	invoke(tx: Transaction, actor: EvryActor, input: I, loaded?: unknown): Promise<SourceResult>;
};

/** The files attached in the turn's own conversation (attachments/store.ts): a file's exact bytes by its id. */
export type ConversationFiles = { read(attachmentId: string): Promise<Uint8Array> };
