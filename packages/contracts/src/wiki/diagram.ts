// Wiki diagram blocks (WP-034). A fenced block with the info string `diagram <type>` holds a title line, an optional
// loop line and node lines `- label | detail | note`. This file is the one parser: the app, the PDF and print export,
// and the wiki authoring tools (by relative path) all call it. It has no runtime imports and uses erasable TypeScript
// only, so Node can run it with its types stripped.

export const DIAGRAM_TYPES = ["flow", "stages", "cycle", "hierarchy", "timeline"] as const;
export type DiagramType = (typeof DIAGRAM_TYPES)[number];

export const DIAGRAM_LIMITS = { title: 100, loop: 100, label: 60, detail: 160, note: 40, nodes: 12, depth: 3 } as const;

/** One node. Empty detail and note are left out. In a timeline the note is the time marker. */
export type DiagramNode = { readonly label: string; readonly detail?: string; readonly note?: string };
export type HierarchyNode = DiagramNode & { readonly children: readonly HierarchyNode[] };

type NonEmpty<T> = readonly [T, ...T[]];

/** `loop` exists only on flow and cycle, a cycle has two nodes or more and only a hierarchy nests (one root). */
export type Diagram =
	| { readonly type: "flow"; readonly title: string; readonly loop?: string; readonly nodes: NonEmpty<DiagramNode> }
	| {
			readonly type: "cycle";
			readonly title: string;
			readonly loop?: string;
			readonly nodes: readonly [DiagramNode, DiagramNode, ...DiagramNode[]];
	  }
	| { readonly type: "stages"; readonly title: string; readonly loop?: never; readonly nodes: NonEmpty<DiagramNode> }
	| { readonly type: "timeline"; readonly title: string; readonly loop?: never; readonly nodes: NonEmpty<DiagramNode> }
	| {
			readonly type: "hierarchy";
			readonly title: string;
			readonly loop?: never;
			readonly nodes: readonly [HierarchyNode];
	  };

/** Line 1 is the first body line, after the opening fence. Line 0 is the opening fence (its info string). */
export type DiagramError = { readonly line: number; readonly message: string };

export type DiagramResult =
	{ readonly ok: true; readonly diagram: Diagram } | { readonly ok: false; readonly errors: NonEmpty<DiagramError> };

/** An opening code fence: up to three spaces, then three or more backticks or tildes, then the info string. */
export type Fence = { readonly marker: string; readonly info: string };

const OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function openFence(line: string): Fence | null {
	const match = OPEN.exec(line);
	if (!match?.[1]) return null;
	const marker = match[1];
	const info = (match[2] ?? "").trim();
	if (marker.startsWith("`") && info.includes("`")) return null;
	return { marker, info };
}

/** The closing fence: the same character, at least as long, and nothing after it but spaces. */
export function closesFence(line: string, fence: Fence): boolean {
	const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
	return !!match?.[1] && match[1][0] === fence.marker[0] && match[1].length >= fence.marker.length;
}

/** A fence whose info string starts with the word `diagram`. */
export function isDiagramInfo(info: string): boolean {
	return info.split(/\s+/)[0] === "diagram";
}

export type FencedBlock = {
	readonly info: string;
	/** The body lines joined with "\n", byte for byte. */
	readonly body: string;
	/** Zero-based index of the opening fence line in the text. */
	readonly start: number;
	/** Zero-based index of the line after the block (after the closing fence, or the line count). */
	readonly end: number;
};

/** Every fenced block in `text`. An unterminated fence runs to the end. */
export function fencedBlocks(text: string): FencedBlock[] {
	const lines = text.split("\n");
	const blocks: FencedBlock[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const fence = openFence(lines[index] ?? "");
		if (!fence) continue;
		let close = index + 1;
		while (close < lines.length && !closesFence(lines[close] ?? "", fence)) close += 1;
		blocks.push({
			info: fence.info,
			body: lines.slice(index + 1, close).join("\n"),
			start: index,
			end: Math.min(close + 1, lines.length),
		});
		index = close;
	}
	return blocks;
}

const NOUN: Record<DiagramType, [string, string]> = {
	flow: ["step", "steps"],
	stages: ["stage", "stages"],
	cycle: ["step", "steps"],
	hierarchy: ["item", "items"],
	timeline: ["milestone", "milestones"],
};

function count(nodes: readonly HierarchyNode[] | readonly DiagramNode[]): number {
	return nodes.reduce((sum, node) => sum + 1 + ("children" in node ? count(node.children) : 0), 0);
}

/** The text alternative, for example "Flow diagram, 3 steps. Repeats: Each season". */
export function diagramSummary(diagram: Diagram): string {
	const n = count(diagram.nodes);
	const [one, many] = NOUN[diagram.type];
	const name = diagram.type[0]!.toUpperCase() + diagram.type.slice(1);
	return `${name} diagram, ${n} ${n === 1 ? one : many}${diagram.loop ? `. Repeats: ${diagram.loop}` : ""}`;
}

const length = (text: string) => [...text].length;

type Parsed = { node: DiagramNode; depth: number; line: number };

/** Parses one diagram block. `info` is the fence info string (`diagram flow`), `body` the lines inside the fence. */
export function parseDiagram(info: string, body: string): DiagramResult {
	const words = info.trim().split(/\s+/);
	if (words[0] !== "diagram") return fail([{ line: 0, message: 'The info string must start with "diagram"' }]);
	const raw = words[1];
	if (!raw) return fail([{ line: 0, message: `Missing diagram type; use ${typeList()}` }]);
	if (!DIAGRAM_TYPES.includes(raw as DiagramType))
		return fail([{ line: 0, message: `Unknown diagram type "${raw}"; use ${typeList()}` }]);
	if (words.length > 2) return fail([{ line: 0, message: `Unexpected text after "diagram ${raw}"` }]);
	const type = raw as DiagramType;
	const errors: DiagramError[] = [];
	const error = (line: number, message: string) => errors.push({ line, message });
	const field = (line: number, name: string, text: string, limit: number) => {
		if (length(text) > limit) error(line, `${name} is ${length(text)} characters; the limit is ${limit}`);
	};
	let title: string | undefined;
	let loop: string | undefined;
	let first = true;
	let lastLine = 1;
	const nodes: Parsed[] = [];
	const lines = body.split("\n");
	lines.forEach((text, index) => {
		const line = index + 1;
		if (!text.trim()) return;
		lastLine = line;
		const isFirst = first;
		first = false;
		const key = /^([A-Za-z][\w-]*):(.*)$/.exec(text);
		if (key?.[1] !== undefined) {
			const name = key[1];
			const value = (key[2] ?? "").trim();
			if (name !== "title" && name !== "loop") return error(line, `Unknown key "${name}"; use title or loop`);
			if (nodes.length) return error(line, `${name} must come before the first node`);
			if (name === "title") {
				if (!isFirst) return error(line, "title must be the first line");
				title = value;
				if (!value) error(line, "title is empty");
				return field(line, "title", value, DIAGRAM_LIMITS.title);
			}
			if (type !== "flow" && type !== "cycle") return error(line, "loop is allowed only in flow and cycle diagrams");
			if (loop !== undefined) return error(line, "loop appears twice");
			loop = value;
			if (!value) error(line, "loop is empty");
			return field(line, "loop", value, DIAGRAM_LIMITS.loop);
		}
		const item = /^( *)-(?: (.*))?$/.exec(text);
		if (!item) return error(line, "Expected a node line: - label | detail | note");
		if (nodes.length === DIAGRAM_LIMITS.nodes)
			error(line, `More than ${DIAGRAM_LIMITS.nodes} nodes; split the diagram`);
		const indent = item[1]?.length ?? 0;
		let depth = 0;
		if (type !== "hierarchy") {
			if (indent) error(line, "Indent is allowed only in hierarchy diagrams");
		} else if (indent % 2) error(line, "Indent by two spaces per level");
		else {
			depth = indent / 2;
			const previous = nodes.at(-1)?.depth ?? -1;
			if (depth > DIAGRAM_LIMITS.depth) error(line, `Nested deeper than level ${DIAGRAM_LIMITS.depth}`);
			else if (depth === 0 && previous >= 0) error(line, "A hierarchy has one root; indent this node under it");
			else if (depth > previous + 1) error(line, "Indent one level (two spaces) at a time");
		}
		const fields = (item[2] ?? "").split("|").map((part) => part.trim());
		if (fields.length > 3) error(line, "A node has at most three fields: label | detail | note");
		const [label = "", detail = "", note = ""] = fields;
		if (!label) error(line, "Node label is empty");
		field(line, "Label", label, DIAGRAM_LIMITS.label);
		field(line, "Detail", detail, DIAGRAM_LIMITS.detail);
		field(line, "Note", note, DIAGRAM_LIMITS.note);
		nodes.push({ node: { label, ...(detail ? { detail } : {}), ...(note ? { note } : {}) }, depth, line });
	});
	if (title === undefined && !errors.some((e) => e.message.startsWith("title must")))
		errors.unshift({ line: 1, message: "Missing title: the first line must be title: <text>" });
	if (!nodes.length) error(lastLine, "No nodes: add at least one line - label | detail | note");
	if (type === "cycle" && nodes.length === 1) error(nodes[0]!.line, "A cycle needs at least 2 nodes");
	if (errors.length || title === undefined) return fail(errors);
	const list = nodes.map((parsed) => parsed.node) as unknown as NonEmpty<DiagramNode>;
	const extra = loop ? { loop } : {};
	if (type === "hierarchy") return { ok: true, diagram: { type, title, nodes: [tree(nodes)] } };
	if (type === "cycle")
		return { ok: true, diagram: { type, title, ...extra, nodes: list as readonly [DiagramNode, DiagramNode] } };
	if (type === "flow") return { ok: true, diagram: { type, title, ...extra, nodes: list } };
	return { ok: true, diagram: { type, title, nodes: list } };
}

function typeList(): string {
	return `${DIAGRAM_TYPES.slice(0, -1).join(", ")} or ${DIAGRAM_TYPES.at(-1)}`;
}

function fail(errors: DiagramError[]): DiagramResult {
	const sorted = errors.map((e, i) => [e, i] as const).sort((a, b) => a[0].line - b[0].line || a[1] - b[1]);
	return { ok: false, errors: sorted.map(([e]) => e) as unknown as NonEmpty<DiagramError> };
}

/** Builds the tree from depth-checked nodes: one root, each child one level below its parent. */
function tree(nodes: Parsed[]): HierarchyNode {
	type Mutable = DiagramNode & { children: Mutable[] };
	const root: Mutable = { ...nodes[0]!.node, children: [] };
	const stack: Mutable[] = [root];
	for (const parsed of nodes.slice(1)) {
		const node: Mutable = { ...parsed.node, children: [] };
		stack.length = parsed.depth;
		stack.at(-1)!.children.push(node);
		stack.push(node);
	}
	return root;
}
