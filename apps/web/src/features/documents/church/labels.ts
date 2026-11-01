import type { ChurchDocument } from "@everyfield/contracts/documents";

// Words the Church Documents screens share.

export const CLASS_LABEL: Record<ChurchDocument["documentClass"], string> = {
	"formal/legal": "Formal or legal",
	"outward-facing": "Outward-facing",
	operational: "Operational",
};

const FORMAT_LABEL = { pdf: "PDF", docx: "Word", xlsx: "Excel" } as const;

/** "PDF, Word and Excel", in that order. */
export function formatList(formats: readonly (keyof typeof FORMAT_LABEL)[]) {
	const names = (["pdf", "docx", "xlsx"] as const).filter((f) => formats.includes(f)).map((f) => FORMAT_LABEL[f]);
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

const SIZES: Record<string, string> = { "612x792": "Letter", "612x1008": "Legal", "595x842": "A4", "396x612": "Half letter", "288x432": "4 x 6 in card" };

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
