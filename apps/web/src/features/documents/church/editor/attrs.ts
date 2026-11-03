// How a node keeps an attribute of the format: in a `data-ef-*` attribute of its HTML, so a copy and a paste keep it.
// An attribute the file leaves out stays `undefined` in the editor and out of the JSON, so a document reads back exactly
// as it was stored. A stored `null` (a table's `source`, an amount that was cleared) is written as `data-ef-<name>-null`.

export type Kind = "string" | "number" | "boolean" | "json";
export type Attrs = Record<string, unknown>;

/** One format attribute: no default (the format's default applies at render), stored in a `data-ef-*` attribute. */
export function attr(name: string, kind: Kind = "string") {
	const html = `data-ef-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
	return {
		default: undefined as unknown,
		parseHTML: (el: HTMLElement) => {
			if (el.hasAttribute(`${html}-null`)) return null;
			const raw = el.getAttribute(html);
			if (raw === null) return undefined;
			if (kind === "number") return Number(raw);
			if (kind === "boolean") return raw === "true";
			if (kind === "json") return JSON.parse(raw) as unknown;
			return raw;
		},
		renderHTML: (attrs: Attrs) => {
			const value = attrs[name];
			if (value === undefined) return {};
			if (value === null) return { [`${html}-null`]: "" };
			return {
				[html]: kind === "json" || kind === "number" || kind === "boolean" ? JSON.stringify(value) : String(value),
			};
		},
	};
}
export const attrsOfSpec = (spec: Record<string, Kind>) =>
	Object.fromEntries(Object.entries(spec).map(([name, kind]) => [name, attr(name, kind)]));

export const BLOCKS = "block colblock boxblock";
export const px = (pt: number) => `${((pt * 4) / 3).toFixed(2)}px`;
