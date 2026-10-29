import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dev-only mail capture (criterion 35). With no provider key, a development or preview server records each send
// to a folder and delivers to nobody. A hosted production server never records: the guard names the allowed
// environments, so an unknown value fails closed.

type Env = Readonly<Record<string, string | undefined>>;

type Captured = {
	id: string;
	at: string;
	from: string;
	to: string;
	subject: string;
	html: string;
	text: string;
};

const folder = join(tmpdir(), "everyfield-dev-outbox");

/** True only with no provider key and a Vercel environment that is absent (local), "development" or "preview". */
export function captureAllowed(env: Env): boolean {
	if (env.RESEND_API_KEY?.trim()) return false;
	return env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development" || env.VERCEL_ENV === "preview";
}

export async function record(message: Omit<Captured, "id" | "at">, directory = folder): Promise<string> {
	const id = `capture-${randomUUID()}`;
	await mkdir(directory, { recursive: true });
	const entry: Captured = { id, at: new Date().toISOString(), ...message };
	await writeFile(join(directory, `${id}.json`), JSON.stringify(entry), { flag: "wx" });
	return id;
}

/** Newest first. */
export async function readOutbox(directory = folder): Promise<Captured[]> {
	const names = await readdir(directory).catch(() => []);
	const entries = await Promise.all(
		names
			.filter((name) => /^capture-[0-9a-f-]{36}\.json$/.test(name))
			.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as Captured),
	);
	return entries.sort((a, b) => b.at.localeCompare(a.at));
}
