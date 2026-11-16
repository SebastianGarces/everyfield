import { FORMAT_SCHEMA } from "./schema.ts";
import type { BlockNode, ColumnSpec, DocDocument, ExportFormat, TableNode } from "./types.ts";

const grouped = (n: number) => String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

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

export function columnWidths(cols: readonly Pick<ColumnSpec, "width">[], width: number) {
	const fixed = cols.reduce((s, c) => s + c.width, 0);
	const auto = cols.filter((c) => c.width === 0).length;
	const share = auto ? Math.max(24, (width - fixed) / auto) : 0;
	return cols.map((c) => +(c.width || share).toFixed(2));
}

type Amount = { ok: true; value: number | null } | { ok: false; message: string };

const AMOUNT = /^(-)?\$?(-)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;

export function parseAmount(text: string, kind: "money" | "number"): Amount {
	const raw = text.trim();
	if (raw === "") return { ok: true, value: null };
	const match = AMOUNT.exec(raw);
	const refuse = (): Amount => ({
		ok: false,
		message: `"${raw}" is not an amount. Type a number such as 3000, $3,000.50 or -20.`,
	});
	if (!match || (match[1] && match[2])) return refuse();
	const [, lead, tail, whole = "0", fraction = ""] = match;
	const digits = whole.replace(/,/g, "");
	if (digits.length > 12 || fraction.length > 10) return refuse();
	let value = Number(`${digits}.${fraction || "0"}`);
	if (kind === "money") value = Math.round((value + Number.EPSILON) * 100) / 100;
	if (lead || tail) value = -value;
	return { ok: true, value };
}

const TABLE = FORMAT_SCHEMA.nodes.table;
export const TABLE_LIMITS = {
	columns: TABLE?.attrs.columns?.max ?? 16,
	rows: TABLE?.content?.max ?? 1000,
} as const;

export function ledgerTables(body: DocDocument["body"]): TableNode[] {
	const out: TableNode[] = [];
	const walk = (nodes: readonly BlockNode[] | undefined) => {
		for (const node of nodes ?? []) {
			if (node.type === "table" && node.attrs.style === "ledger") out.push(node);
			if (node.type === "columns") for (const col of node.content) walk(col.content);
			if (node.type === "box") walk(node.content);
		}
	};
	walk(body.content);
	return out;
}

export function exportsFor(exports: readonly ExportFormat[], body: DocDocument["body"]): ExportFormat[] {
	const has = exports.includes("xlsx");
	const ledger = ledgerTables(body).length > 0;
	if (ledger === has) return [...exports];
	return ledger ? [...exports, "xlsx"] : exports.filter((format) => format !== "xlsx");
}
