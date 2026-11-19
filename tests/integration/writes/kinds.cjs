exports.statementKind = function statementKind(text) {
	if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION)\b/i.test(text)) return "transaction";
	if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(?:"?[\w]+"?)(?:\s+\w+)?\s+SET)\b/i.test(text)) return "write";
	if (/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b|pg_advisory/i.test(text)) return "locked read";
	return "read";
};

const platform = [
	{
		name: "session lookup",
		pattern: /\brequest_session\(/,
		reason: "every signed-in request turns its cookie into a viewer before any feature code runs",
	},
	{
		name: "write gate",
		pattern: /"write_gate"/,
		reason: "every established write locks its account, seat and church before it reads its own rows",
	},
];
exports.platform = platform;

const keywords = new Set(["lateral", "of", "only", "select", "values"]);
function tablesOf(text) {
	const local = new Set(
		[...text.matchAll(/(?:\bWITH|,)\s+(?:RECURSIVE\s+)?"?(\w+)"?\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi)].map(
			(m) => m[1].toLowerCase(),
		),
	);
	const plain = text.replace(/\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b|\(\s*\w+\s+FROM\b/gi, " ");
	const found = new Set();
	for (const m of plain.matchAll(
		/\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:ONLY\s+)?"?(\w+)"?(?:\s*\.\s*"?(\w+)"?)?(\s*\()?/gi,
	)) {
		const name = (m[2] ?? m[1]).toLowerCase();
		if (!m[3] && !keywords.has(name) && !local.has(name)) found.add(name);
	}
	return [...found].sort();
}

const idLike = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[\w-]{20,})$/i;
function collect(value, into, depth = 0) {
	if (into.size >= 5000 || depth > 6 || value === null || value === undefined) return into;
	if (typeof value === "string") {
		if (idLike.test(value)) into.add(value.toLowerCase());
	} else if (Array.isArray(value)) for (const v of value) collect(v, into, depth + 1);
	else if (typeof value === "object") for (const v of Object.values(value)) collect(v, into, depth + 1);
	return into;
}
exports.resultValues = (result) =>
	collect(
		[result].flat().map((r) => r?.rows),
		new Set(),
	);

exports.statementStep = function statementStep(text, values, previous) {
	const kind = exports.statementKind(text);
	const skip = platform.find((p) => p.pattern.test(text))?.name;
	const params = collect(values ?? [], new Set());
	return {
		kind,
		tables: kind === "transaction" ? [] : tablesOf(text),
		linked: previous ? [...params].some((v) => previous.has(v)) : false,
		...(skip ? { skip } : {}),
	};
};

exports.captureResult = function captureResult(args, outcome, settle) {
	const at = args.findIndex((a) => typeof a === "function");
	if (at >= 0) {
		const callback = args[at];
		args[at] = function (error, result) {
			if (!error) settle(exports.resultValues(result));
			return Reflect.apply(callback, this, [error, result]);
		};
		return outcome(args);
	}
	const returned = outcome(args);
	if (returned && typeof returned.then === "function")
		returned.then(
			(result) => settle(exports.resultValues(result)),
			() => {},
		);
	return returned;
};
