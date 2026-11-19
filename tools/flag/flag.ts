import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Transaction } from "../../packages/db/src/client.ts";
import {
	readAccountIdByEmail,
	readGlobalValues,
	readOverrides,
	readStaleReleaseFlags,
	registry,
	setFlag,
	type FlagScope,
	type Registry,
} from "../../packages/domain/src/flags/index.ts";

export const HELP = `bin/flag: read and change Everyfield feature flags (docs/architecture/patterns.md, "Feature flags").
Targets the shared development database by default (DATABASE_URL, else the main checkout's apps/web/.env.local).
Every command prints the database it targets first.

  flag list                         every registry flag: kind, default, owner, task, expiry and its global value
  flag show <name>                  one flag's declaration, global value and every workspace and account override
  flag set <name> on|off|clear --workspace <id>   override for one plant or organization
  flag set <name> on|off|clear --account <id|email>  override for one account, by id or sign-in email
  flag set <name> on|off|clear --all              the global value, for everyone
        Turning a release flag on with --all needs an approved flip: it runs evf flip status <name> --json and
        refuses unless the state is approved. Ask with evf flip request <name> --task T-<n> --note "<why>".
        kill and ops flags, turning a flag off and clearing a value need no flip. Each change writes one
        flags.changed audit row; setting the value a flag already holds writes nothing.
  flag stale [--file]               release flags on for everyone, unchanged for 14 or more days (dated from their
        last flags.changed audit row), with the evf task new command that files each removal. --file files them
        when evf is reachable on this Mac and skips a flag with an open removal task (label flag:<name>), so a
        rerun files nothing twice. Never files under CI; with no flag database configured under CI it skips
  flag check                        fails when a release flag is past its expires date or a registry entry has no
        readFlag("<name>") or switchedOff(…, "<name>", …) left outside the registry and flag declarations
        (apps/web test:unit runs it: bin/dev check and CI)

Targets:
  (default)                 the shared development database
  --qa <qa-id>              the Neon branch of a bin/qa preview (bin/qa list), through neonctl
  --production              production, only with FLAG_PRODUCTION_DATABASE_URL set from Sebastian's production env
                            (AGENTS guard 1). Never from a seat, a test or CI.

Flags Explorer: on previews with FLAGS_SECRET set (bin/qa and the local bin/dev stack preview), the Vercel Toolbar
can force a flag for one browser through the vercel-flag-overrides cookie; that changes no feature_flag row and is
ignored in production. Runbook: docs/runbooks/qa-preview.md.`;

type Db = Pick<Transaction, "execute">;
export type EvfResult = { status: number | null; stdout: string; stderr: string };
export type Evf = (args: readonly string[]) => EvfResult;

export type FlagDeps = {
	db: Db;
	target: string;
	evf: Evf;
	out: (line: string) => void;
	err: (line: string) => void;
	ci: boolean;
	declared?: Registry;
};

export class FlagError extends Error {
	readonly code: number;
	constructor(message: string, code = 1) {
		super(message);
		this.code = code;
	}
}

const OPERATOR = { cause: "bin/flag" } as const;
const STALE_DAYS = 14;

const onOff = (value: boolean | null | undefined) => (value === true ? "on" : value === false ? "off" : "unset");
const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const day = (date: Date) => date.toISOString().slice(0, 10);

export function take(args: string[], name: string): string | undefined {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const value = args[at + 1];
	if (value === undefined || value.startsWith("--")) throw new FlagError(`${name} needs a value.`, 2);
	args.splice(at, 2);
	return value;
}

function declaration(declared: Registry, name: string | undefined) {
	if (!name) throw new FlagError("Name a flag. bin/flag list shows them.", 2);
	const flag = Object.hasOwn(declared, name) ? declared[name] : undefined;
	if (!flag) throw new FlagError(`No flag ${name} in the registry (packages/domain/src/flags/registry.ts).`);
	return flag;
}

async function list(deps: FlagDeps, declared: Registry) {
	const values = await readGlobalValues(deps.db, declared);
	const rows = [
		["NAME", "KIND", "DEFAULT", "OWNER", "TASK", "EXPIRES", "GLOBAL"],
		...Object.entries(declared).map(([name, f]) => [
			name,
			f.kind,
			onOff(f.default),
			f.owner,
			f.task,
			f.expires,
			onOff(values.get(name)),
		]),
	];
	const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
	for (const row of rows)
		deps.out(
			row
				.map((cell, i) => cell.padEnd(widths[i]!))
				.join("  ")
				.trimEnd(),
		);
}

async function show(deps: FlagDeps, declared: Registry, name: string | undefined) {
	const f = declaration(declared, name);
	const flag = name!;
	const [values, overrides] = await Promise.all([readGlobalValues(deps.db, declared), readOverrides(deps.db, flag)]);
	deps.out(flag);
	deps.out(
		`  kind ${f.kind}, default ${onOff(f.default)}, owner ${f.owner}, task ${f.task}, created ${f.created}, expires ${f.expires}`,
	);
	deps.out(`  global: ${onOff(values.get(flag))}`);
	if (!overrides.length) deps.out("  overrides: none");
	else {
		deps.out("  overrides:");
		for (const o of overrides)
			deps.out(`    ${o.kind === "account" ? "account" : `workspace (${o.kind})`} ${o.tenant}: ${onOff(o.value)}`);
	}
}

const FLIP_STATES = ["approved", "open", "declined", "none"] as const;
type FlipStatus = { flag: string; state: (typeof FLIP_STATES)[number]; decision: string | null };

function parseFlipStatus(stdout: string): FlipStatus {
	const value: unknown = JSON.parse(stdout);
	if (!value || typeof value !== "object") throw Error("not an object");
	const { flag, state, decision } = value as Record<string, unknown>;
	if (typeof flag !== "string" || !FLIP_STATES.includes(state as FlipStatus["state"])) throw Error("no flag or state");
	if (decision !== undefined && decision !== null && typeof decision !== "string") throw Error("bad decision");
	return { flag, state: state as FlipStatus["state"], decision: decision ?? null };
}

function requireFlip(deps: FlagDeps, name: string, task: string) {
	const ask = `Ask with: evf flip request ${name} --task ${task} --note "<why it may go on for everyone>"`;
	const refuse = (why: string) =>
		new FlagError(`Refused: turning the release flag ${name} on for everyone needs an approved flip. ${why} ${ask}`);
	const ran = deps.evf(["flip", "status", name, "--json"]);
	if (ran.status === null) throw refuse("evf is not reachable here, so the flip cannot be checked.");
	if (ran.status !== 0)
		throw refuse(`evf flip status failed (exit ${ran.status}): ${ran.stderr.trim().split("\n").pop() ?? ""}`.trim());
	let parsed: FlipStatus;
	try {
		parsed = parseFlipStatus(ran.stdout);
	} catch {
		throw refuse("evf flip status printed output bin/flag cannot read.");
	}
	if (parsed.flag !== name) throw refuse(`evf flip status answered for ${parsed.flag}, not ${name}.`);
	if (parsed.state === "approved") return parsed.decision;
	const decision = parsed.decision ? ` (${parsed.decision})` : "";
	throw refuse(`evf flip status says ${parsed.state}${decision}.`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

async function set(deps: FlagDeps, declared: Registry, args: string[]) {
	const options = [...args];
	const workspace = take(options, "--workspace");
	const account = take(options, "--account");
	const all = options.includes("--all");
	const [name, raw, ...extra] = options.filter((o) => o !== "--all");
	if (extra.length || options.filter((o) => o === "--all").length > 1)
		throw new FlagError(`Unexpected: ${extra.join(" ") || "--all"}`, 2);
	const f = declaration(declared, name);
	const flag = name!;
	if (raw !== "on" && raw !== "off" && raw !== "clear") throw new FlagError("Say on, off or clear.", 2);
	const value = raw === "clear" ? null : raw === "on";
	const scopes = [workspace !== undefined, account !== undefined, all].filter(Boolean).length;
	if (scopes !== 1) throw new FlagError("Give exactly one of --workspace <id>, --account <id> or --all.", 2);
	let scope: FlagScope = { kind: "global" };
	if (workspace !== undefined) {
		if (!UUID.test(workspace)) throw new FlagError(`--workspace ${workspace} is not an id (a uuid).`);
		scope = { kind: "workspace", id: workspace };
	}
	if (account !== undefined) {
		const id = EMAIL.test(account) ? await readAccountIdByEmail(deps.db, account) : account;
		if (id === null)
			throw new FlagError(`No single account signs in as ${account} in ${deps.target}. Nothing changed.`);
		if (!UUID.test(id)) throw new FlagError(`--account ${account} is not an account id (a uuid) or a sign-in email.`);
		scope = { kind: "account", id };
	}
	let approval: string | null = null;
	if (scope.kind === "global" && value === true && f.kind === "release") approval = requireFlip(deps, flag, f.task);
	try {
		await setFlag(deps.db, { flag, scope, value, operator: OPERATOR }, declared);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("flag_scope_unavailable")) {
			const id = "id" in scope ? scope.id : "";
			throw new FlagError(
				scope.kind === "workspace"
					? `No plant or organization ${id} in ${deps.target}. Nothing changed.`
					: `No account ${id} in ${deps.target}. Nothing changed.`,
			);
		}
		throw error;
	}
	const where = scope.kind === "global" ? "for everyone" : `for ${scope.kind} ${"id" in scope ? scope.id : ""}`;
	deps.out(
		`${flag}: ${value === null ? "cleared" : onOff(value)} ${where}${approval ? ` (flip ${approval} approved)` : ""}.`,
	);
}

export function removalAsk(name: string, flag: Registry[string], since: Date) {
	return `Remove the release flag ${name} (owner ${flag.owner}, from ${flag.task}). It has been on for everyone since ${day(since)}. Delete its entry in packages/domain/src/flags/registry.ts, the off branch at every readFlag("${name}") and the tests of the off path; typecheck then names any read that is left (docs/architecture/patterns.md, Feature flags).`;
}

const removalTitle = (name: string) => `Remove the ${name} feature flag`;
const removalLabel = (name: string) => `flag:${name}`;
const AUTHOR = "bin/flag stale";

type OpenTask = { id: number; label: string | null; lifecycle: string };

function parseTasks(stdout: string): OpenTask[] {
	const value: unknown = JSON.parse(stdout);
	if (!Array.isArray(value)) throw Error("not a list");
	return value.map((task: Record<string, unknown>) => {
		if (typeof task.id !== "number" || typeof task.lifecycle !== "string") throw Error("not a task");
		return { id: task.id, label: typeof task.label === "string" ? task.label : null, lifecycle: task.lifecycle };
	});
}

async function stale(deps: FlagDeps, declared: Registry, args: string[]) {
	const file = args.includes("--file");
	if (args.some((o) => o !== "--file")) throw new FlagError(`Unexpected: ${args.join(" ")}`, 2);
	if (file && deps.ci) throw new FlagError("bin/flag stale --file never files from CI. Nothing filed.");
	const found = await readStaleReleaseFlags(deps.db, STALE_DAYS, declared);
	if (!found.length) {
		deps.out(`No release flag has been on for everyone for ${STALE_DAYS} or more days.`);
		return;
	}
	deps.out(`Release flags on for everyone for ${STALE_DAYS} or more days: ${found.length}`);
	for (const s of found) {
		const f = declared[s.name]!;
		deps.out(`${s.name}  on since ${day(s.since)} (${s.days} days), owner ${f.owner}, task ${f.task}`);
		deps.out(
			`  printf '%s\\n' ${shellQuote(removalAsk(s.name, f, s.since))} | evf task new --title ${shellQuote(removalTitle(s.name))} --label ${shellQuote(removalLabel(s.name))} --author ${shellQuote(AUTHOR)} --ask-file /dev/stdin`,
		);
	}
	if (!file) return;
	const listed = deps.evf(["task", "list", "--json"]);
	let open: OpenTask[];
	try {
		if (listed.status !== 0) throw Error("evf task list failed");
		open = parseTasks(listed.stdout);
	} catch {
		throw new FlagError("evf is not reachable on this Mac (evf task list failed). Nothing filed.");
	}
	const dir = mkdtempSync(join(tmpdir(), "bin-flag-"));
	try {
		for (const s of found) {
			const existing = open.find((t) => t.label === removalLabel(s.name) && t.lifecycle === "open");
			if (existing) {
				deps.out(`skipped ${s.name}: T-${existing.id} is already open.`);
				continue;
			}
			const ask = join(dir, `${s.name}.md`);
			writeFileSync(ask, removalAsk(s.name, declared[s.name]!, s.since) + "\n");
			const filed = deps.evf([
				"task",
				"new",
				"--title",
				removalTitle(s.name),
				"--label",
				removalLabel(s.name),
				"--author",
				AUTHOR,
				"--ask-file",
				ask,
			]);
			if (filed.status !== 0)
				throw new FlagError(`evf task new failed for ${s.name} (exit ${filed.status}): ${filed.stderr.trim()}`);
			deps.out(`filed ${s.name}: ${filed.stdout.trim()}`);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export const DB_COMMANDS = new Set(["list", "show", "set", "stale"]);

export async function runFlag(argv: readonly string[], deps: FlagDeps): Promise<void> {
	const declared = deps.declared ?? registry;
	const [command, ...rest] = argv;
	deps.err(`bin/flag: target ${deps.target}`);
	if (command === "list" && !rest.length) return list(deps, declared);
	if (command === "show" && rest.length === 1) return show(deps, declared, rest[0]);
	if (command === "set") return set(deps, declared, rest);
	if (command === "stale") return stale(deps, declared, rest);
	throw new FlagError(`Unknown command: flag ${argv.join(" ")}\n\n${HELP}`, 2);
}
