import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { commentsExempt, root } from "./ratchet.mjs";

const ts = createRequire(new URL("../../packages/db/package.json", import.meta.url))("typescript");

export const git = (args, options = {}) =>
	execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });

export const repoFiles = () =>
	git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(Boolean);

export const JS = /\.[cm]?[jt]sx?$/;
export const MIGRATIONS = /^packages\/db\/migrations\/[^/]+\.sql$/;

const lineAt = (text, index) => text.slice(0, index).split("\n").length;

function scannerComments(text) {
	if (!text.includes("//") && !text.includes("/*")) return [];
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
	const lines = [];
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
		if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia)
			lines.push(lineAt(text, scanner.getTokenStart()));
	return lines;
}

function cssComments(text) {
	const lines = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'") {
			for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
		} else if (c === "/" && text[i + 1] === "*") {
			lines.push(lineAt(text, i));
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		}
	}
	return lines;
}

function hashComments(text) {
	if (!text.includes("#")) return [];
	return text.split("\n").flatMap((line, at) => {
		if (at === 0 && line.startsWith("#!")) return [];
		let quote = null;
		for (let j = 0; j < line.length; j++) {
			const c = line[j];
			if (quote) {
				if (c === "\\" && quote === '"') j++;
				else if (c === quote) quote = null;
			} else if ((c === '"' || c === "'") && (j === 0 || /[\s:[{,=(]/.test(line[j - 1]))) quote = c;
			else if (c === "#" && (j === 0 || /\s/.test(line[j - 1]))) return [at + 1];
		}
		return [];
	});
}

function sqlComments(text) {
	const lines = [];
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "'" || c === '"') {
			for (i++; i < text.length; i++) {
				if (text[i] !== c) continue;
				if (text[i + 1] === c) i++;
				else break;
			}
		} else if (c === "-" && text[i + 1] === "-") {
			lines.push(lineAt(text, i));
			const end = text.indexOf("\n", i);
			i = end === -1 ? text.length : end;
		} else if (c === "/" && text[i + 1] === "*") {
			lines.push(lineAt(text, i));
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 1;
		}
	}
	return lines;
}

const HASH_FILES = new Set([".gitignore", ".prettierignore"]);

export function commentScanner(path) {
	if (MIGRATIONS.test(path)) return sqlComments;
	if (/\.jsonc?$/.test(path)) return scannerComments;
	if (path.endsWith(".css")) return cssComments;
	if (/\.(ya?ml|toml|sh)$/.test(path) || HASH_FILES.has(basename(path))) return hashComments;
	if (/^bin\/[^/.]+$/.test(path) || path.startsWith("tools/git-hooks/")) return hashComments;
	return null;
}

const DIRECTIVE = new RegExp(
	[
		"(?:es|ox)lint-(?:dis",
		"|en)able",
		"|@ts-(?:ign",
		"ore|noch",
		"eck|ch",
		"eck|expect-err",
		"or)",
		"|(?:biome|prettier)-ign",
		"ore",
	].join(""),
	"g",
);

export const directiveCount = (text) => text.match(DIRECTIVE)?.length ?? 0;

export const inScope = (path) => !commentsExempt(path) && (JS.test(path) || commentScanner(path) !== null);
