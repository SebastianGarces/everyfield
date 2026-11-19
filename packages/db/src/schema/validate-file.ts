import "server-only";
import { Worker } from "node:worker_threads";
import sharp from "sharp";
import { StorageError } from "./storage-error.ts";

const PARSE_MS = 3000;
const STARTUP_MS = 30_000;

type Parser = { worker: Worker; ready: Promise<boolean>; answer?: (valid: boolean) => void };

export function commitmentValidator(entry?: string, parseMs = PARSE_MS) {
	let current: Parser | null = null;
	let queue: Promise<unknown> = Promise.resolve();

	function parser(): Parser {
		if (current) return current;
		const worker = new Worker(new URL("./parse-pdf.worker.mjs", import.meta.url), {
			execArgv: [],
			workerData: { entry },
			resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
		});
		const started: Parser = { worker, ready: Promise.resolve(false) };
		started.ready = new Promise<boolean>((resolve) => {
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
			if (typeof value === "boolean") started.answer?.(value);
		});
		worker.once("exit", () => {
			if (current === started) current = null;
		});
		worker.once("error", () => void worker.terminate());
		worker.unref();
		current = started;
		return started;
	}
	function stop(p: Parser) {
		if (current === p) current = null;
		void p.worker.terminate();
	}

	async function parseOnce(bytes: Uint8Array) {
		const p = parser();
		if (!(await p.ready)) {
			stop(p);
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
				stop(p);
			}, parseMs);
			p.answer = settle;
			p.worker.once("exit", exited);
			p.worker.postMessage(Uint8Array.from(bytes));
		});
	}

	async function parsePdf(bytes: Uint8Array) {
		const run = async () => {
			const first = await parseOnce(bytes);
			if (first !== "crashed") return first;
			return (await parseOnce(bytes)) === true;
		};
		const result = queue.then(run, run);
		queue = result.catch(() => undefined);
		return result;
	}

	return {
		warm() {
			parser();
		},
		async validate(bytes: Uint8Array, mediaType: string): Promise<void> {
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
			if (!(await parsePdf(bytes))) throw new StorageError("invalid_file");
		},
	};
}

const commitments = commitmentValidator();
export const validateCommitment = commitments.validate;
export const warmCommitmentParser = commitments.warm;

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
