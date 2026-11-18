const { createHash } = require("node:crypto");

exports.statementKind = function statementKind(text) {
	if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION)\b/i.test(text)) return "transaction";
	if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(?:"?[\w]+"?)(?:\s+\w+)?\s+SET)\b/i.test(text)) return "write";
	if (/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b|pg_advisory/i.test(text)) return "locked read";
	return "read";
};

exports.statementShape = function statementShape(text) {
	return text
		.replace(/'(?:[^']|'')*'/g, "?")
		.replace(/\$\d+/g, "?")
		.replace(/\b\d+(?:\.\d+)?\b/g, "?")
		.replace(/\(\s*\?(?:\s*,\s*\?)*\s*\)/g, "(?)")
		.replace(/\s+/g, " ")
		.trim();
};

exports.repeatedShapes = function repeatedShapes(shapes) {
	const repeats = {};
	for (const [shape, count] of shapes)
		if (count > 1)
			repeats[
				shape.length > 300
					? `${shape.slice(0, 300)}… #${createHash("sha256").update(shape).digest("hex").slice(0, 10)}`
					: shape
			] = count;
	return repeats;
};
