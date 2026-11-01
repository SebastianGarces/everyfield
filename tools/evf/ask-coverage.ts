/**
 * The Ask coverage table of a verifier report (OPS-86). The verbatim ask names deliverables: routes, pages, sections,
 * screens, commands, files. The report opens with one row for each, before any criterion or check table:
 * `delivered`, `deferred <follow-up label>` or `missing`. post-review.mjs reads the report with this parser.
 */

export type CoverageRow = { deliverable: string; status: "delivered" | "deferred" | "missing"; label?: string };

const HEADING = /^## Ask coverage\s*$/m;
const cells = (line: string) =>
	line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((c) => c.trim());
const plain = (text: string) => text.replace(/[`*_]/g, "").trim();

/** The coverage rows of a report, or the reason the table is not acceptable. */
export function parseAskCoverage(report: string): { rows: CoverageRow[] } | { error: string } {
	const at = report.search(HEADING);
	if (at < 0)
		return { error: "the report needs an Ask coverage section: one row for each deliverable in the verbatim ask" };
	const before = report.slice(0, at).split("\n");
	if (before.some((l) => l.trim().startsWith("|")))
		return { error: "the Ask coverage section must come before the first criterion or check table" };
	const lines = report.slice(at).split("\n").slice(1);
	const end = lines.findIndex((l) => /^## /.test(l));
	const table = (end < 0 ? lines : lines.slice(0, end)).filter((l) => l.trim().startsWith("|"));
	const data = table.filter((l) => !cells(l).every((c) => /^:?-{2,}:?$/.test(c))).slice(1); // The first row is the header.
	if (!data.length) return { error: "the Ask coverage table has no deliverable rows" };
	const rows: CoverageRow[] = [];
	for (const line of data) {
		const [deliverable = "", status = ""] = cells(line);
		const s = plain(status);
		const deferred = /^deferred\s+(.+)$/i.exec(s);
		if (!plain(deliverable)) return { error: `an Ask coverage row names no deliverable: ${line.trim()}` };
		if (/^delivered$/i.test(s)) rows.push({ deliverable: plain(deliverable), status: "delivered" });
		else if (/^missing$/i.test(s)) rows.push({ deliverable: plain(deliverable), status: "missing" });
		else if (deferred) rows.push({ deliverable: plain(deliverable), status: "deferred", label: deferred[1]!.trim() });
		else
			return {
				error: `Ask coverage row "${plain(deliverable)}" has status "${s}"; use delivered, deferred <follow-up label> or missing`,
			};
	}
	return { rows };
}

/** Why a report with these rows cannot be approved, or null. `labels` are the follow-up labels the store holds for the task. */
export function approvalBlock(rows: CoverageRow[], labels: string[]): string | null {
	const missing = rows.filter((r) => r.status === "missing");
	if (missing.length)
		return `Ask coverage lists missing deliverables without a filed follow-up: ${missing.map((r) => r.deliverable).join("; ")}. Post changes_requested`;
	const unfiled = rows.filter((r) => r.status === "deferred" && !labels.includes(r.label!));
	if (unfiled.length)
		return `Ask coverage defers to labels that are not follow-ups of this task: ${unfiled.map((r) => `${r.deliverable} -> ${r.label}`).join("; ")}. The task's follow-ups: ${labels.join(", ") || "none"}`;
	return null;
}
