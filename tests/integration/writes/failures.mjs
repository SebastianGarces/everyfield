const BLOCK_LINES = 30;
export const BLOCK_CHARS = 2000;
export const MESSAGE_CHARS = 8000;

const SUMMARY = "✖ failing tests:";

export function behaviorFailure(evidence, log) {
	const lines = log.split("\n");
	const head = ["Behavior suites failed; evidence: " + evidence, ...lines.filter((line) => line.includes("✖"))].join(
		"\n",
	);
	const blocks = failingBlocks(lines).map((block) => trim(block, evidence));
	if (!blocks.length) return head;
	const cut = `… more failing tests cut; full log: ${evidence}`;
	let message = head + "\n\nFailing tests' errors:";
	for (const [index, block] of blocks.entries()) {
		const room = MESSAGE_CHARS - message.length - (index < blocks.length - 1 ? cut.length + 2 : 0);
		if (block.length + 2 > room) return message + "\n\n" + cut;
		message += "\n\n" + block;
	}
	return message;
}

const SLOWEST = 5;

export function limitFailure({ limit, directory, phases, files, rows, now, load }) {
	const phase = phases.at(-1) ?? { label: "setup", at: now };
	const started = new Map(rows.filter((row) => row.event === "start").map((row) => [row.file, row.at]));
	const finished = rows
		.filter((row) => row.event === "finish")
		.map((row) => [row.file, row.at - started.get(row.file)])
		.sort(([, a], [, b]) => b - a);
	const done = new Set(finished.map(([file]) => file));
	const running = [...started].filter(([file]) => !done.has(file)).map(([file, at]) => [file, now - at]);
	const list = (entries) =>
		entries.length ? entries.map(([file, ms]) => `\n  ${file} (${duration(ms)})`).join("") : " none";
	const timings = phases.map(({ label, at }, i) => `${label} ${duration((phases[i + 1]?.at ?? now) - at)}`);
	return [
		`The census reached its ${duration(limit)} limit in its ${phase.label} phase; evidence: ${directory}`,
		`Elapsed: ${duration(now - (phases[0]?.at ?? now))} (${timings.join(", ")}); load average ${load.map((n) => n.toFixed(1)).join(" ")}`,
		`Suite files finished: ${done.size} of ${files.length}`,
		`Still running:${list(running)}`,
		`Slowest finished:${list(finished.slice(0, SLOWEST))}`,
	].join("\n");
}

function duration(ms) {
	const seconds = Math.round(ms / 1000);
	return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function failingBlocks(lines) {
	const start = lines.lastIndexOf(SUMMARY);
	if (start < 0) return [];
	const blocks = [];
	let block = null;
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("test at ")) {
			block = { file: testPathWithoutCwdSegments(line.slice("test at ".length)), lines: [] };
			blocks.push(block);
		} else if (block && line.trim()) block.lines.push(line);
	}
	return blocks.map(nameErrorAndTestFrame);
}

function testPathWithoutCwdSegments(location) {
	return "/" + location.replace(/:\d+:\d+$/, "").replace(/^(?:\.\.?\/)+/, "");
}

function nameErrorAndTestFrame({ file, lines }) {
	const [name, ...rest] = lines;
	const body = rest.map((line) => line.replace(/^ {2}/, ""));
	const firstFrame = body.findIndex((line) => /^\s+at /.test(line));
	if (firstFrame < 0) return [name, ...body];
	const frames = [];
	for (const line of body.slice(firstFrame)) {
		if (!/^\s+at /.test(line)) break;
		frames.push(line);
	}
	const frame = frames.find((line) => line.includes(file)) ?? frames[0];
	return [name, ...body.slice(0, firstFrame), frame.replace(/ \{$/, "")];
}

function trim(lines, evidence) {
	const marker = `  … error cut; full log: ${evidence}`;
	const kept = lines.slice(0, BLOCK_LINES);
	let text = kept.join("\n");
	if (kept.length === lines.length && text.length <= BLOCK_CHARS) return text;
	text = text.slice(0, BLOCK_CHARS - marker.length - 1);
	return text + "\n" + marker;
}
