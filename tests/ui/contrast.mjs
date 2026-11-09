// Text contrast measured on the screen, not from styles. Computed background colors miss what is really behind text:
// a chip over a filled header, a gradient, an image. Axe reads styles and missed #420, so this helper reads pixels.
//
// contrastOf(locator) screenshots the element's box twice: as drawn, and with only its glyphs made transparent
// (-webkit-text-fill-color, so currentColor backgrounds and borders do not change). The pixels that differ between the
// two shots are where the glyphs sit, and the second shot holds the real pixels behind them. Each of those background
// pixels is compared with the text's fill color by the WCAG 2 relative luminance formula. The worst one (lowest ratio)
// is the result.
import { inflateSync } from "node:zlib";

const PROBE = "data-contrast-probe";
/** A pixel is part of a glyph when one channel differs by more than this between the two shots. Text that is close to
 * its background differs only a little, so the bar stays just above rendering noise. */
const GLYPH_DIFF = 2;

/**
 * Measures the text contrast of the element `locator` names.
 * Returns { ratio, text, background, glyphPixels, shot } where `text` and `background` are the #rrggbb colors behind
 * the worst ratio, `glyphPixels` counts the pixels measured and `shot` is the PNG of the element as drawn.
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
		const drawn = decodePng(shot);
		const under = decodePng(behind);
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
			glyphPixels,
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
export function contrastRatio(a, b) {
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

/** Decodes an 8-bit, non-interlaced RGB or RGBA PNG (what browser screenshots are) into RGBA pixels. */
export function decodePng(buffer) {
	let offset = 8;
	let width = 0;
	let height = 0;
	let channels = 0;
	const data = [];
	while (offset < buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const body = buffer.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			const [depth, colorType, , , interlace] = body.subarray(8, 13);
			channels = { 2: 3, 6: 4 }[colorType];
			if (depth !== 8 || !channels || interlace !== 0)
				throw new Error(`unsupported PNG: depth ${depth}, color type ${colorType}, interlace ${interlace}`);
		} else if (type === "IDAT") data.push(body);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(data));
	const stride = width * channels;
	const rows = Buffer.alloc(stride * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? rows[y * stride + x - channels] : 0;
			const up = y > 0 ? rows[(y - 1) * stride + x] : 0;
			const corner = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels] : 0;
			let predictor = 0;
			if (filter === 1) predictor = left;
			else if (filter === 2) predictor = up;
			else if (filter === 3) predictor = (left + up) >> 1;
			else if (filter === 4) {
				const p = left + up - corner;
				const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - corner)];
				predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
			}
			rows[y * stride + x] = (line[x] + predictor) & 0xff;
		}
	}
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0, j = 0; i < width * height; i++, j += channels) {
		pixels[i * 4] = rows[j];
		pixels[i * 4 + 1] = rows[j + 1];
		pixels[i * 4 + 2] = rows[j + 2];
		pixels[i * 4 + 3] = channels === 4 ? rows[j + 3] : 255;
	}
	return { width, height, pixels };
}
