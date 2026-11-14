import type { PipelineImportFileProblem } from "@everyfield/contracts/organizations";
import ExcelJS from "exceljs";
import { Refusal } from "../core.ts";
import { parseCsv } from "./format.ts";

// One table of text from an uploaded spreadsheet: a UTF-8 CSV through the People CSV parser, or the first worksheet of
// an Excel (.xlsx) file, such as a Microsoft Forms export. Every cell is plain text; a formula is kept as its text with
// its leading "=", never evaluated. Line ends inside a cell read as "\n" either way, so the same answers read the same.

export type SheetLimits = { bytes: number; rows: number; columns: number };
export type SheetProblem = PipelineImportFileProblem;
export class SheetRefused extends Error {
	readonly problem: SheetProblem;
	constructor(problem: SheetProblem) {
		super(problem);
		this.problem = problem;
	}
}
const refuse = (problem: SheetProblem): never => {
	throw new SheetRefused(problem);
};

/** The header's titles and each data row's cells, as many as the header has, plus any extra cells that hold text. */
export type Sheet = { header: string[]; rows: string[][] };

/** The file's format from its name: only .csv and .xlsx are read. */
export function sheetFormat(fileName: string): "csv" | "xlsx" | null {
	const ext = /\.([^.]+)$/.exec(fileName.trim().toLowerCase())?.[1];
	return ext === "csv" ? "csv" : ext === "xlsx" ? "xlsx" : null;
}

export async function readSheet(bytes: Uint8Array, fileName: string, limits: SheetLimits): Promise<Sheet> {
	const format = sheetFormat(fileName) ?? refuse("file_type");
	if (bytes.length > limits.bytes) refuse("file_too_large");
	if (bytes.length === 0) refuse("file_empty");
	const table = format === "csv" ? readCsv(bytes, limits) : await readXlsx(bytes, limits);
	// Trailing empty header cells are not columns; a header with no title at all is no header.
	const [first, ...rest] = table;
	if (!first) refuse("file_empty");
	let width = first!.length;
	while (width > 0 && first![width - 1]!.trim() === "") width--;
	if (width === 0) refuse("no_header");
	if (width > limits.columns) refuse("column_limit");
	const rows = rest.filter((r) => r.some((v) => v.trim() !== ""));
	if (rows.length === 0) refuse("no_rows");
	if (rows.length > limits.rows) refuse("row_limit");
	return { header: first!.slice(0, width).map((t) => t.trim()), rows };
}

const lines = (value: string) => value.replace(/\r\n?/g, "\n");

function readCsv(bytes: Uint8Array, limits: SheetLimits): string[][] {
	let text: string;
	try {
		// A leading byte order mark is removed; bytes that are not UTF-8 text are refused.
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return refuse("file_unreadable");
	}
	if (text.includes("\0")) refuse("file_unreadable");
	if (text.trim() === "") refuse("file_empty");
	try {
		// The header and one record past the limit, so a file over it is refused as soon as the parser sees it.
		return parseCsv(text, limits.rows + 2).map((r) => r.fields.map(lines));
	} catch (error) {
		if (error instanceof Refusal) return refuse(error.code === "row_limit_exceeded" ? "row_limit" : "file_unreadable");
		throw error;
	}
}

/** Uncompressed bytes an .xlsx may hold, by its own central directory, before any part is inflated. */
const EXPANDED_MAX = 64 * 1024 * 1024;
const EOCD = 0x06054b50,
	CENTRAL = 0x02014b50;
/** The sum of the uncompressed sizes the zip declares, or null when it has no readable central directory. */
function declaredSize(b: Uint8Array): number | null {
	const u16 = (o: number) => b[o]! | (b[o + 1]! << 8);
	const u32 = (o: number) => (u16(o) | (u16(o + 2) << 16)) >>> 0;
	for (let end = b.length - 22; end >= Math.max(0, b.length - 22 - 0xffff); end--) {
		if (u32(end) !== EOCD) continue;
		let at = u32(end + 16),
			total = 0;
		for (let n = u16(end + 10); n > 0; n--) {
			if (at + 46 > b.length || u32(at) !== CENTRAL) return null;
			total += u32(at + 24);
			at += 46 + u16(at + 28) + u16(at + 30) + u16(at + 32);
		}
		return total;
	}
	return null;
}

async function readXlsx(bytes: Uint8Array, limits: SheetLimits): Promise<string[][]> {
	const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
	const declared = zip ? declaredSize(bytes) : null;
	if (declared === null || declared > EXPANDED_MAX) refuse("file_unreadable");
	const book = new ExcelJS.Workbook();
	try {
		await book.xlsx.load(Buffer.from(bytes) as never);
	} catch {
		refuse("file_unreadable");
	}
	const sheet = book.worksheets[0];
	if (!sheet || sheet.actualRowCount === 0) refuse("file_empty");
	if (sheet!.actualRowCount > limits.rows + 1) refuse("row_limit");
	const table: string[][] = [];
	sheet!.eachRow({ includeEmpty: false }, (row) => {
		const cells: string[] = [];
		row.eachCell({ includeEmpty: true }, (cell, column) => {
			// A formula, shared or not, as the text typed in the cell.
			cells[column - 1] = cell.type === ExcelJS.ValueType.Formula ? "=" + cell.formula : cellText(cell.value);
		});
		table.push(Array.from(cells, (v) => v ?? ""));
	});
	return table;
}

/** A cell as the text a person sees typed in it. */
function cellText(value: ExcelJS.CellValue): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return lines(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
	if (value instanceof Date) {
		// Excel stores a local time with no zone, which exceljs reads as UTC: show it as written.
		const iso = value.toISOString();
		return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
	}
	if ("richText" in value) return lines(value.richText.map((r) => r.text).join(""));
	if ("hyperlink" in value) return lines(String(value.text ?? value.hyperlink));
	if ("error" in value) return String(value.error);
	return "";
}
