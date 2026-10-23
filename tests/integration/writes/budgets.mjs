// The statement budget rules (D69, patterns.md "Performance"), applied to measured samples. One budget per write,
// HTTP request or named read in limits.json: { limit, retry?, reason? }. `limit` holds the first attempt and `retry`
// a run that rolled back or reran the established way. `limit` equals the most statements measured, so slack cannot
// hide growth. `retry` is an upper bound: a retry's count depends on which of two racing writes lands first. A write
// above the pattern carries a reason. A page sends the same count however much data it shows. Each broken rule is one
// line naming the budget, the measured count and the limit.

/** A simple write: at most this many statements (patterns.md). For an HTTP request this includes the session lookup. */
export const WRITE_PATTERN = 6;

const kindsText = (kinds = {}) =>
	Object.entries(kinds)
		.map(([kind, n]) => `${n} ${kind}`)
		.join(", ");

/** The budget name a sample uses: its own, else the operation before its variant suffix. */
export function budgetName(limits, name) {
	return Object.hasOwn(limits, name) ? name : name.split(":")[0];
}

export function checkBudgets(rows, limits) {
	const problems = [];
	// Writes always need a budget. A run that wrote nothing (a read, a replay, a refusal) is held to the budget of its
	// operation, found after the variant suffix is removed.
	const samples = rows.filter(
		(row) =>
			row.kind === "sample" &&
			row.status !== "threw" &&
			(row.writes > 0 || Object.hasOwn(limits, budgetName(limits, row.name))),
	);
	const measured = new Map();
	for (const sample of samples) {
		const name = budgetName(limits, sample.name);
		const budget = limits[name];
		if (!budget) {
			problems.push(`${sample.name}: ${sample.count} statements, no budget in limits.json`);
			continue;
		}
		const variant = sample.rollbacks ? "retry" : "limit";
		const entry = measured.get(name) ?? { limit: [], retry: [], write: false };
		entry[variant].push(sample);
		// An HTTP POST is a write request even on a run that changed nothing (a replay, a refusal).
		entry.write ||= sample.writes > 0 || name.startsWith("POST ");
		measured.set(name, entry);
		if (budget[variant] === undefined)
			problems.push(`${sample.name}: ${sample.count} statements on a ${variant} run, which has no budget`);
		else if (sample.count > budget[variant])
			problems.push(
				`${sample.name}: ${sample.count} statements, limit ${budget[variant]}${variant === "retry" ? " (retry)" : ""} (${kindsText(sample.kinds)})`,
			);
	}
	for (const [name, budget] of Object.entries(limits)) {
		const entry = measured.get(name);
		if (!entry) {
			problems.push(`${name}: budgeted but never measured; remove it or exercise it`);
			continue;
		}
		// A retry's count depends on which of two racing writes lands first, so only the first run is held exactly.
		const most = Math.max(...entry.limit.map((s) => s.count));
		if (entry.limit.length && budget.limit > most)
			problems.push(`${name}: ${most} statements at most, limit ${budget.limit}; set it to ${most}`);
		const over = entry.write && budget.limit > WRITE_PATTERN;
		if (over && !budget.reason?.trim())
			problems.push(
				`${name}: limit ${budget.limit} is above the ${WRITE_PATTERN}-statement write pattern; add a reason`,
			);
		if (!over && budget.reason !== undefined) problems.push(`${name}: within the pattern; remove its reason`);
		// A page read uses a fixed number of statements independent of data size: every read of it sends the same count.
		if (name.startsWith("GET ")) {
			const counts = [...new Set(entry.limit.map((s) => s.count))];
			if (counts.length > 1)
				problems.push(`${name}: ${counts.join(" and ")} statements as its data grows; a page read must be fixed`);
		}
	}
	return problems;
}
