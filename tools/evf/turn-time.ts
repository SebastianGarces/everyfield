import { readFileSync } from "node:fs";

/**
 * Where a seat's time went, from its Claude Code transcript (OPS-134). The stop hook's `turn_end` and the long run check
 * both call this module, so the two cannot disagree. It reads timestamps, tool names and Bash command names only; it
 * returns durations and never message text, prompts, commands or tool output.
 */

export type Split = { toolMs: number; checkMs: number; waitMs: number; modelMs: number };
type Kind = "check" | "wait" | "tool";
type Span = { from: number; to: number; kind: Kind };
type Entry = {
	ts: number;
	/** A user entry with no tool_result and no isMeta flag: a prompt that begins a turn. */
	opens: boolean;
	endsTurn: boolean;
	calls: Array<{ id: string; kind: Kind }>;
	results: string[];
};

const ENV_PREFIX = /^(?:[A-Za-z_]\w*=\S*\s+)*/;
/** The shell words that can stand before a command, as in `until x; do sleep 5; done`. */
const SHELL_PREFIX = /^(?:(?:do|then|else|elif|if|while|until|time|!)\s+)*/;
const EVF_CHECKS = new Set(["verify", "check", "test", "timing", "ac run", "browser run"]);

function kindOfCommand(command: string): Kind {
	let kind: Kind = "tool";
	// Quoted text and a heredoc body are not code.
	const parts = command
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
		.replace(/<<[^]*$/, "")
		.split(/[\n;|&(){}]/);
	for (const part of parts) {
		const words = part.trim().replace(SHELL_PREFIX, "").replace(ENV_PREFIX, "").split(/\s+/),
			[path = "", second = "", third = ""] = words,
			first = path.slice(path.lastIndexOf("/") + 1);
		if (first === "evf" && (EVF_CHECKS.has(second) || EVF_CHECKS.has(`${second} ${third}`))) return "check";
		if (
			first === "sleep" ||
			(first === "herdr" && second === "agent" && third === "wait") ||
			(first === "gh" && second === "run" && third === "watch") ||
			(first === "gh" && second === "pr" && third === "checks" && words.includes("--watch"))
		)
			kind = "wait";
	}
	return kind;
}

/** Check, wait or tool, for one tool call. An Agent call is tool time. */
function kindOf(name: unknown, input: unknown): Kind {
	if (name === "Monitor") return "wait";
	const command = (input as { command?: unknown } | null)?.command;
	return name === "Bash" && typeof command === "string" ? kindOfCommand(command) : "tool";
}

/** The main-session user and assistant entries with a timestamp. Other kinds and lines that do not parse are skipped. */
export function parseEntries(lines: string[]): Entry[] {
	const out: Entry[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: any;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if ((e?.type !== "user" && e?.type !== "assistant") || e.isSidechain === true) continue;
		const ts = Date.parse(e.timestamp);
		if (!Number.isFinite(ts)) continue;
		const content: any[] = Array.isArray(e.message?.content) ? e.message.content : [];
		const results = content.filter((b) => b?.type === "tool_result").map((b) => String(b.tool_use_id));
		out.push({
			ts,
			opens: e.type === "user" && !results.length && e.isMeta !== true,
			endsTurn: e.type === "assistant" && (e.message?.stop_reason === "end_turn" || e.message?.model === "<synthetic>"),
			calls: content
				.filter((b) => b?.type === "tool_use")
				.map((b) => ({ id: String(b.id), kind: kindOf(b.name, b.input) })),
			results,
		});
	}
	return out;
}

/** Each tool call as a span. A call with no result runs until `end`, or until a new prompt shows it was abandoned. */
function toolSpans(entries: Entry[], end: number): Span[] {
	const open = new Map<string, { from: number; kind: Kind }>(),
		spans: Span[] = [];
	const close = (id: string, to: number) => {
		const call = open.get(id);
		if (call) spans.push({ from: call.from, to, kind: call.kind });
		open.delete(id);
	};
	for (const e of entries) {
		if (e.opens) for (const id of open.keys()) close(id, e.ts);
		for (const id of e.results) close(id, e.ts);
		for (const c of e.calls) open.set(c.id, { from: e.ts, kind: c.kind });
	}
	for (const id of open.keys()) close(id, end);
	return spans;
}

/** Divide [start, end] among the spans: overlaps count once, check over wait over tool, and the rest is model time. */
function partition(spans: Span[], start: number, end: number): Split {
	const edges = spans
		.map((s) => ({ ...s, from: Math.max(s.from, start), to: Math.min(s.to, end) }))
		.filter((s) => s.from < s.to)
		.flatMap((s) => [
			{ at: s.from, kind: s.kind, step: 1 },
			{ at: s.to, kind: s.kind, step: -1 },
		])
		.sort((a, b) => a.at - b.at);
	const active: Record<Kind, number> = { check: 0, wait: 0, tool: 0 },
		split: Split = { toolMs: 0, checkMs: 0, waitMs: 0, modelMs: 0 };
	let at = start;
	for (const edge of [...edges, { at: end, kind: "tool" as Kind, step: 0 }]) {
		const ms = edge.at - at;
		if (active.check) split.checkMs += ms;
		else if (active.wait) split.waitMs += ms;
		else if (active.tool) split.toolMs += ms;
		else split.modelMs += ms;
		at = edge.at;
		active[edge.kind] += edge.step;
	}
	return split;
}

/**
 * The turn that just ended: from the last prompt, or from `previousEnd` for a stop-hook continuation (whose feedback
 * entry is meta and opens no turn), to the last entry. Null when the entries show no such turn.
 */
export function turnOf(
	entries: Entry[],
	previousEnd: number | null,
): (Split & { startedAt: number; endedAt: number }) | null {
	const endedAt = entries.at(-1)?.ts,
		startedAt = previousEnd ?? entries.findLast((e) => e.opens)?.ts;
	if (endedAt === undefined || startedAt === undefined || endedAt < startedAt) return null;
	return { startedAt, endedAt, ...partition(toolSpans(entries, endedAt), startedAt, endedAt) };
}

/** The split of a run's whole time so far: time outside any turn is wait, because such a seat waits on something. */
export function runSplit(entries: Entry[], start: number, now: number): Split {
	const outside: Span[] = [];
	let outsideFrom: number | null = start;
	for (const e of entries) {
		// One final message can span several lines, each with its stop reason; the turn ends at the last of them.
		if (e.endsTurn) outsideFrom = e.ts;
		else if (outsideFrom !== null) {
			outside.push({ from: outsideFrom, to: e.ts, kind: "wait" });
			outsideFrom = null;
		}
	}
	if (outsideFrom !== null) outside.push({ from: outsideFrom, to: now, kind: "wait" });
	return partition([...toolSpans(entries, now), ...outside], start, now);
}

/** A transcript's entries. A whole read is fast enough for the Stop hook's 15 seconds: 215 MB parses in 1.4 s. */
export const readEntries = (path: string): Entry[] => parseEntries(readFileSync(path, "utf8").split("\n"));
