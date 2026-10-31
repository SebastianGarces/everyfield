import type { BlockKind, BlockRow } from "@/components/BlockEditor";
import {
	BLOCK_TEXT_MAX,
	BODY_BLOCKS_MAX,
	BODY_JSON_MAX,
	type ChurchBlock,
	type ChurchPage,
} from "@everyfield/contracts/documents";
import type { Template } from "./model.ts";

// Church Documents on the screen: the body as editor rows and back, the checks that run before a save, and the words
// for each refusal. Pure functions, so the editor and its tests share one definition.

export type Slot = ChurchPage["slots"][number];
type ChurchClass = ChurchPage["document"]["documentClass"];

export const CLASS_LABEL: Record<ChurchClass, string> = {
	"formal/legal": "Formal and legal",
	"outward-facing": "Outward-facing",
	operational: "Operational",
};

const TEXT_KIND: Record<string, BlockKind> = {
	heading: "heading",
	subheading: "subheading",
	paragraph: "paragraph",
	quote: "quote",
};

/** The body as editor rows. A slot row is keyed by its slot id, so its place and label survive any edit. */
export function rowsFromBody(body: readonly ChurchBlock[], slots: readonly Slot[]): BlockRow[] {
	const rows = body.map((block, index): BlockRow => {
		if (block.kind === "slot") {
			const label = slots.find((slot) => slot.id === block.slotId)?.label ?? block.slotId;
			return { key: `slot:${block.slotId}`, kind: "paragraph", text: block.text, slot: { label } };
		}
		if ("items" in block)
			return {
				key: `b-${index}`,
				kind: block.kind === "numbered_list" ? "numbered" : "list",
				text: block.items.join("\n"),
			};
		return { key: `b-${index}`, kind: TEXT_KIND[block.kind] ?? "paragraph", text: block.text };
	});
	return rows.length ? rows : [{ key: "b-0", kind: "paragraph", text: "" }];
}

/** Rows as a body. A blank block is dropped. A slot always stays, even blank. */
export function bodyFromRows(rows: readonly BlockRow[]): ChurchBlock[] {
	const body: ChurchBlock[] = [];
	for (const row of rows) {
		if (row.slot) {
			body.push({ kind: "slot", slotId: row.key.slice("slot:".length), text: row.text });
			continue;
		}
		if (row.kind === "list" || row.kind === "numbered") {
			const items = row.text.split("\n").filter((line) => line.trim());
			if (items.length) body.push({ kind: row.kind === "list" ? "bulleted_list" : "numbered_list", items });
			continue;
		}
		if (!row.text.trim()) continue;
		body.push({ kind: row.kind, text: row.text });
	}
	return body;
}

/** True when the editor holds the same body as the saved one. */
export function sameBody(rows: readonly BlockRow[], saved: readonly ChurchBlock[]) {
	return JSON.stringify(bodyFromRows(rows)) === JSON.stringify(saved);
}

const EMPTY = "Add some text before you save.";
const TOO_LONG = "Shorten the document. It is too long to save.";

/** A plain message when the body cannot be saved, else null. Runs before any request. */
export function bodyProblem(rows: readonly BlockRow[]): string | null {
	const body = bodyFromRows(rows);
	if (!body.some((block) => ("items" in block ? true : block.text.trim().length > 0))) return EMPTY;
	let count = 0;
	for (const block of body) {
		count += "items" in block ? block.items.length : 1;
		const texts = "items" in block ? block.items : [block.text];
		if (texts.some((text) => text.length > BLOCK_TEXT_MAX)) return TOO_LONG;
	}
	if (count > BODY_BLOCKS_MAX || JSON.stringify(body).length > BODY_JSON_MAX) return TOO_LONG;
	return null;
}

/** What the template panel offers for one template. */
export type CreateOffer = "create" | "owner_only" | "not_ready" | "none";
export function createOffer(template: Pick<Template, "editable">, canCreate: boolean): CreateOffer {
	if (template.editable === null) return "none";
	if (template.editable === "pending") return "not_ready";
	return canCreate ? "create" : "owner_only";
}

/** A time in the church plant's time zone, in one fixed format. */
export function plantTime(iso: string, timeZone: string) {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

export const THEME_LABEL = { church: "Church theme", "everyfield-neutral": "Everyfield-neutral theme" } as const;

type Refusal = { code: string; problem?: string; slotIds?: string[] };

/** A sentence for a refused Church Document action. It never shows a code or an id. */
export function churchProblem(refusal: Refusal | "lost", fallback: string, slots: readonly Slot[] = []) {
	if (refusal === "lost") return fallback;
	switch (refusal.code) {
		case "conflict":
			return "Someone saved a newer version. Your edits are still here. Reload to see the newer version.";
		case "access_denied":
			return "Only an Owner or Admin of the church plant can do this.";
		case "invalid_input":
			return refusal.problem ?? fallback;
		case "render_failed":
			return "The file could not be made. Nothing was saved.";
		case "template_not_authored":
			return "The editable version of this template is not ready yet.";
		case "unavailable":
			return "This document is not available.";
		case "slot_not_deletable": {
			const names = (refusal.slotIds ?? []).map((id) => slots.find((slot) => slot.id === id)?.label ?? id);
			return `The ${names.join(" and ")} slot cannot be removed. Nothing was saved, and your edits are still here.`;
		}
		default:
			return fallback;
	}
}
