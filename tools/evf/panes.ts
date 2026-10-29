import type { DatabaseSync } from "node:sqlite";
import { run } from "./lib.ts";

/**
 * Seats are split panes in the Herdr workspace that runs the evf TUI. The layout functions here are pure: they read
 * pane rectangles in cells and name the next split or resize. The Herdr calls at the bottom apply them.
 */

/** The TUI workspace label. A test or a scratch workspace overrides it with EVF_TUI_LABEL. */
export const DEFAULT_TUI_LABEL = "evf TUI";
export const tuiLabel = () => process.env.EVF_TUI_LABEL || DEFAULT_TUI_LABEL;
/** The stable signal for the TUI pane: a foreground process in it matches this. EVF_TUI_PROCESS overrides it. */
export const tuiProcess = () => new RegExp(process.env.EVF_TUI_PROCESS || "evf-tui|main\\.ts\\s+tui");

/** Herdr reports cells. Decision (OPS-65): one cell is 10 x 20 px, so "wider than tall" is judged in pixels. */
export const CELL_PX = { w: 10, h: 20 } as const;
export const TUI_MIN = { cols: 120, rows: 30 } as const;
export const SEAT_MIN = { cols: 80, rows: 24 } as const;

export type Direction = "right" | "down";
export type PaneRect = { id: string; x: number; y: number; w: number; h: number };
export type SplitRect = { id: string; direction: Direction; ratio: number; x: number; y: number; w: number; h: number };
export type Layout = { panes: PaneRect[]; splits: SplitRect[] };
export type Resize = { pane: string; direction: "right" | "left" | "down" | "up"; amount: number };

const area = (p: PaneRect) => p.w * CELL_PX.w * (p.h * CELL_PX.h);
const splitDirection = (p: PaneRect): Direction => (p.w * CELL_PX.w >= p.h * CELL_PX.h ? "right" : "down");

/** Half of a split pane along `direction`, in cells, as Herdr rounds it (the first half gets the odd cell). */
function half(p: PaneRect, direction: Direction): { w: number; h: number } {
	return direction === "right" ? { w: Math.floor(p.w / 2), h: p.h } : { w: p.w, h: Math.floor(p.h / 2) };
}

/**
 * The pane to split and the direction: the largest pane along its longer side. Seat panes win ties, so the TUI pane
 * keeps its size. A split that would leave the TUI pane under its minimum is skipped; when nothing else can be split
 * the largest seat pane is split anyway.
 */
export function chooseSplit(panes: PaneRect[], tuiId: string): { pane: string; direction: Direction } {
	const ranked = [...panes].sort((a, b) => area(b) - area(a) || Number(a.id === tuiId) - Number(b.id === tuiId));
	for (const p of ranked) {
		const direction = splitDirection(p),
			rest = half(p, direction);
		if (p.id === tuiId && (rest.w < TUI_MIN.cols || rest.h < TUI_MIN.rows)) continue;
		return { pane: p.id, direction };
	}
	const seat = ranked.find((p) => p.id !== tuiId) ?? ranked[0]!;
	return { pane: seat.id, direction: splitDirection(seat) };
}

/** Which panes sit on the first side of a split, and which on the second (the first side starts at the rectangle origin). */
function sides(layout: Layout, s: SplitRect): { first: PaneRect[]; second: PaneRect[] } {
	const inside = layout.panes.filter((p) => p.x >= s.x && p.y >= s.y && p.x + p.w <= s.x + s.w && p.y + p.h <= s.y + s.h),
		edge = s.direction === "right" ? s.x + s.w * s.ratio : s.y + s.h * s.ratio,
		at = (p: PaneRect) => (s.direction === "right" ? p.x : p.y);
	return { first: inside.filter((p) => at(p) < edge - 1), second: inside.filter((p) => at(p) >= edge - 1) };
}

/** The columns of a side for a right split, its rows for a down split: the most panes one line across the side crosses. */
function tracks(panes: PaneRect[], split: Direction): number {
	const lo = (p: PaneRect) => (split === "right" ? p.y : p.x),
		len = (p: PaneRect) => (split === "right" ? p.h : p.w);
	return Math.max(...panes.map((p) => panes.filter((q) => lo(q) <= lo(p) + len(p) / 2 && lo(p) + len(p) / 2 < lo(q) + len(q)).length));
}

/**
 * The next resize that moves a split toward giving every column and row of a side the same size: a side's share of
 * a right split is its column count, of a down split its row count. Equal columns keep every pane wide enough, and the
 * TUI pane is always a full column. Outermost split first. Null when every split is within one cell of its target.
 * Apply it, read the layout again and ask once more.
 */
export function nextResize(layout: Layout): Resize | null {
	const share = (panes: PaneRect[], d: Direction) => tracks(panes, d);
	for (const s of [...layout.splits].sort((a, b) => b.w * b.h - a.w * a.h)) {
		const { first, second } = sides(layout, s);
		if (!first.length || !second.length) continue;
		const target = share(first, s.direction) / (share(first, s.direction) + share(second, s.direction)),
			total = s.direction === "right" ? s.w : s.h,
			now = s.direction === "right" ? Math.max(...first.map((p) => p.x + p.w)) - s.x : Math.max(...first.map((p) => p.y + p.h)) - s.y;
		if (Math.abs(now - Math.round(total * target)) <= 1) continue;
		const divider = s.direction === "right" ? s.x + now : s.y + now,
			delta = target - s.ratio,
			// Herdr moves the border of the pane on the side named by the direction: the first side's far border to move
			// the divider right or down, the second side's near border to move it left or up.
			touching =
				delta > 0
					? first.find((p) => (s.direction === "right" ? p.x + p.w : p.y + p.h) === divider)
					: second.find((p) => (s.direction === "right" ? p.x : p.y) === divider);
		if (!touching) continue;
		return {
			pane: touching.id,
			direction: s.direction === "right" ? (delta > 0 ? "right" : "left") : delta > 0 ? "down" : "up",
			amount: Math.abs(delta),
		};
	}
	return null;
}

// --- Herdr calls ---------------------------------------------------------------------------------------------------

type Json = Record<string, any>;
function herdrJson(args: string[]): Json | undefined {
	const r = run("herdr", args);
	if (r.code !== 0) return undefined;
	try {
		return (JSON.parse(r.stdout) as { result?: Json }).result ?? {};
	} catch {
		return undefined;
	}
}

/** True when a foreground process in the pane is the evf TUI. */
export function isTuiPane(pane: string): boolean {
	const procs = (herdrJson(["pane", "process-info", "--pane", pane])?.process_info?.foreground_processes ?? []) as Json[];
	return procs.some((p) => tuiProcess().test(String(p.cmdline ?? "")));
}

/** The workspace labeled for the TUI and the pane in it that runs the TUI process. */
export function findTui(): { workspace: string; pane: string } | undefined {
	const workspaces = ((herdrJson(["workspace", "list"])?.workspaces ?? []) as Json[]).filter(
		(w) => w.label === tuiLabel(),
	);
	for (const w of workspaces)
		for (const p of (herdrJson(["pane", "list", "--workspace", w.workspace_id])?.panes ?? []) as Json[])
			if (isTuiPane(p.pane_id)) return { workspace: w.workspace_id, pane: p.pane_id };
	return undefined;
}

/** The layout of the tab that holds `pane`. */
export function readLayout(pane: string): Layout | undefined {
	const layout = herdrJson(["pane", "layout", "--pane", pane])?.layout;
	if (!layout) return undefined;
	const rect = (r: Json) => ({ x: r.x, y: r.y, w: r.width, h: r.height });
	return {
		panes: (layout.panes as Json[]).map((p) => ({ id: p.pane_id, ...rect(p.rect) })),
		splits: ((layout.splits ?? []) as Json[]).map((s) => ({
			id: s.id,
			direction: s.direction,
			ratio: s.ratio,
			...rect(s.rect),
		})),
	};
}

/** Share the tab's space again after a pane closed. At most one resize per split, so it always ends. */
export function rebalance(tuiPane: string): void {
	for (let i = 0; i < 16; i++) {
		const layout = readLayout(tuiPane),
			step = layout && nextResize(layout);
		if (!step) return;
		run("herdr", ["pane", "resize", "--pane", step.pane, "--direction", step.direction, "--amount", String(step.amount)]);
	}
}

/**
 * Close the pane of a run that reached a terminal status, then rebalance the TUI workspace. Runs after the store
 * update commits. Refuses the TUI pane, a pane the run does not own and a pane another open run records. A pane that
 * is alone in its workspace (the fallback path) closes the workspace instead. Returns what it did, for the log.
 */
export function closeRunPane(db: DatabaseSync, runId: number): string {
	const r = db.prepare("SELECT status, herdr_pane FROM runs WHERE id = ?").get(runId) as
		| { status: string; herdr_pane: string | null }
		| undefined;
	if (!r?.herdr_pane || r.status === "started") return "";
	const pane = r.herdr_pane;
	if (isTuiPane(pane)) return `pane ${pane} is the TUI pane: not closed`;
	const shared = db
		.prepare("SELECT id FROM runs WHERE herdr_pane = ? AND status = 'started' AND id != ?")
		.get(pane, runId) as { id: number } | undefined;
	if (shared) return `pane ${pane} still belongs to open run ${shared.id}: not closed`;
	const info = herdrJson(["pane", "get", pane])?.pane as Json | undefined;
	if (!info) return `pane ${pane} is already gone`;
	const workspace = String(info.workspace_id),
		siblings = ((herdrJson(["pane", "list", "--workspace", workspace])?.panes ?? []) as Json[]).filter(
			(p) => p.pane_id !== pane,
		);
	const closed = siblings.length
		? run("herdr", ["pane", "close", pane])
		: run("herdr", ["workspace", "close", workspace]);
	if (closed.code !== 0) return `herdr could not close pane ${pane}: ${(closed.stderr || closed.stdout).trim()}`;
	const tui = siblings.find((p) => isTuiPane(p.pane_id));
	if (tui) rebalance(tui.pane_id);
	return `closed pane ${pane}`;
}
