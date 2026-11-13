import "server-only";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { outboxFolder, type Captured } from "./capture.ts";

// Read side of the dev mail capture. Only the dev outbox route imports this file, so the send path stays free of
// directory reads and the production bundle does not trace the filesystem.

/** Newest first. */
export async function readOutbox(directory = outboxFolder()): Promise<Captured[]> {
	const names = await readdir(directory).catch(() => []);
	const entries = await Promise.all(
		names
			.filter((name) => /^capture-[0-9a-f-]{36}\.json$/.test(name))
			.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as Captured),
	);
	return entries.sort((a, b) => b.at.localeCompare(a.at));
}
