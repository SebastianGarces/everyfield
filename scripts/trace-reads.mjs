// Preloaded by `bin/dev nightly`'s coverage run (scripts/nightly.ts, T-41) through NODE_OPTIONS, so every child
// process loads it too. V8 coverage sees only the modules a test executes; a test that reads a file as text, or lists a
// directory, would look as if it never touched it, and selection would skip it. This records every path the process
// reads or lists through node:fs into TRACE_READS_DIR/<pid>.txt, one absolute path per line, with directories ending
// in "/". It changes no behavior: each wrapper calls the original with the same arguments.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.TRACE_READS_DIR;
if (dir) {
	const seen = new Set();
	const note = (target, isDir) => {
		try {
			const path = target instanceof URL ? fileURLToPath(target) : typeof target === "string" ? resolve(target) : null;
			if (path) seen.add(isDir ? path.replace(/\/*$/, "/") : path);
		} catch {
			// A path we cannot name is one the test did not read from the repository.
		}
	};
	const wrap = (owner, name, isDir) => {
		const original = owner[name];
		if (typeof original !== "function") return;
		owner[name] = function (target, ...rest) {
			note(target, isDir);
			return original.call(this, target, ...rest);
		};
	};
	for (const name of ["readFileSync", "readFile", "createReadStream", "existsSync", "statSync", "openSync"])
		wrap(fs, name, false);
	for (const name of ["readdirSync", "readdir", "opendirSync", "opendir"]) wrap(fs, name, true);
	wrap(fs.promises, "readFile", false);
	wrap(fs.promises, "readdir", true);
	wrap(fs.promises, "opendir", true);
	syncBuiltinESMExports();
	process.on("exit", () => {
		if (!seen.size) return;
		try {
			fs.writeFileSync(join(dir, `${process.pid}.txt`), [...seen].join("\n") + "\n", { flag: "a" });
		} catch {
			// The run's own directory is gone; the map loses this process, and its paths fall back to the rules.
		}
	});
}
