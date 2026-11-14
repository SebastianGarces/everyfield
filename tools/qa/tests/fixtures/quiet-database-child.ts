// A QA test process for containers.test.ts: it starts a quiet database, prints the container's name, then either fails
// as a node:test test (`fail`) or waits to be interrupted (`wait`). It never stops the database itself.
import test from "node:test";
import { source, startQuietDatabase } from "../fixtures.ts";

const started = () => console.log(startQuietDatabase(source, "cleanup").container);
if (process.argv[2] === "fail")
	test("fails after its database started", () => {
		started();
		throw new Error("the QA test failed");
	});
else {
	started();
	setInterval(() => {}, 60_000);
}
