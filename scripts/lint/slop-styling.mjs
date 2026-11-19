export const SCOPE = /^(?:apps\/web\/src\/features\/|packages\/ui\/src\/)/;

const LABEL_UTILITY = "section-label";
const LABEL_TRACKING = "var(--ef-label-tracking)";

const APPROVED_SURFACES = {
	"ef-insight": "the gradient card surface (InsightCard)",
	"ef-scroll-fade": "the fade mask at the end of a scrolling list",
	"ef-top-fade": "the fade under the sticky top bar",
	"ef-skel": "the loading shimmer",
	"ef-ring": "the progress ring",
	"ef-none-swatch": "the diagonal stroke on the no-color swatch",
	hatch: "the hatched fill for planned or empty ranges",
	'[data-ef-node="spacer"]': "the hatched fill that marks an empty spacer block in the document editor",
};

const BEIGE_HEX = new Set([
	"f5f5dc",
	"f6f0e9",
	"faf0e6",
	"fdf5e6",
	"fff8dc",
	"faebd7",
	"ffebcd",
	"ffefd5",
	"ffe4c4",
	"f5deb3",
	"d2b48c",
	"eee8d5",
	"f5f0e8",
	"f4ecd8",
	"efe6d8",
	"ede4d3",
	"e8dcc8",
	"fbf6ed",
	"f7f3ec",
	"faf7f2",
	"fcfbf8",
]);
const BEIGE_NAMES =
	/\b(?:beige|linen|oldlace|cornsilk|antiquewhite|blanchedalmond|papayawhip|bisque|wheat|tan|ivory)\b/i;

const MESSAGES = {
	eyebrow: (t) =>
		`${t} sits directly above a heading as an eyebrow label. Let the heading carry the section; put a quiet label below it or drop it.`,
	"mono-uppercase": (t) =>
		`${t}: monospace with uppercase reads as generated decoration. Keep monospace for code and references, in normal case.`,
	tracking: (t) =>
		`${t}: wide letter tracking is allowed only through the ${LABEL_UTILITY} utility (CSS: letter-spacing: ${LABEL_TRACKING}). Use normal or negative tracking.`,
	serif: (t) =>
		`${t}: serif type comes only from --ef-font-display or --ef-font-title (font-display, font-title or the heading defaults).`,
	beige: (t) =>
		`${t}: beige palettes read as generated decoration, and cream is the brand color only through its token (cream, --ef-cream). Use a surface token (surface, surface-2, frame, canvas).`,
	counter: (t) =>
		`${t}: zero-padded step counters are decoration. Use an ordered list, a plain number or the step's name.`,
	orb: (t) => `${t}: blurred colored blobs and colored glows are decoration. Use the surface, edge and shadow tokens.`,
	gradient: (t) =>
		`${t}: a gradient is allowed only through a named surface: ${Object.keys(APPROVED_SURFACES).join(", ")} (packages/ui/src/foundations/product.css and controls/controls.css).`,
};
export const message = (kind, token) =>
	`${MESSAGES[kind](token)} (everyfield/no-slop-styling ${kind}, scripts/lint/slop-styling.mjs)`;

const positiveLength = (value) => {
	const v = value.trim().replace(/_/g, " ");
	if (/^(?:normal|0|0\.0*|initial|inherit|unset)$/i.test(v)) return false;
	if (v.startsWith("var(") || v.startsWith("-") || v.startsWith("calc(-")) return false;
	const n = Number.parseFloat(v);
	return Number.isFinite(n) && n > 0;
};

const splitLayers = (value) => {
	const layers = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "(") depth++;
		else if (value[i] === ")") depth--;
		else if (value[i] === "," && depth === 0) {
			layers.push(value.slice(start, i));
			start = i + 1;
		}
	}
	layers.push(value.slice(start));
	return layers.map((l) => l.trim()).filter(Boolean);
};

const LENGTH = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|rem|em)?$/;
function glowLayer(value) {
	return splitLayers(value).some((layer) => {
		const parts = layer.split(/\s+/);
		if (parts.includes("inset")) return false;
		const lengths = parts.filter((p) => LENGTH.test(p)).map(Number.parseFloat);
		if (lengths.length < 3) return false;
		const [x, y, blur, spread = 0] = lengths;
		return x === 0 && y === 0 && blur > 0 && spread >= 0;
	});
}

const blurPx = (value) => {
	const m = value.match(/blur\(\s*(\d+(?:\.\d+)?)(px|rem)?/);
	if (!m) return 0;
	return Number(m[1]) * (m[2] === "rem" ? 16 : 1);
};

const isSerifFamily = (value) => {
	const v = value.trim();
	if (/^var\(--ef-font-(?:display|title)\)/.test(v)) return false;
	return /(?<![\w-])serif\b|georgia|times|garamond|playfair|merriweather|lora\b|baskerville|didot/i.test(
		v.replace(/sans-serif/gi, ""),
	);
};
const isMonoFamily = (value) => /monospace|\bmono\b|courier|menlo|consolas|var\(--ef-font-mono\)/i.test(value);

const bareToken = (token) =>
	token
		.replace(/^!|!$/g, "")
		.split(/:(?![^[]*\])/)
		.pop();

export function classProblems(str) {
	const tokens = str
		.split(/\s+/)
		.filter(Boolean)
		.map((raw) => ({ raw, bare: bareToken(raw) }));
	const out = [];
	const has = (name) => tokens.some((t) => t.bare === name);
	if (has("font-mono") && has("uppercase")) out.push(["mono-uppercase", "font-mono with uppercase"]);
	for (const { raw, bare } of tokens) {
		let m;
		if (/^tracking-(?:wide|wider|widest)$/.test(bare)) out.push(["tracking", raw]);
		else if ((m = bare.match(/^tracking-\[([^\]]+)\]$/)) && positiveLength(m[1])) out.push(["tracking", raw]);
		if (bare === "font-serif" || ((m = bare.match(/^font-\[([^\]]+)\]$/)) && isSerifFamily(m[1].replace(/_/g, " "))))
			out.push(["serif", raw]);
		if (/-stone-\d+(?:\/\d+)?$/.test(bare)) out.push(["beige", raw]);
		else
			for (const hex of bare.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi))
				if (BEIGE_HEX.has(hex[1].toLowerCase())) out.push(["beige", raw]);
		if (/^blur-(?:2xl|3xl)$/.test(bare) || ((m = bare.match(/^blur-\[([^\]]+)\]$/)) && blurPx(`blur(${m[1]})`) >= 24))
			out.push(["orb", raw]);
		else if ((m = bare.match(/^shadow-\[(.+)\]$/)) && glowLayer(m[1].replace(/_/g, " "))) out.push(["orb", raw]);
		if (
			/^bg-(?:linear|radial|conic)(?:-|$)|^bg-gradient-to-/.test(bare) ||
			/(?:linear|radial|conic)-gradient\(/.test(bare)
		)
			out.push(["gradient", raw]);
	}
	return out;
}

export function styleProblems(props) {
	const out = [];
	const get = (name) => props.get(name);
	const spacing = get("letterSpacing");
	if (spacing !== undefined && positiveLength(String(spacing))) out.push(["tracking", `letterSpacing: ${spacing}`]);
	const family = get("fontFamily");
	if (typeof family === "string" && isSerifFamily(family)) out.push(["serif", `fontFamily: ${family}`]);
	if (typeof family === "string" && isMonoFamily(family) && /uppercase/i.test(String(get("textTransform") ?? "")))
		out.push(["mono-uppercase", "fontFamily monospace with textTransform uppercase"]);
	for (const name of ["background", "backgroundColor", "borderColor"]) {
		const v = get(name);
		if (typeof v === "string" && BEIGE_NAMES.test(v)) out.push(["beige", `${name}: ${v}`]);
	}
	const filter = get("filter");
	if (typeof filter === "string" && blurPx(filter) >= 16) out.push(["orb", `filter: ${filter}`]);
	const shadow = get("boxShadow");
	if (typeof shadow === "string" && glowLayer(shadow)) out.push(["orb", `boxShadow: ${shadow}`]);
	return out;
}

const approvedSelector = (selector) =>
	Object.keys(APPROVED_SURFACES).some((name) =>
		name.startsWith("[") ? selector.includes(name) : new RegExp(`\\.${name}(?![\\w-])`).test(selector),
	);

function cssBlocks(text) {
	const blocks = [];
	const stack = [];
	let buf = "";
	let line = 1;
	let bufLine = 1;
	const clean = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
	for (const ch of clean) {
		if (ch === "{") {
			const selector = buf.trim();
			const isUtility = selector.startsWith("@utility");
			stack.push({ selector, decls: [], line: bufLine, utility: isUtility ? selector.split(/\s+/)[1] : null });
			buf = "";
		} else if (ch === "}") {
			const top = stack.pop();
			if (buf.trim()) top?.decls.push({ text: buf.trim(), line: bufLine });
			if (top) blocks.push({ ...top, context: stack.map((s) => s.selector) });
			buf = "";
		} else if (ch === ";") {
			if (stack.length && buf.trim()) stack[stack.length - 1].decls.push({ text: buf.trim(), line: bufLine });
			buf = "";
		} else {
			if (!buf.trim() && ch.trim()) bufLine = line;
			buf += ch;
		}
		if (ch === "\n") line++;
	}
	return blocks;
}

export function cssProblems(text) {
	const out = [];
	for (const block of cssBlocks(text)) {
		const approved =
			approvedSelector(block.selector) ||
			block.context.some(approvedSelector) ||
			(block.utility && (block.utility in APPROVED_SURFACES || block.utility === LABEL_UTILITY));
		const decls = block.decls
			.map((d) => {
				const i = d.text.indexOf(":");
				return i < 0
					? null
					: { prop: d.text.slice(0, i).trim().toLowerCase(), value: d.text.slice(i + 1).trim(), line: d.line };
			})
			.filter(Boolean);
		const where = block.selector.replace(/\s+/g, " ");
		const push = (kind, d, what) =>
			out.push({ kind, line: d.line, selector: where, token: what ?? `${d.prop}: ${d.value}` });
		const upper = decls.find((d) => d.prop === "text-transform" && /uppercase/i.test(d.value));
		const mono = decls.find((d) => (d.prop === "font-family" || d.prop === "font") && isMonoFamily(d.value));
		if (upper && mono) push("mono-uppercase", upper, "monospace font-family with text-transform: uppercase");
		for (const d of decls) {
			if (d.prop === "letter-spacing" && d.value !== LABEL_TRACKING && positiveLength(d.value)) push("tracking", d);
			if ((d.prop === "font-family" || d.prop === "font") && isSerifFamily(d.value)) push("serif", d);
			if (/^(?:background|background-color|background-image|border-color|outline-color|fill)$/.test(d.prop)) {
				if (BEIGE_NAMES.test(d.value)) push("beige", d);
			}
			for (const hex of d.value.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi))
				if (BEIGE_HEX.has(hex[1].toLowerCase())) push("beige", d);
			if (approved) continue;
			if (/(?:linear|radial|conic)-gradient\(/.test(d.value)) push("gradient", d);
			if (d.prop === "filter" && blurPx(d.value) >= 16) push("orb", d);
			if (d.prop === "box-shadow" && glowLayer(d.value)) push("orb", d);
		}
	}
	return out;
}

const HEADING_TAG = /^h[1-3]$/;
const HEADING_COMPONENT = /(?:Title|Heading)$/;
const HEADING_CLASS = /^(?:text-(?:title|display)-(?:sm|md|lg)|font-(?:display|title)|text-(?:xl|[2-9]xl))$/;
const SMALL_CLASS = /^(?:text-(?:xs|sm|\[(?:9|10|11|12|13)px\])|section-label)$/;

export function labelLike(classes) {
	const bare = classes.map(bareToken);
	const tracked = bare.some(
		(c) =>
			/^tracking-(?:wide|wider|widest)$/.test(c) ||
			(/^tracking-\[([^\]]+)\]$/.test(c) && positiveLength(c.slice(10, -1))),
	);
	return (
		bare.includes(LABEL_UTILITY) || tracked || (bare.includes("uppercase") && bare.some((c) => SMALL_CLASS.test(c)))
	);
}

export function headingLike(name, classes) {
	if (HEADING_TAG.test(name) || HEADING_COMPONENT.test(name)) return true;
	return classes.map(bareToken).some((c) => {
		if (HEADING_CLASS.test(c)) return true;
		const m = c.match(/^text-\[(\d+)px\]$/);
		return m ? Number(m[1]) >= 20 : false;
	});
}

export const COUNTER_TEXT = /^\s*0\d\.?\s*$/;
export const COUNTER_NAME = /^(?:i|j|idx|index|step|steps|position|rank|order|ordinal|number|num|count)$/i;
export const TIME_NAME = /(?:day|month|year|hour|minute|second|min|sec|time|date|^hh$|^mm$|^ss$)/i;
