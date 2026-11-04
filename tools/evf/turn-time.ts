import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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

/** The simple commands of a shell line. Quoted text and a heredoc body are not code. */
const simpleCommands = (line: string): string[] =>
	line
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
		.replace(/<<[^]*$/, "")
		.split(/[\n;|&(){}]/);

const ENV_PREFIX = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+)*/;
const EVF_CHECKS = new Set(["verify", "check", "test", "timing", "ac run", "browser run"]);

function kindOfCommand(command: string): Kind {
	let kind: Kind = "tool";
	for (const part of simpleCommands(command)) {
		const words = part.trim().replace(ENV_PREFIX, "").split(/\s+/),
			[first = "", second = "", third = ""] = words;
		if ((first === "evf" || first.endsWith("/evf")) && (EVF_CHECKS.has(second) || EVF_CHECKS.has(`${second} ${third}`)))
			return "check";
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
		if (e.opens) for (const id of [...open.keys()]) close(id, e.ts);
		for (const id of e.results) close(id, e.ts);
		for (const c of e.calls) if (!open.has(c.id)) open.set(c.id, { from: e.ts, kind: c.kind });
	}
	for (const id of [...open.keys()]) close(id, end);
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

type Turn = Split & { startedAt: number; endedAt: number };

/**
 * The turn that just ended: from the last prompt, or from `previousEnd` for a stop-hook continuation (whose feedback
 * entry is meta and opens no turn), to the last entry. Null when the entries show no such turn.
 */
export function turnOf(entries: Entry[], previousEnd: number | null): Turn | null {
	const endedAt = entries.at(-1)?.ts,
		startedAt = previousEnd ?? entries.findLast((e) => e.opens)?.ts;
	if (endedAt === undefined || startedAt === undefined || endedAt < startedAt) return null;
	return { startedAt, endedAt, ...partition(toolSpans(entries, endedAt), startedAt, endedAt) };
}

/** The split of a run's whole time so far: time outside any turn is wait, because such a seat waits on something. */
export function runSplit(entries: Entry[], start: number, now: number): Split {
	const outside: Span[] = [];
	let inTurn = false,
		outsideFrom = start;
	entries.forEach((e, i) => {
		// One final message can span several lines, each with its stop reason; the turn ends at the last of them.
		if (!inTurn && !(e.endsTurn && entries[i - 1]?.endsTurn))
			outside.push({ from: outsideFrom, to: e.ts, kind: "wait" });
		inTurn = !e.endsTurn;
		if (e.endsTurn) outsideFrom = e.ts;
	});
	if (!inTurn) outside.push({ from: outsideFrom, to: now, kind: "wait" });
	return partition([...toolSpans(entries, now), ...outside], start, now);
}

const TAIL_BYTES = 1024 * 1024;
/** The end of a transcript, as long as the last turn needs: the Stop hook has 15 seconds and a transcript can be large. */
export function readLastTurn(path: string): Entry[] {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		for (let want = TAIL_BYTES; ; want *= 4) {
			const length = Math.min(want, size),
				buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, size - length);
			// A first line cut in half does not parse, so it is skipped.
			const entries = parseEntries(buffer.toString("utf8").split("\n"));
			if (length === size || entries.some((e) => e.opens)) return entries;
		}
	} finally {
		closeSync(fd);
	}
}
