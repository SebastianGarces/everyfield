import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const wiki = fileURLToPath(new URL("../../../apps/web/src/features/wiki/", import.meta.url));
const WIDE = /\b12(?:80|79)(?![0-9])|\b80rem\b|(?<!\w)xl:(?=\S)|breakpoint-xl\b|@(?:variant|screen)\s+xl\b/;
const wideLines = (file: string) =>
	readFileSync(wiki + file, "utf8")
		.split("\n")
		.flatMap((line, i) => (WIDE.test(line) ? [`${file}:${i + 1}`] : []));

test("INV-wiki-layout: the wiki's 1280 px switch is written only in layout.ts, as min-[1280px], xl: or a media query nowhere else", () => {
	const files = globSync("**/*.{ts,tsx,css}", { cwd: wiki });
	assert.ok(wideLines("layout.ts").length > 0 && files.includes("client.tsx") && files.includes("editor.css"));
	assert.deepEqual(
		files.filter((file) => file !== "layout.ts").flatMap(wideLines),
		[],
		"name the classes in features/wiki/layout.ts and import them",
	);
});
