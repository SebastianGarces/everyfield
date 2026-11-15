import { mkdirSync, openSync, readFileSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	batch,
	changes,
	CLICKABLE,
	describe,
	FILLABLE,
	must,
	nearest,
	pick,
	treeOf,
	type Browser,
	type Pick,
} from "./browser.ts";
import {
	AppError,
	evidenceDir,
	EXIT,
	insideWorkTree,
	sleepSync,
	type Element,
	type Repo,
	type SessionState,
} from "./state.ts";

export type Context = {
	repo: Repo;
	browser: Browser;
	origin: string | undefined;
	state: SessionState;
	task: string | undefined;
};

const SETTLE = [["wait", "--load", "networkidle", "--timeout", "5000"]];
const READ = [["snapshot", "-i"], ["get", "url"], ["get", "title"], ["errors"], ["console"]];
const WIDTHS: Record<number, number> = { 390: 844, 1440: 900 };
const CAP = 30;
const PROBE = readFileSync(new URL("./cursor-probe.js", import.meta.url), "utf8")
	.trim()
	.replace(/;$/, "");
const TALL =
	"String(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, ...[...document.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight).map((e) => innerHeight + e.scrollHeight - e.clientHeight)))";
const MODAL_OPEN =
	"String(!![...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].some((e) => e.getClientRects().length))";

type Page = { url: string; path: string; title: string; elements: Element[]; problems: number };

function readPage(steps: ReturnType<typeof batch>): Page {
	const [snapshot, url, title, errors, consoleLog] = steps.slice(-READ.length);
	const href = String(must(url).url ?? "");
	const messages = (must(consoleLog).messages as { type?: string }[] | undefined) ?? [];
	const errorList = (must(errors).errors as unknown[] | undefined) ?? [];
	let path = href;
	try {
		const parsed = new URL(href);
		path = parsed.pathname + parsed.search;
	} catch {}
	return {
		url: href,
		path,
		title: String(must(title).title ?? ""),
		elements: treeOf(must(snapshot)),
		problems: errorList.length + messages.filter((message) => message.type === "error").length,
	};
}

function problemsNote(context: Context, page: Page): string {
	const fresh = page.problems - context.state.seenErrors;
	context.state.seenErrors = page.problems;
	return fresh > 0 ? ` · ! ${fresh} new error${fresh === 1 ? "" : "s"} (app errors)` : "";
}

const where = (page: Page) => `${page.path} "${page.title}" · ${page.elements.length} interactive`;

export function requireOrigin(context: Context): string {
	if (!context.origin)
		throw new AppError(
			EXIT.noTarget,
			"no app to drive: run app up, or pass --url <origin> once (app goto / --url ...)",
		);
	return context.origin;
}

const target = (origin: string, route: string) => (/^https?:\/\//.test(route) ? route : origin + route);

export function goto(context: Context, route: string): string {
	const origin = requireOrigin(context);
	const steps = batch(context.browser, [["open", target(origin, route)], ...SETTLE, ...READ]);
	must(steps[0]);
	const page = readPage(steps);
	return `${where(page)}${problemsNote(context, page)}`;
}

export type Cookie = { name: string; value: string };

export function signInBrowser(context: Context, cookie: Cookie | null, route: string): Page {
	const origin = requireOrigin(context);
	const setCookie = cookie
		? [
				[
					"cookies",
					"set",
					cookie.name,
					cookie.value,
					"--url",
					origin,
					"--httpOnly",
					...(origin.startsWith("https:") ? ["--secure"] : []),
				],
			]
		: [];
	const steps = batch(context.browser, [
		["cookies", "clear"],
		...setCookie,
		["set", "viewport", "1440", "900"],
		["open", target(origin, route)],
		...SETTLE,
		...READ,
	]);
	for (const step of steps.slice(0, setCookie.length + 3)) must(step);
	return readPage(steps);
}

export function loginLine(context: Context, persona: string | null, page: Page): string {
	if (persona && /^\/(signin|access)(\/|$|\?)/.test(page.path))
		throw new AppError(
			EXIT.noTarget,
			`${persona} is not signed in (landed on ${page.path}). Retry with app login ${persona} --fresh`,
		);
	context.state.persona = persona ?? undefined;
	return `${persona ? `signed in ${persona}` : "signed out"} → ${where(page)}${problemsNote(context, page)}`;
}

function scopeSelector(scope: string | undefined): string | undefined {
	if (!scope || scope === "auto") return undefined;
	if (scope === "page") return "";
	if (scope === "dialog") return "[role=dialog],[role=alertdialog],dialog[open]";
	return scope;
}

export function snapshot(context: Context, options: { scope?: string; all?: boolean }): string {
	const chosen = scopeSelector(options.scope);
	const steps =
		chosen === undefined
			? batch(context.browser, [["eval", MODAL_OPEN], ["snapshot", "-i", "-s", "main"], ...READ])
			: batch(context.browser, [...(chosen ? [["snapshot", "-i", "-s", chosen]] : []), ...READ]);
	const page = readPage(steps);
	let scope = options.scope ?? "page";
	let elements = page.elements;
	if (chosen === undefined) {
		const modal = must(steps[0]).result === "true";
		const main = steps[1]!;
		scope = modal ? "dialog" : main.success ? "main" : "page";
		if (scope === "main") elements = treeOf(must(main));
	} else if (chosen) {
		if (!steps[0]!.success)
			throw new AppError(EXIT.notFound, `nothing matches --scope ${options.scope} on ${page.path}`);
		elements = treeOf(must(steps[0]));
	}
	const header = `${page.path} "${page.title}" · ${scope} · ${elements.length} interactive${problemsNote(context, page)}`;
	const baseline = context.state.baseline;
	context.state.baseline = { url: page.url, scope, elements };
	if (!options.all && baseline && baseline.url === page.url && baseline.scope === scope) {
		const diff = changes(baseline.elements, elements);
		if (!diff.length) return `${header} · unchanged since your last snapshot`;
		return [`${header} · ${diff.length} changed since your last snapshot`, ...capped(diff, "app snapshot --all")].join(
			"\n",
		);
	}
	return [
		header,
		...capped(
			elements.map((element) => describe(element)),
			"app snapshot --all",
		),
	].join("\n");
}

function capped(lines: string[], more: string): string[] {
	if (lines.length <= CAP) return lines;
	return [...lines.slice(0, CAP), `… ${lines.length - CAP} more (${more})`];
}

function act(context: Context, verb: string, action: string[], subject: string): string {
	const steps = batch(context.browser, [["get", "url"], ["snapshot", "-i"], action, ...SETTLE, ...READ]);
	const before = treeOf(must(steps[1]));
	const beforeUrl = String(must(steps[0]).url ?? "");
	must(steps[2]);
	const page = readPage(steps);
	const note = problemsNote(context, page);
	if (page.url !== beforeUrl) return `${verb} ${subject} → ${where(page)}${note}`;
	const diff = changes(before, page.elements);
	if (!diff.length) return `${verb} ${subject} · no change in interactive elements${note}`;
	const shown = diff.slice(0, 3).join(" · ");
	return `${verb} ${subject} · ${shown}${diff.length > 3 ? ` · ${diff.length - 3} more (app snapshot)` : ""}${note}`;
}

function resolveElement(context: Context, name: string, roles: Set<string>, options: Pick, what: string): Element {
	requireOrigin(context);
	const elements = treeOf(must(batch(context.browser, [["snapshot", "-i"]])[0]));
	return pick(elements, name, roles, options, what);
}

const subject = (element: Element) => `${element.role} "${element.name}"`;

export function click(context: Context, name: string, options: Pick): string {
	const element = resolveElement(context, name, CLICKABLE, options, "clickable");
	return act(context, "clicked", ["click", `@${element.ref}`], subject(element));
}

export function fill(context: Context, label: string, value: string, options: Pick): string {
	const element = resolveElement(context, label, FILLABLE, options, "field");
	return act(context, "filled", ["fill", `@${element.ref}`, value], subject(element));
}

export function press(context: Context, key: string): string {
	requireOrigin(context);
	return act(context, "pressed", ["press", key], key);
}

export type Expectation = {
	text?: string;
	noText?: string;
	url?: string;
	title?: string;
	role?: string;
	name?: string;
	timeout: number;
};

function bodyLines(context: Context): string[] {
	const text = must(batch(context.browser, [["eval", "document.body.innerText"]])[0]).result;
	return [
		...new Set(
			String(text ?? "")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		),
	];
}

function waitFor(context: Context, expression: string, timeout: number): boolean {
	return batch(context.browser, [["wait", "--fn", expression, "--timeout", String(timeout)]])[0]?.success === true;
}

export function expect(context: Context, wanted: Expectation): string {
	requireOrigin(context);
	const seconds = `${wanted.timeout / 1000} s`;
	if (wanted.text !== undefined) {
		const text = JSON.stringify(wanted.text);
		if (waitFor(context, `document.body.innerText.includes(${text})`, wanted.timeout)) return `ok text ${text}`;
		const close = nearest(bodyLines(context), wanted.text, (line) => line, 1)[0];
		throw new AppError(
			EXIT.failed,
			`FAIL text ${text} not found within ${seconds}.${close ? ` Closest on page: ${JSON.stringify(close.slice(0, 120))}` : ""}`,
		);
	}
	if (wanted.noText !== undefined) {
		const text = JSON.stringify(wanted.noText);
		if (waitFor(context, `!document.body.innerText.includes(${text})`, wanted.timeout)) return `ok no text ${text}`;
		throw new AppError(EXIT.failed, `FAIL text ${text} still on the page after ${seconds}`);
	}
	if (wanted.url !== undefined) {
		const path = JSON.stringify(wanted.url);
		if (
			waitFor(
				context,
				`location.pathname + location.search === ${path} || location.pathname === ${path}`,
				wanted.timeout,
			)
		)
			return `ok url ${wanted.url}`;
		const now = String(must(batch(context.browser, [["eval", "location.pathname + location.search"]])[0]).result);
		throw new AppError(EXIT.failed, `FAIL url is ${now}, not ${wanted.url}`);
	}
	if (wanted.title !== undefined) {
		const title = JSON.stringify(wanted.title);
		if (waitFor(context, `document.title.includes(${title})`, wanted.timeout)) return `ok title ${title}`;
		const now = String(must(batch(context.browser, [["get", "title"]])[0]).title);
		throw new AppError(EXIT.failed, `FAIL title is ${JSON.stringify(now)}, not ${title}`);
	}
	if (wanted.name !== undefined) {
		const deadline = Date.now() + wanted.timeout;
		const name = wanted.name;
		for (;;) {
			const elements = treeOf(must(batch(context.browser, [["snapshot", "-i"]])[0]));
			const found = elements.find(
				(element) =>
					(!wanted.role || element.role === wanted.role) && element.name.toLowerCase().includes(name.toLowerCase()),
			);
			if (found) return `ok ${describe(found)}`;
			if (Date.now() > deadline) {
				const close = nearest(elements, name, (element) => element.name);
				throw new AppError(
					EXIT.failed,
					`FAIL no ${wanted.role ?? "element"} named "${name}" within ${seconds}. Nearest: ${close.map((element) => describe(element)).join(", ") || "none"}`,
				);
			}
			sleepSync(250);
		}
	}
	throw new AppError(EXIT.usage, "expect needs --text, --no-text, --path, --title or --name [--role]");
}

function pngSize(file: string): string {
	const header = Buffer.alloc(24);
	const handle = openSync(file, "r");
	readSync(handle, header, 0, 24, 0);
	closeSync(handle);
	return `${header.readUInt32BE(16)}x${header.readUInt32BE(20)}`;
}

export function shot(
	context: Context,
	name: string,
	options: { out?: string; widths: number[]; viewportOnly: boolean },
): string {
	requireOrigin(context);
	if (!/^[\w.-]+$/.test(name))
		throw new AppError(EXIT.usage, "shot names use letters, digits, dot, dash or underscore");
	const dir = options.out ? resolve(options.out) : join(evidenceDir(context.repo, context.task), "shots");
	if (insideWorkTree(dir))
		throw new AppError(EXIT.usage, `${dir} is inside a git work tree; evidence stays outside the repository`);
	mkdirSync(dir, { recursive: true });
	const lines: string[] = [];
	for (const width of options.widths) {
		const height = WIDTHS[width] ?? (width < 768 ? 844 : 900);
		const file = join(dir, `${name}-${width}.png`);
		const sized = batch(context.browser, [
			["set", "viewport", String(width), String(height)],
			["wait", "300"],
			["eval", TALL],
		]);
		must(sized[0]);
		const tall = Math.min(Number(must(sized[2]).result) || height, 16000);
		const capture =
			!options.viewportOnly && tall > height
				? [
						["set", "viewport", String(width), String(tall)],
						["wait", "300"],
						["screenshot", file],
					]
				: [["screenshot", file]];
		for (const step of batch(context.browser, capture)) must(step);
		lines.push(`${file} ${pngSize(file)}`);
	}
	must(batch(context.browser, [["set", "viewport", "1440", "900"]])[0]);
	return lines.join("\n");
}

type Violation = { role: string; name: string; cursor: string; hitCursor: string | null; expected: string };

export function cursorAudit(context: Context, scope: string | undefined): string {
	requireOrigin(context);
	const raw = must(batch(context.browser, [["eval", `(${PROBE})(${JSON.stringify(scope ?? "")})`]])[0]).result;
	const report = JSON.parse(String(raw)) as { checked?: number; violations?: Violation[]; missing?: string };
	if (report.missing) throw new AppError(EXIT.notFound, `nothing matches --scope ${report.missing}`);
	const violations = report.violations ?? [];
	const summary = `${report.checked ?? 0} clickable, ${violations.length} wrong`;
	if (!violations.length) return summary;
	const listed = violations
		.slice(0, 6)
		.map(
			(v) => `${v.role} "${v.name}" cursor=${v.cursor}${v.hitCursor ? ` (hit ${v.hitCursor})` : ""} want ${v.expected}`,
		);
	throw new AppError(
		EXIT.failed,
		`${summary}: ${listed.join(" · ")}${violations.length > 6 ? ` · ${violations.length - 6} more` : ""}`,
	);
}

export function errors(context: Context): string {
	const steps = batch(context.browser, [["errors"], ["console"]]);
	const pageErrors = ((must(steps[0]).errors as { text?: string }[] | undefined) ?? []).map(
		(error) => `error ${firstText(error.text)}`,
	);
	const consoleErrors = ((must(steps[1]).messages as { type?: string; text?: string }[] | undefined) ?? [])
		.filter((message) => message.type === "error")
		.map((message) => `console ${firstText(message.text)}`);
	const all = [...pageErrors, ...consoleErrors];
	const fresh = all.slice(context.state.seenErrors);
	context.state.seenErrors = all.length;
	if (!all.length) return "0 errors";
	return [
		`${all.length} error${all.length === 1 ? "" : "s"} this session, ${fresh.length} new since the last report`,
		...capped(fresh.length ? fresh : all, "app raw -- errors"),
	].join("\n");
}

const firstText = (text: string | undefined) => (text ?? "").split("\n")[0]!.slice(0, 160);
