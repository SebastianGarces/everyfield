import test from "node:test";
import assert from "node:assert/strict";
import {
	CELL_PX,
	SEAT_MIN,
	TUI_MIN,
	chooseSplit,
	nextResize,
	type Direction,
	type Layout,
	type Resize,
} from "../panes.ts";

/** A model of Herdr's split tree: splits halve with the odd cell to the first side, a close hands the space to the sibling. */
type Node = { id: string } | { dir: Direction; ratio: number; a: Node; b: Node; name: string };
const isSplit = (n: Node): n is Extract<Node, { dir: Direction }> => "dir" in n;

class Tab {
	root: Node = { id: "TUI" };
	count = 0;
	cols: number;
	rows: number;
	constructor(cols: number, rows: number) {
		this.cols = cols;
		this.rows = rows;
	}

	layout(): Layout {
		const panes: Layout["panes"] = [],
			splits: Layout["splits"] = [];
		const walk = (n: Node, x: number, y: number, w: number, h: number) => {
			if (!isSplit(n)) return void panes.push({ id: n.id, x, y, w, h });
			splits.push({ id: n.name, direction: n.dir, ratio: n.ratio, x, y, w, h });
			if (n.dir === "right") {
				const first = Math.round(w * n.ratio);
				walk(n.a, x, y, first, h);
				walk(n.b, x + first, y, w - first, h);
			} else {
				const first = Math.round(h * n.ratio);
				walk(n.a, x, y, w, first);
				walk(n.b, x, y + first, w, h - first);
			}
		};
		walk(this.root, 0, 0, this.cols, this.rows);
		return { panes, splits };
	}
	private path(id: string, n: Node = this.root, trail: Array<{ n: Extract<Node, { dir: Direction }>; side: "a" | "b" }> = []) {
		if (!isSplit(n)) return n.id === id ? trail : undefined;
		return this.path(id, n.a, [...trail, { n, side: "a" }]) ?? this.path(id, n.b, [...trail, { n, side: "b" }]);
	}
	split(id: string, dir: Direction): string {
		const fresh = `S${++this.count}`,
			swap = (n: Node): Node =>
				isSplit(n)
					? { ...n, a: swap(n.a), b: swap(n.b) }
					: n.id === id
						? { dir, ratio: 0.5, a: n, b: { id: fresh }, name: `split-${fresh}` }
						: n;
		this.root = swap(this.root);
		return fresh;
	}
	close(id: string) {
		const drop = (n: Node): Node => {
			if (!isSplit(n)) return n;
			if (!isSplit(n.a) && n.a.id === id) return n.b;
			if (!isSplit(n.b) && n.b.id === id) return n.a;
			return { ...n, a: drop(n.a), b: drop(n.b) };
		};
		this.root = drop(this.root);
	}
	/** Herdr moves the pane's border in `direction`; a pane with no border on that side moves the opposite one. */
	resize(r: Resize) {
		const axis: Direction = r.direction === "right" || r.direction === "left" ? "right" : "down",
			grow = r.direction === "right" || r.direction === "down",
			trail = this.path(r.pane)!.filter((t) => t.n.dir === axis).reverse(),
			own = grow ? "a" : "b",
			hit = trail.find((t) => t.side === own) ?? trail[0]!;
		hit.n.ratio = Math.min(0.9, Math.max(0.1, hit.n.ratio + (grow ? r.amount : -r.amount)));
	}
	rebalance() {
		for (let i = 0; i < 16; i++) {
			const step = nextResize(this.layout());
			if (!step) return;
			this.resize(step);
		}
		assert.fail("rebalance did not settle");
	}
	add(): string {
		const pick = chooseSplit(this.layout().panes, "TUI");
		return this.split(pick.pane, pick.direction);
	}
}

const px = (p: { w: number; h: number }) => ({ w: p.w * CELL_PX.w, h: p.h * CELL_PX.h });
const rects = (tab: Tab) => tab.layout().panes.map((p) => `${p.id}:${p.x},${p.y} ${p.w}x${p.h}`);

function assertGrid(tab: Tab, label: string) {
	const panes = tab.layout().panes,
		areas = panes.map((p) => px(p).w * px(p).h);
	for (const p of panes) {
		assert.ok(px(p).w >= 0.75 * px(p).h, `${label}: ${p.id} is a tall narrow column (${p.w}x${p.h}) in ${rects(tab)}`);
		const min = p.id === "TUI" ? TUI_MIN : SEAT_MIN;
		assert.ok(p.w >= min.cols && p.h >= min.rows, `${label}: ${p.id} is under its minimum (${p.w}x${p.h})`);
	}
	// Herdr divides whole cells (512 columns in 3 equal columns is 171, 170, 171), so 2x carries one cell of rounding.
	assert.ok(Math.max(...areas) <= 2.05 * Math.min(...areas), `${label}: pane areas differ by more than 2x in ${rects(tab)}`);
}

test("OPS-65-layout: 1 to 6 seats on a 5120x1440 px tab tile as a balanced grid, split both ways", () => {
	const tab = new Tab(512, 72),
		directions: Direction[] = [];
	const expected = [
		["TUI:0,0 256x72", "S1:256,0 256x72"],
		["TUI:0,0 256x72", "S1:256,0 128x72", "S2:384,0 128x72"],
		["TUI:0,0 128x72", "S3:128,0 128x72", "S1:256,0 128x72", "S2:384,0 128x72"],
		["TUI:0,0 128x72", "S3:128,0 128x36", "S4:128,36 128x36", "S1:256,0 128x72", "S2:384,0 128x72"],
		["TUI:0,0 128x72", "S3:128,0 128x36", "S4:128,36 128x36", "S1:256,0 128x36", "S5:256,36 128x36", "S2:384,0 128x72"],
		["TUI:0,0 128x72", "S3:128,0 128x36", "S4:128,36 128x36", "S1:256,0 128x36", "S5:256,36 128x36", "S2:384,0 128x36", "S6:384,36 128x36"],
	];
	for (let seats = 1; seats <= 6; seats++) {
		const pick = chooseSplit(tab.layout().panes, "TUI");
		directions.push(pick.direction);
		tab.split(pick.pane, pick.direction);
		assert.deepEqual(rects(tab), expected[seats - 1], `${seats} seats`);
		assertGrid(tab, `${seats} seats`);
		if (seats >= 4) assert.ok(directions.includes("right") && directions.includes("down"), "both split directions appear");
	}
});

test("OPS-65-layout: the largest pane splits along its longer side, and never at the TUI pane's expense", () => {
	const pane = (id: string, w: number, h: number) => ({ id, x: 0, y: 0, w, h });
	assert.deepEqual(chooseSplit([pane("TUI", 300, 72), pane("a", 100, 72)], "TUI"), { pane: "TUI", direction: "right" });
	assert.deepEqual(chooseSplit([pane("TUI", 128, 72), pane("a", 128, 72)], "TUI"), { pane: "a", direction: "down" });
	assert.deepEqual(chooseSplit([pane("TUI", 300, 60), pane("a", 100, 40)], "TUI"), { pane: "TUI", direction: "right" });
	// Halving the TUI pane would leave it under 120 columns, so the next largest pane splits.
	assert.deepEqual(chooseSplit([pane("TUI", 200, 72), pane("a", 150, 50)], "TUI"), { pane: "a", direction: "right" });
});

test("OPS-65-layout: closing seat panes rebalances; every close order keeps the grid rules", () => {
	const full = () => {
		const tab = new Tab(512, 72);
		for (let i = 0; i < 6; i++) tab.add();
		return tab;
	};
	const permutations = (xs: string[]): string[][] =>
		xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
	const seats = ["S1", "S2", "S3", "S4", "S5", "S6"];
	// Closing one at a time, in every order.
	for (const order of permutations(seats)) {
		const tab = full();
		for (const id of order) {
			tab.close(id);
			tab.rebalance();
			assertGrid(tab, `after closing ${id} in ${order}`);
		}
		assert.deepEqual(rects(tab), ["TUI:0,0 512x72"], "the TUI pane fills the workspace when it is alone");
	}
	// A mixed sequence: close, add, close.
	const tab = full();
	tab.close("S2");
	tab.rebalance();
	assertGrid(tab, "S2 closed");
	tab.add();
	tab.close("S3");
	tab.rebalance();
	assertGrid(tab, "S3 closed after an add");
});
