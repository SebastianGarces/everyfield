import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { batch, changes, describe, must, nearest, pick, treeOf, type Browser, type Pick } from "./browser.ts";
import {
	AppError,
	evidenceDir,
	firstLine,
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

const script = (file: string) =>
	readFileSync(new URL(file, import.meta.url), "utf8")
		.trim()
		.replace(/;$/, "");
const PROBE = script("./cursor-probe.js");
const FIELDS = script("./fields.js");
const TEXT = script("./text-probe.js");

const SETTLE = [["wait", "--load", "networkidle", "--timeout", "5000"]];
const FRAME = [
	"eval",
	"new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done('framed'))))",
];
const MODAL = [
	"eval",
	"String(!![...document.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].some((e) => e.getClientRects().length))",
];
const LIVE = [
	"eval",
	"JSON.stringify([...new Set([...document.querySelectorAll('[role=status],[role=alert],[aria-live]:not([aria-live=off])')].map((e) => (e.innerText || '').trim().replace(/\\s+/g, ' ')).filter(Boolean))])",
];
const READ = [["snapshot", "-i"], ["get", "url"], ["get", "title"], ["errors"], ["console"], LIVE];
const WIDTHS: Record<number, number> = { 390: 844, 1440: 900 };
const CAP = 30;
const TALL =
	"String(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, ...[...document.querySelectorAll('*')].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight).map((e) => innerHeight + e.scrollHeight - e.clientHeight)))";

type Steps = ReturnType<typeof batch>;
type Page = { url: string; path: string; title: string; elements: Element[]; problems: number; live: string[] };

const liveOf = (step: Steps[number] | undefined): string[] => JSON.parse(String(must(step).result ?? "[]")) as string[];

function readPage(steps: Steps): Page {
	const [snapshot, url, title, errors, consoleLog, live] = steps.slice(-READ.length);
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
		live: liveOf(live),
	};
}

function notes(context: Context, page: Page, liveBefore: string[] = []): string {
	const fresh = page.problems - context.state.seenErrors;
	context.state.seenErrors = page.problems;
	context.state.lastUrl = page.url;
	const live = page.live.filter((text) => !liveBefore.includes(text)).slice(0, 2);
	return [
		...live.map((text) => ` · live "${text.length > 80 ? `${text.slice(0, 79)}…` : text}"`),
		fresh > 0 ? ` · ! ${fresh} new error${fresh === 1 ? "" : "s"} (app errors)` : "",
	].join("");
}

const where = (page: Page) => `${page.path} "${page.title}" · ${page.elements.length} interactive`;

export function requireOrigin(context: Context): string {
	if (!context.origin) throw new AppError(EXIT.noTarget, "no app to drive: run app up, or pass --url <origin> once");
	return context.origin;
}

const target = (origin: string, route: string) => (/^https?:\/\//.test(route) ? route : origin + route);

export function goto(context: Context, route: string): string {
	const origin = requireOrigin(context);
	const steps = batch(context.browser, [["open", target(origin, route)], ...SETTLE, ...READ]);
	must(steps[0]);
	const page = readPage(steps);
	context.state.baseline = undefined;
	return `${where(page)}${notes(context, page)}`;
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
	context.state.baseline = undefined;
	context.state.seenErrors = 0;
	return readPage(steps);
}

export function loginLine(context: Context, persona: string | null, page: Page): string {
	if (persona && /^\/(signin|access)(\/|$|\?)/.test(page.path))
		throw new AppError(
			EXIT.noTarget,
			`${persona} is not signed in (landed on ${page.path}). Retry with app login ${persona} --fresh`,
		);
	context.state.persona = persona ?? undefined;
	return `${persona ? `signed in ${persona}` : "signed out"} → ${where(page)}${notes(context, page)}`;
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
			? batch(context.browser, [MODAL, ["snapshot", "-i", "-s", "main"], ...READ])
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
	const baseline = context.state.baseline;
	const live = page.live.length
		? [`live: ${page.live.map((text) => JSON.stringify(text.slice(0, 80))).join(" · ")}`]
		: [];
	const header = `${page.path} "${page.title}" · ${scope} · ${elements.length} interactive${notes(context, page).replace(/ · live "[^"]*"/g, "")}`;
	context.state.baseline = { url: page.url, scope, elements };
	if (!options.all && baseline && baseline.url === page.url && baseline.scope === scope) {
		const diff = changes(baseline.elements, elements);
		if (!diff.length) return [`${header} · unchanged since your last snapshot`, ...live].join("\n");
		return [
			`${header} · ${diff.length} changed since your last snapshot`,
			...capped(diff, "app snapshot --all"),
			...live,
		].join("\n");
	}
	const reason =
		!options.all && baseline
			? baseline.url !== page.url
				? " · new page, full list"
				: ` · scope is now ${scope}, full list`
			: "";
	return [
		`${header}${reason}`,
		...capped(
			elements.map((element) => describe(element)),
			"app snapshot --all",
		),
		...live,
	].join("\n");
}

function capped(lines: string[], more: string): string[] {
	if (lines.length <= CAP) return lines;
	return [...lines.slice(0, CAP), `… ${lines.length - CAP} more (${more})`];
}

type Acted = { line: string; after: Steps };

function act(
	context: Context,
	verb: string,
	actions: string[][],
	subject: string,
	after: string[][] = [],
	unchanged = " · no change in interactive elements",
): Acted {
	const head = [["get", "url"], ["snapshot", "-i"], MODAL, LIVE];
	const steps = batch(context.browser, [...head, ...actions, ...SETTLE, FRAME, ...after, MODAL, ...READ]);
	const beforeUrl = String(must(steps[0]).url ?? "");
	const before = treeOf(must(steps[1]));
	const modalBefore = must(steps[2]).result === "true";
	const liveBefore = liveOf(steps[3]);
	for (const step of steps.slice(head.length, head.length + actions.length))
		if (!step.success)
			throw new AppError(
				EXIT.notFound,
				`could not ${verb.replace(/ed$/, "")} ${subject}: ${firstLine(step.error ?? "failed")}`,
			);
	const tail = steps.slice(head.length + actions.length + SETTLE.length + 1);
	const modalAfter = must(tail[after.length]).result === "true";
	const page = readPage(steps);
	const note = notes(context, page, liveBefore);
	const done = (text: string): Acted => ({
		line: `${verb} ${subject}${text}${note}`,
		after: tail.slice(0, after.length),
	});
	if (page.url !== beforeUrl) {
		context.state.baseline = undefined;
		return done(` → ${where(page)}`);
	}
	const diff = changes(before, page.elements);
	if (modalBefore !== modalAfter) {
		const heading = diff.find((line) => /^\+ \S+ heading /.test(line));
		return done(
			modalAfter
				? ` · opened dialog${heading ? ` ${heading.replace(/^\+ \S+ heading /, "")}` : ""} · ${page.elements.length} interactive`
				: ` · closed the dialog · ${page.elements.length} interactive`,
		);
	}
	if (!diff.length) return done(page.live.some((text) => !liveBefore.includes(text)) ? "" : unchanged);
	const shown = diff.slice(0, 6).join(" · ");
	return done(` · ${shown}${diff.length > 6 ? ` · ${diff.length - 6} more (app snapshot)` : ""}`);
}

function snapshotFor(context: Context): { elements: Element[]; modalOpen: boolean } {
	requireOrigin(context);
	const steps = batch(context.browser, [["snapshot", "-i"], MODAL]);
	return { elements: treeOf(must(steps[0])), modalOpen: must(steps[1]).result === "true" };
}

const subject = (element: Element) => `${element.role} "${element.name}"`;

export function click(context: Context, name: string, options: Pick): string {
	const seen = snapshotFor(context);
	const element = pick(seen.elements, name, options, seen);
	const unique =
		seen.elements.filter((other) => other.role === element.role && other.name === element.name).length === 1;
	const action =
		unique && element.name
			? ["find", "role", element.role, "click", "--name", element.name, "--exact"]
			: ["click", `@${element.ref}`];
	const state = batch(context.browser, [
		["is", "enabled", `@${element.ref}`],
		["get", "attr", `@${element.ref}`, "aria-disabled"],
	]);
	if (must(state[0]).enabled === false || must(state[1]).value === "true")
		throw new AppError(EXIT.failed, `FAIL ${subject(element)} is disabled; the click would do nothing`);
	return act(
		context,
		"clicked",
		[action],
		subject(element),
		[],
		" · no change seen: no navigation, no element or live-text change",
	).line;
}

export function press(context: Context, key: string): string {
	requireOrigin(context);
	return act(context, "pressed", [["press", key]], key).line;
}

type Field = { selector: string; kind: string; label: string; value: string };

const SEGMENT = /^(month|day|year|hours?|minutes?|seconds?|am\/pm)$/i;
const TRUE = /^(on|true|yes|checked|1)$/i;
const FALSE = /^(off|false|no|unchecked|0)$/i;
const FORMAT: Record<string, string> = {
	date: "YYYY-MM-DD",
	time: "HH:MM (24 h)",
	"datetime-local": "YYYY-MM-DDTHH:MM",
	month: "YYYY-MM",
	week: "YYYY-Www",
	color: "#rrggbb",
	range: "a number",
	checkbox: "on or off",
	radio: "on",
	file: "a file path",
};
const fieldLine = (field: Field) => `${field.kind} "${field.label}"`;
const shortLabel = (label: string) => label.split(" · ")[0]!.trim();
const bare = (label: string) => shortLabel(label).toLowerCase();

function chooseField(fields: Field[], label: string, nth: number | undefined): Field {
	const wanted = label.trim().toLowerCase();
	const exact = fields.filter((field) => field.label.toLowerCase() === wanted || bare(field.label) === wanted);
	const matches = exact.length ? exact : fields.filter((field) => field.label.toLowerCase().includes(wanted));
	if (nth !== undefined) {
		const chosen = matches[nth - 1];
		if (!chosen) throw new AppError(EXIT.notFound, `only ${matches.length} fields match "${label}"`);
		return chosen;
	}
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1)
		throw new AppError(
			EXIT.notFound,
			`${matches.length} fields match "${label}": ${matches.slice(0, 4).map(fieldLine).join(", ")}. Add --nth <n>`,
		);
	const datelike = fields.filter((field) => ["date", "time", "datetime-local"].includes(field.kind));
	if (SEGMENT.test(label.trim()) && datelike.length)
		throw new AppError(
			EXIT.notFound,
			`"${label}" is one segment of a date or time field; fill the whole field: ${datelike
				.map((field) => `fill "${shortLabel(field.label)}" <${FORMAT[field.kind]}>`)
				.join(" · ")}`,
		);
	throw new AppError(
		EXIT.notFound,
		`no field labelled "${label}". Nearest: ${
			nearest(fields, label, (field) => field.label)
				.map(fieldLine)
				.join(", ") || "none (app snapshot)"
		}`,
	);
}

function fillActions(field: Field, value: string): string[][] {
	const request = (op: string) => [
		"eval",
		`(${FIELDS})(${JSON.stringify({ op, selector: field.selector, kind: field.kind, value })})`,
	];
	switch (field.kind) {
		case "textbox":
			return [["fill", field.selector, value]];
		case "select":
			return [["select", field.selector, value]];
		case "file":
			return [["upload", field.selector, resolve(value)]];
		case "checkbox":
		case "radio": {
			if (!TRUE.test(value) && !FALSE.test(value))
				throw new AppError(EXIT.usage, `${fieldLine(field)} takes ${FORMAT[field.kind]}, not "${value}"`);
			if (field.kind === "radio" && FALSE.test(value))
				throw new AppError(EXIT.usage, `${fieldLine(field)} cannot be turned off; fill another option of its group`);
			if (field.value === String(TRUE.test(value))) return [];
			return [["click", field.selector]];
		}
		case "combobox":
			return [
				["click", field.selector],
				["wait", "[role=option]", "--timeout", "5000"],
				["find", "role", "option", "click", "--name", value, "--exact"],
			];
		default:
			return [request("set")];
	}
}

function matchesWanted(field: Field, wanted: string, held: { value: string; alt: string }): boolean {
	const value = held.value.trim();
	if (field.kind === "checkbox" || field.kind === "radio") return value === String(TRUE.test(wanted));
	if (field.kind === "select") return value.toLowerCase() === wanted.toLowerCase() || held.alt === wanted;
	if (field.kind === "combobox") return value.toLowerCase().includes(wanted.toLowerCase());
	if (field.kind === "file") return value === `${basename(wanted)} (${statSync(resolve(wanted)).size} B)`;
	return held.value === wanted;
}

export function fill(context: Context, label: string, value: string, nth: number | undefined): string {
	requireOrigin(context);
	const fields = JSON.parse(
		String(must(batch(context.browser, [["eval", `(${FIELDS})({"op":"list"})`]])[0]).result),
	) as Field[];
	const field = chooseField(fields, label, nth);
	if (field.kind === "file") {
		const path = resolve(value);
		try {
			accessSync(path, constants.R_OK);
			if (!statSync(path).isFile()) throw new Error("not a file");
		} catch {
			throw new AppError(EXIT.usage, `no readable file at ${path}`);
		}
	}
	const read = ["eval", `(${FIELDS})(${JSON.stringify({ op: "read", selector: field.selector, kind: field.kind })})`];
	let acted: Acted;
	try {
		acted = act(context, "filled", fillActions(field, value), fieldLine(field), [read]);
	} catch (error) {
		if (!(error instanceof AppError) || field.kind !== "combobox") throw error;
		const open = batch(context.browser, [
			["snapshot", "-i"],
			["press", "Escape"],
		]);
		const options = treeOf(must(open[0])).filter((element) => element.role === "option");
		throw new AppError(
			EXIT.notFound,
			`${fieldLine(field)} has no option named "${value}". Options: ${
				options
					.slice(0, 12)
					.map((option) => JSON.stringify(option.name))
					.join(", ") || "none listed"
			}`,
		);
	}
	const held = JSON.parse(String(must(acted.after[0]).result)) as { value: string; alt: string; missing?: boolean };
	if (held.missing)
		throw new AppError(EXIT.failed, `FAIL ${fieldLine(field)} left the page during fill; check with app snapshot`);
	if (!matchesWanted(field, value, held))
		throw new AppError(
			EXIT.failed,
			`FAIL ${fieldLine(field)} holds ${JSON.stringify(held.value)} after fill (wanted ${JSON.stringify(value)}${FORMAT[field.kind] ? `, format ${FORMAT[field.kind]}` : ""})`,
		);
	return acted.line.replace(`filled ${fieldLine(field)}`, `filled ${fieldLine(field)} = ${JSON.stringify(held.value)}`);
}

export type Expectation = {
	text?: string;
	noText?: string;
	url?: string;
	title?: string;
	role?: string;
	name?: string;
	screenReader: boolean;
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
		const probe = `(${TEXT})(${text})`;
		const enough = wanted.screenReader ? `${probe} !== "absent"` : `${probe} === "visible"`;
		const found = waitFor(context, enough, wanted.timeout);
		const state = String(must(batch(context.browser, [["eval", probe]])[0]).result);
		if (found && state !== "absent")
			return `ok text ${text} (${state === "visible" ? "visible" : "screen-reader text, not visible"})`;
		if (state === "screen-reader")
			throw new AppError(
				EXIT.failed,
				`FAIL text ${text} is on the page but not visible (hidden, clipped, transparent or covered) after ${seconds}; --screen-reader asserts text for assistive technology`,
			);
		const close = nearest(bodyLines(context), wanted.text, (line) => line, 1)[0];
		throw new AppError(
			EXIT.failed,
			`FAIL text ${text} not found within ${seconds}.${close ? ` Closest on page: ${JSON.stringify(close.slice(0, 120))}` : ""}`,
		);
	}
	if (wanted.noText !== undefined) {
		const text = JSON.stringify(wanted.noText);
		const probe = `(${TEXT})(${text})`;
		const gone = wanted.screenReader ? `${probe} === "absent"` : `${probe} !== "visible"`;
		if (waitFor(context, gone, wanted.timeout))
			return `ok no text ${text} (${wanted.screenReader ? "not even for screen readers" : "not visible"})`;
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

const resized = (width: number, height: number) => [
	["set", "viewport", String(width), String(height)],
	["wait", "--fn", `innerWidth === ${width} && innerHeight === ${height}`, "--timeout", "5000"],
	FRAME,
];

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
		const sized = batch(context.browser, [...resized(width, height), ["eval", TALL]]);
		for (const step of sized) must(step);
		const tall = Math.min(Number(must(sized[3]).result) || height, 16000);
		const capture =
			!options.viewportOnly && tall > height ? [...resized(width, tall), ["screenshot", file]] : [["screenshot", file]];
		for (const step of batch(context.browser, capture)) must(step);
		lines.push(`${file} ${pngSize(file)}`);
	}
	for (const step of batch(context.browser, resized(1440, 900))) must(step);
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
