/**
 * A stored spec, read as sections. One parser serves the proof gate (which criteria need proof) and the seat context
 * (which text a seat must see), so the two never disagree about what the Done list is.
 *
 * A section starts at a Markdown heading or at an unindented label line: Goal, Done (criteria, when), Non-goals,
 * Approach, Facts, Decisions or Later slices, plain ("Done when:"), bold ("**Non-goals**") or with text after the colon
 * ("Non-goals: lighting."). Blank lines never end a section. Text before the first section is one "other" section.
 */

export type SectionKind = "goal" | "done" | "non-goals" | "other";
export type Section = { kind: SectionKind; title: string; lines: string[] };

const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;
const LABEL =
	/^[*_]{0,2}(goal|done(?: criteria| when)?|non-goals|approach|facts|decisions|later slices)\b([^:\n]{0,60}?)[*_]{0,2}\s*(?::|$)/i;

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
	return items
		.map((item) =>
			item
				.map((l) => l.trim())
				.filter(Boolean)
				.join(" "),
		)
		.filter(Boolean);
}

/**
 * The paragraphs of a stored ask that start with `Coordinator note`: instructions the coordinator added after the
 * owner's words. Idea, compare and session-start text keep them whole, because they change what a seat must do.
 */
export function coordinatorNotes(ask: string | null | undefined): string[] {
	return (ask ?? "")
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.filter((p) => /^coordinator note\b/i.test(p));
}

/**
 * The later slices of a spec: each numbered or bulleted item under a `## Later slices` heading or a `Later slices:`
 * label is one slice, its text joined from the lines under it. Prose before the first item is not a slice. A spec with
 * no such section gives an empty list.
 */
export function laterSlices(spec: string | null | undefined): string[] {
	if (!spec) return [];
	const section = specSections(spec).find((s) => /^later slices\b/i.test(s.title));
	if (!section) return [];
	const items: string[][] = [];
	for (const line of section.lines.slice(1)) {
		const start = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
		if (start) items.push([start[1]!.trim()]);
		else if (items.length && line.trim()) items.at(-1)!.push(line.trim());
	}
	return items.map((item) => item.join(" ")).filter(Boolean);
}

/**
 * How evf checks one Done criterion (OPS-112). `ac`: a test whose name carries `marker` (`AC:<task ref>-<n>`), which
 * `evf ac run` runs and turns into the proof row. `owner`: a taste call a person judges, with the reason no test can.
 */
type Check = { kind: "ac"; marker: string; task: string; n: string } | { kind: "owner"; reason: string };
type CriterionCheck = { criterion: string; values: string[]; check: Check | null };

const CHECK_LINE = /^\s*Check:\s*(.*?)\s*$/i;
const AC_VALUE = /^AC:(\S+)-(\d+)$/;
const OWNER_VALUE = /^owner\s*[—–-]\s*(\S.*)$/i;

/** One `Check:` value, or null when it is neither `AC:<task>-<n>` nor `owner — <reason>`. */
export function parseCheck(value: string): Check | null {
	const ac = AC_VALUE.exec(value);
	if (ac) return { kind: "ac", marker: value, task: ac[1]!, n: ac[2]! };
	const owner = OWNER_VALUE.exec(value);
	return owner ? { kind: "owner", reason: owner[1]!.trim() } : null;
}

/** Each numbered Done criterion with the `Check:` values written under it and the check they parse to. */
export function doneChecks(spec: string | null): CriterionCheck[] {
	const done = spec ? specSections(spec).find((s) => s.kind === "done") : undefined;
	const out: CriterionCheck[] = [];
	for (const line of done?.lines.slice(1) ?? []) {
		const n = NUMBERED.exec(line)?.[1];
		if (n) out.push({ criterion: n, values: [], check: null });
		else if (out.length && CHECK_LINE.test(line)) out.at(-1)!.values.push(CHECK_LINE.exec(line)![1]!);
	}
	for (const c of out) c.check = c.values.length === 1 ? parseCheck(c.values[0]!) : null;
	return out;
}

/** The criteria a test proves: their number and marker. */
export const acCriteria = (spec: string | null): Array<{ criterion: string; marker: string }> =>
	doneChecks(spec).flatMap((c) => (c.check?.kind === "ac" ? [{ criterion: c.criterion, marker: c.check.marker }] : []));

/**
 * Why each Done criterion of a spec for `taskRef` fails the `Check:` rule, one line per bad criterion. With `required`
 * every criterion needs one valid line; without it the rule applies only once the spec has any `Check:` line.
 */
export function checkProblems(spec: string, taskRef: string, required: boolean): string[] {
	const checks = doneChecks(spec);
	if (!required && !checks.some((c) => c.values.length)) return [];
	return checks.flatMap(({ criterion: n, values, check }) => {
		if (!values.length) return [`criterion ${n} has no Check: line`];
		if (values.length > 1) return [`criterion ${n} has ${values.length} Check: lines; give one`];
		if (!check) return [`criterion ${n}: "Check: ${values[0]}" is neither AC:${taskRef}-${n} nor owner — <reason>`];
		if (check.kind === "ac" && check.task !== taskRef)
			return [`criterion ${n}: ${check.marker} names task ${check.task}, not ${taskRef}`];
		if (check.kind === "ac" && check.n !== n)
			return [`criterion ${n}: ${check.marker} names criterion ${check.n}, not ${n}`];
		return [];
	});
}
