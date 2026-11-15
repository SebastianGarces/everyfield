import { recordId } from "@everyfield/contracts/common";
import type { Outcome } from "../../components/save/model.ts";

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
const COLUMNS = ["prospect", "attendee", "following_up", "interviewed", "core_group"] as const;
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
const COMMITMENTS = ["any", "active", "withdrawn", "unknown"] as const;
type CommitmentValue = (typeof COMMITMENTS)[number];
const ARCHIVED = ["exclude", "include", "only"] as const;
type ArchivedValue = (typeof ARCHIVED)[number];
const VIEWS = ["list", "card", "pipeline"] as const;
export type ViewValue = (typeof VIEWS)[number];

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

export function skippedStages(from: StageValue, to: StageValue): StageValue[] {
	const a = STAGES.indexOf(from),
		b = STAGES.indexOf(to);
	return b > a + 1 ? STAGES.slice(a + 1, b) : [];
}
const COMMITTED: readonly StageValue[] = ["core_group", "launch_team", "leader"];
export function leavesCommitted(from: StageValue, to: StageValue): boolean {
	return COMMITTED.includes(from) && !COMMITTED.includes(to);
}

export type PeopleQuery = {
	view: ViewValue;
	search: string;
	stages: StageValue[];
	sources: SourceValue[];
	tags: string[];
	classification: ClassificationValue | null;
	commitment: CommitmentValue;
	archived: ArchivedValue;
	page: number;
};
const PAGE_SIZE = 24;
const MAX_PAGE = 100_000;

type Params = { getAll(name: string): string[]; get(name: string): string | null };
const pick = <T extends string>(all: readonly T[], value: string | null, fallback: T): T =>
	value !== null && (all as readonly string[]).includes(value) ? (value as T) : fallback;
const picks = <T extends string>(all: readonly T[], values: string[]): T[] =>
	all.filter((v) => values.flatMap((x) => x.split(",")).includes(v));

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
					.filter((t) => recordId.safeParse(t).success),
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

export function listRequest(q: PeopleQuery): Record<string, unknown> {
	return {
		limit: PAGE_SIZE,
		...(q.search ? { search: q.search } : {}),
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

export function withFilters(q: PeopleQuery, patch: Partial<Omit<PeopleQuery, "page">>): PeopleQuery {
	return { ...q, ...patch, page: 1 };
}
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
export function pairsToReview(pairs: { items: readonly unknown[]; completeness: "complete" | "partial" } | null) {
	if (!pairs?.items.length) return null;
	return `${pairs.items.length}${pairs.completeness === "partial" ? "+" : ""} to review in Duplicates`;
}
export function rangeText(q: PeopleQuery, shown: number, total: number | null): string {
	const first = (q.page - 1) * PAGE_SIZE + 1;
	if (shown === 0) return "No people on this page";
	const range = shown === 1 ? `${first}` : `${first}–${first + shown - 1}`;
	return total === null ? `Showing ${range}` : `Showing ${range} of ${total} ${total === 1 ? "person" : "people"}`;
}

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

export function newerRevision(a: string, b: string): boolean {
	return BigInt(a) > BigInt(b);
}

export function changedFields<T extends Record<string, unknown>>(base: T, draft: T): Partial<T> {
	const out: Partial<T> = {};
	for (const k of Object.keys(draft) as (keyof T)[]) if (draft[k] !== base[k]) out[k] = draft[k];
	return out;
}

export function withEntry<E extends { id: string }, A extends { items: E[]; next: number | null }>(
	activities: Outcome<A>,
	entry: E,
): Outcome<A> {
	if (activities.status !== "ok") return activities;
	const list = activities.value;
	if (list.items.some((e) => e.id === entry.id))
		return { status: "ok", value: { ...list, items: list.items.map((e) => (e.id === entry.id ? entry : e)) } };
	return { status: "ok", value: { ...list, items: [entry, ...list.items] } };
}

export function moveInOrder(ids: readonly string[], id: string, direction: "up" | "down"): string[] {
	const from = ids.indexOf(id),
		to = direction === "up" ? from - 1 : from + 1;
	if (from < 0 || to < 0 || to >= ids.length) return [...ids];
	const next = [...ids];
	[next[from], next[to]] = [next[to]!, next[from]!];
	return next;
}

export function columnOf(stage: StageValue): ColumnValue {
	return stage === "launch_team" || stage === "leader" ? "core_group" : stage;
}

export type ColumnAnswer<R extends string = string> = {
	revision: string;
	personIds: string[];
	personRevisions: Record<string, R>;
};

export function columnCards<C extends { person: { id: string; stage: StageValue; revision: R } }, R extends string>(
	column: ColumnValue,
	loaded: readonly C[],
	moved: ReadonlyMap<string, C>,
	answer: ColumnAnswer<R> | undefined,
	order?: readonly string[],
): C[] {
	const here = loaded.map((c) => moved.get(c.person.id) ?? c).filter((c) => columnOf(c.person.stage) === column);
	const arrived = [...moved.values()].filter(
		(c) => columnOf(c.person.stage) === column && !loaded.some((l) => l.person.id === c.person.id),
	);
	const cards = [...here, ...arrived].map((c) => {
		const saved = answer?.personRevisions[c.person.id];
		return saved && newerRevision(saved, c.person.revision) ? { ...c, person: { ...c.person, revision: saved } } : c;
	});
	const ids = order ?? answer?.personIds;
	if (!ids) return cards;
	const rank = (c: C) => {
		const i = ids.indexOf(c.person.id);
		return i < 0 ? ids.length : i;
	};
	return cards
		.map((c, i) => ({ c, i }))
		.sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
		.map(({ c }) => c);
}
