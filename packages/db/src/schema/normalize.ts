function tokenize(source: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < source.length) {
		const start = i;
		if (source.startsWith("--", i)) {
			const end = source.indexOf("\n", i + 2);
			i = end < 0 ? source.length : end + 1;
		} else if (source.startsWith("/*", i)) {
			let depth = 1;
			i += 2;
			while (i < source.length && depth) {
				if (source.startsWith("/*", i)) {
					depth++;
					i += 2;
				} else if (source.startsWith("*/", i)) {
					depth--;
					i += 2;
				} else i++;
			}
			if (depth) throw Error("Unterminated SQL comment");
		} else {
			const escaped = /^[eE]'/.test(source.slice(i));
			const quote = escaped ? "'" : source[i];
			if (quote === "'" || quote === '"') {
				i += escaped ? 2 : 1;
				let closed = false;
				while (i < source.length) {
					if (escaped && source[i] === "\\") {
						i += 2;
						continue;
					}
					if (source[i] === quote) {
						if (source[i + 1] === quote) {
							i += 2;
							continue;
						}
						i++;
						closed = true;
						break;
					}
					i++;
				}
				if (!closed) throw Error("Unterminated SQL quoted token");
			} else {
				const dollar = source.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
				if (dollar) {
					const end = source.indexOf(dollar, i + dollar.length);
					if (end < 0) throw Error("Unterminated SQL dollar string");
					i = end + dollar.length;
				} else {
					const token = source.slice(i).match(/^(?:[A-Za-z_][\w$]*|\s+|.)/s)?.[0];
					if (!token) throw Error("Invalid SQL token");
					i += token.length;
				}
			}
		}
		tokens.push(source.slice(start, i));
	}
	return tokens;
}

/** Kit assumes public for default-schema references; our runner selects the application schema. */
export function normalizeOwnTableReferences(source: string, tableNames: ReadonlySet<string>): string {
	const tokens = tokenize(source);
	const identifier = (token: string) =>
		token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase();
	const trivia = (token: string) => /^\s+$|^--|^\/\*/.test(token);
	for (let i = 0; i < tokens.length; i++) {
		if (identifier(tokens[i] ?? "") !== "public") continue;
		let dot = i + 1;
		while (dot < tokens.length && trivia(tokens[dot] ?? "")) dot++;
		if (tokens[dot] !== ".") continue;
		let target = dot + 1;
		while (target < tokens.length && trivia(tokens[target] ?? "")) target++;
		if (target >= tokens.length || !tableNames.has(identifier(tokens[target] ?? ""))) continue;
		let context = i - 1;
		while (context >= 0 && trivia(tokens[context] ?? "")) context--;
		if (context < 0 || !["references", "table", "on"].includes(identifier(tokens[context] ?? ""))) continue;
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

/** Qualify only extension type positions; vector-shaped names and values stay byte-for-byte unchanged. */
export function qualifyVectorTypes(source: string): string {
	const tokens = tokenize(source);
	const significant = tokens.flatMap((value, index) => (/^\s+$|^--|^\/\*/.test(value) ? [] : [{ value, index }]));
	const value = (i: number) => significant[i]?.value.toLowerCase();
	const types = new Set<number>();
	const stack: { cast: boolean; table: boolean; segment: number }[] = [];
	let statementStart = 0;
	for (const [i, token] of significant.entries()) {
		if (token.value === ";") statementStart = i + 1;
		if (token.value === "(") {
			const header = significant.slice(statementStart, i).map((t) => t.value.toLowerCase());
			stack.push({
				cast: value(i - 1) === "cast",
				table: header[0] === "create" && header.includes("table") && stack.length === 0,
				segment: i + 1,
			});
		} else if (token.value === ")") stack.pop();
		else if (token.value === "," && stack.at(-1)?.table) {
			const frame = stack.at(-1);
			if (frame) frame.segment = i + 1;
		}
		if (!["vector", '"vector"'].includes(token.value.toLowerCase()) || value(i - 1) === ".") continue;
		if (value(i - 1) === ":" && value(i - 2) === ":") types.add(token.index);
		if (value(i - 1) === "as" && stack.at(-1)?.cast) types.add(token.index);
		const frame = stack.at(-1);
		if (
			frame?.table &&
			i === frame.segment + 1 &&
			!["constraint", "check", "primary", "foreign", "unique", "exclude"].includes(value(frame.segment) ?? "")
		)
			types.add(token.index);
		const prefix = significant.slice(statementStart, i).map((t) => t.value.toLowerCase());
		if (prefix[0] === "alter" && prefix[1] === "table") {
			if (value(i - 1) === "type" && prefix.includes("column")) types.add(token.index);
			const add = prefix.lastIndexOf("add");
			if (add >= 0) {
				const clause = prefix.slice(add + 1).filter((t) => t !== "column");
				if (clause[0] === "if" && clause[1] === "not" && clause[2] === "exists") clause.splice(0, 3);
				if (
					clause.length === 1 &&
					!["constraint", "primary", "foreign", "unique", "check", "exclude"].includes(clause[0] ?? "")
				)
					types.add(token.index);
			}
		}
	}
	for (const index of types) tokens[index] = "public.vector";
	return tokens.join("");
}

export function assertQualifiedVectorTypes(source: string): void {
	if (qualifyVectorTypes(source) !== source)
		throw new Error("Migration contains an unqualified vector type; run pnpm --filter @everyfield/db generate");
}
