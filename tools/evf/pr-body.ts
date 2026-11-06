import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { followUpsOfTask } from "./db.ts";
import { partialLine, type FollowUp } from "./followups.ts";
import { acVideoMarkers } from "./ac.ts";
import { EvfError, fail, parseTask, readParty, run, type ReviewParty, type TaskRef } from "./lib.ts";

const TEMPLATES = {
	ordinary: ".agents/skills/everyfield-pr/template.md",
	wiki: "tools/evf/templates/wiki-pr.md",
	prototype: "tools/evf/templates/prototype-pr.md",
};
export type PrBodyClass = keyof typeof TEMPLATES;
const withoutComments = (text: string) => text.replace(/<!--[^]*?(?:-->|$)/g, "").replace(/\r\n/g, "\n");

/** Metadata chooses a body format only. Merge authority stays with ship and approve. */
export function prBodyClass(pr: unknown): PrBodyClass {
	if (!pr || typeof pr !== "object" || !("headRefName" in pr) || typeof pr.headRefName !== "string") return "ordinary";
	if (/^wiki\/[\w.-]+$/.test(pr.headRefName)) {
		if (
			!("files" in pr) ||
			!Array.isArray(pr.files) ||
			!pr.files.length ||
			!pr.files.every((file) => file && typeof file.path === "string" && file.path.startsWith("docs/reference/wiki/"))
		)
			fail("Wiki PR body format requires every changed file to stay in docs/reference/wiki/.");
		return "wiki";
	}
	if (
		/^task\/fb-\d+$/.test(pr.headRefName) &&
		"labels" in pr &&
		Array.isArray(pr.labels) &&
		pr.labels.some((label) => label?.name === "prototype")
	)
		return "prototype";
	return "ordinary";
}

/** Ignore headings and machine lines inside examples, while retaining their content for evidence. */
function plainLines(lines: string[]): Array<{ text: string; index: number }> {
	const plain: Array<{ text: string; index: number }> = [];
	let fence: { marker: string; length: number } | null = null;
	for (const [index, text] of lines.entries()) {
		const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
		if (fence) {
			if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = null;
		} else if (match) fence = { marker: match[1][0], length: match[1].length };
		else plain.push({ text, index });
	}
	return plain;
}

/** The task a `task/<slug>` branch belongs to, or undefined for any other branch. */
export function taskOfBranch(branch: string | undefined): TaskRef | undefined {
	const slug = /^task\/([\w-]+)$/.exec(branch ?? "")?.[1];
	if (!slug) return undefined;
	try {
		return parseTask(slug.replace(/^(wp-\d{3})-(contract|api|ui)$/, "$1/$2"));
	} catch (e) {
		if (e instanceof EvfError) return undefined;
		throw e;
	}
}

/** The follow-ups an ordinary PR body must name for a branch's task (OPS-86). Empty when the branch has none. */
export const followUpsOfBranch = (root: string, branch: string | undefined): FollowUp[] => {
	const task = taskOfBranch(branch);
	return task ? followUpsOfTask(root, task) : [];
};

/** The markers whose PR body proof row must link a video, for a branch's task (OPS-112). */
export const acVideoMarkersOfBranch = (root: string, branch: string | undefined): Set<string> => {
	const task = taskOfBranch(branch);
	return task ? acVideoMarkers(root, task) : new Set();
};

/**
 * A task with follow-ups covers only part of its ask. The first non-empty line under `## Summary` starts with
 * `Partial:` and names every follow-up label, so a reader of the PR sees the deferred scope first.
 */
function requirePartial(lines: string[], summaryAt: number, followUps: FollowUp[]): void {
	const first = lines
		.slice(summaryAt + 1)
		.map((l) => l.trim())
		.find(Boolean);
	const labels = followUps.map((f) => f.label);
	const missing = first?.startsWith("Partial:") ? labels.filter((l) => !first.includes(l)) : labels;
	if (first?.startsWith("Partial:") && !missing.length) return;
	fail(
		`This task has ${labels.length} follow-up${labels.length === 1 ? "" : "s"} (${labels.join(", ")}), so the PR covers only part of the ask. ` +
			`The first line under ## Summary must start with "Partial:" and name ${first?.startsWith("Partial:") ? `the missing ${missing.join(", ")}` : "each one"}. Write: ${partialLine(followUps)}`,
	);
}

const AC_MARKER = /AC:[A-Za-z]+-\d+(?:\/[a-z]+)?-\d+(?!\d)/;
const VIDEO_LINK = /https?:\/\/\S*\.(?:webm|mp4)\b/i;

/**
 * The answer key in the PR body (OPS-112): each proof table row that names an `AC:` marker links its video on the
 * evidence page publish.mjs builds. A row needs none only when it names tools/evf/tests and evf's own row for the
 * marker stores no video (`videoMarkers` holds the markers a browser test proved).
 */
function requireAcVideos(lines: string[], videoMarkers: Set<string>): void {
	const missing = lines
		.filter((line) => /^\s*\|/.test(line))
		.flatMap((row) => {
			const marker = AC_MARKER.exec(row)?.[0];
			if (!marker || VIDEO_LINK.test(row)) return [];
			return !videoMarkers.has(marker) && row.includes("tools/evf/tests") ? [] : [marker];
		});
	if (missing.length)
		fail(
			`The PR body proof table has AC: rows with no video link: ${missing.join(", ")}. Link each row's video on the evidence page publish.mjs builds (https://…/index.html#<video>.webm). A row that only tools/evf/tests tests prove names tools/evf/tests instead.`,
		);
}

/** The text a PR body writes for the head. `evf pr open` replaces it, so the source file never goes stale (OPS-147). */
export const HEAD_PLACEHOLDER = "{{EVF_HEAD}}";
export const fillHead = (body: string, head: string) => body.replaceAll(HEAD_PLACEHOLDER, head);

/** Runs `use` with a temporary file that holds a filled body, for `gh --body-file`. */
export function withBodyFile<T>(body: string, use: (file: string) => T): T {
	const file = join(mkdtempSync(join(tmpdir(), "evf-pr-body-")), "pr-body.md");
	try {
		writeFileSync(file, body);
		return use(file);
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}
}

/** A commit a verification section claims: `Verified head: <sha>`, `verified at <sha>`, `ran on head <sha>`, `head is <sha>`. */
const NAMED_HEAD =
	/\b(?:verified\b(?:[\s:]+[\w-]+){0,5}?|head\b(?:\s+(?:is|sha|commit))?)[\s:]*[`*]*([0-9a-f]{7,40})\b/gi;
/** A line that says its head is history makes no claim about the current one. */
const EARLIER_HEAD = /\bround \d|\b(?:old|older|previous|prior|earlier|former|before)\b|#\d+.s head/i;

/**
 * Why a body names a head other than `head` as verified, or null (OPS-147). It reads the verification sections and skips
 * code fences. A hex word that is no commit in this repository is not a head. `cwd` is a checkout with the commits.
 */
export function staleHeadFault(cwd: string, body: string, head: string): string | null {
	let verification = false;
	const named: string[] = [];
	for (const { text } of plainLines(withoutComments(body).split("\n"))) {
		if (text.startsWith("## ")) verification = /verif/i.test(text);
		if (!verification) continue;
		if (text.includes(HEAD_PLACEHOLDER)) return `the PR body still holds ${HEAD_PLACEHOLDER}; evf pr open fills it`;
		if (EARLIER_HEAD.test(text)) continue;
		for (const [, sha] of text.matchAll(NAMED_HEAD)) {
			const lower = sha.toLowerCase();
			if (head.startsWith(lower) || named.includes(lower)) continue;
			if (run("git", ["rev-parse", "--verify", "--quiet", `${lower}^{commit}`], { cwd }).code === 0) named.push(lower);
		}
	}
	return named.length
		? `the PR body names ${named.join(", ")} as verified, but the head is ${head.slice(0, 10)}. Write ${HEAD_PLACEHOLDER} for the current head, and say "round <n>" or "earlier" on a line about an older head`
		: null;
}

/** Each class template owns its required sections. This check has no CI or review dependency. */
export function checkPrBody(
	root: string,
	body: string,
	kind: PrBodyClass = "ordinary",
	followUps: FollowUp[] = [],
	videoMarkers: Set<string> = new Set(),
): { kind: PrBodyClass; sections: string[]; author: ReviewParty } {
	const template = TEMPLATES[kind],
		path = join(root, template);
	if (!existsSync(path)) fail(`PR body template is missing: ${template}.`);
	const sections = plainLines(withoutComments(readFileSync(path, "utf8")).split("\n"))
		.filter((l) => l.text.startsWith("## "))
		.map((l) => l.text);
	if (!sections.length || new Set(sections).size !== sections.length)
		fail("PR body template must define distinct required sections.");
	const lines = withoutComments(body).split("\n"),
		plain = plainLines(lines);
	const headings = plain.filter((l) => l.text.startsWith("## "));
	const found = headings.filter((l) => sections.includes(l.text));
	if (JSON.stringify(found.map((l) => l.text)) !== JSON.stringify(sections)) {
		const missing = sections.filter((section) => !found.some((l) => l.text === section));
		fail(
			missing.length
				? `PR body is missing required sections: ${missing.join(", ")}.`
				: "PR body required sections must appear exactly once, in template order.",
		);
	}
	const authors = plain.filter((l) => l.text.startsWith("EVF-Author:"));
	if (authors.length !== 1) fail("PR body needs exactly one EVF-Author line.");
	const author = authors[0];
	let parsed: unknown = null;
	try {
		parsed = JSON.parse(author.text.slice("EVF-Author:".length));
	} catch {
		// Not JSON: readParty names the expected shape.
	}
	const party = readParty(parsed);
	if (typeof party === "string")
		fail(
			`EVF-Author must be {"session":"<Claude Code session UUID>","model":"<model id>","role":"<seat role>"}: ${party}.`,
		);
	if (headings.some((heading) => heading.index >= author.index))
		fail("EVF-Author must follow the last PR body section.");
	for (const heading of found) {
		const end = headings.find((l) => l.index > heading.index)?.index ?? author.index;
		const content = lines
			.slice(heading.index + 1, Math.min(end, author.index))
			.filter((line) => !/^\s*(?:#{1,6}\s|`{3,}|~{3,}|Verified head:)/.test(line))
			.join("\n")
			.trim();
		if (!content) fail(`PR body section has no content: ${heading.text}.`);
	}
	if (kind === "ordinary" && followUps.length) {
		const summary = found.find((l) => l.text === "## Summary");
		if (summary) requirePartial(lines, summary.index, followUps);
	}
	requireAcVideos(
		plain.map((l) => l.text),
		videoMarkers,
	);
	const footer = lines.slice(author.index + 1).filter((line) => line.trim());
	if (footer.length !== 1 || !/^🤖 Generated with \[[^\]]+\]\(https:\/\/[^)]+\)$/.test(footer[0]))
		fail("End the PR body with its attribution line after EVF-Author.");
	return { kind, sections, author: party };
}

/**
 * One PR body fix a `body_only` review lists (OPS-113, D-c): an exact text the body must contain (`present`) or must
 * not contain (`absent`), and why. The check is exact text only, so evf proves it without a model.
 */
export type BodyItem = { present: string; why: string } | { absent: string; why: string };

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** Parses the `body` list of a `body_only` review. Returns the reason when the list or an item is malformed. */
export function readBodyItems(input: unknown): BodyItem[] | string {
	if (!Array.isArray(input) || !input.length) return "a body_only review needs a non-empty list of body items";
	const items: BodyItem[] = [];
	for (const [i, item] of input.entries()) {
		const at = `body item ${i + 1}`;
		if (!item || typeof item !== "object" || Array.isArray(item)) return `${at} is not an object`;
		const keys = Object.keys(item).filter((k) => k !== "why");
		if (keys.length !== 1 || (keys[0] !== "present" && keys[0] !== "absent"))
			return `${at} needs exactly one of "present" or "absent" and nothing else besides "why"`;
		const text = (item as Record<string, unknown>)[keys[0]],
			why = (item as Record<string, unknown>).why;
		if (!nonEmpty(text)) return `${at} needs a non-empty "${keys[0]}" text`;
		if (!nonEmpty(why)) return `${at} needs a non-empty "why"`;
		items.push(keys[0] === "present" ? { present: text, why } : { absent: text, why });
	}
	return items;
}

/** How a body item reads in prompts and refusals. */
export const describeBodyItem = (item: BodyItem): string =>
	"present" in item
		? `present ${JSON.stringify(item.present)} (${item.why})`
		: `absent ${JSON.stringify(item.absent)} (${item.why})`;

/** The first item the body does not meet, or undefined when it meets every item. Line endings do not count. */
export function unmetBodyItem(body: string, items: BodyItem[]): BodyItem | undefined {
	const text = body.replace(/\r\n/g, "\n");
	const has = (part: string) => text.includes(part.replace(/\r\n/g, "\n"));
	return items.find((item) => ("present" in item ? !has(item.present) : has(item.absent)));
}

/**
 * The `evf pr body <PR>` check: reads the PR body, branch, labels and files from GitHub and checks the body with the
 * template its class selects. The body stage (OPS-113) runs this same code after it pushes the body.
 */
export function checkGithubBody(
	cwd: string,
	root: string,
	number: number,
): { body: string; headRefOid: string; checked: ReturnType<typeof checkPrBody> } {
	const result = run("gh", ["pr", "view", String(number), "--json", "body,headRefName,headRefOid,labels,files"], {
		cwd,
	});
	if (result.code !== 0) fail("Cannot read the PR body from GitHub.");
	const pr: unknown = JSON.parse(result.stdout);
	if (!pr || typeof pr !== "object" || !("body" in pr) || typeof pr.body !== "string")
		fail("Cannot read the PR body from GitHub.");
	const headRefOid = "headRefOid" in pr && typeof pr.headRefOid === "string" ? pr.headRefOid : "";
	const checked = checkPrBody(
		cwd,
		pr.body,
		prBodyClass(pr),
		followUpsOfBranch(root, (pr as { headRefName?: string }).headRefName),
		acVideoMarkersOfBranch(root, (pr as { headRefName?: string }).headRefName),
	);
	return { body: pr.body, headRefOid, checked };
}
