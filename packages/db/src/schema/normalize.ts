/** Kit assumes public for default-schema references; our runner selects the application schema. */
export function normalizeOwnTableReferences(source: string, tableNames: ReadonlySet<string>): string {
	const tokens =
		source.match(
			/--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\$([A-Za-z_][\w]*)?\$[\s\S]*?\$\1\$|'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][\w$]*|\s+|./g,
		) ?? [];
	const identifier = (token: string) =>
		token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase();
	const trivia = (token: string) => /^\s+$|^--|^\/\*/.test(token);
	for (let i = 0; i < tokens.length; i++) {
		if (identifier(tokens[i]) !== "public") continue;
		let dot = i + 1;
		while (dot < tokens.length && trivia(tokens[dot])) dot++;
		if (tokens[dot] !== ".") continue;
		let target = dot + 1;
		while (target < tokens.length && trivia(tokens[target])) target++;
		if (target >= tokens.length || !tableNames.has(identifier(tokens[target]))) continue;
		let context = i - 1;
		while (context >= 0 && trivia(tokens[context])) context--;
		if (context < 0 || !["references", "table", "on"].includes(identifier(tokens[context]))) continue;
		tokens[i] = "";
		tokens[dot] = "";
	}
	return tokens.join("");
}

export function assertUnqualifiedOwnTables(source: string, tableNames: ReadonlySet<string>): void {
	if (normalizeOwnTableReferences(source, tableNames) !== source) {
		throw new Error(
			"Migration contains a public-qualified application table; run pnpm --filter @everyfield/db generate",
		);
	}
}
