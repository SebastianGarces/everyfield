import { spawnSync } from "node:child_process";
import { AppError, EXIT, firstLine, run, type Element } from "./state.ts";

export const IDLE_TIMEOUT = "10m";

export type Browser = { session: string; flags: string[] };

export const browserFor = (session: string, origin: string | undefined): Browser => ({
	session,
	flags: [
		"--session",
		session,
		"--idle-timeout",
		IDLE_TIMEOUT,
		...(origin?.startsWith("https:") ? ["--ignore-https-errors"] : []),
	],
});

type Step = { command: string[]; success: boolean; result: Record<string, unknown> | null; error: string | null };

export function batch(browser: Browser, steps: string[][]): Step[] {
	const child = spawnSync("agent-browser", [...browser.flags, "--json", "batch"], {
		input: JSON.stringify(steps),
		encoding: "utf8",
		timeout: 180_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (child.error) throw new AppError(EXIT.browser, `agent-browser could not run: ${child.error.message}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(child.stdout);
	} catch {
		throw new AppError(EXIT.browser, `agent-browser: ${firstLine(child.stderr || child.stdout) || "no output"}`);
	}
	if (!Array.isArray(parsed)) {
		const error = (parsed as { error?: unknown }).error;
		throw new AppError(EXIT.browser, `agent-browser: ${typeof error === "string" ? error : "unexpected output"}`);
	}
	return parsed as Step[];
}

export function must(step: Step | undefined): Record<string, unknown> {
	if (!step) throw new AppError(EXIT.browser, "agent-browser returned fewer results than steps");
	if (!step.success)
		throw new AppError(EXIT.browser, `agent-browser ${step.command[0]}: ${firstLine(step.error ?? "failed")}`);
	return step.result ?? {};
}

export function sessionOpen(session: string): boolean {
	return run("agent-browser", ["session", "list"])
		.stdout.split("\n")
		.some((line) => line.trim() === session);
}

export function closeBrowser(browser: Browser): boolean {
	if (!sessionOpen(browser.session)) return false;
	run("agent-browser", [...browser.flags, "close"], { timeout: 30_000 });
	return true;
}

const LINE = /^\s*- ([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?/;

export function parseTree(tree: string): Element[] {
	const elements: Element[] = [];
	for (const line of tree.split("\n")) {
		const match = LINE.exec(line);
		if (!match) continue;
		const attrs = (match[3] ?? "").split(", ").filter(Boolean);
		const ref = attrs.find((attr) => attr.startsWith("ref="))?.slice(4);
		if (!ref) continue;
		elements.push({
			ref,
			role: match[1]!,
			name: (match[2] ?? "").replace(/\\(.)/g, "$1").trim(),
			attrs: attrs.filter((attr) => !attr.startsWith("ref=")).join(", "),
		});
	}
	return elements;
}

export function treeOf(result: Record<string, unknown>): Element[] {
	const snapshot = result.snapshot;
	const tree =
		typeof snapshot === "string" ? snapshot : String((snapshot as { tree?: unknown } | undefined)?.tree ?? "");
	return parseTree(tree);
}

const short = (name: string) => (name.length > 60 ? `${name.slice(0, 59)}…` : name);

export const describe = (element: Element, withRef = true) =>
	`${withRef ? `${element.ref} ` : ""}${element.role}${element.name ? ` "${short(element.name)}"` : ""}${element.attrs ? ` [${element.attrs}]` : ""}`;

export function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let previous = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const kept = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
			previous = kept;
		}
	}
	return row[b.length]!;
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

export function nearest<T>(items: T[], wanted: string, text: (item: T) => string, count = 3): T[] {
	const target = wanted.toLowerCase();
	const wantedWords = words(wanted);
	const score = (item: T) => {
		const value = text(item).toLowerCase();
		if (!value) return Number.POSITIVE_INFINITY;
		if (value.includes(target) || target.includes(value)) return Math.abs(value.length - target.length) / 1000;
		const shared = wantedWords.filter((word) => value.includes(word)).length;
		return (wantedWords.length - shared) * 100 + distance(value.slice(0, target.length + 8), target);
	};
	return items
		.map((item) => ({ item, score: score(item) }))
		.filter((entry) => Number.isFinite(entry.score))
		.sort((a, b) => a.score - b.score)
		.slice(0, count)
		.map((entry) => entry.item);
}

export const CLICKABLE = new Set([
	"button",
	"link",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"checkbox",
	"radio",
	"switch",
	"treeitem",
	"combobox",
	"row",
	"cell",
	"gridcell",
	"listitem",
	"img",
	"generic",
]);

export type Pick = { role?: string; nth?: number; exact?: boolean };

const listed = (elements: Element[]) =>
	elements.map((element) => `${element.role} "${short(element.name)}" (${element.ref})`).join(", ");

export function pick(elements: Element[], name: string, options: Pick, context: { modalOpen: boolean }): Element {
	const pool = elements.filter((element) =>
		options.role ? element.role === options.role : CLICKABLE.has(element.role),
	);
	const wanted = name.toLowerCase();
	const named = (list: Element[]) => {
		const exact = list.filter((element) => element.name.toLowerCase() === wanted);
		return exact.length || options.exact ? exact : list.filter((e) => e.name.toLowerCase().includes(wanted));
	};
	const matches = named(pool);
	const kind = options.role ?? "clickable";
	const modal = context.modalOpen ? " (a dialog is open; only its elements are reachable)" : "";
	if (!matches.length) {
		const otherRoles = named(elements);
		if (otherRoles.length)
			throw new AppError(
				EXIT.notFound,
				`no ${kind} named "${name}"${modal}; found ${listed(otherRoles.slice(0, 3))}: add --role ${otherRoles[0]!.role}`,
			);
		const close = nearest(elements, name, (element) => element.name);
		throw new AppError(
			EXIT.notFound,
			`no ${kind} named "${name}"${modal}. Nearest: ${listed(close) || "none (app snapshot)"}`,
		);
	}
	if (options.nth !== undefined) {
		const chosen = matches[options.nth - 1];
		if (!chosen) throw new AppError(EXIT.notFound, `only ${matches.length} ${kind} match "${name}"`);
		return chosen;
	}
	if (matches.length > 1)
		throw new AppError(
			EXIT.notFound,
			`${matches.length} ${kind}s match "${name}": ${matches
				.slice(0, 4)
				.map((element) => describe(element))
				.join(", ")}. Add --nth <n>, --role <role> or --exact`,
		);
	return matches[0]!;
}

function keyed(elements: Element[]): Map<string, Element> {
	const seen = new Map<string, number>();
	const out = new Map<string, Element>();
	for (const element of elements) {
		const base = `${element.role}\u0000${element.name}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		out.set(`${base}\u0000${n}`, element);
	}
	return out;
}

export function changes(before: Element[], after: Element[]): string[] {
	const old = keyed(before);
	const now = keyed(after);
	const lines: string[] = [];
	for (const [key, element] of now) {
		const previous = old.get(key);
		if (!previous) lines.push(`+ ${describe(element)}`);
		else if (previous.attrs !== element.attrs) lines.push(`~ ${describe(element)}`);
	}
	for (const [key, element] of old) if (!now.has(key)) lines.push(`- ${describe(element, false)}`);
	return lines;
}
