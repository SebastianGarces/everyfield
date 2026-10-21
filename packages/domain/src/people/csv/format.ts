import { deny } from "../core.ts";

/** One CSV record and the physical line it starts on. */
export type CsvRecord = { line: number; fields: string[] };

const COMMA = 44,
	CR = 13,
	LF = 10,
	QUOTE = 34;

/** Line breaks in text[from, to): CRLF, LF and a lone CR each count once. */
function breaks(text: string, from: number, to: number): number {
	let n = 0;
	for (let i = from; i < to; i++) {
		const ch = text.charCodeAt(i);
		if (ch === LF || (ch === CR && text.charCodeAt(i + 1) !== LF)) n++;
	}
	return n;
}

/**
 * RFC 4180 records from decoded text: comma separated, CRLF, LF or CR line ends, quoted fields with doubled quotes and
 * embedded line breaks. A quote inside an unquoted field, text after a closing quote or an unterminated quote is
 * refused as malformed_csv_quoting with its line. Blank lines are not records. More than maxRecords records is refused
 * as soon as the parser sees one too many.
 */
export function parseCsv(text: string, maxRecords: number): CsvRecord[] {
	const records: CsvRecord[] = [],
		n = text.length;
	let i = 0,
		line = 1;
	while (i < n) {
		const start = line,
			fields: string[] = [];
		for (;;) {
			if (text.charCodeAt(i) === QUOTE) {
				const open = line;
				let value = "",
					from = ++i;
				for (;;) {
					const q = text.indexOf('"', i);
					if (q < 0) deny("malformed_csv_quoting", { line: open });
					line += breaks(text, i, q);
					if (text.charCodeAt(q + 1) === QUOTE) {
						value += text.slice(from, q + 1);
						i = from = q + 2;
						continue;
					}
					value += text.slice(from, q);
					i = q + 1;
					break;
				}
				const next = text.charCodeAt(i);
				if (i < n && next !== COMMA && next !== CR && next !== LF) deny("malformed_csv_quoting", { line });
				fields.push(value);
			} else {
				let j = i;
				for (; j < n; j++) {
					const ch = text.charCodeAt(j);
					if (ch === COMMA || ch === CR || ch === LF) break;
					if (ch === QUOTE) deny("malformed_csv_quoting", { line });
				}
				fields.push(text.slice(i, j));
				i = j;
			}
			if (i >= n) break;
			if (text.charCodeAt(i) === COMMA) {
				i++;
				continue;
			}
			i += text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
			line++;
			break;
		}
		if (fields.length === 1 && fields[0] === "") continue;
		if (records.length === maxRecords) deny("row_limit_exceeded");
		records.push({ line: start, fields });
	}
	return records;
}

// REQ-PPL-019: a cell a spreadsheet would read as a formula or control gets a leading apostrophe.
const formulaStart = /^[=+\-@\t\r]/;
const needsQuotes = /[",\r\n]/;
function cell(value: string | null): string {
	if (value === null) return "";
	const safe = formulaStart.test(value) ? "'" + value : value;
	return needsQuotes.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}
/** One RFC 4180 line with CRLF, every text cell neutralized against formula execution. */
export function csvLine(values: readonly (string | null)[]): string {
	return values.map(cell).join(",") + "\r\n";
}
