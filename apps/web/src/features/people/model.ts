// Pure rules of the People screens: URL state, stage vocabulary and the one-save-per-person store. No React, no
// server code and no runtime imports, so the rules run the same in the browser, on the server and in node tests.

export const STAGES = [
	"prospect",
	"attendee",
	"following_up",
	"interviewed",
	"core_group",
	"launch_team",
	"leader",
] as const;
export type StageValue = (typeof STAGES)[number];
export const COLUMNS = ["prospect", "attendee", "following_up", "interviewed", "core_group"] as const;
export type ColumnValue = (typeof COLUMNS)[number];
export const SOURCES = [
	"personal_referral",
	"social_media",
	"vision_meeting",
	"website",
	"event",
	"partner_church",
	"meeting_guest_list",
	"other",
] as const;
export type SourceValue = (typeof SOURCES)[number];
export const CLASSIFICATIONS = ["adult", "child", "unknown"] as const;
export type ClassificationValue = (typeof CLASSIFICATIONS)[number];
export const COMMITMENTS = ["any", "active", "withdrawn", "unknown"] as const;
export type CommitmentValue = (typeof COMMITMENTS)[number];
export const ARCHIVED = ["exclude", "include", "only"] as const;
export type ArchivedValue = (typeof ARCHIVED)[number];
export const VIEWS = ["list", "card", "pipeline"] as const;
export type ViewValue = (typeof VIEWS)[number];

/** The shared StageChip keys (packages/ui display Badges) for each contract stage. */
export const STAGE_KEY = {
	prospect: "prospect",
	attendee: "attendee",
	following_up: "following",
	interviewed: "interviewed",
	core_group: "core",
	launch_team: "launch",
	leader: "leader",
} as const satisfies Record<StageValue, string>;

export const STAGE_LABEL: Record<StageValue, string> = {
	prospect: "Prospect",
	attendee: "Attendee",
	following_up: "Following up",
	interviewed: "Interviewed",
	core_group: "Core group",
	launch_team: "Launch team",
	leader: "Leader",
};
export const SOURCE_LABEL: Record<SourceValue, string> = {
	personal_referral: "Personal referral",
	social_media: "Social media",
	vision_meeting: "Vision meeting",
	website: "Website",
	event: "Event",
	partner_church: "Partner church",
	meeting_guest_list: "Meeting guest list",
	other: "Other",
};
export const CLASSIFICATION_LABEL: Record<ClassificationValue, string> = {
	adult: "Adult",
	child: "Child",
	unknown: "Not recorded",
};

/** Stages a move passes over: moving prospect to interviewed skips attendee and following up. */
export function skippedStages(from: StageValue, to: StageValue): StageValue[] {
	const a = STAGES.indexOf(from),
		b = STAGES.indexOf(to);
	return b > a + 1 ? STAGES.slice(a + 1, b) : [];
}
const COMMITTED: readonly StageValue[] = ["core_group", "launch_team", "leader"];
/** Leaving core group, launch team or leader for an earlier stage asks what happens to the person's open duties. */
export function leavesCommitted(from: StageValue, to: StageValue): boolean {
	return COMMITTED.includes(from) && !COMMITTED.includes(to);
}

// ---------------------------------------------------------------------------------------------------------------
// URL state (REQ-PPL-001, D67): view, search, filters and the page number live in the address, so a list is a link.
// Any filter, search or view change goes back to page one and keeps the other filters.

export type PeopleQuery = {
	view: ViewValue;
	search: string;
	stages: StageValue[];
	sources: SourceValue[];
	/** Tag IDs. A person matches only when they carry every selected tag (REQ-PPL-001, ruling D47). */
	tags: string[];
	classification: ClassificationValue | null;
	commitment: CommitmentValue;
	archived: ArchivedValue;
	page: number;
};
export const PAGE_SIZE = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The contract's highest page number; a larger number in the address reads as the last page. */
const MAX_PAGE = 100_000;

type Params = { getAll(name: string): string[]; get(name: string): string | null };
const pick = <T extends string>(all: readonly T[], value: string | null, fallback: T): T =>
	value !== null && (all as readonly string[]).includes(value) ? (value as T) : fallback;
const picks = <T extends string>(all: readonly T[], values: string[]): T[] =>
	all.filter((v) => values.flatMap((x) => x.split(",")).includes(v));

/** Reads the address into a query. Values outside the closed lists are ignored, never guessed. */
export function parseQuery(params: Params): PeopleQuery {
	const page = Number(params.get("page") ?? "1");
	const classification = params.get("adult");
	return {
		view: pick(VIEWS, params.get("view"), "list"),
		search: (params.get("q") ?? "").trim().slice(0, 255),
		stages: picks(STAGES, params.getAll("stage")),
		sources: picks(SOURCES, params.getAll("source")),
		tags: [
			...new Set(
				params
					.getAll("tag")
					.flatMap((t) => t.split(","))
					.map((t) => t.trim().toLowerCase())
					.filter((t) => UUID.test(t)),
			),
		].slice(0, 100),
		classification:
			classification && (CLASSIFICATIONS as readonly string[]).includes(classification)
				? (classification as ClassificationValue)
				: null,
		commitment: pick(COMMITMENTS, params.get("commitment"), "any"),
		archived: pick(ARCHIVED, params.get("retired"), "exclude"),
		page: Number.isInteger(page) && page > 1 ? Math.min(page, MAX_PAGE) : 1,
	};
}

/** The address for a query. Defaults are left out, so the plain list is just /people. */
export function querySearch(q: PeopleQuery): string {
	const out = new URLSearchParams();
	if (q.view !== "list") out.set("view", q.view);
	if (q.search) out.set("q", q.search);
	if (q.stages.length) out.set("stage", q.stages.join(","));
	if (q.sources.length) out.set("source", q.sources.join(","));
	for (const t of q.tags) out.append("tag", t);
	if (q.classification) out.set("adult", q.classification);
	if (q.commitment !== "any") out.set("commitment", q.commitment);
	if (q.archived !== "exclude") out.set("retired", q.archived);
	if (q.view !== "pipeline" && q.page > 1) out.set("page", String(q.page));
	const s = out.toString();
	return s ? `?${s}` : "";
}

/** The listPeopleRequest for a query. The page load and every "Show more" build it here, the same way. */
export function listRequest(q: PeopleQuery): Record<string, unknown> {
	return {
		limit: PAGE_SIZE,
		...(q.search ? { search: q.search } : {}),
		// List and cards show the same rows, so they send the same request and share page numbers.
		view: q.view === "pipeline" ? "pipeline" : "list",
		stages: q.stages,
		sources: q.sources,
		tags: q.tags,
		tagOperator: "all",
		...(q.classification ? { adultClassification: q.classification } : {}),
		commitment: q.commitment,
		archived: q.view === "pipeline" ? "exclude" : q.archived,
		page: q.view === "pipeline" ? 1 : q.page,
	};
}

/** A filter, search or view change: back to the first page, other filters kept. */
export function withFilters(q: PeopleQuery, patch: Partial<Omit<PeopleQuery, "page">>): PeopleQuery {
	return { ...q, ...patch, page: 1 };
}
/** The number of pages for a total; an empty list still has page one. */
export function pageCount(total: number): number {
	return Math.max(1, Math.ceil(total / PAGE_SIZE));
}
export function isFiltered(q: PeopleQuery): boolean {
	return (
		q.search !== "" ||
		q.stages.length > 0 ||
		q.sources.length > 0 ||
		q.tags.length > 0 ||
		q.classification !== null ||
		q.commitment !== "any" ||
		q.archived !== "exclude"
	);
}
/** "Showing 25–48 of 214 people". */
export function rangeText(q: PeopleQuery, shown: number, total: number | null): string {
	const first = (q.page - 1) * PAGE_SIZE + 1;
	if (shown === 0) return "No people on this page";
	const range = shown === 1 ? `${first}` : `${first}–${first + shown - 1}`;
	return total === null ? `Showing ${range}` : `Showing ${range} of ${total} ${total === 1 ? "person" : "people"}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Request keys (idempotency). A key belongs to one exact payload. A retry after a lost answer reuses it, so the server
// replays the first result instead of acting twice; any change to the payload gets a new key, because the server
// refuses a known key with a different payload.

export type KeyedPayload = { key: string; body: string };
export function keyFor(prior: KeyedPayload | null, payload: unknown, fresh: () => string): KeyedPayload {
	const body = stableJson(payload);
	return prior && prior.body === body ? prior : { key: fresh(), body };
}
function stableJson(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
	if (v !== null && typeof v === "object")
		return `{${Object.keys(v)
			.sort()
			.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	return JSON.stringify(v);
}

/** Revisions are decimal strings of PostgreSQL bigints; compare them as numbers, never as text. */
export function newerRevision(a: string, b: string): boolean {
	return BigInt(a) > BigInt(b);
}

// ---------------------------------------------------------------------------------------------------------------
// The person store (R3). It owns the saved person, the drafts and the one mutation in flight. Every person action goes
// through it, so two actions cannot race on one revision and a draft never disappears unless its save succeeded.

export type Outcome<T> =
	| { status: "ok"; value: T }
	| { status: "refused"; code: string }
	/** The answer was lost (network, server restart). The same request may be sent again with the same key. */
	| { status: "lost" };

export type Saved = { revision: string };
export type PersonState<P extends Saved, D> = {
	saved: P;
	/** Drafts by slot ("profile", "note", "note:<id>", "stage", ...). A slot with no entry has nothing unsaved. */
	drafts: Readonly<Record<string, D>>;
	/** The slot whose save is running, or null. At most one at a time. */
	pending: string | null;
	/** The key and payload of each slot's last attempt, for a retry after a lost answer. */
	keys: Readonly<Record<string, KeyedPayload>>;
	/** The last refusal or lost answer per slot, for the message under that form. */
	errors: Readonly<Record<string, "refused" | "lost" | string>>;
};
export type PersonEvent<P extends Saved, D> =
	| { type: "edit"; slot: string; draft: D }
	| { type: "discard"; slot: string }
	| { type: "begin"; slot: string; key: KeyedPayload }
	| { type: "settle"; slot: string; outcome: Outcome<P | null>; keepDraft?: boolean }
	| { type: "server"; person: P };

export function initialPerson<P extends Saved, D>(person: P): PersonState<P, D> {
	return { saved: person, drafts: {}, pending: null, keys: {}, errors: {} };
}
const without = <T>(r: Readonly<Record<string, T>>, k: string): Record<string, T> => {
	const { [k]: _, ...rest } = r;
	void _;
	return rest;
};

export function personReducer<P extends Saved, D>(s: PersonState<P, D>, e: PersonEvent<P, D>): PersonState<P, D> {
	switch (e.type) {
		case "edit":
			// A form being saved is read-only; an edit that still arrives for it is ignored, so the sent draft stays the draft.
			if (s.pending === e.slot) return s;
			return { ...s, drafts: { ...s.drafts, [e.slot]: e.draft }, errors: without(s.errors, e.slot) };
		case "discard":
			if (s.pending === e.slot) return s;
			return {
				...s,
				drafts: without(s.drafts, e.slot),
				keys: without(s.keys, e.slot),
				errors: without(s.errors, e.slot),
			};
		case "begin":
			if (s.pending !== null) return s;
			return { ...s, pending: e.slot, keys: { ...s.keys, [e.slot]: e.key }, errors: without(s.errors, e.slot) };
		case "settle": {
			if (s.pending !== e.slot) return s;
			const o = e.outcome;
			if (o.status === "ok") {
				return {
					...s,
					saved: o.value && !newerRevision(s.saved.revision, o.value.revision) ? o.value : s.saved,
					pending: null,
					drafts: e.keepDraft ? s.drafts : without(s.drafts, e.slot),
					keys: without(s.keys, e.slot),
					errors: without(s.errors, e.slot),
				};
			}
			// A refusal is final for that key; a lost answer keeps the key so the retry replays instead of acting twice.
			return {
				...s,
				pending: null,
				keys: o.status === "lost" ? s.keys : without(s.keys, e.slot),
				errors: { ...s.errors, [e.slot]: o.status === "lost" ? "lost" : o.code },
			};
		}
		case "server":
			// Server props after a refresh. An older revision never replaces a newer one already saved here.
			return newerRevision(s.saved.revision, e.person.revision) ? s : { ...s, saved: e.person };
	}
}

/** The fields of `draft` that differ from `base`: an edit sends only what the person changed. */
export function changedFields<T extends Record<string, unknown>>(base: T, draft: T): Partial<T> {
	const out: Partial<T> = {};
	for (const k of Object.keys(draft) as (keyof T)[]) if (draft[k] !== base[k]) out[k] = draft[k];
	return out;
}

/**
 * The person store as an external store for useSyncExternalStore. `begin` decides synchronously, so a double click or
 * two dialogs cannot start two saves before React renders.
 */
export class PersonStore<P extends Saved, D> {
	#state: PersonState<P, D>;
	#listeners = new Set<() => void>();
	constructor(person: P) {
		this.#state = initialPerson<P, D>(person);
	}
	get = (): PersonState<P, D> => this.#state;
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};
	dispatch = (event: PersonEvent<P, D>): void => {
		const next = personReducer(this.#state, event);
		if (next === this.#state) return;
		this.#state = next;
		for (const l of this.#listeners) l();
	};
	/** Starts a save for `slot` and gives its request key, or null when another save is running. */
	begin(slot: string, payload: unknown, fresh: () => string): KeyedPayload | null {
		if (this.#state.pending !== null) return null;
		const key = keyFor(this.#state.keys[slot] ?? null, payload, fresh);
		this.dispatch({ type: "begin", slot, key });
		return key;
	}
}

/**
 * One save through the store: start it, call the server with the request key, settle it. `toPerson` takes the saved
 * person from the answer, when the answer carries one. Gives the outcome, or null when another save was running.
 */
export async function runSave<P extends Saved, D, T>(
	store: PersonStore<P, D>,
	slot: string,
	payload: unknown,
	call: (requestKey: string) => Promise<Outcome<T>>,
	options: { fresh: () => string; toPerson?: (value: T) => P | null; keepDraft?: boolean },
): Promise<Outcome<T> | null> {
	const key = store.begin(slot, payload, options.fresh);
	if (!key) return null;
	let result: Outcome<T>;
	try {
		result = await call(key.key);
	} catch {
		result = { status: "lost" };
	}
	store.dispatch({
		type: "settle",
		slot,
		keepDraft: options.keepDraft,
		outcome: result.status === "ok" ? { status: "ok", value: options.toPerson?.(result.value) ?? null } : result,
	});
	return result;
}

/** A column order with one person moved one place up or down. The same order when that move leaves the column. */
export function moveInOrder(ids: readonly string[], id: string, direction: "up" | "down"): string[] {
	const from = ids.indexOf(id),
		to = direction === "up" ? from - 1 : from + 1;
	if (from < 0 || to < 0 || to >= ids.length) return [...ids];
	const next = [...ids];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}
