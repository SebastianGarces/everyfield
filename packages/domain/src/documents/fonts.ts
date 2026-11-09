import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FONT } from "./theme.ts";

// The font files, read at run time from their committed copies. A literal `new URL` per file breaks in a page chunk,
// where Turbopack turns it into a public /_next/static URL that fs cannot read, so "Save for your church" (a server
// action) failed to render. A template URL such as `./fonts/${file}` made Turbopack load DMSans-Regular for every face.
// So the path is computed in `fontFile`, as the reference loader does, and apps/web/next.config.ts traces the files.
const FILES: [file: string, family: string, weight: number, style: "normal" | "italic"][] = [
	["DMSans-Regular.ttf", FONT.body, 400, "normal"],
	["DMSans-Medium.ttf", FONT.body, 500, "normal"],
	["DMSans-Bold.ttf", FONT.body, 700, "normal"],
	["DMSans-Italic.ttf", FONT.body, 400, "italic"],
	["DMSans-BoldItalic.ttf", FONT.body, 700, "italic"],
	["EFFigures-Regular.ttf", FONT.figures, 400, "normal"],
	["EFFigures-Medium.ttf", FONT.figures, 500, "normal"],
	["EFFigures-Bold.ttf", FONT.figures, 700, "normal"],
	["DMSerifDisplay-Regular.ttf", FONT.display, 400, "normal"],
];

/** A file path string. Next's server bundle uses its own URL class, which Node's fs rejects. */
function fontFile(name: string) {
	return fileURLToPath(new URL(name, import.meta.url).href);
}

type Loaded = { family: string; src: Uint8Array; fontWeight: number; fontStyle: "normal" | "italic"; file: string };
let loaded: Loaded[] | undefined;

/** Font files read once from the committed copies. They are the only families a document may use. */
export function documentFonts() {
	loaded ??= FILES.map(([file, family, fontWeight, fontStyle]) => ({
		file,
		family,
		fontWeight,
		fontStyle,
		src: new Uint8Array(readFileSync(fontFile(`fonts/${file}`))),
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
