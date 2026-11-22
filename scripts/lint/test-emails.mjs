import { matchesGlob } from "node:path";

const SCOPE = ["tests/**", "tools/**/tests/**", "ops/**/test/**"];
export const EMAIL_EXEMPT = {
	"tests/evry/evals/*.json":
		"recorded eval cases: an edit forces a paid re-record (D-1292), and their addresses are model inputs already sent",
};

const EMAIL = /(?<![\w.%+-])(?<!\/\/[^\s/@"'`]*)[\w.%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})(?![\w-]|\.[a-z0-9])/gi;
const RESERVED = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|resend\.dev)$/;

export const emailScoped = (path) =>
	SCOPE.some((glob) => matchesGlob(path, glob)) && !Object.keys(EMAIL_EXEMPT).some((glob) => matchesGlob(path, glob));

export function emailProblems(path, text) {
	const problems = [];
	for (const match of text.matchAll(EMAIL)) {
		if (RESERVED.test(match[1].toLowerCase())) continue;
		const line = text.slice(0, match.index).split("\n").length;
		problems.push(
			`${path}:${line}: ${match[0]} is a real address; use a reserved domain (example.com, *.example, *.test, *.invalid) or a resend.dev test address`,
		);
	}
	return problems;
}
