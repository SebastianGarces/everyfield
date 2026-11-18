import { globSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = fileURLToPath(new URL("./weights.json", import.meta.url));
const proofs = ["tests/integration/writes/requests.mjs", "tests/integration/writes/native.mjs"];
const PRE_T463_CONCURRENCY = 2;

const usage = `Usage: node tests/integration/writes/weights.mjs --part-1-ms <ms> <run folder>...

Writes tests/integration/writes/weights.json, the measured weights the statement census splits its suites by.

Each run folder holds one green CI run's census artifacts, for example
  gh run download <run id> -p 'statement-census-part-*' -D <folder>/<run id>
The folder's name is recorded as the run id.

A suite's weight is the time its top-level tests took in its part's behaviors.log, plus the part's per-file start-up
time: the part's process time (concurrency x duration_ms) less its test time, spread over its files. The census log
prints no file names, so each top-level test is matched to the part's files, which node runs and reports in path order.
A suite measured in several runs gets the rounded mean.

--part-1-ms is the wall time part 1 spends before its behaviors run: its production build step plus its requests and
native proofs, read from the same runs' job step times. The split counts it as weight part 1 already carries.

The same folders and --part-1-ms always give the same file.`;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function matcher(source) {
	const templates = [...source.matchAll(/`((?:[^`\\]|\\.)*)`/gs)]
		.map((match) => match[1].split(/\$\{[^}]*\}/))
		.filter((pieces) => pieces.length > 1 && pieces.join("").length >= 12)
		.map(
			(pieces) =>
				new RegExp("^" + pieces.map((piece) => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".+?") + "$", "s"),
		);
	return (name) => source.includes(name) || templates.some((template) => template.test(name));
}

export function weighPart({ log, ran, concurrency = PRE_T463_CONCURRENCY }, sources) {
	const files = ran.filter((file) => !proofs.includes(file)).sort(compare);
	if (!files.length) return {};
	const matches = files.map((file) => matcher(sources(file)));
	const tests = files.map(() => 0);
	let at = 0;
	for (const [, name, ms] of log.matchAll(/^[✔✖﹣] (.*) \(([\d.]+)ms\)(?: # .*)?$/gm)) {
		const found = matches.findIndex((match, index) => index >= at && match(name));
		if (found >= 0) at = found;
		tests[at] += Number(ms);
	}
	const duration = Number(/^ℹ duration_ms ([\d.]+)$/m.exec(log)?.[1]);
	if (!(duration > 0)) throw Error("A behaviors.log has no duration_ms line");
	const startup = Math.max(0, (concurrency * duration - tests.reduce((a, b) => a + b, 0)) / files.length);
	return Object.fromEntries(files.map((file, index) => [file, tests[index] + startup]));
}

export function weigh(runs, part1, sources) {
	const measured = new Map();
	for (const parts of runs)
		for (const part of parts)
			for (const [file, ms] of Object.entries(weighPart(part, sources)))
				measured.set(file, [...(measured.get(file) ?? []), ms]);
	const suites = [...measured.keys()].sort(compare).map((file) => {
		const all = measured.get(file);
		return [file, Math.round(all.reduce((a, b) => a + b, 0) / all.length)];
	});
	return { part1, suites: Object.fromEntries(suites) };
}

export function partSuites(files, weights, index, total, concurrency) {
	if (total === 1) return files;
	const known = files
		.map((file) => weights.suites[file])
		.filter((ms) => ms !== undefined)
		.sort((a, b) => a - b);
	const fallback = known.length ? known[Math.floor(known.length / 2)] : 1;
	const parts = Array.from({ length: total }, (_, i) => ({
		load: i === 0 ? weights.part1 * concurrency : 0,
		files: [],
	}));
	const weighed = files.map((file) => ({ file, ms: weights.suites[file] ?? fallback }));
	weighed.sort((a, b) => b.ms - a.ms || compare(a.file, b.file));
	for (const { file, ms } of weighed) {
		const lightest = parts.reduce((least, part) => (part.load < least.load ? part : least));
		lightest.load += ms;
		lightest.files.push(file);
	}
	return parts[index - 1].files;
}

function readRun(folder) {
	return globSync("statement-census-part-*/*/counts.jsonl", { cwd: folder })
		.sort(compare)
		.flatMap((counts) => {
			const marker = readFileSync(join(folder, counts), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((row) => row.kind === "part");
			if (!marker) throw Error(`${join(folder, counts)} has no part marker; use only green runs`);
			const ran = marker.ran.filter((file) => !proofs.includes(file));
			if (!ran.length) return [];
			const log = readFileSync(join(folder, counts, "../behaviors.log"), "utf8");
			return [{ log, ran: marker.ran, concurrency: marker.concurrency }];
		});
}

function main(args) {
	const flag = args.indexOf("--part-1-ms");
	const part1 = Number(args[flag + 1]);
	const folders = args.filter((_, index) => flag < 0 || (index !== flag && index !== flag + 1));
	if (args.includes("--help") || flag < 0 || !(part1 >= 0) || !folders.length) {
		console.log(usage);
		process.exit(args.includes("--help") ? 0 : 2);
	}
	const sorted = [...folders].sort((a, b) => compare(basename(a), basename(b)));
	const source = (file) => {
		try {
			return readFileSync(join(root, file), "utf8");
		} catch {
			return "";
		}
	};
	const weights = weigh(sorted.map(readRun), Math.round(part1), source);
	const file = { runs: sorted.map((folder) => basename(folder)), ...weights };
	const runs = `"runs": [${file.runs.map((run) => JSON.stringify(run)).join(", ")}]`;
	writeFileSync(output, JSON.stringify(file, null, "\t").replace(/"runs": \[[^\]]*\]/, runs) + "\n");
	console.log(`${output}: ${Object.keys(weights.suites).length} suites from ${file.runs.join(", ")}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
