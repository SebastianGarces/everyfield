import { FORMAT_SCHEMA, type BlockNode, type ChurchDocument, type PageSize } from "@everyfield/contracts/documents";
import { FORMAT_LABEL } from "../model.ts";

// Words the Church Documents screens share.

export const CLASS_LABEL: Record<ChurchDocument["documentClass"], string> = {
	"formal/legal": "Formal or legal",
	"outward-facing": "Outward-facing",
	operational: "Operational",
};

/** "PDF, Word and Excel", in that order. */
export function formatList(formats: readonly (keyof typeof FORMAT_LABEL)[]) {
	const names = (["pdf", "docx", "xlsx"] as const).filter((f) => formats.includes(f)).map((f) => FORMAT_LABEL[f]);
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/** The paper sizes by the name Page setup shows. */
export const PAPER_LABEL: Record<PageSize, string> = {
	letter: "Letter",
	legal: "Legal",
	a4: "A4",
	"half-letter": "Half Letter",
	"card-4x6": "4 x 6 card",
	custom: "Custom",
};

/** The named paper sizes by their portrait points, "612x792" for Letter. */
const SIZES: Record<string, string> = Object.fromEntries(
	Object.entries(FORMAT_SCHEMA.pageSizes).map(([size, box]) => [
		`${box.width}x${box.height}`,
		PAPER_LABEL[size as PageSize] ?? size,
	]),
);

/** The blocks whose name does not depend on their attributes, as Insert and template compare both say it. */
export const BLOCK_NAME = {
	paragraph: "Paragraph",
	bulletList: "Bulleted list",
	orderedList: "Numbered list",
	quote: "Quote",
	divider: "Divider",
	spacer: "Spacer",
	pageBreak: "Page break",
	box: "Colored box",
	table: "Table",
} as const;

const named = (type: keyof typeof BLOCK_NAME) => () => BLOCK_NAME[type];

/** What a block is called: "Paragraph", "Heading 2", "3 columns". A heading with no level is the format's level 2. */
const BLOCK_LABEL: Record<string, (block: BlockNode) => string> = {
	paragraph: named("paragraph"),
	heading: (b) => `Heading ${(b.attrs as { level?: number } | undefined)?.level ?? 2}`,
	bulletList: named("bulletList"),
	orderedList: named("orderedList"),
	quote: named("quote"),
	divider: named("divider"),
	spacer: named("spacer"),
	pageBreak: named("pageBreak"),
	columns: (b) => `${(b as { content?: unknown[] }).content?.length ?? 2} columns`,
	box: named("box"),
	image: (b) => {
		const source = (b.attrs as { source?: string } | undefined)?.source ?? "logo";
		return source === "mark" ? "Mark" : source === "photo" ? "Photo" : "Logo";
	},
	writeIn: (b) => {
		const kind = (b.attrs as { kind?: string } | undefined)?.kind;
		return kind === "signature" ? "Signature line" : kind === "date" ? "Date line" : "Write-in line";
	},
	slot: (b) => (b.attrs as { label?: string } | undefined)?.label ?? "Section",
	table: named("table"),
};

export const blockLabel = (block: BlockNode) => BLOCK_LABEL[block.type]?.(block) ?? "Block";

/** "Letter" or "4 cards on one Letter sheet". */
export function paperText(page: { width: number; height: number; perSheet: number }) {
	const portrait = page.width <= page.height ? `${page.width}x${page.height}` : `${page.height}x${page.width}`;
	const name = SIZES[portrait] ?? `${Math.round(page.width)} x ${Math.round(page.height)} pt`;
	const sheet = page.width > page.height ? `${name}, landscape` : name;
	return page.perSheet > 1 ? `${page.perSheet} cards on one ${sheet} sheet` : sheet;
}

/** "Updated Nov 1, 2026". */
export function updatedText(iso: string) {
	const date = new Date(iso);
	return `Updated ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

/** "Nov 8, 2026, 3:04 PM" in the reader's own time zone. */
export function savedAt(iso: string) {
	return new Date(iso).toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
