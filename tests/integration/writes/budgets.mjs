export const WRITE_PATTERN = 6;

const kindsText = (kinds = {}) =>
	Object.entries(kinds)
		.map(([kind, n]) => `${n} ${kind}`)
		.join(", ");

export function budgetName(limits, name) {
	return Object.hasOwn(limits, name) ? name : name.split(":")[0];
}

export function checkSamples(rows, limits) {
	return measure(rows, limits).problems;
}

export function checkBudgets(rows, limits) {
	const { problems, measured } = measure(rows, limits);
	for (const [name, budget] of Object.entries(limits)) {
		const entry = measured.get(name);
		if (!entry) {
			problems.push(`${name}: budgeted but never measured; remove it or exercise it`);
			continue;
		}
		const most = Math.max(...entry.limit.map((s) => s.count));
		if (entry.limit.length && budget.limit > most)
			problems.push(`${name}: ${most} statements at most, limit ${budget.limit}; set it to ${most}`);
		const over = entry.write && budget.limit > WRITE_PATTERN;
		if (over && !budget.reason?.trim())
			problems.push(
				`${name}: limit ${budget.limit} is above the ${WRITE_PATTERN}-statement write pattern; add a reason`,
			);
		if (!over && budget.reason !== undefined) problems.push(`${name}: within the pattern; remove its reason`);
		if (name.startsWith("GET ")) {
			const counts = [...new Set(entry.limit.map((s) => s.count))];
			if (counts.length > 1)
				problems.push(`${name}: ${counts.join(" and ")} statements as its data grows; a page read must be fixed`);
		}
	}
	return problems;
}

function measure(rows, limits) {
	const problems = [];
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
		entry.write ||= sample.writes > 0 || name.startsWith("POST ");
		measured.set(name, entry);
		if (budget[variant] === undefined)
			problems.push(`${sample.name}: ${sample.count} statements on a ${variant} run, which has no budget`);
		else if (sample.count > budget[variant])
			problems.push(
				`${sample.name}: ${sample.count} statements, limit ${budget[variant]}${variant === "retry" ? " (retry)" : ""} (${kindsText(sample.kinds)})`,
			);
	}
	return { problems, measured };
}
