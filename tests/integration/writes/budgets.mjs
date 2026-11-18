export const WRITE_PATTERN = 6;
const REPEAT_LIMIT = 2;

const kindsText = (kinds = {}) =>
	Object.entries(kinds)
		.map(([kind, n]) => `${n} ${kind}`)
		.join(", ");

const most = (samples) => Math.max(...samples.map((s) => s.count));

const perRow = (sample) =>
	sample.rollbacks ? [] : Object.entries(sample.repeats ?? {}).filter(([, count]) => count > REPEAT_LIMIT);

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
		const measuredMost = entry.limit.length ? most(entry.limit) : budget.limit;
		if (entry.write && measuredMost > WRITE_PATTERN && !budget.reason?.trim())
			problems.push(
				`${name}: ${measuredMost} statements is above the ${WRITE_PATTERN}-statement write pattern; add a reason`,
			);
		if (name.startsWith("GET ")) {
			const counts = [...new Set(entry.limit.map((s) => s.count))];
			if (counts.length > 1)
				problems.push(`${name}: ${counts.join(" and ")} statements as its data grows; a page read must be fixed`);
		}
	}
	return problems;
}

export function tighten(rows, limits, units) {
	const ran = rows.filter((row) => row.kind === "part").flatMap((row) => row.ran);
	if (ran.length !== units.length || new Set(ran).size !== ran.length || !units.every((unit) => ran.includes(unit)))
		return null;
	const { measured } = measure(rows, limits);
	const changes = [];
	const tightened = {};
	for (const [name, budget] of Object.entries(limits)) {
		const entry = measured.get(name);
		const next = { ...budget };
		const why = [];
		if (entry?.limit.length && budget.limit > most(entry.limit)) {
			next.limit = most(entry.limit);
			why.push(`${next.limit} statements at most, limit ${budget.limit}`);
		}
		if (entry?.retry.length && budget.retry === undefined) {
			next.retry = most(entry.retry);
			why.push(`a retry run sent ${next.retry} statements and had no retry budget`);
		}
		if (entry && next.reason !== undefined && !(entry.write && next.limit > WRITE_PATTERN)) {
			delete next.reason;
			why.push(`within the ${WRITE_PATTERN}-statement write pattern, so its reason is stale`);
		}
		if (entry && next.repeats !== undefined && !entry.repeated) {
			delete next.repeats;
			why.push("no statement repeats per row any more, so its repeats reason is stale");
		}
		if (why.length) changes.push(`${name}: ${why.join("; ")}; tightened to ${JSON.stringify(next)}`);
		tightened[name] = next;
	}
	return { limits: tightened, changes };
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
	const repeated = new Map();
	for (const sample of samples) {
		const name = budgetName(limits, sample.name);
		const budget = limits[name];
		if (!budget) {
			problems.push(`${sample.name}: ${sample.count} statements, no budget in limits.json`);
			continue;
		}
		const variant = sample.rollbacks ? "retry" : "limit";
		const entry = measured.get(name) ?? { limit: [], retry: [], write: false, repeated: false };
		entry[variant].push(sample);
		entry.write ||= sample.writes > 0 || name.startsWith("POST ");
		measured.set(name, entry);
		if (budget[variant] !== undefined && sample.count > budget[variant])
			problems.push(
				`${sample.name}: ${sample.count} statements, limit ${budget[variant]}${variant === "retry" ? " (retry)" : ""} (${kindsText(sample.kinds)})`,
			);
		for (const [shape, count] of perRow(sample)) {
			entry.repeated = true;
			const key = name + "\0" + shape;
			if (!budget.repeats?.trim()) repeated.set(key, Math.max(count, repeated.get(key) ?? 0));
		}
	}
	for (const [key, count] of repeated) {
		const [name, shape] = key.split("\0");
		problems.push(
			`${name}: N+1, sends the same statement ${count} times in one run: ${shape.slice(0, 200)}; batch it into one set-based statement, or give limits.json a repeats reason`,
		);
	}
	return { problems, measured };
}
