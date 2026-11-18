import { FORMAT_SCHEMA, type BlockNode, type ChurchDocument, type PageSize } from "@everyfield/contracts/documents";
import { FORMAT_LABEL } from "../model.ts";

export const CLASS_LABEL: Record<ChurchDocument["documentClass"], string> = {
	"formal/legal": "Formal or legal",
	"outward-facing": "Outward-facing",
	operational: "Operational",
};

export function formatList(formats: readonly (keyof typeof FORMAT_LABEL)[]) {
	const names = (["pdf", "docx", "xlsx"] as const).filter((f) => formats.includes(f)).map((f) => FORMAT_LABEL[f]);
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

export const PAPER_LABEL: Record<PageSize, string> = {
	letter: "Letter",
	legal: "Legal",
	a4: "A4",
	"half-letter": "Half Letter",
	"card-4x6": "4 x 6 card",
	custom: "Custom",
};

const SIZES: Record<string, string> = Object.fromEntries(
	Object.entries(FORMAT_SCHEMA.pageSizes).map(([size, box]) => [
		`${box.width}x${box.height}`,
		PAPER_LABEL[size as PageSize] ?? size,
	]),
);

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

const BLOCK_LABEL: Record<string, (block: BlockNode) => string> = {
	heading: (b) => `Heading ${(b.attrs as { level?: number } | undefined)?.level ?? 2}`,
	columns: (b) => `${(b as { content?: unknown[] }).content?.length ?? 2} columns`,
	image: (b) => {
		const source = (b.attrs as { source?: string } | undefined)?.source ?? "logo";
		return source === "mark" ? "Mark" : source === "photo" ? "Photo" : "Logo";
	},
	writeIn: (b) => {
		const kind = (b.attrs as { kind?: string } | undefined)?.kind;
		return kind === "signature" ? "Signature line" : kind === "date" ? "Date line" : "Write-in line";
	},
	slot: (b) => (b.attrs as { label?: string } | undefined)?.label ?? "Section",
};

export const blockLabel = (block: BlockNode): string =>
	(BLOCK_NAME as Record<string, string>)[block.type] ?? BLOCK_LABEL[block.type]?.(block) ?? "Block";

export function paperText(page: { width: number; height: number; perSheet: number }) {
	const portrait = page.width <= page.height ? `${page.width}x${page.height}` : `${page.height}x${page.width}`;
	const name = SIZES[portrait] ?? `${Math.round(page.width)} x ${Math.round(page.height)} pt`;
	const sheet = page.width > page.height ? `${name}, landscape` : name;
	return page.perSheet > 1 ? `${page.perSheet} cards on one ${sheet} sheet` : sheet;
}

export function updatedText(iso: string) {
	const date = new Date(iso);
	return `Updated ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })}`;
}

export function archivedText(iso: string, by: string | null) {
	const date = new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
	return `Archived ${date} by ${by ?? "a former member"}`;
}
