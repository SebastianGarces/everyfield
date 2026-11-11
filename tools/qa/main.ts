import { spawnSync } from "node:child_process";
import { qaDown, qaList, qaUp } from "./qa.ts";
import { fail, QaError } from "./store.ts";

const HELP = `QA previews for Nora (docs/runbooks/qa-preview.md). Run on Sebastian's Mac with neonctl and vercel logged in.
  qa up <branch>   Neon branch off development, migrate, seed, Vercel preview of the branch head; prints the id and URL
  qa list          open QA previews: id, branch, URL, Neon branch, age, head
  qa down <id>     remove the alias, the deployment and the Neon branch; a second run does nothing and succeeds`;

function main([sub, arg, ...rest]: string[]): number {
	if (!sub || sub === "help" || sub === "--help") {
		console.log(HELP);
		return 0;
	}
	const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (top.status !== 0) fail("qa must run inside the everyfield repository.");
	const root = top.stdout.trim();
	if (!rest.length) {
		if (sub === "up" && arg) return qaUp(root, arg);
		if (sub === "down" && arg) return qaDown(root, arg);
		if (sub === "list" && !arg) return qaList(root);
	}
	console.error(`Unknown command: qa ${[sub, arg, ...rest].filter(Boolean).join(" ")}\n\n${HELP}`);
	return 2;
}

try {
	process.exitCode = main(process.argv.slice(2));
} catch (error) {
	if (!(error instanceof QaError)) throw error;
	console.error(`qa: ${error.message}`);
	process.exitCode = 1;
}
