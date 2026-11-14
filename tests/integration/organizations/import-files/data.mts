// The rows of the pipeline import fixtures (T-363). Row 1 is the header of a Microsoft Forms export: the form's own
// ID, times, Email and Name columns, then its questions.
export const APPLICATIONS: string[][] = [
	[
		"ID",
		"Start time",
		"Completion time",
		"Email",
		"Name",
		"Full name",
		"Email address",
		"Phone number",
		"Describe your calling",
		"Spouse's name",
		"Have you completed a background check?",
	],
	[
		"1",
		"2026-10-03 14:02",
		"2026-10-03 14:22",
		"anonymous",
		"",
		"Jordan Reyes",
		"jordan@example.test",
		"512-555-0101",
		"East Austin, among young families.\nWe have prayed about it for two years, together.",
		"Maria Reyes",
		"Yes, in 2025",
	],
	[
		"2",
		"2026-10-05 09:10",
		"2026-10-05 09:31",
		"anonymous",
		"",
		"Sam Ortiz",
		"Sam@Example.test",
		"",
		"Students near campus, starting with a dinner table",
		"",
		"No",
	],
	[
		"3",
		"2026-10-06 18:40",
		"2026-10-06 18:55",
		"anonymous",
		"",
		"Casey Lee",
		"casey@example.test",
		"512-555-0103",
		"Ready to apprentice",
		"Jo Lee",
		"Yes",
	],
];
/** applications-v2.xlsx: the same titles, questions first and the form's own columns last. */
export const V2_ORDER = [6, 5, 8, 10, 9, 7, 0, 3, 4, 1, 2];

/** A UTF-8 CSV with a byte order mark and CRLF line ends, every field quoted where it needs it. */
export function csvOf(rows: string[][]) {
	const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""').replaceAll("\n", "\r\n")}"` : v);
	return "﻿" + rows.map((r) => r.map(cell).join(",") + "\r\n").join("");
}
