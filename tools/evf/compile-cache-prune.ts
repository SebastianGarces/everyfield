/**
 * bin/evf runs this when its compile cache folder is past the bound: `compile-cache-prune.ts <folder> <keep KB>`.
 * It removes the oldest files until the folder is at the size to keep. A file another process just removed, or one this
 * process may not remove, is skipped: losing a cache entry only costs a compile. Sizes are disk blocks, as `du` counts.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const [folder, keepKb] = process.argv.slice(2);
const files: { path: string; bytes: number; mtimeMs: number }[] = [];
let excess = -Number(keepKb) * 1024;
for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
	if (!entry.isFile()) continue;
	const path = join(entry.parentPath, entry.name);
	try {
		const { blocks, mtimeMs } = statSync(path),
			bytes = blocks * 512;
		files.push({ path, bytes, mtimeMs });
		excess += bytes;
	} catch {}
}
files.sort((a, b) => a.mtimeMs - b.mtimeMs);
for (const { path, bytes } of files) {
	if (excess <= 0) break;
	try {
		unlinkSync(path);
		excess -= bytes;
	} catch {}
}
