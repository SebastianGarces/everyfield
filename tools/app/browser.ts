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

export const describe = (element: Element, withRef = true) =>
	`${withRef ? `${element.ref} ` : ""}${element.role}${element.name ? ` "${element.name}"` : ""}${element.attrs ? ` [${element.attrs}]` : ""}`;

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

export function nearest<T>(items: T[], wanted: string, text: (item: T) => string, count = 3): T[] {
	const target = wanted.toLowerCase();
	const score = (item: T) => {
		const value = text(item).toLowerCase();
		if (!value) return Number.POSITIVE_INFINITY;
		if (value.includes(target) || target.includes(value)) return Math.abs(value.length - target.length) / 100;
		return distance(value.slice(0, target.length + 8), target);
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
export const FILLABLE = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

export type Pick = { role?: string; nth?: number; exact?: boolean };

export function pick(elements: Element[], name: string, roles: Set<string>, options: Pick, what: string): Element {
	const pool = elements.filter((element) => (options.role ? element.role === options.role : roles.has(element.role)));
	const wanted = name.toLowerCase();
	const exact = pool.filter((element) => element.name.toLowerCase() === wanted);
	const matches = exact.length || options.exact ? exact : pool.filter((e) => e.name.toLowerCase().includes(wanted));
	const kind = options.role ?? what;
	if (!matches.length) {
		const close = nearest(pool.length ? pool : elements, name, (element) => element.name);
		throw new AppError(
			EXIT.notFound,
			`no ${kind} named "${name}". Nearest: ${close.map((element) => `${element.role} "${element.name}" (${element.ref})`).join(", ") || "none (app snapshot)"}`,
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

export function changes(before: Element[], after: Element[]): string[] {
	const old = new Map(before.map((element) => [element.ref, element]));
	const now = new Set(after.map((element) => element.ref));
	const lines: string[] = [];
	for (const element of after) {
		const previous = old.get(element.ref);
		if (!previous) lines.push(`+ ${describe(element)}`);
		else if (previous.name !== element.name || previous.attrs !== element.attrs || previous.role !== element.role)
			lines.push(`~ ${describe(element)}`);
	}
	for (const element of before) if (!now.has(element.ref)) lines.push(`- ${describe(element, false)}`);
	return lines;
}
