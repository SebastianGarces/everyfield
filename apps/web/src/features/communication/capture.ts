import "server-only";

import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mail capture (criterion 35, WP-029). The senders record a message here when mailRecipientAllowed refuses its
// address, or when a development or preview server has no provider key. A record delivers to nobody. A production
// deployment approves every address, so it records nothing. A scheduled capture waits in the folder like a held email:
// it can be cancelled or moved until its time passes, and after that it counts as sent.

type Env = Readonly<Record<string, string | undefined>>;

export type Captured = {
	id: string;
	at: string;
	from: string;
	to: string;
	subject: string;
	html: string;
	text: string;
	/** The headers the provider request would carry: the List-Unsubscribe pair of an optional email. */
	headers?: Readonly<Record<string, string>>;
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

/**
 * May this server run on capture with no provider key, and may it show the outbox? True only for a Vercel environment
 * that is absent (local), "development" or "preview", with or without a key, so an unknown value fails closed. This is
 * not the recipient rule: `mailRecipientAllowed` alone decides which address the provider may receive.
 */
export function captureAllowed(env: Env): boolean {
	return env.VERCEL_ENV === undefined || env.VERCEL_ENV === "development" || env.VERCEL_ENV === "preview";
}

/** A capture id, as `record` makes it. Any other id belongs to the provider. */
export const isCaptureId = (id: string): boolean => id.startsWith("capture-");

export async function captureSilent(): Promise<boolean> {
	return access(join(outboxFolder(), NO_ANSWER_FILE)).then(
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

/**
 * Cancel one held capture (`movedTo` null) or move it to `movedTo`. A repeat of a change already made answers done. A
 * capture whose time has passed went out; a missing or cancelled one has no answer.
 */
export async function changeCaptured(id: string, movedTo: string | null): Promise<"done" | "sent" | "unknown"> {
	if (!/^capture-[0-9a-f-]{36}$/.test(id)) return "unknown";
	const file = join(outboxFolder(), `${id}.json`);
	const entry = await readFile(file, "utf8").then(
		(text) => JSON.parse(text) as Captured,
		() => null,
	);
	if (!entry) return "unknown";
	const held = entry.scheduledAt === null ? null : Date.parse(entry.scheduledAt);
	if (movedTo === null ? entry.cancelled : !entry.cancelled && held === Date.parse(movedTo)) return "done";
	if (entry.cancelled) return "unknown";
	if (held === null || held <= Date.now()) return "sent";
	const next = movedTo === null ? { ...entry, cancelled: true } : { ...entry, scheduledAt: movedTo };
	await writeFile(file, JSON.stringify(next));
	return "done";
}
