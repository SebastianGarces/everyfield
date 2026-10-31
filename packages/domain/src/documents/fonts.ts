import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FONT } from "./theme.ts";

const FILES = [
	["DMSans-Regular.ttf", FONT.body, 400],
	["DMSans-Medium.ttf", FONT.body, 500],
	["DMSans-Bold.ttf", FONT.body, 700],
	["EFFigures-Regular.ttf", FONT.figures, 400],
	["EFFigures-Medium.ttf", FONT.figures, 500],
	["EFFigures-Bold.ttf", FONT.figures, 700],
	["DMSerifDisplay-Regular.ttf", FONT.display, 400],
] as const;

let loaded: { family: string; src: Uint8Array; fontWeight: number; file: string }[] | undefined;

/** Font files read once from the committed copies. They are the only families a document may use. */
export function documentFonts() {
	loaded ??= FILES.map(([file, family, fontWeight]) => ({
		file,
		family,
		fontWeight,
		src: new Uint8Array(readFileSync(fileURLToPath(new URL(`./fonts/${file}`, import.meta.url)))),
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
