import "server-only";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { StorageError } from "./storage-error.ts";

const PARSE_MS = 3000;
const STARTUP_MS = 30_000;

type Parser = { worker: Worker; ready: Promise<boolean>; answer?: (valid: boolean) => void };
const parsers = new Map<string, Parser>();
let queue: Promise<unknown> = Promise.resolve();

function parser(entry?: string): Parser {
	const known = parsers.get(entry ?? "");
	if (known) return known;
	const worker = new Worker(new URL("./parse-pdf.worker.mjs", import.meta.url), {
		execArgv: [],
		workerData: { entry },
		resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
	});
	const current: Parser = { worker, ready: Promise.resolve(false) };
	current.ready = new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), STARTUP_MS);
		worker.once("message", (value) => {
			clearTimeout(timer);
			resolve(value === "ready");
		});
		worker.once("exit", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
	worker.on("message", (value) => {
		if (typeof value === "boolean") current.answer?.(value);
	});
	worker.once("exit", () => {
		if (parsers.get(entry ?? "") === current) parsers.delete(entry ?? "");
	});
	worker.once("error", () => void worker.terminate());
	worker.unref();
	parsers.set(entry ?? "", current);
	return current;
}
function stop(p: Parser, entry?: string) {
	if (parsers.get(entry ?? "") === p) parsers.delete(entry ?? "");
	void p.worker.terminate();
}

export function warmCommitmentParser() {
	parser();
}

async function parseOnce(bytes: Uint8Array, entry: string | undefined, parseMs: number) {
	const p = parser(entry);
	if (!(await p.ready)) {
		stop(p, entry);
		return "crashed" as const;
	}
	return new Promise<boolean | "crashed">((resolve) => {
		const settle = (value: boolean | "crashed") => {
			clearTimeout(timer);
			p.answer = undefined;
			p.worker.off("exit", exited);
			resolve(value);
		};
		const exited = () => settle("crashed");
		const timer = setTimeout(() => {
			settle(false);
			stop(p, entry);
		}, parseMs);
		p.answer = settle;
		p.worker.once("exit", exited);
		p.worker.postMessage(Uint8Array.from(bytes));
	});
}

async function parsePdf(bytes: Uint8Array, entry: string | undefined, parseMs: number) {
	const run = async () => {
		const first = await parseOnce(bytes, entry, parseMs);
		if (first !== "crashed") return first;
		return (await parseOnce(bytes, entry, parseMs)) === true;
	};
	const result = queue.then(run, run);
	queue = result.catch(() => undefined);
	return result;
}

export async function validateCommitment(
	bytes: Uint8Array,
	mediaType: string,
	pdf: { entry?: string; parseMs?: number } = {},
): Promise<void> {
	if (!bytes.length || bytes.length > 10 * 1024 * 1024) throw new StorageError("invalid_file");
	if (mediaType === "image/jpeg" || mediaType === "image/png") {
		try {
			const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning", animated: false });
			const metadata = await image.metadata();
			if (metadata.format !== (mediaType === "image/jpeg" ? "jpeg" : "png")) throw new StorageError("invalid_file");
			await image.raw().timeout({ seconds: 3 }).toBuffer();
		} catch {
			throw new StorageError("invalid_file");
		}
		return;
	}
	if (mediaType !== "application/pdf" || Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-")
		throw new StorageError("invalid_file");
	if (!(await parsePdf(bytes, pdf.entry, pdf.parseMs ?? PARSE_MS))) throw new StorageError("invalid_file");
}

export async function validateAvatar(bytes: Uint8Array, mediaType: string): Promise<void> {
	if (!bytes.length || bytes.length > 3 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(mediaType))
		throw new StorageError("invalid_avatar");
	try {
		const image = sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning", animated: false });
		const metadata = await image.metadata();
		if (
			metadata.format !== (mediaType === "image/jpeg" ? "jpeg" : mediaType === "image/png" ? "png" : "webp") ||
			(metadata.pages ?? 1) !== 1
		)
			throw new StorageError("invalid_avatar");
		await image.raw().timeout({ seconds: 3 }).toBuffer();
	} catch {
		throw new StorageError("invalid_avatar");
	}
}
