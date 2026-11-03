// The table rules the editor and every renderer share: how a number prints, how wide a column is, how an amount typed by
// hand reads, and which exports follow from the body. One copy here, so the editor shows what the PDF, Word and Excel print.
import { FORMAT_SCHEMA } from "./schema.ts";
import type { BlockNode, ColumnSpec, DocDocument, ExportFormat } from "./types.ts";

const grouped = (n: number) => String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * `$1,234` for money (with cents when the amount has them), `1,234.5` for a number. Money rounds to whole cents first,
 * so a sum such as 0.20 + 0.70 + 0.10, whose float result is 0.9999999999999999, prints `$1` and not `$0.100`.
 */
export function formatNumber(value: number, kind: "money" | "number") {
	if (kind === "money") {
		const totalCents = Math.round(Math.abs(value) * 100);
		const dollars = Math.floor(totalCents / 100);
		const cents = totalCents % 100;
		const sign = value < 0 && totalCents > 0 ? "-" : "";
		return `${sign}$${grouped(dollars)}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
	}
	const abs = +Math.abs(value).toFixed(4);
	const sign = value < 0 && abs > 0 ? "-" : "";
	const decimals = Number.isInteger(abs) ? "" : String(abs).replace(/^\d+/, "");
	return `${sign}${grouped(abs)}${decimals}`;
}

/** True when a money amount carries cents (an Excel column then shows two decimals). */
export const hasCents = (value: number) => Math.round(Math.abs(value) * 100) % 100 !== 0;

/** The narrowest a column shares out, in points. */
export const MIN_COLUMN = 24;

/** Column widths in points: fixed widths as given, the rest of `width` shared by the columns with width 0. */
export function columnWidths(cols: readonly Pick<ColumnSpec, "width">[], width: number) {
	const fixed = cols.reduce((s, c) => s + c.width, 0);
	const auto = cols.filter((c) => c.width === 0).length;
	const share = auto ? Math.max(MIN_COLUMN, (width - fixed) / auto) : 0;
	return cols.map((c) => +(c.width || share).toFixed(2));
}

export type AmountKind = "money" | "number";
export type Amount = { ok: true; value: number | null } | { ok: false; message: string };

const AMOUNT = /^(-)?\$?(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

/**
 * An amount typed by hand. Blank is no amount (null). `$3,000`, `3000.50` and `-20` read; money rounds to cents.
 * Anything else is refused with a message that says what to type.
 */
export function parseAmount(text: string, kind: AmountKind): Amount {
	const raw = text.trim();
	if (raw === "") return { ok: true, value: null };
	const match = AMOUNT.exec(raw);
	const refuse = (): Amount => ({
		ok: false,
		message: `"${raw.length > 24 ? `${raw.slice(0, 24)}…` : raw}" is not an amount. Type a number such as 3000, $3,000.50 or -20.`,
	});
	if (!match || (match[1] && match[2])) return refuse();
	const [, lead, tail, whole = "0", fraction = ""] = match;
	const digits = whole.replace(/,/g, "");
	if (digits.length > 12 || fraction.length > 10) return refuse();
	let value = Number(`${digits}.${fraction || "0"}`);
	if (kind === "money") value = Math.round((value + Number.EPSILON) * 100) / 100;
	if (lead || tail) value = -value;
	return { ok: true, value: value === 0 ? 0 : value };
}

/** The limits the format sets on a table. */
const TABLE = FORMAT_SCHEMA.nodes.table;
export const TABLE_LIMITS = {
	columns: TABLE?.attrs.columns?.max ?? 16,
	rows: TABLE?.content?.max ?? 1000,
	writeInRows: { min: TABLE?.attrs.writeInRows?.min ?? 0, max: TABLE?.attrs.writeInRows?.max ?? 200 },
} as const;

/** True when the body holds a budget table (a ledger), in a column or a box too. The page header and footer do not count. */
export function bodyHasLedger(body: DocDocument["body"]): boolean {
	const walk = (nodes: readonly BlockNode[] | undefined): boolean =>
		(nodes ?? []).some(
			(node) =>
				(node.type === "table" && node.attrs.style === "ledger") ||
				(node.type === "columns" && node.content.some((col) => walk(col.content))) ||
				(node.type === "box" && walk(node.content)),
		);
	return walk(body.content);
}

/**
 * The `exports` list that follows from the body: Excel only while the body holds a budget table. A list that is already
 * right comes back unchanged, so a document without a budget table keeps its stored order.
 */
export function exportsFor(exports: readonly ExportFormat[], body: DocDocument["body"]): ExportFormat[] {
	const has = exports.includes("xlsx");
	const ledger = bodyHasLedger(body);
	if (ledger === has) return [...exports];
	return ledger ? [...exports, "xlsx"] : exports.filter((format) => format !== "xlsx");
}
