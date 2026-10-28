/**
 * A stored spec, read as sections. One parser serves the proof gate (which criteria need proof) and the seat context
 * (which text a seat must see), so the two never disagree about what the Done list is.
 *
 * A section starts at a Markdown heading or at an unindented label line: Goal, Done (criteria, when), Non-goals,
 * Approach, Facts or Decisions, plain ("Done when:"), bold ("**Non-goals**") or with text after the colon
 * ("Non-goals: lighting."). Blank lines never end a section. Text before the first section is one "other" section.
 */

export type SectionKind = "goal" | "done" | "non-goals" | "other";
export type Section = { kind: SectionKind; title: string; lines: string[] };

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const LABEL = /^[*_]{0,2}(goal|done(?: criteria| when)?|non-goals|approach|facts|decisions)\b([^:\n]{0,60}?)[*_]{0,2}\s*(?::|$)/i;

const kindOf = (title: string): SectionKind =>
	/^non-goals/i.test(title) ? "non-goals" : /^done\b/i.test(title) ? "done" : /^goal\b/i.test(title) ? "goal" : "other";

function sectionStart(line: string): string | null {
	const heading = HEADING.exec(line);
	if (heading) return heading[1]!.replace(/[*_]/g, "").trim();
	const label = LABEL.exec(line);
	return label ? `${label[1]}${label[2]}`.trim() : null;
}

export function specSections(spec: string): Section[] {
	const out: Section[] = [];
	for (const line of spec.split("\n")) {
		const title = sectionStart(line);
		if (title !== null) out.push({ kind: kindOf(title), title, lines: [line] });
		else if (out.length) out.at(-1)!.lines.push(line);
		else out.push({ kind: "other", title: "", lines: [line] });
	}
	return out;
}

/** A numbered line ("1.", "  2.") starts a Done criterion. */
const NUMBERED = /^\s*(\d+)\./;

/** The numbered Done criteria of a spec, as written, from the first Done section. */
export function doneCriteria(spec: string | null): string[] {
	const done = spec ? specSections(spec).find((s) => s.kind === "done") : undefined;
	return (done?.lines.slice(1) ?? []).flatMap((line) => NUMBERED.exec(line)?.[1] ?? []);
}

/**
 * A section's items, one line each: the header line, then each numbered or bulleted line joined with the lines under
 * it. Blank lines are dropped.
 */
export function sectionItems(lines: string[]): string[] {
	const items: string[][] = [];
	lines.forEach((line, i) => {
		if (i < 2 || NUMBERED.test(line) || /^\s*[-*+]\s/.test(line)) items.push([line]);
		else items.at(-1)!.push(line);
	});
	return items.map((item) => item.map((l) => l.trim()).filter(Boolean).join(" ")).filter(Boolean);
}
