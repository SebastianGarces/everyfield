// Text contrast measured on the screen, not from styles. Computed background colors miss what is really behind text:
// a chip over a filled header, a gradient, an image. Axe reads styles and missed #420, so this helper reads pixels.
//
// contrastOf(locator) screenshots the element's box twice: as drawn, and with only its glyphs made transparent
// (-webkit-text-fill-color, so currentColor backgrounds and borders do not change). The pixels that differ between the
// two shots are where the glyphs sit, and the second shot holds the real pixels behind them. Each of those background
// pixels is compared with the text's fill color by the WCAG 2 relative luminance formula. The worst one (lowest ratio)
// is the result.
import sharp from "../../apps/web/node_modules/sharp/dist/index.mjs";

const PROBE = "data-contrast-probe";
/** A pixel is part of a glyph when one channel differs by more than this between the two shots. Text that is close to
 * its background differs only a little, so the bar stays just above rendering noise. */
const GLYPH_DIFF = 2;

/**
 * Measures the text contrast of the element `locator` names.
 * Returns { ratio, text, background, shot } where `text` and `background` are the #rrggbb colors behind the worst
 * ratio and `shot` is the PNG of the element as drawn.
 */
export async function contrastOf(locator) {
	await locator.scrollIntoViewIfNeeded();
	const options = { animations: "disabled", caret: "hide" };
	const fill = await locator.evaluate((el) => {
		// The fill color the glyphs are painted with, and the opacity of the element and its parents.
		let opacity = 1;
		for (let node = el; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
		return { color: getComputedStyle(el).webkitTextFillColor || getComputedStyle(el).color, opacity };
	});
	const style = await locator.page().addStyleTag({
		content: `[${PROBE}], [${PROBE}] *, [${PROBE}]::before, [${PROBE}]::after, [${PROBE}] *::before, [${PROBE}] *::after {
			-webkit-text-fill-color: transparent !important; text-shadow: none !important;
			text-decoration-color: transparent !important; }`,
	});
	try {
		const shot = await locator.screenshot(options);
		await locator.evaluate((el, probe) => el.setAttribute(probe, ""), PROBE);
		const behind = await locator.screenshot(options);
		const drawn = await decode(shot);
		const under = await decode(behind);
		if (drawn.width !== under.width || drawn.height !== under.height)
			throw new Error(`the two shots differ in size: ${drawn.width}x${drawn.height}, ${under.width}x${under.height}`);
		const [r, g, b, a] = parseColor(fill.color);
		const alpha = a * fill.opacity;
		const differs = (i) => [0, 1, 2].some((k) => Math.abs(drawn.pixels[i + k] - under.pixels[i + k]) > GLYPH_DIFF);
		let glyphPixels = 0;
		for (let i = 0; i < drawn.pixels.length; i += 4) if (differs(i)) glyphPixels++;
		// Text that changes no pixel matches what is behind it: measure it against the whole box.
		let worst = null;
		for (let i = 0; i < drawn.pixels.length; i += 4) {
			if (glyphPixels && !differs(i)) continue;
			const background = [under.pixels[i], under.pixels[i + 1], under.pixels[i + 2]];
			const text = [r, g, b].map((c, k) => Math.round(c * alpha + background[k] * (1 - alpha)));
			const ratio = contrastRatio(text, background);
			if (!worst || ratio < worst.ratio) worst = { ratio, text, background };
		}
		return {
			ratio: Math.round(worst.ratio * 100) / 100,
			text: hex(worst.text),
			background: hex(worst.background),
			shot,
		};
	} finally {
		await locator.evaluate((el, probe) => el.removeAttribute(probe), PROBE);
		await style.evaluate((el) => el.remove());
	}
}

/** WCAG 2 relative luminance of an sRGB color given as [r, g, b] in 0-255. */
export function luminance(rgb) {
	const [r, g, b] = rgb.map((c) => {
		const s = c / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio of two sRGB colors, from 1 to 21. */
function contrastRatio(a, b) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

const hex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/** Parses a computed `rgb()` or `rgba()` color into [r, g, b, alpha]. */
function parseColor(css) {
	const parts = css
		.match(/rgba?\(([^)]+)\)/)?.[1]
		.split(/[\s,/]+/)
		.filter(Boolean)
		.map(Number);
	if (!parts || parts.length < 3) throw new Error(`cannot read the text color ${css}`);
	return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** Decodes a PNG into RGBA pixels. */
async function decode(png) {
	const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { width: info.width, height: info.height, pixels: data };
}
