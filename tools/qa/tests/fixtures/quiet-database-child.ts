// A QA test process for containers.test.ts: it starts a quiet database, prints the container's name, then either fails
// as a node:test test (`fail`) or waits to be interrupted (`wait`). It never stops the database itself. A waiting child
// exits once its stdin closes, which happens when its parent dies however it dies, so it never outlives the test that
// started it. `parent` runs a waiting child under itself, for the case where the child's parent is killed.
import test from "node:test";
import { spawn } from "node:child_process";
import { source, startQuietDatabase } from "../fixtures.ts";

const started = () => console.log(startQuietDatabase(source, "cleanup").container);
const mode = process.argv[2];
if (mode === "fail")
	test("fails after its database started", () => {
		started();
		throw new Error("the QA test failed");
	});
else if (mode === "parent") {
	spawn(process.execPath, [import.meta.filename, "wait"], { stdio: ["pipe", "inherit", "inherit"] });
	setInterval(() => {}, 60_000);
} else {
	process.stdin.on("end", () => process.exit(0)).resume();
	started();
	setInterval(() => {}, 60_000);
}
