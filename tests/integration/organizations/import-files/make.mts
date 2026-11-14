// Writes the pipeline import fixtures (T-363) beside this script: a Microsoft Forms style export, the same titles in
// another column order, and the same rows as a UTF-8 CSV with a byte order mark, CRLF, quoted commas and multi-line
// answers. Run from packages/domain: npx tsx ../../tests/integration/organizations/import-files/make.mts
import { writeFileSync } from "node:fs";
import ExcelJS from "../../../../packages/domain/node_modules/exceljs/excel.js";
import { APPLICATIONS, csvOf, V2_ORDER } from "./data.mts";

const dir = new URL(".", import.meta.url);
async function xlsx(name: string, order: number[]) {
	const book = new ExcelJS.Workbook();
	const sheet = book.addWorksheet("Sheet1");
	for (const row of APPLICATIONS) sheet.addRow(order.map((i) => row[i]));
	writeFileSync(new URL(name, dir), new Uint8Array(await book.xlsx.writeBuffer()));
}
await xlsx("applications.xlsx", APPLICATIONS[0]!.map((_, i) => i));
await xlsx("applications-v2.xlsx", V2_ORDER);
writeFileSync(new URL("applications.csv", dir), csvOf(APPLICATIONS));
