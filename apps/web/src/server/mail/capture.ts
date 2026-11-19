import "server-only";

import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Captured = {
	id: string;
	at: string;
	from: string;
	to: string;
	subject: string;
	html: string;
	text: string;
	headers?: Readonly<Record<string, string>>;
	scheduledAt: string | null;
	cancelled: boolean;
};

export const outboxFolder = (): string =>
	process.env.EVERYFIELD_DEV_OUTBOX?.trim() || join(tmpdir(), "everyfield-dev-outbox");

export const isCaptureId = (id: string): boolean => id.startsWith("capture-");

export async function capture(
	message: Omit<Captured, "id" | "at" | "scheduledAt" | "cancelled">,
	scheduledAt: string | null,
	key: string,
	directory = outboxFolder(),
): Promise<{ id: string; fresh: boolean }> {
	const id = `capture-${keyedId(key)}`;
	await mkdir(directory, { recursive: true });
	const entry: Captured = { id, at: new Date().toISOString(), ...message, scheduledAt, cancelled: false };
	try {
		await writeFile(join(directory, `${id}.json`), JSON.stringify(entry), { flag: "wx" });
		return { id, fresh: true };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return { id, fresh: false };
		throw error;
	}
}

function keyedId(key: string): string {
	const h = createHash("sha256").update(key).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function captured(id: string): Promise<boolean> {
	if (!/^capture-[0-9a-f-]{36}$/.test(id)) return false;
	return access(join(outboxFolder(), `${id}.json`)).then(
		() => true,
		() => false,
	);
}

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
