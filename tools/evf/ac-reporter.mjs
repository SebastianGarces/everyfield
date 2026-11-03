// The node:test reporter `evf ac run` reads (OPS-112): one JSON line per finished test or suite. A skipped or todo test
// does not count as passed, so a marker cannot pass by being skipped.
export default async function* acReporter(source) {
	for await (const event of source)
		if (event.type === "test:pass" || event.type === "test:fail")
			yield JSON.stringify({
				name: event.data.name,
				file: event.data.file,
				result: event.type === "test:fail" ? "failed" : event.data.skip || event.data.todo ? "skipped" : "passed",
			}) + "\n";
}
