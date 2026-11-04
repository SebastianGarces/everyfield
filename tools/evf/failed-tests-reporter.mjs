/**
 * A node:test reporter for `evf test` under `evf verify` (OPS-132). It writes one JSON test name per line and no error
 * text. A parent whose only failure is a failed subtest is skipped, so one failed test gives one name.
 */
export default async function* failedTests(source) {
	for await (const event of source) {
		if (event.type !== "test:fail") continue;
		if (event.data.details?.error?.failureType === "subtestsFailed") continue;
		yield `${JSON.stringify(event.data.name)}\n`;
	}
}
