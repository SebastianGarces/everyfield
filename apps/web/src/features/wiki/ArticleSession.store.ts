import { createDebouncer, observeIntersection, observeSize } from "@everyfield/ui/foundations";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ExportResult, WriteResult } from "./actions.ts";
import { fractionText, pdfFilename } from "./model.ts";

type ReadingKey = { requestKey: string; articleId: string; plantId?: string };

export type SessionPort = {
	recordView: (key: ReadingKey) => Promise<WriteResult>;
	saveProgress: (key: ReadingKey, fraction: string) => Promise<WriteResult>;
	saveBookmark: (key: ReadingKey & { expectedRevision: string }, desired: boolean) => Promise<WriteResult>;
	downloadPdf: (articleId: string, source: string | null) => Promise<ExportResult>;
	printCopy: (articleId: string, source: string | null) => Promise<ExportResult>;
};

export type SessionSeed = {
	articleId: string;
	slug: string;
	source: string | null;
	readingRevision: string;
	plantId?: string;
	bookmarked: boolean;
	observedFraction: string;
	completed: boolean;
	updated: boolean;
};

export type SessionState = {
	marked: boolean;
	percent: string;
	done: boolean;
	updated: boolean;
	note: string;
	actions: {
		track: (column: HTMLElement) => () => void;
		toggleBookmark: () => Promise<void>;
		pdf: () => Promise<void>;
		print: () => Promise<void>;
	};
};

export type SessionStore = StoreApi<SessionState>;

const SCROLL_SETTLE_MS = 500;

const COMPLETION_LINE = 0.8;

const progressStep = (fraction: number) =>
	[0.25, 0.5, 0.75, 1].filter((step) => fraction >= step).length + (fraction > COMPLETION_LINE ? 1 : 0);

function saveFile(filename: string, bytes: string) {
	const binary = atob(bytes);
	const data = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
	const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

function openPrint(html: string): boolean {
	const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
	const popup = window.open(url);
	if (!popup) return false;
	popup.addEventListener("load", () => popup.print());
	return true;
}

export function createArticleSessionStore(seed: SessionSeed, port: SessionPort): SessionStore {
	const reading = { articleId: seed.articleId, ...(seed.plantId ? { plantId: seed.plantId } : {}) };
	const settle = createDebouncer(SCROLL_SETTLE_MS);
	let revision = seed.readingRevision;
	let chain: Promise<unknown> = Promise.resolve();
	let seen = Number(seed.observedFraction) || 0;
	let sent = seen;
	let viewed = false;
	let bookmarkKey = crypto.randomUUID();
	let printFallback: string | null = null;

	return createStore<SessionState>()((set, get) => {
		const enqueue = (task: (rev: string) => Promise<WriteResult>): Promise<WriteResult> => {
			const next = chain.then(async (): Promise<WriteResult> => {
				const result = await task(revision).catch((): WriteResult => ({ status: "lost" }));
				if (result.status === "ok") {
					revision = result.revision;
					set({
						marked: result.bookmarked,
						percent: fractionText(Math.max(Number(result.observedFraction) || 0, seen)),
						done: result.completed,
						note: "",
						...(result.updated ? { updated: true } : {}),
					});
				} else if (result.status === "conflict") set({ note: "Reload the page, then try again." });
				else if (result.status === "denied") set({ note: "You cannot change this article." });
				else set({ note: "That did not save. Try again." });
				return result;
			});
			chain = next;
			return next;
		};

		const save = () => {
			if (seen <= sent) return;
			sent = seen;
			const fraction = fractionText(seen);
			void enqueue(() => port.saveProgress({ requestKey: crypto.randomUUID(), ...reading }, fraction));
		};

		const sendOnLeave = () => {
			if (seen <= sent) return;
			sent = seen;
			void fetch("/api/wiki/progress", {
				method: "POST",
				keepalive: true,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requestKey: crypto.randomUUID(), fraction: fractionText(seen), ...reading }),
			}).catch(() => undefined);
		};

		return {
			marked: seed.bookmarked,
			percent: seed.observedFraction,
			done: seed.completed,
			updated: seed.updated,
			note: "",
			actions: {
				track(column) {
					if (!viewed) {
						viewed = true;
						void enqueue(() => port.recordView({ requestKey: crypto.randomUUID(), ...reading }));
					}
					const article = column.querySelector<HTMLElement>("#wiki-article");
					if (!article) return () => undefined;
					const scrolls = getComputedStyle(column).overflowY !== "visible";
					const measure = () => {
						const total = article.scrollHeight;
						if (total <= 0) return;
						const rect = article.getBoundingClientRect();
						const edge = scrolls ? column.getBoundingClientRect().bottom : window.innerHeight;
						const visible = Math.min(total, Math.max(0, edge - rect.top));
						const next = Math.min(1, visible / total);
						const reached = next >= 0.995 ? 1 : next;
						if (reached <= seen) return;
						seen = reached;
						set({ percent: fractionText(reached) });
						if (progressStep(reached) > progressStep(sent)) save();
					};
					const settled = () => settle.run(measure);
					const stopFirstSight = observeIntersection<HTMLElement>(
						(_entry, stop) => {
							stop();
							measure();
						},
						{ root: scrolls ? column : null },
					)(article);
					const scroller: HTMLElement | Window = scrolls ? column : window;
					scroller.addEventListener("scroll", settled, { passive: true });
					const stopSizing = observeSize(settled, { viewport: true })(column);
					window.addEventListener("pagehide", sendOnLeave);
					return () => {
						scroller.removeEventListener("scroll", settled);
						stopFirstSight?.();
						stopSizing?.();
						window.removeEventListener("pagehide", sendOnLeave);
						settle.cancel();
						save();
					};
				},
				async toggleBookmark() {
					const desired = !get().marked;
					set({ marked: desired });
					const result = await enqueue((rev) =>
						port.saveBookmark({ requestKey: bookmarkKey, expectedRevision: rev, articleId: seed.articleId }, desired),
					);
					if (result.status !== "ok") set({ marked: !desired });
					else bookmarkKey = crypto.randomUUID();
				},
				async pdf() {
					printFallback = null;
					const result = await port
						.downloadPdf(seed.articleId, seed.source)
						.catch((): ExportResult => ({ status: "lost" }));
					if (result.status === "pdf") {
						try {
							saveFile(pdfFilename(seed.slug), result.bytes);
						} catch {
							set({ note: "The PDF could not be made. Try again." });
						}
						return;
					}
					if (result.status === "print" && result.fallback) {
						printFallback = result.html;
						set({ note: "The PDF font failed. You can print the article instead." });
						return;
					}
					set({
						note:
							result.status === "denied"
								? "You cannot download this article."
								: "The PDF could not be made. Try again.",
					});
				},
				async print() {
					const result: ExportResult = printFallback
						? { status: "print", html: printFallback, fallback: true }
						: await port.printCopy(seed.articleId, seed.source).catch((): ExportResult => ({ status: "lost" }));
					if (result.status === "print") {
						if (!openPrint(result.html)) set({ note: "Allow pop-up windows to print this article." });
						return;
					}
					set({
						note:
							result.status === "denied" ? "You cannot print this article." : "Print could not be prepared. Try again.",
					});
				},
			},
		};
	});
}
