// The sample brand kit for review renders and tests. A fictional church. It is passed straight to the renderer;
// WP-104 owns stored kits. The logo paths come from the WP-036/ui prototype.
import { readFileSync } from "node:fs";
import type { DocumentTheme, ThemeImage } from "../../../../packages/domain/src/documents/theme.ts";

const paths = JSON.parse(readFileSync(new URL("./logo-paths.json", import.meta.url), "utf8")) as Record<
	string,
	{ d: string }
>;

const mark = (p: string, a: string, k = 1, ox = 0, oy = 0) => {
	const X = (v: number) => +(ox + v * k).toFixed(2);
	const Y = (v: number) => +(oy + v * k).toFixed(2);
	const L = (v: number) => +(v * k).toFixed(2);
	return `<circle cx="${X(24)}" cy="${Y(24)}" r="${L(24)}" fill="${p}"/><polygon points="${X(19)},${Y(38)} ${X(21)},${Y(17)} ${X(27)},${Y(17)} ${X(29)},${Y(38)}" fill="#FFFFFF"/><rect x="${X(20)}" y="${Y(11)}" width="${L(8)}" height="${L(6)}" fill="${a}"/><polygon points="${X(19)},${Y(11)} ${X(24)},${Y(5)} ${X(29)},${Y(11)}" fill="${a}"/>`;
};
const svg = (w: number, h: number, inner: string, alt: string): ThemeImage => ({
	bytes: new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${inner}</svg>`),
	mediaType: "image/svg+xml",
	alt,
	aspect: w / h,
});

const alt = "Harborlight Church logo: a white lighthouse in a navy circle beside the name Harborlight";
const photo: ThemeImage = {
	bytes: new Uint8Array(readFileSync(new URL("./photo-harbor.jpg", import.meta.url))),
	mediaType: "image/jpeg",
	alt: "Photo: a lighthouse on a harbor shore at dusk",
	aspect: 3,
};

export function sampleKit(primary = "#1F4E6B", accent = "#E3A21A", name = "harborlight-sample"): DocumentTheme {
	return {
		name,
		primary,
		accent,
		logo: svg(
			215,
			48,
			mark(primary, accent) +
				`<path d="${paths.hWord!.d}" fill="${primary}"/><path d="${paths.hSub!.d}" fill="${primary}"/>`,
			alt,
		),
		tagline: "A light at the harbor. A home for the city.",
		photo,
		letterhead: {
			legalName: "Harborlight Community Church, Inc.",
			address: "412 Pier Street, Suite 2, Portland, ME 04101",
			ein: "84-1234567",
			phone: "(207) 555-0142",
			email: "hello@harborlight.example",
			web: "harborlight.example",
		},
	};
}
/** Stress kit: a yellow primary with about 1.4:1 contrast on white. */
export const lowContrastKit = () => sampleKit("#F5D90A", "#FFE866", "harborlight-low");
