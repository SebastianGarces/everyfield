import "server-only";

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dev-only mail capture (criterion 35). With no provider key, a development or preview server records each send
// to a folder and delivers to nobody. A hosted production server never records: the guard names the allowed
// environments, so an unknown value fails closed. A scheduled capture waits in the folder like a held email: it can
// be cancelled or moved until its time passes, and after that it counts as sent.

type Env = Readonly<Record<string, string | undefined>>;

export type Captured = {
	id: string;
	at: string;
	from: string;
	to: string;
	subject: string;
	html: string;
	text: string;
	/** The held send time, or null for a send-now capture. */
	scheduledAt: string | null;
	cancelled: boolean;
};

/** The outbox folder. `EVERYFIELD_DEV_OUTBOX` lets a test use its own folder. Read at call time. */
export const outboxFolder = (): string =>
	process.env.EVERYFIELD_DEV_OUTBOX?.trim() || join(tmpdir(), "everyfield-dev-outbox");

/**
 * Test-only switch. While a file with this name is in the outbox folder, the capture gives no answer to a send,
 * cancel or time change, as a provider timeout would, so a preview can show each not-confirmed state.
 */
export const NO_ANSWER_FILE = "no-answer";

/** True only with no provider key and a Vercel environment that is absent (local), "development" or "preview". */
export function captureAllowed(env: Env): boolean {
	if (env.RESEND_API_KEY?.trim()) return false;
	return env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development" || env.VERCEL_ENV === "preview";
}

export async function captureSilent(directory = outboxFolder()): Promise<boolean> {
	return access(join(directory, NO_ANSWER_FILE)).then(
		() => true,
		() => false,
	);
}

export async function record(
	message: Omit<Captured, "id" | "at" | "scheduledAt" | "cancelled">,
	scheduledAt: string | null = null,
	directory = outboxFolder(),
): Promise<string> {
	const id = `capture-${randomUUID()}`;
	await mkdir(directory, { recursive: true });
	const entry: Captured = { id, at: new Date().toISOString(), ...message, scheduledAt, cancelled: false };
	await writeFile(join(directory, `${id}.json`), JSON.stringify(entry), { flag: "wx" });
	return id;
}

type Held = "done" | "sent" | "unknown";

/**
 * Change one held capture. A repeat of a change already made answers done. A capture whose time has passed went out;
 * a missing or cancelled one has no answer.
 */
async function changeHeld(
	id: string,
	done: (entry: Captured) => boolean,
	change: (entry: Captured) => Captured,
	directory: string,
): Promise<Held> {
	if (!/^capture-[0-9a-f-]{36}$/.test(id)) return "unknown";
	const file = join(directory, `${id}.json`);
	const entry = await readFile(file, "utf8").then(
		(text) => JSON.parse(text) as Captured,
		() => null,
	);
	if (!entry) return "unknown";
	if (done(entry)) return "done";
	if (entry.cancelled) return "unknown";
	if (entry.scheduledAt === null || Date.parse(entry.scheduledAt) <= Date.now()) return "sent";
	await writeFile(file, JSON.stringify(change(entry)));
	return "done";
}

export const cancelCaptured = (id: string, directory = outboxFolder()) =>
	changeHeld(
		id,
		(entry) => entry.cancelled,
		(entry) => ({ ...entry, cancelled: true }),
		directory,
	);

export const moveCaptured = (id: string, at: string, directory = outboxFolder()) =>
	changeHeld(
		id,
		(entry) => !entry.cancelled && entry.scheduledAt !== null && Date.parse(entry.scheduledAt) === Date.parse(at),
		(entry) => ({ ...entry, scheduledAt: at }),
		directory,
	);
