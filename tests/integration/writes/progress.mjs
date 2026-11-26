export default async function* progress(events) {
	const names = new Map();
	for await (const { type, data } of events) {
		const row = (event) => JSON.stringify({ event, file: data.file, at: Date.now() }) + "\n";
		if (type === "test:dequeue" && data.nesting === 0 && !names.has(data.file)) {
			names.set(data.file, data.name);
			yield row("start");
		} else if (type === "test:complete" && data.nesting === 0 && names.get(data.file) === data.name)
			yield row("finish");
	}
}
