import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";

process.on("SIGTERM", () => {});

test("hangs with a child of its own", () => {
	const hang = `process.on("SIGTERM", () => {}); require("node:net").createServer().listen(0);`;
	const child = spawn(process.execPath, ["-e", hang], { detached: true, stdio: "ignore" });
	writeFileSync(join(process.env.CENSUS_FIXTURE, "pids.json"), JSON.stringify([process.ppid, process.pid, child.pid]));
	return new Promise(() => createServer().listen(0));
});
