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

function failingBlocks(lines) {
	const start = lines.lastIndexOf(SUMMARY);
	if (start < 0) return [];
	const blocks = [];
	let block = null;
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith("test at ")) {
			block = { file: testFile(line.slice("test at ".length)), lines: [] };
			blocks.push(block);
		} else if (block && line.trim()) block.lines.push(line);
	}
	return blocks.map(nameErrorAndTestFrame);
}

// The reporter prints the path relative to the child's cwd (packages/domain in the census),
// so drop leading ./ and ../ segments to match it inside an absolute file:// frame.
function testFile(location) {
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
