import type { Diagram } from "../../../packages/contracts/src/wiki/diagram.ts";

// @ts-expect-error Only flow and cycle diagrams carry a loop.
export const stagesWithLoop: Diagram = { type: "stages", title: "Phases", loop: "Again", nodes: [{ label: "One" }] };

// @ts-expect-error A cycle needs two nodes or more.
export const shortCycle: Diagram = { type: "cycle", title: "Loop", nodes: [{ label: "One" }] };

// @ts-expect-error A diagram has at least one node.
export const empty: Diagram = { type: "flow", title: "Nothing", nodes: [] };

// @ts-expect-error Only hierarchy nodes carry children.
export const nestedFlow: Diagram = { type: "flow", title: "Steps", nodes: [{ label: "One", children: [] }] };

// @ts-expect-error A hierarchy has one root.
export const twoRoots: Diagram = {
	type: "hierarchy",
	title: "Tree",
	nodes: [
		{ label: "A", children: [] },
		{ label: "B", children: [] },
	],
};
