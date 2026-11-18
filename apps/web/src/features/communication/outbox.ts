import "server-only";

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { outboxFolder, type Captured } from "../../server/mail/capture.ts";

export async function readOutbox(directory = outboxFolder()): Promise<Captured[]> {
	const names = await readdir(directory).catch(() => []);
	const entries = await Promise.all(
		names
			.filter((name) => /^capture-[0-9a-f-]{36}\.json$/.test(name))
			.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as Captured),
	);
	return entries.sort((a, b) => b.at.localeCompare(a.at));
}
