import { createStore, type StoreApi } from "zustand/vanilla";
import { createRead, type Read } from "../../components/read.tsx";
import { ASSET_FLOW, EMPTY_FLOW, hasPicks, releaseAll } from "./brand/picks";
import { begin, discard, edit, emptyBook, finish, isDirty, rebase, same, type Book } from "./drafts";
import { OFFLINE_REFERENCE, type Refusal } from "./save";
import type {
	BrandReply,
	BrandView,
	GetSectionRequest,
	Locality,
	OrderRead,
	RegionRead,
	RegionSuggestion,
	Reply,
	SectionKey,
	SectionResult,
	SectionSeed,
	SettingsPort,
} from "./port";

export type SaveOutcome<T> = { ok: true; server: T } | { ok: false; refusal: Refusal; server?: T };

type Lost = { status: "lost" };
export type SectionReply = Reply<SectionResult> | Lost;
export type BrandRead = BrandReply<BrandView> | Lost;

export type SettingsReads = {
	section: Read<[GetSectionRequest], SectionReply>;
	brand: Read<[], BrandRead>;
	wiki: Read<[], OrderRead>;
	region: Read<[], RegionRead>;
	regionMatches: Read<[Locality], RegionSuggestion[] | null>;
};

export type SettingsState = {
	port: SettingsPort;
	reads: SettingsReads;
	book: Book<SectionKey, Refusal>;
	servers: Partial<Record<SectionKey, unknown>>;
	flows: Record<string, unknown>;
	actions: {
		observe: (key: SectionKey, server: unknown) => void;
		edit: (key: SectionKey, value: unknown, server: unknown) => void;
		save: (key: SectionKey, server: unknown, work: (sent: unknown) => Promise<SaveOutcome<unknown>>) => Promise<void>;
		clear: () => void;
		setFlow: (key: string, update: (prev: unknown) => unknown) => void;
		replaceSection: (request: GetSectionRequest, value: SectionResult) => void;
	};
};

export type SettingsStore = StoreApi<SettingsState>;

const LOST: Lost = { status: "lost" };

const OFFLINE_SAVE: Refusal = {
	message: "Everyfield could not be reached, so this may not have saved. Load the latest version to check.",
	reference: OFFLINE_REFERENCE,
	code: "unknown",
};

const ACCOUNT_REVISION_SECTIONS = ["account", "notifications"] as const;

const settled = <T>(thenable: PromiseLike<T>) => new Promise<T>((resolve, reject) => thenable.then(resolve, reject));

export function selectDirtyKeys(state: Pick<SettingsState, "book" | "servers" | "flows">): SectionKey[] {
	const keys = (Object.keys(state.book.edits) as SectionKey[]).filter((key) =>
		isDirty(state.book, key, state.servers[key]),
	);
	return hasPicks(state.flows[ASSET_FLOW]) && !keys.includes("brand") ? [...keys, "brand"] : keys;
}

export function createSettingsStore({ port, seed }: { port: SettingsPort; seed: SectionSeed | null }): SettingsStore {
	const shareAccountRevision = (value: SectionResult) => {
		if (value.section !== "account" && value.section !== "notifications") return;
		for (const other of ACCOUNT_REVISION_SECTIONS)
			if (other !== value.section)
				reads.section.patch(
					(reply) =>
						reply.status === "ok" && reply.value.section === other
							? { ...reply, value: { ...reply.value, revision: value.revision } }
							: reply,
					{ section: other },
				);
	};

	const reads: SettingsReads = {
		section: createRead(
			async (request: GetSectionRequest): Promise<SectionReply> => {
				const reply = await port.getSection(request);
				if (reply.status === "ok") shareAccountRevision(reply.value);
				return reply;
			},
			{ failed: () => LOST, fresh: Infinity },
		),
		brand: createRead((): Promise<BrandRead> => port.brand.get(), { failed: () => LOST, fresh: Infinity }),
		wiki: createRead(() => port.wiki.read(), { failed: (): OrderRead => LOST, fresh: Infinity }),
		region: createRead(() => port.region.read(), { failed: (): RegionRead => LOST }),
		regionMatches: createRead((locality: Locality) => port.region.suggest(locality), {
			failed: () => null,
			keep: (found) => found !== null,
		}),
	};
	if (seed && "request" in seed) reads.section.seed(settled(seed.value), seed.request);
	if (seed && "brand" in seed) reads.brand.seed(settled(seed.brand));

	return createStore<SettingsState>()((set, get) => {
		const observe = (key: SectionKey, server: unknown) => {
			const { book, servers } = get();
			if (key in servers && same(servers[key], server)) return;
			set({
				book: key in servers ? rebase(book, key, servers[key], server) : book,
				servers: { ...servers, [key]: server },
			});
		};
		const remember = (key: SectionKey, server: unknown) => {
			if (!(key in get().servers)) set({ servers: { ...get().servers, [key]: server } });
		};
		return {
			port,
			reads,
			book: emptyBook<SectionKey, Refusal>(),
			servers: {},
			flows: {},
			actions: {
				observe,
				edit: (key, value, server) => {
					remember(key, server);
					set({ book: edit(get().book, key, value, server) });
				},
				save: async (key, server, work) => {
					remember(key, server);
					const started = begin(get().book, key, server);
					if (!started) return;
					set({ book: started.book });
					const outcome = await work(started.sent).catch((): SaveOutcome<unknown> => ({
						ok: false,
						refusal: OFFLINE_SAVE,
					}));
					if (outcome.server !== undefined) observe(key, outcome.server);
					set({ book: finish(get().book, key, outcome, get().servers[key]) });
				},
				clear: () => {
					let book = get().book;
					for (const key of Object.keys(book.edits) as SectionKey[]) book = discard(book, key);
					const flows = get().flows;
					releaseAll(flows[ASSET_FLOW]);
					set({ book, flows: ASSET_FLOW in flows ? { ...flows, [ASSET_FLOW]: EMPTY_FLOW } : flows });
				},
				setFlow: (key, update) => set({ flows: { ...get().flows, [key]: update(get().flows[key]) } }),
				replaceSection: (request, value) => {
					reads.section.patch(() => ({ status: "ok", value }), request);
					shareAccountRevision(value);
				},
			},
		};
	});
}
