import { createStore, type StoreApi } from "zustand/vanilla";
import type { Reply } from "../conversation/api.ts";
import type * as api from "./api.ts";
import {
	actionNotice,
	approvalLeft,
	checkable,
	isMail,
	isPhoto,
	phaseOf,
	pollDelay,
	reviseInput,
	seatsAccount,
	type Review,
} from "./model.ts";

export type Action = "approve" | "revise" | "cancel" | "retry" | "recheck";
export type Busy = Action | "check" | null;
export type Notice = { text: string; tone: "error" | "neutral" };
export type Load = "loading" | "ready" | "lost" | "unavailable";
export type Outcome = {
	notice: Notice | null;
	refused: { code: string; revision: number } | null;
	unknown: { action: Action; revision: number } | null;
};
export type Staged = { upload: string; status: "ready"; src: string } | { upload: string; status: "gone" | "lost" };

export type ReviewPort = Pick<
	typeof api,
	"readReview" | "readStagedPhoto" | "approve" | "revise" | "cancel" | "retry" | "check"
> & { refresh: () => void };

export type ReviewState = {
	review: Review | null;
	load: Load;
	busy: Busy;
	outcome: Outcome;
	ranOut: Review | null;
	photo: Staged | null;
	actions: {
		follow: (listener: () => void) => () => void;
		reload: () => void;
		approve: (reason?: string) => Promise<void>;
		cancel: () => Promise<void>;
		revise: (edits?: Record<string, string>) => Promise<void>;
		retry: () => Promise<void>;
		recheck: () => Promise<void>;
		check: () => Promise<void>;
		clearNotice: () => void;
		retryPhoto: () => void;
	};
};

export type ReviewStore = StoreApi<ReviewState>;

const NONE: Outcome = { notice: null, refused: null, unknown: null };

export const NOT_DONE: Record<Action, string> = {
	approve: "This change was not approved. Nothing was changed.",
	revise: "Your update was not saved. Update the review again.",
	cancel: "This change was not cancelled. It is still waiting for your review.",
	retry: "Evry did not try this again. Try again.",
	recheck: "Evry could not ask the email service again. Check again.",
};

export const lapsedOf = (state: Pick<ReviewState, "review" | "ranOut">) =>
	!!state.review && (approvalLeft(state.review) <= 0 || state.ranOut === state.review);

export const phaseNow = (state: Pick<ReviewState, "review" | "ranOut" | "load">) =>
	state.load === "ready" && state.review ? phaseOf(state.review, lapsedOf(state)) : null;

export function uploadOf(review: Review | null): string | null {
	if (!review || !isPhoto(review.operation)) return null;
	const after = review.review.changes.find((c) => c.field === "photo")?.after;
	return typeof after === "string" ? after : null;
}

export function photoWanted(state: Pick<ReviewState, "review" | "ranOut" | "load" | "photo">): string | null {
	const upload = uploadOf(state.review);
	if (upload === null || phaseNow(state) !== "pending") return null;
	return state.photo?.upload === upload ? null : upload;
}

const asDataUrl = (blob: Blob) =>
	new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result));
		reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
		reader.readAsDataURL(blob);
	});

export function createReviewStore(init: {
	id: string;
	seed: Review | null | undefined;
	port: ReviewPort;
}): ReviewStore {
	const { id, port } = init;
	let generation = 0;
	let readers = 0;
	let unwatch = () => {};
	let reading = false;
	let photoRead: { upload: string; run: number } | null = null;
	let photoRun = 0;
	let poll: number | null = null;
	let polls = 0;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let expiry: { review: Review; timer: ReturnType<typeof setTimeout> } | null = null;
	let typed: string | undefined;
	let open: {
		before: Review;
		done: (now: Review, before: Review) => boolean;
		settled: (now: Review) => Notice | null;
	} | null = null;
	let awaiting = false;

	return createStore<ReviewState>()((set, get, store) => {
		const note = (review: Review | null, ranOut: Review | null = get().ranOut) => {
			if (!review || !seatsAccount(review.operation)) return;
			const phase = phaseOf(review, lapsedOf({ review, ranOut }));
			if (phase === "pending" || phase === "running") awaiting = true;
			else if (phase === "completed" && awaiting && readers > 0) {
				awaiting = false;
				port.refresh();
			}
		};

		const show = (next: Review) => {
			set({ review: next, load: "ready" });
			note(next);
		};

		const gone = () => set((s) => ({ load: "unavailable", outcome: { ...s.outcome, notice: null } }));

		const read = async () => {
			const g = generation;
			const reply = await port.readReview(id);
			if (g !== generation) return null;
			if (reply.status === "ok") show(reply.value);
			else if (reply.status === "refused") gone();
			return reply;
		};

		const load = () => {
			if (reading) return;
			reading = true;
			void read().then((reply) => {
				reading = false;
				if (reply?.status === "lost") set({ load: "lost" });
			});
		};

		const stopPoll = () => {
			poll = null;
			clearTimeout(pollTimer);
		};

		const startPoll = () => {
			const run = (poll = ++polls);
			let attempt = 0;
			const readAgainLater = () => {
				pollTimer = setTimeout(async () => {
					const reply = await read();
					if (poll === run && reply?.status !== "refused") readAgainLater();
				}, pollDelay(attempt++));
			};
			readAgainLater();
		};

		const lapseLater = (review: Review) =>
			setTimeout(() => set({ ranOut: review }), Math.min(approvalLeft(review) + 50, 2 ** 31 - 1));

		const readPhoto = (upload: string) => {
			const run = ++photoRun;
			photoRead = { upload, run };
			void port
				.readStagedPhoto(id)
				.then(async (reply): Promise<Staged> => {
					if (reply.status !== "ok") return { upload, status: reply.status === "refused" ? "gone" : "lost" };
					return { upload, status: "ready", src: await asDataUrl(reply.value) };
				})
				.catch((): Staged => ({ upload, status: "lost" }))
				.then((photo) => {
					if (photoRead?.run !== run) return;
					photoRead = null;
					set({ photo });
				});
		};

		const sync = () => {
			const state = get();
			const watched = readers > 0;
			if (watched && state.load === "loading") load();

			const review = state.review;
			const timed = watched && review && state.ranOut !== review && approvalLeft(review) > 0 ? review : null;
			if (expiry?.review !== timed) {
				if (expiry) clearTimeout(expiry.timer);
				expiry = timed ? { review: timed, timer: lapseLater(timed) } : null;
			}

			const running = watched && state.busy === null && phaseNow(state) === "running";
			if (running && poll === null) startPoll();
			else if (!running && poll !== null) stopPoll();

			const wanted = photoWanted(state);
			if (photoRead && photoRead.upload !== wanted && (watched || wanted !== null)) photoRead = null;
			if (watched && wanted !== null && !photoRead) readPhoto(wanted);
		};

		async function act<T>(
			action: Action,
			send: (review: Review) => Promise<Reply<T>>,
			result: (value: T) => Review,
			done: (now: Review, before: Review) => boolean,
			settled: (now: Review) => Notice | null = () => null,
		) {
			const before = get().review;
			if (get().busy !== null || !before) return;
			const g = ++generation;
			set((s) => ({ busy: action, outcome: { ...s.outcome, notice: null } }));
			const reply = await send(before);
			let current: Review | null = reply.status === "ok" ? result(reply.value) : null;
			let refused = false;
			if (reply.status !== "ok") {
				const reread = await port.readReview(before.id);
				if (reread.status === "ok") current = reread.value;
				refused = reread.status === "refused";
			}
			if (g !== generation) return set({ busy: null });
			const lost = reply.status === "lost" && !current && !refused;
			open = lost ? { before, done, settled } : null;
			const outcome: Outcome = {
				notice: null,
				refused: reply.status === "refused" ? { code: reply.error.code, revision: before.revision } : null,
				unknown: lost ? { action, revision: before.revision } : null,
			};
			if (lost) return set({ busy: null, outcome });
			if (refused) return set({ busy: null, outcome, load: "unavailable" });
			const code = reply.status === "refused" ? reply.error.code : null;
			const notice: Notice | null =
				current && (reply.status === "ok" || done(current, before))
					? settled(current)
					: current && (code === "review_expired" || code === "review_closed" || code === "photo_unavailable")
						? null
						: {
								text: actionNotice(reply.status === "refused" ? reply.error : "lost", isMail(before.operation)),
								tone: "error",
							};
			set({ busy: null, outcome: { ...outcome, notice }, ...(current && { review: current, load: "ready" }) });
			if (current) note(current);
		}

		const approve = (reason = typed) => {
			typed = reason;
			return act(
				"approve",
				(r) => port.approve(r, reason),
				(v) => v.proposal,
				(now, before) => now.revision === before.revision && now.status === "approved",
			);
		};

		const check = async () => {
			const u = open;
			const unknown = get().outcome.unknown;
			if (!u || !unknown || get().busy !== null) return;
			if (unknown.action === "approve") return approve();
			const g = ++generation;
			set((s) => ({ busy: "check", outcome: { ...s.outcome, notice: null } }));
			const reread = await port.readReview(u.before.id);
			if (g !== generation) return set({ busy: null });
			if (reread.status === "lost")
				return set((s) => ({
					busy: null,
					outcome: {
						...s.outcome,
						notice: { text: "Still no answer. Check your connection, then check again.", tone: "neutral" },
					},
				}));
			open = null;
			if (reread.status === "refused")
				return set((s) => ({
					busy: null,
					load: "unavailable",
					outcome: { ...s.outcome, notice: null, unknown: null },
				}));
			set((s) => ({
				busy: null,
				review: reread.value,
				load: "ready",
				outcome: {
					...s.outcome,
					unknown: null,
					notice: u.done(reread.value, u.before)
						? u.settled(reread.value)
						: { text: NOT_DONE[unknown.action], tone: "error" },
				},
			}));
			note(reread.value);
		};

		note(init.seed ?? null, null);

		return {
			review: init.seed ?? null,
			load: init.seed === undefined ? "loading" : init.seed ? "ready" : "unavailable",
			busy: null,
			outcome: NONE,
			ranOut: null,
			photo: null,
			actions: {
				follow: (listener) => {
					const off = store.subscribe(listener);
					readers++;
					if (readers === 1) {
						unwatch = store.subscribe(sync);
						sync();
					}
					return () => {
						off();
						readers--;
						if (readers > 0) return;
						unwatch();
						sync();
					};
				},
				reload: () => {
					set({ load: "loading" });
					load();
				},
				approve,
				cancel: () =>
					act(
						"cancel",
						(r) => port.cancel(r.id),
						(v) => v.proposal,
						(now) => now.status === "cancelled" || now.outcome !== null || now.executing,
						(now) =>
							now.outcome === "completed"
								? { text: "This change was already saved, so it can't be cancelled.", tone: "neutral" }
								: now.status !== "cancelled" && now.executing
									? { text: "This change is already running. The card shows its result.", tone: "neutral" }
									: null,
					),
				revise: (edits) =>
					act(
						"revise",
						(r) => port.revise(r.id, r.operation, r.revision, reviseInput(r, edits)),
						(v) => v,
						(now, before) => now.revision > before.revision,
					),
				retry: () =>
					act(
						"retry",
						(r) => port.retry(r.id),
						(v) => v.proposal,
						(now) => now.outcome === null || now.outcome === "completed",
					),
				recheck: () =>
					act(
						"recheck",
						(r) => port.check(r.id),
						(v) => v.proposal,
						(now) => now.outcome === "completed",
						(now) =>
							checkable(now)
								? { text: "The email service still has not confirmed this. Check again later.", tone: "neutral" }
								: null,
					),
				check,
				clearNotice: () => set((s) => ({ outcome: { ...s.outcome, notice: null } })),
				retryPhoto: () => set({ photo: null }),
			},
		};
	});
}
