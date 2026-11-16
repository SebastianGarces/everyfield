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
		} catch {}
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
		} catch {}
	});
}
