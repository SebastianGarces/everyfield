import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { browserFor, closeBrowser, sessionOpen } from "./browser.ts";
import { cookieFor, down, personaKey, personas, serve, staleNote, status, up } from "./local.ts";
import {
	click,
	cursorAudit,
	errors,
	expect,
	fill,
	goto,
	loginLine,
	press,
	shot,
	signInBrowser,
	snapshot,
	type Context,
	type Cookie,
} from "./page.ts";
import {
	AppError,
	dropSession,
	EXIT,
	readJson,
	readLocalApp,
	readSession,
	repoAt,
	writeSession,
	type Repo,
} from "./state.ts";

const HELP = `app: drive this worktree's Everyfield in one agent-browser session (agent-browser underneath, one line per result)
  up [--mode prod|dev]          this head on a throwaway Postgres 18 with the QA seed; restarts when the code changed
  status | down | personas      the local app; down also closes the browser
  login <persona>|none [--goto /route] [--fresh] [--cookie-file <json>]
  goto <route>                  open a route; prints path, title, interactive count
  snapshot [--scope main|nav|dialog|page|<css>] [--all]
                                interactive elements and live/status text; then only what changed since the last one
  click <name> [--role r] [--nth n] [--exact]       press <key>
  fill <label> <value> [--nth n]  reads the value back and fails when the field does not hold it. Values by kind:
                                text as is · date YYYY-MM-DD · time HH:MM · select/combobox the option name ·
                                checkbox/radio on|off · file a path
  expect --text t | --no-text t | --path /route | --title t | --name n [--role r]   [--timeout ms]
  shot <name> [--widths 390,1440] [--viewport] [--out dir]   PNGs outside the repo, full height by default
  cursor-audit [--scope <css>]  every visible clickable must show cursor:pointer (not-allowed when disabled)
  errors                        page and console errors this session
  do [--file steps]             one command per line (stdin by default); stops at the first failure
  raw -- <agent-browser args>   anything else, with this session's flags
  close                         close the browser session (do this when you finish)
Target: app up's app by default. Any other origin (a portless preview): --url <origin> once, then
login <key> --cookie-file <json>, where the JSON holds {"<key>": {"cookie": "name=value"}} or {"cookies": {"<key>":
{"name": ..., "value": ...}}} (the tests/ui seed fixtures work as they are).
Global: --session <name> (default app-<worktree>), --task <id> (evidence folder
<git common dir>/evf-evidence/<id>/<sha7>/shots). After an idle close the next command reopens the last page as the
last persona. Exit: 0 ok, 1 expectation failed, 2 usage, 3 element not found or ambiguous, 4 no app or not signed in,
5 agent-browser error.`;

const OPTIONS = {
	url: { type: "string" },
	session: { type: "string" },
	task: { type: "string" },
	scope: { type: "string" },
	all: { type: "boolean" },
	role: { type: "string" },
	nth: { type: "string" },
	exact: { type: "boolean" },
	name: { type: "string" },
	label: { type: "string" },
	value: { type: "string" },
	text: { type: "string" },
	"no-text": { type: "string" },
	title: { type: "string" },
	path: { type: "string" },
	timeout: { type: "string" },
	widths: { type: "string" },
	viewport: { type: "boolean" },
	out: { type: "string" },
	goto: { type: "string" },
	fresh: { type: "boolean" },
	"cookie-file": { type: "string" },
	file: { type: "string" },
	mode: { type: "string" },
} as const;

type Values = ReturnType<typeof parse>["values"];

function parse(args: string[]) {
	try {
		return parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true });
	} catch (error) {
		throw new AppError(EXIT.usage, `${(error as Error).message} (app help)`);
	}
}

function tokens(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let quote = "";
	let started = false;
	for (let i = 0; i < line.length; i++) {
		const char = line[i]!;
		if (quote) {
			if (char === quote) quote = "";
			else if (char === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) out.push(current);
			current = "";
			started = false;
		} else {
			current += char;
			started = true;
		}
	}
	if (quote) throw new AppError(EXIT.usage, `unclosed quote in: ${line}`);
	if (started) out.push(current);
	return out;
}

function number(raw: string | undefined, fallback: number, what: string): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) throw new AppError(EXIT.usage, `${what} must be a positive number`);
	return value;
}

function contextFor(repo: Repo, values: Values): Context {
	const session = values.session ?? process.env.AGENT_BROWSER_SESSION ?? `app-${repo.name}`;
	const state = readSession(repo, session);
	const local = readLocalApp(repo);
	if (values.url) state.origin = values.url.replace(/\/+$/, "");
	else if (local?.phase === "ready") state.origin = local.origin;
	const origin = state.origin;
	if (state.lastUrl && origin && !state.lastUrl.startsWith(`${origin}/`)) {
		state.persona = undefined;
		state.lastUrl = undefined;
		state.baseline = undefined;
	}
	return { repo, browser: browserFor(session, origin), origin, state, task: values.task };
}

function cookieFromFile(path: string, persona: string): Cookie {
	const data = readJson<Record<string, unknown>>(path);
	if (!data) throw new AppError(EXIT.usage, `no cookie file at ${path}`);
	const nested = (data.cookies as Record<string, unknown> | undefined)?.[persona];
	let value: unknown =
		nested ?? persona.split(".").reduce<unknown>((at, key) => (at as Record<string, unknown>)?.[key], data);
	if (value && typeof value === "object" && "cookie" in value) value = value.cookie;
	if (typeof value === "string" && value.includes("=")) {
		const at = value.indexOf("=");
		return { name: value.slice(0, at), value: value.slice(at + 1) };
	}
	if (value && typeof value === "object" && "name" in value && "value" in value)
		return { name: String(value.name), value: String(value.value) };
	throw new AppError(EXIT.usage, `${path} has no cookie for ${persona}`);
}

function cookieOf(context: Context, persona: string, cookieFile: string | undefined, fresh: boolean): Cookie {
	return cookieFile ? cookieFromFile(cookieFile, persona) : cookieFor(context.repo, personaKey(persona), fresh);
}

function login(context: Context, values: Values, raw: string | undefined): string {
	if (!raw) throw new AppError(EXIT.usage, "login <persona>|none (app personas)");
	const cookieFile = values["cookie-file"] ? resolve(values["cookie-file"]) : undefined;
	const persona = raw === "none" ? null : cookieFile ? raw : personaKey(raw);
	const cookie = persona ? cookieOf(context, persona, cookieFile, values.fresh === true) : null;
	const page = signInBrowser(context, cookie, values.goto ?? (persona ? "/overview" : "/"));
	context.state.cookieFile = cookieFile;
	const line = loginLine(context, persona, page);
	const stale = cookieFile || values.url ? null : staleNote(context.repo);
	return stale ? `${line}\n${stale}` : line;
}

function reopen(context: Context): string | null {
	const { persona, lastUrl, cookieFile } = context.state;
	if (!lastUrl || sessionOpen(context.browser.session)) return null;
	let path = "/";
	try {
		const url = new URL(lastUrl);
		path = url.pathname + url.search;
	} catch {}
	const why = `the browser had closed (idle timeout or crash)`;
	let cookie: Cookie | null = null;
	if (persona)
		try {
			cookie = cookieOf(context, persona, cookieFile, false);
		} catch (error) {
			context.state.persona = undefined;
			context.state.lastUrl = undefined;
			throw new AppError(
				EXIT.noTarget,
				`${why} and ${persona} cannot sign in again (${error instanceof AppError ? error.message : String(error)}); run app login <persona>`,
			);
		}
	const page = signInBrowser(context, cookie, path);
	if (persona && /^\/(signin|access)(\/|$|\?)/.test(page.path)) {
		context.state.persona = undefined;
		throw new AppError(EXIT.noTarget, `${why}; ${persona} is no longer signed in: run app login ${persona} --fresh`);
	}
	context.state.lastUrl = page.url;
	return `${why}: reopened ${persona ? `as ${persona} ` : ""}at ${page.path}`;
}

const pickOptions = (values: Values) => ({
	role: values.role,
	nth: values.nth === undefined ? undefined : number(values.nth, 1, "--nth"),
	exact: values.exact,
});

function one(positionals: string[], index: number, what: string): string {
	const value = positionals[index];
	if (value === undefined) throw new AppError(EXIT.usage, `give ${what} (app help)`);
	return value;
}

async function command(repo: Repo, args: string[], outer: Values | null): Promise<string> {
	const { values: own, positionals } = parse(args);
	const values: Values = outer ? { ...outer, ...own } : own;
	const [verb, ...rest] = positionals;
	if (!verb || verb === "help") return HELP;
	if (verb === "up")
		return up(repo, { mode: values.mode ?? "prod", timeoutSeconds: number(values.timeout, 600, "--timeout") });
	if (verb === "status") return [await status(repo), browserStatus(repo, values)].join("\n");
	if (verb === "personas") return personas();
	if (verb === "down") return [closeLine(repo, values), down(repo)].join("\n");
	if (verb === "close") return closeLine(repo, values);
	if (verb === "do") {
		if (outer) throw new AppError(EXIT.usage, "do cannot run inside do");
		return script(repo, values);
	}
	const context = contextFor(repo, values);
	try {
		switch (verb) {
			case "login":
				return login(context, values, rest[0]);
			case "goto":
				return withReopen(context, () => goto(context, one(rest, 0, "a route, e.g. /people")));
			case "snapshot":
				return withReopen(context, () => snapshot(context, { scope: values.scope, all: values.all }));
			case "click":
				return withReopen(context, () =>
					click(context, values.name ?? one(rest, 0, "the accessible name to click"), pickOptions(values)),
				);
			case "fill": {
				const label = values.label ?? one(rest, 0, "the field label");
				const value = values.value ?? one(rest, values.label ? 0 : 1, "the value to fill");
				return withReopen(context, () => fill(context, label, value, pickOptions(values).nth));
			}
			case "press":
				return withReopen(context, () => press(context, one(rest, 0, "a key, e.g. Enter")));
			case "expect":
				return withReopen(context, () =>
					expect(context, {
						text: values.text,
						noText: values["no-text"],
						url: values.path,
						title: values.title,
						role: values.role,
						name: values.name,
						timeout: number(values.timeout, 5000, "--timeout"),
					}),
				);
			case "shot":
				return withReopen(context, () =>
					shot(context, one(rest, 0, "a shot name"), {
						out: values.out,
						widths: (values.widths ?? "390,1440").split(",").map((width) => number(width, 0, "--widths")),
						viewportOnly: values.viewport === true,
					}),
				);
			case "cursor-audit":
				return withReopen(context, () => cursorAudit(context, values.scope));
			case "errors":
				return withReopen(context, () => errors(context));
			default:
				throw new AppError(EXIT.usage, `unknown command ${verb} (app help)`);
		}
	} finally {
		writeSession(repo, context.browser.session, context.state);
	}
}

function withReopen(context: Context, run: () => string): string {
	const note = reopen(context);
	const result = run();
	return note ? `${note}\n${result}` : result;
}

function closeLine(repo: Repo, values: Values): string {
	const context = contextFor(repo, values);
	const closed = closeBrowser(context.browser);
	dropSession(repo, context.browser.session);
	return closed ? `closed ${context.browser.session}` : `no open session ${context.browser.session}`;
}

function browserStatus(repo: Repo, values: Values): string {
	const context = contextFor(repo, values);
	const open = sessionOpen(context.browser.session);
	const persona = context.state.persona ? ` as ${context.state.persona}` : "";
	const last = context.state.lastUrl ? ` at ${new URL(context.state.lastUrl).pathname}` : "";
	const state = open
		? `open${persona}${last}`
		: context.state.lastUrl
			? `closed (was${persona}${last}; the next command reopens it)`
			: "closed";
	return `session ${context.browser.session} ${state} · target ${context.origin ?? "none"}`;
}

async function script(repo: Repo, values: Values): Promise<string> {
	const text = values.file ? readFileSync(values.file, "utf8") : readFileSync(0, "utf8");
	const steps = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	if (!steps.length) throw new AppError(EXIT.usage, "do got no steps: one app command per line");
	const shared: Values = { url: values.url, session: values.session, task: values.task };
	const lines: string[] = [];
	for (const [index, step] of steps.entries()) {
		const words = tokens(step);
		if (words[0] === "app") words.shift();
		try {
			const result = await command(repo, words, shared);
			lines.push(`${index + 1} ok ${result.replace(/^ok /, "").split("\n").join("\n  ")}`);
		} catch (error) {
			if (!(error instanceof AppError)) throw error;
			lines.push(
				`${index + 1} FAIL ${error.message.replace(/^FAIL /, "")}`,
				`stopped at step ${index + 1} of ${steps.length}: ${step}`,
			);
			throw new AppError(error.code, lines.join("\n"));
		}
	}
	lines.push(`${steps.length}/${steps.length} ok`);
	return lines.join("\n");
}

function raw(repo: Repo, args: string[]): number {
	const split = args.indexOf("--");
	if (split < 0) throw new AppError(EXIT.usage, "raw -- <agent-browser args>");
	const { values } = parse(args.slice(0, split).filter((arg) => arg !== "raw"));
	const context = contextFor(repo, values);
	const child = spawnSync("agent-browser", [...context.browser.flags, ...args.slice(split + 1)], { stdio: "inherit" });
	return child.status ?? EXIT.browser;
}

async function main(args: string[]): Promise<number> {
	if (args[0] === "--help" || args[0] === "-h") {
		console.log(HELP);
		return EXIT.ok;
	}
	const repo = repoAt(process.cwd());
	if (args[0] === "_serve") {
		await serve(repo);
		return EXIT.ok;
	}
	if (args.includes("raw") && args.includes("--") && args.indexOf("raw") < args.indexOf("--")) return raw(repo, args);
	console.log(await command(repo, args, null));
	return EXIT.ok;
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof AppError)) throw error;
	console.log(error.message);
	process.exitCode = error.code;
}
