import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openWorkDb, workDbPath } from "./db.ts";

/**
 * Token usage and estimated cost per seat run (OPS-69). Numbers come only from the local Claude Code transcript of the
 * run's session: token counts and model names, never message text. Costs are list-price estimates; nothing is billed.
 */

export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });

/**
 * US dollars per million tokens at Anthropic's API list prices. Source: the Opus and Sonnet tier list prices on
 * anthropic.com/pricing. UNVERIFIED for 5.5: written on 2026-10-30 without network access, so a person must check the
 * numbers against the pricing page. Cache write 5m is 1.25 × input, 1h is 2 × input, cache read is 0.1 × input.
 */
export const PRICES_SOURCE =
	"anthropic.com/pricing (Opus and Sonnet tier list prices), read 2026-10-30, unverified for 5.5";
export type Price = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number };
export const PRICES: Record<string, Price> = {
	"claude-opus-5-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
	"claude-sonnet-5-5": { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
};

/** Estimated dollars for one model's tokens, or null when the model has no price. Unsplit cache writes cost the 5m rate. */
export function costOf(model: string, t: Tokens): number | null {
	const p = Object.hasOwn(PRICES, model) ? PRICES[model]! : undefined;
	if (!p) return null;
	const w1h = Math.min(t.cacheWrite1h, t.cacheWrite),
		w5m = t.cacheWrite - w1h;
	return (
		(t.input * p.input +
			t.output * p.output +
			t.cacheRead * p.cacheRead +
			w5m * p.cacheWrite5m +
			w1h * p.cacheWrite1h) /
		1e6
	);
}

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The session's main transcript and its subagent transcripts, or null when no transcript exists. */
function transcriptFiles(session: string): string[] | null {
	if (!/^[\w-]+$/.test(session)) return null;
	const projects = join(claudeDir(), "projects");
	let folders: string[];
	try {
		folders = readdirSync(projects);
	} catch {
		return null;
	}
	for (const folder of folders) {
		const main = join(projects, folder, `${session}.jsonl`);
		if (!existsSync(main)) continue;
		const subDir = join(projects, folder, session, "subagents");
		let subs: string[] = [];
		try {
			subs = readdirSync(subDir)
				.filter((n) => n.endsWith(".jsonl"))
				.sort()
				.map((n) => join(subDir, n));
		} catch {
			/* no subagents */
		}
		return [main, ...subs];
	}
	return null;
}

/**
 * Token totals per model for a session. Claude Code writes one line per content block, so a message's usage repeats
 * under one message.id: each id counts once, with the largest value seen per field. `<synthetic>` entries and lines
 * that do not parse are skipped. Returns null when there is no transcript or the main file cannot be read.
 */
export function readSessionUsage(session: string): Map<string, Tokens> | null {
	const files = transcriptFiles(session);
	if (!files) return null;
	const byId = new Map<string, { model: string; t: Tokens }>();
	for (const [i, file] of files.entries()) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			if (i === 0) return null;
			continue;
		}
		for (const [lineNo, line] of text.split("\n").entries()) {
			if (!line.trim()) continue;
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const m = entry?.message,
				u = m?.usage;
			if (!m || typeof u !== "object" || u === null || typeof m.model !== "string" || m.model === "<synthetic>")
				continue;
			const id = typeof m.id === "string" ? m.id : null;
			const seen: Tokens = {
				input: num(u.input_tokens),
				output: num(u.output_tokens),
				cacheRead: num(u.cache_read_input_tokens),
				cacheWrite: num(u.cache_creation_input_tokens),
				cacheWrite1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
			};
			const key = id ?? `${file}:${lineNo}`;
			const have = byId.get(key);
			if (!have) byId.set(key, { model: m.model, t: seen });
			else for (const k of Object.keys(seen) as Array<keyof Tokens>) have.t[k] = Math.max(have.t[k], seen[k]);
		}
	}
	const out = new Map<string, Tokens>();
	for (const { model, t } of byId.values()) {
		const sum = out.get(model) ?? zero();
		for (const k of Object.keys(t) as Array<keyof Tokens>) sum[k] += t[k];
		out.set(model, sum);
	}
	return out;
}

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null };

/** Sum the models: cost is null when any model has no price. */
export function totalUsage(models: Map<string, Tokens>): Usage {
	const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const [model, t] of models) {
		u.input += t.input;
		u.output += t.output;
		u.cacheRead += t.cacheRead;
		u.cacheWrite += t.cacheWrite;
		const c = costOf(model, t);
		u.cost = u.cost === null || c === null ? null : u.cost + c;
	}
	return u;
}

const WRITE_USAGE =
	"UPDATE runs SET tokens_in = ?, tokens_out = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_est = ? WHERE id = ?";

/**
 * Fill a run's usage columns from its transcript. Without a session id or a readable transcript the columns stay as
 * they are. Never throws: closing a run must succeed whatever the transcript looks like. Returns whether it filled.
 */
export function fillRunUsage(db: DatabaseSync, runId: number): boolean {
	try {
		const row = db.prepare("SELECT session_id FROM runs WHERE id = ?").get(runId) as
			{ session_id: string | null } | undefined;
		if (!row?.session_id) return false;
		const models = readSessionUsage(row.session_id);
		if (!models) return false;
		const u = totalUsage(models);
		db.prepare(WRITE_USAGE).run(u.input, u.output, u.cacheRead, u.cacheWrite, u.cost, runId);
		return true;
	} catch {
		return false;
	}
}

/** `evf usage --backfill`: fill every run that has a session id and a readable transcript. Idempotent. */
export function usageBackfill(root: string): number {
	const db = openWorkDb(root);
	try {
		const runs = db.prepare("SELECT id, session_id FROM runs ORDER BY id").all() as Array<{
			id: number;
			session_id: string | null;
		}>;
		let filled = 0,
			noSession = 0,
			noTranscript = 0;
		for (const r of runs) {
			if (!r.session_id) noSession++;
			else if (fillRunUsage(db, r.id)) filled++;
			else noTranscript++;
		}
		console.log(
			`usage backfill: filled ${filled} runs, skipped ${noSession + noTranscript} (no session id: ${noSession}, no transcript: ${noTranscript}). Costs are list-price estimates; nothing is billed.`,
		);
		return 0;
	} finally {
		db.close();
	}
}

type RunRow = {
	task: string;
	round: number;
	stage: string;
	role: string;
	model: string | null;
	status: string;
	tokens_in: number | null;
	tokens_out: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	cost_est: number | null;
};

export type Group = "build" | "review" | "prototype";
const BUILD_STAGES = ["plan", "implement", "simplify"];
const REVIEW_STAGES = ["evidence", "verify"];
/** Build is plan, implement, ui and simplify in round 0; review and rework is the rest of the seat stages. */
export function groupOf(stage: string, round: number): Group | null {
	if (BUILD_STAGES.includes(stage)) return round === 0 ? "build" : "review";
	if (REVIEW_STAGES.includes(stage)) return "review";
	if (/^idea\d*$/.test(stage) || stage === "compare" || stage === "merge") return "prototype";
	return null; // pr, ci and ship: evf stages with no Claude session.
}

type Bucket = {
	runs: number;
	withData: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	unpriced: number;
};
const bucket = (): Bucket => ({
	runs: 0,
	withData: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	unpriced: 0,
});
function add(b: Bucket, r: RunRow): void {
	b.runs++;
	if (r.tokens_in === null) return; // no data: never counted as zero
	b.withData++;
	b.input += r.tokens_in;
	b.output += r.tokens_out ?? 0;
	b.cacheRead += r.cache_read_tokens ?? 0;
	b.cacheWrite += r.cache_write_tokens ?? 0;
	if (r.cost_est === null) b.unpriced++;
	else b.cost += r.cost_est;
}
const cell = (b: Bucket) => ({
	runs: b.runs,
	runs_with_data: b.withData,
	no_data: b.runs - b.withData,
	input: b.input,
	output: b.output,
	cache_read: b.cacheRead,
	cache_write: b.cacheWrite,
	cost_estimate_usd: b.withData && b.unpriced < b.withData ? Math.round(b.cost * 1e4) / 1e4 : null,
	unpriced_runs: b.unpriced,
});
type Cell = ReturnType<typeof cell>;

export type UsageReport = {
	note: string;
	prices_source: string;
	tasks: Array<{
		task: string;
		rounds: number;
		verify_fails: number;
		ci_fails: number;
		by_role_model: Array<{ role: string; model: string } & Cell>;
		total: Cell;
	}>;
	by_model?: Array<{ model: string; groups: Record<Group, Cell>; total: Cell }>;
};

const NOTE = "Costs are estimates at API list prices. Nothing is billed.";

export function buildUsageReport(db: DatabaseSync, only?: string): UsageReport {
	const tasks = db
		.prepare(
			`SELECT id, COALESCE(ref, slug) AS ref, round FROM tasks WHERE status != 'abandoned' ${only ? "AND (ref = ? OR slug = ?)" : ""} ORDER BY COALESCE(ref, slug), id`,
		)
		.all(...(only ? [only, only] : [])) as Array<{ id: number; ref: string; round: number }>;
	const runsOf = db.prepare(
		"SELECT ? AS task, round, stage, role, model, status, tokens_in, tokens_out, cache_read_tokens, cache_write_tokens, cost_est FROM runs WHERE task_id = ? AND role != 'evf' ORDER BY id",
	);
	const fails = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ? AND stage = ? AND status = 'failed'");
	const report: UsageReport = { note: NOTE, prices_source: PRICES_SOURCE, tasks: [] };
	const models = new Map<string, Record<Group, Bucket> & { total: Bucket }>();
	for (const t of tasks) {
		const rows = runsOf.all(t.ref, t.id) as RunRow[];
		const groups = new Map<string, Bucket>();
		const total = bucket();
		for (const r of rows) {
			const key = `${r.role}\u0000${r.model ?? "unknown"}`;
			const b = groups.get(key) ?? bucket();
			add(b, r);
			groups.set(key, b);
			add(total, r);
			const g = groupOf(r.stage, r.round);
			if (g) {
				const m = models.get(r.model ?? "unknown") ?? {
					build: bucket(),
					review: bucket(),
					prototype: bucket(),
					total: bucket(),
				};
				add(m[g], r);
				add(m.total, r);
				models.set(r.model ?? "unknown", m);
			}
		}
		report.tasks.push({
			task: t.ref,
			rounds: t.round,
			verify_fails: (fails.get(t.id, "verify") as { n: number }).n,
			ci_fails: (fails.get(t.id, "ci") as { n: number }).n,
			by_role_model: [...groups]
				.map(([key, b]) => {
					const [role, model] = key.split("\u0000") as [string, string];
					return { role, model, ...cell(b) };
				})
				.sort((a, b) => a.role.localeCompare(b.role) || a.model.localeCompare(b.model)),
			total: cell(total),
		});
	}
	if (!only)
		report.by_model = [...models]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([model, m]) => ({
				model,
				groups: { build: cell(m.build), review: cell(m.review), prototype: cell(m.prototype) },
				total: cell(m.total),
			}));
	return report;
}

const n = (v: number) => v.toLocaleString("en-US");
const dollars = (c: Cell) => (c.cost_estimate_usd === null ? "no data" : `$${c.cost_estimate_usd.toFixed(2)} estimate`);
function line(label: string, c: Cell): string {
	if (!c.runs_with_data) return `${label}: no data (${c.runs} ${c.runs === 1 ? "run" : "runs"})`;
	const missing = c.no_data ? `, ${c.no_data} with no data` : "";
	return `${label}: input ${n(c.input)}, output ${n(c.output)}, cache read ${n(c.cache_read)}, cache write ${n(c.cache_write)}, ${dollars(c)} (${c.runs} ${c.runs === 1 ? "run" : "runs"}${missing})`;
}

export function renderUsageReport(r: UsageReport): string {
	const out = [`Usage report. ${r.note} Prices: ${r.prices_source}.`];
	for (const t of r.tasks) {
		out.push("", `${t.task}: rounds ${t.rounds}, verify fails ${t.verify_fails}, CI fails ${t.ci_fails}`);
		for (const g of t.by_role_model) out.push(`  ${line(`${g.role} on ${g.model}`, g)}`);
		out.push(`  ${line("total", t.total)}`);
	}
	if (r.by_model) {
		out.push("", "By model");
		for (const m of r.by_model) {
			out.push(`  ${m.model}`);
			out.push(`    ${line("build (round 0 plan, implement, ui, simplify)", m.groups.build)}`);
			out.push(`    ${line("review and rework (evidence, verify, round 1+ build stages)", m.groups.review)}`);
			out.push(`    ${line("prototype", m.groups.prototype)}`);
			out.push(`    ${line("total", m.total)}`);
		}
	}
	return out.join("\n");
}

export function usageReport(root: string, opts: { task?: string; json: boolean }): number {
	if (!existsSync(workDbPath(root))) {
		console.log("usage: no work store yet. Run evf db migrate.");
		return 0;
	}
	const db = openWorkDb(root, { readOnly: true });
	try {
		const report = buildUsageReport(db, opts.task);
		console.log(opts.json ? JSON.stringify(report, null, 2) : renderUsageReport(report));
		return 0;
	} finally {
		db.close();
	}
}
