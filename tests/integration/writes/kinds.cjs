// What one SQL statement does, so a failed budget can say where the statements go. Shared by the domain counter
// (counter.mjs) and the per-request observer (observer.cjs).
exports.statementKind = function statementKind(text) {
	if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|START\s+TRANSACTION)\b/i.test(text)) return "transaction";
	if (/\b(?:INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+(?:"?[\w]+"?)(?:\s+\w+)?\s+SET)\b/i.test(text)) return "write";
	if (/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b|\bFOR\s+KEY\s+SHARE\b|pg_advisory/i.test(text)) return "locked read";
	return "read";
};
