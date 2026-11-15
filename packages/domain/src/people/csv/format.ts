import { deny } from "../core.ts";

export type CsvRecord = { line: number; fields: string[] };

const COMMA = 44,
	CR = 13,
	LF = 10,
	QUOTE = 34;

function breaks(text: string, from: number, to: number): number {
	let n = 0;
	for (let i = from; i < to; i++) {
		const ch = text.charCodeAt(i);
		if (ch === LF || (ch === CR && text.charCodeAt(i + 1) !== LF)) n++;
	}
	return n;
}

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

const formulaStart = /^[=+\-@\t\r]/;
const needsQuotes = /[",\r\n]/;
function cell(value: string | null): string {
	if (value === null) return "";
	const safe = formulaStart.test(value) ? "'" + value : value;
	return needsQuotes.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
}
export function csvLine(values: readonly (string | null)[]): string {
	return values.map(cell).join(",") + "\r\n";
}
