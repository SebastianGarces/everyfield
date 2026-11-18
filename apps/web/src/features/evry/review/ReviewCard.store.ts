import { createStore, type StoreApi } from "zustand/vanilla";
import { createRead, type Read } from "../../../components/read.tsx";
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

export type Shown = Review | null | "lost";

export type ReviewState = {
	shown: Read<[string], Shown>;
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

export type Current = Omit<ReviewState, "shown"> & { review: Review | null; load: Load };

export const reviewOf = (value: Shown | undefined) => (value && value !== "lost" ? value : null);

export const loadOf = (value: Shown | undefined): Load =>
	value === undefined ? "loading" : value === "lost" ? "lost" : value === null ? "unavailable" : "ready";

export const lapsedOf = (state: Pick<Current, "review" | "ranOut">) =>
	!!state.review && (approvalLeft(state.review) <= 0 || state.ranOut === state.review);

export const phaseNow = (state: Pick<Current, "review" | "ranOut" | "load">) =>
	state.load === "ready" && state.review ? phaseOf(state.review, lapsedOf(state)) : null;

export function uploadOf(review: Review | null): string | null {
	if (!review || !isPhoto(review.operation)) return null;
	const after = review.review.changes.find((c) => c.field === "photo")?.after;
	return typeof after === "string" ? after : null;
}

export function photoWanted(state: Current): string | null {
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
	const shown = createRead(
		(proposal: string) =>
			port
				.readReview(proposal)
				.then((reply): Shown => (reply.status === "ok" ? reply.value : reply.status === "refused" ? null : "lost")),
		{ failed: (): Shown => "lost", fresh: Infinity, keep: () => true },
	);
	if (init.seed !== undefined) shown.seed(init.seed, id);

	return createStore<ReviewState>()((set, get, store) => {
		const value = () => shown.peek(id)?.value;
		const view = (): Current => ({ ...get(), review: reviewOf(value()), load: loadOf(value()) });
		const write = (next: Review | null) => shown.patch(() => next, id);

		const note = (review: Review | null, ranOut: Review | null = get().ranOut) => {
			if (!review || !seatsAccount(review.operation)) return;
			const phase = phaseOf(review, lapsedOf({ review, ranOut }));
			if (phase === "pending" || phase === "running") awaiting = true;
			else if (phase === "completed" && awaiting && readers > 0) {
				awaiting = false;
				port.refresh();
			}
		};

		const read = async () => {
			const g = generation;
			const reply = await port.readReview(id);
			if (g !== generation) return null;
			if (reply.status === "ok") write(reply.value);
			else if (reply.status === "refused") {
				write(null);
				set((s) => ({ outcome: { ...s.outcome, notice: null } }));
			}
			return reply;
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
			const state = view();
			const watched = readers > 0;

			const review = state.review;
			const counting = phaseNow(state) === "pending" || phaseNow(state) === "unconfirmed";
			const timed =
				watched && counting && review && state.ranOut !== review && approvalLeft(review) > 0 ? review : null;
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
			const before = view().review;
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
			if (refused) {
				write(null);
				return set({ busy: null, outcome });
			}
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
			if (current) write(current);
			set({ busy: null, outcome: { ...outcome, notice } });
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
			write(reread.status === "refused" ? null : reread.value);
			if (reread.status === "refused")
				return set((s) => ({ busy: null, outcome: { ...s.outcome, notice: null, unknown: null } }));
			set((s) => ({
				busy: null,
				outcome: {
					...s.outcome,
					unknown: null,
					notice: u.done(reread.value, u.before)
						? u.settled(reread.value)
						: { text: NOT_DONE[unknown.action], tone: "error" },
				},
			}));
		};

		note(init.seed ?? null, null);

		return {
			shown,
			busy: null,
			outcome: NONE,
			ranOut: null,
			photo: null,
			actions: {
				follow: (listener) => {
					const off = store.subscribe(listener);
					readers++;
					if (readers === 1) {
						const stops = [
							store.subscribe(sync),
							shown.connect(() => {
								note(view().review);
								sync();
							}, id),
						];
						unwatch = () => stops.forEach((stop) => stop());
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
				reload: () => void shown.retry(id),
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
