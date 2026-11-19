export const WRITE_PATTERN = 6;
const PROMISE = /\b(?:reviews? it|for now|later|until|today|revisit|temporar(?:y|ily))\b/i;

const kindsText = (kinds = {}) =>
	Object.entries(kinds)
		.map(([kind, n]) => `${n} ${kind}`)
		.join(", ");

const KINDS = ["transaction", "locked read", "read", "write"];
const mix = (counts) =>
	KINDS.filter((kind) => counts[kind])
		.map((kind) => `${counts[kind]} ${kind}`)
		.join(", ");
function statedMix(reason) {
	const sentence = /Its largest first run[^:.]*: ([^.]*)\./.exec(reason)?.[1];
	if (sentence === undefined) return null;
	const counts = {};
	for (const [, n, kind] of sentence.matchAll(/(\d+) (transaction|locked read|read|write)\b/g))
		counts[kind] = (counts[kind] ?? 0) + Number(n);
	return mix(counts);
}

export function budgetName(limits, name) {
	return Object.hasOwn(limits, name) ? name : name.split(":")[0];
}

const isRead = (step) => !step.skip && (step.kind === "read" || step.kind === "locked read");
const related = (a, b) => b.linked || a.tables.some((t) => b.tables.includes(t));

export function readRuns(steps = []) {
	const runs = [];
	let run = [];
	for (const step of steps) {
		if (isRead(step) && run.length && related(run.at(-1), step)) run.push(step);
		else {
			if (run.length > 1) runs.push(run);
			run = isRead(step) ? [step] : [];
		}
	}
	if (run.length > 1) runs.push(run);
	return runs;
}

const runText = (run) =>
	`${run.length} reads in a row on related rows (${run.map((s) => `${s.kind} of ${s.tables.join("+") || "no table"}`).join(", then ")})`;

function flaggedReads(samples, limits) {
	const holders = new Map();
	for (const sample of samples)
		for (const step of sample.steps ?? []) holders.set(step.id, [...(holders.get(step.id) ?? []), sample]);
	const flagged = new Map();
	for (const sample of samples)
		for (const run of readRuns(sample.steps)) {
			const inner = (holders.get(run[0].id) ?? []).some(
				(other) => other.steps.length < sample.steps.length && run.every((s) => other.steps.some((o) => o.id === s.id)),
			);
			const name = budgetName(limits, sample.name);
			if (!inner && !flagged.has(name)) flagged.set(name, runText(run));
		}
	return flagged;
}

export function checkSamples(rows, limits) {
	return measure(rows, limits).problems;
}

export function checkBudgets(rows, limits) {
	const { problems, measured, samples } = measure(rows, limits);
	const reads = flaggedReads(samples, limits);
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
		const promise = over && budget.reason?.match(PROMISE);
		if (promise)
			problems.push(
				`${name}: its reason promises ("${promise[0]}") instead of naming the structural cause of each statement`,
			);
		const largest = entry.limit.filter((s) => s.count === most);
		if (over && budget.reason?.trim() && largest.length) {
			const stated = statedMix(budget.reason);
			const measured = largest.map((s) => mix(s.kinds));
			if (!measured.includes(stated))
				problems.push(
					stated === null
						? `${name}: its reason must state the measured statement mix: "Its largest first run: ${measured[0]}."`
						: `${name}: its reason states a largest first run of ${stated}, but it sent ${measured.join(" or ")}`,
				);
		}
		if (!over && budget.reason !== undefined) problems.push(`${name}: within the pattern; remove its reason`);
		const run = reads.get(name);
		if (run && !budget.reads?.trim()) problems.push(`${name}: ${run}; make them one statement or give a reads reason`);
		if (!run && budget.reads !== undefined)
			problems.push(`${name}: no related reads in a row; remove its reads reason`);
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
	return { problems, measured, samples };
}
