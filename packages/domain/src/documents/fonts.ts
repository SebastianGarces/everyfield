import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FONT } from "./theme.ts";

// One literal `new URL` for each file. A bundler copies only the files it can name: a template URL such as
// `./fonts/${file}` made Turbopack load DMSans-Regular for every face, so bold, italic and the serif printed regular.
const FILES: [file: string, url: URL, family: string, weight: number, style: "normal" | "italic"][] = [
	["DMSans-Regular.ttf", new URL("./fonts/DMSans-Regular.ttf", import.meta.url), FONT.body, 400, "normal"],
	["DMSans-Medium.ttf", new URL("./fonts/DMSans-Medium.ttf", import.meta.url), FONT.body, 500, "normal"],
	["DMSans-Bold.ttf", new URL("./fonts/DMSans-Bold.ttf", import.meta.url), FONT.body, 700, "normal"],
	["DMSans-Italic.ttf", new URL("./fonts/DMSans-Italic.ttf", import.meta.url), FONT.body, 400, "italic"],
	["DMSans-BoldItalic.ttf", new URL("./fonts/DMSans-BoldItalic.ttf", import.meta.url), FONT.body, 700, "italic"],
	["EFFigures-Regular.ttf", new URL("./fonts/EFFigures-Regular.ttf", import.meta.url), FONT.figures, 400, "normal"],
	["EFFigures-Medium.ttf", new URL("./fonts/EFFigures-Medium.ttf", import.meta.url), FONT.figures, 500, "normal"],
	["EFFigures-Bold.ttf", new URL("./fonts/EFFigures-Bold.ttf", import.meta.url), FONT.figures, 700, "normal"],
	[
		"DMSerifDisplay-Regular.ttf",
		new URL("./fonts/DMSerifDisplay-Regular.ttf", import.meta.url),
		FONT.display,
		400,
		"normal",
	],
];

type Loaded = { family: string; src: Uint8Array; fontWeight: number; fontStyle: "normal" | "italic"; file: string };
let loaded: Loaded[] | undefined;

/** Font files read once from the committed copies. They are the only families a document may use. */
export function documentFonts() {
	loaded ??= FILES.map(([file, url, family, fontWeight, fontStyle]) => ({
		file,
		family,
		fontWeight,
		fontStyle,
		src: new Uint8Array(readFileSync(url)),
	}));
	return loaded;
}

/** SHA-256 of each font file, for the render engine version. */
export function fontDigests() {
	return documentFonts().map((font) => ({
		file: font.file,
		sha256: createHash("sha256").update(font.src).digest("hex"),
	}));
}
