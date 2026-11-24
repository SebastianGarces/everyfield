const CONTEXT = /(?<![\w-]|\.\s*)secrets(?![\w-])(?:\s*\.\s*[\w*-]+|\s*\[[^\]]*\])?/gi;
const INHERIT = /(?<![\w-])secrets["']?\s*:\s*(?:[>|][-+\d]*\s*)?["']?inherit\b/gi;

function contextUses(text: string): string[] {
	const code = text.replace(/'[^']*'/g, (literal) => " ".repeat(literal.length));
	return [...code.matchAll(CONTEXT)].map((m) => text.slice(m.index, m.index + m[0].length));
}

function bareConditions(text: string): string[] {
	const lines = text.split("\n");
	return lines.flatMap((line, i) => {
		const key = /^(\s*(?:- +)*)["']?if["']?\s*:(.*)$/.exec(line);
		if (!key) return [];
		const rest = lines.slice(i + 1);
		const end = rest.findIndex((next) => next.trim() && next.search(/\S/) <= key[1].length);
		const value = [key[2], ...rest.slice(0, end < 0 ? rest.length : end)].join("\n").trim();
		return [value.startsWith("'") ? value.slice(1).replaceAll("''", "'") : value];
	});
}

export function secretUses(text: string): string[] {
	const expression = /\$\{\{(?:'[^']*'|(?!\}\})[^'])*/g;
	return [
		...[...text.matchAll(expression)].flatMap((m) => contextUses(m[0])),
		...bareConditions(text).flatMap((value) => contextUses(value.replace(expression, ""))),
		...[...text.matchAll(INHERIT)].map(() => "secrets: inherit"),
	];
}
