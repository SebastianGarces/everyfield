import { appendFileSync } from "node:fs";

/**
 * A node:test reporter that writes one JSON object per line for each failed test, its name and file, and no error text.
 * A parent whose only failure is a failed subtest is skipped, so one failed test gives one name (OPS-132).
 *
 * `evf test` strips EVF_FAILED_TESTS and gives this reporter the file as its destination. A package script has no such
 * choice: Node truncates a destination at each start, and one check runs many commands, some at once. There the flags
 * send the output to the null device and each line is appended to EVF_FAILED_TESTS.
 */
const appendTo = process.env.EVF_FAILED_TESTS;

export default async function* failedTests(source) {
	for await (const event of source) {
		if (event.type !== "test:fail") continue;
		if (event.data.details?.error?.failureType === "subtestsFailed") continue;
		const line = `${JSON.stringify({ name: event.data.name, file: event.data.file })}\n`;
		if (appendTo) {
			try {
				appendFileSync(appendTo, line);
			} catch {
				// Names only observe. A lost name must not change the test run's result.
			}
		}
		yield line;
	}
}
