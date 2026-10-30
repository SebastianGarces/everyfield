// WCAG 2.x contrast. Every text/background pair in a document goes through `pair()`,
// so the IDEA.md ratio table is generated from what the page actually uses.
export const hex = (c: string) => {
	const m = /^#?([0-9a-f]{6})$/i.exec(c);
	if (!m) throw new Error(`not a #rrggbb colour: ${c}`);
	const n = parseInt(m[1]!, 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255] as const;
};
export const toHex = (r: number, g: number, b: number) =>
	"#" +
	[r, g, b]
		.map((v) =>
			Math.round(Math.min(255, Math.max(0, v)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")
		.toUpperCase();
const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
export const luminance = (c: string) => {
	const [r, g, b] = hex(c);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
export const ratio = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
};
export const mix = (a: string, b: string, t: number) => {
	const [r1, g1, b1] = hex(a),
		[r2, g2, b2] = hex(b);
	return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
};
export const gray = (c: string) => {
	const [r, g, b] = hex(c);
	const y = 0.299 * r + 0.587 * g + 0.114 * b;
	return toHex(y, y, y);
};

export const MIN_BODY = 4.5; // WCAG 1.4.3 normal text
export const MIN_NONTEXT = 3; // WCAG 1.4.11 borders, checkbox outlines, large text

export type PairRecord = { use: string; fg: string; bg: string; ratio: number; min: number };
export class ContrastLog {
	rows: PairRecord[] = [];
	/** Record a pair and return the foreground, so it can be used inline. */
	pair(use: string, fg: string, bg: string, min = MIN_BODY) {
		const r = ratio(fg, bg);
		if (!this.rows.some((x) => x.use === use && x.fg === fg && x.bg === bg))
			this.rows.push({ use, fg, bg, ratio: r, min });
		if (r < min) throw new Error(`contrast ${r.toFixed(2)} < ${min} for "${use}" ${fg} on ${bg}`);
		return fg;
	}
}

/** Text colour on a brand fill: whichever of white or ink has the higher WCAG ratio. */
export const textOn = (bg: string, ink: string, white = "#FFFFFF") =>
	ratio(white, bg) >= ratio(ink, bg) ? white : ink;

/** A brand colour used as text or as a thin line: keep it if it clears `min` on `bg`, else step it toward ink until it does.
 *  A brand colour under 3:1 is therefore never printed as text; the derived shade is. */
export const legible = (brand: string, bg: string, ink: string, min = MIN_BODY) => {
	if (ratio(brand, bg) >= min) return brand;
	for (let t = 0.05; t <= 1.0001; t += 0.05) {
		const c = mix(brand, ink, t);
		if (ratio(c, bg) >= min) return c;
	}
	return ink;
};
