"use client";

import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	Cancel01Icon,
	FilterHorizontalIcon,
	GridViewIcon,
	KanbanIcon,
	LeftToRightListBulletIcon,
	UserAdd01Icon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	Card,
	EmptyState,
	FilterChip,
	IconButton,
	PageHeader,
	SearchInput,
	SegmentedControl,
	StatePanel,
} from "@everyfield/ui/controls";
import { Avatar, DataTable, PersonCard, StageChip, StatusBadge, type Column } from "@everyfield/ui/display";
import { Icon } from "@everyfield/ui/foundations";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { z } from "zod";
import { AddPersonDialog } from "./AddPersonDialog.tsx";
import {
	CLASSIFICATION_LABEL,
	CLASSIFICATIONS,
	isFiltered,
	nextPage,
	previousPage,
	querySearch,
	rangeText,
	SOURCE_LABEL,
	SOURCES,
	STAGE_KEY,
	STAGE_LABEL,
	STAGES,
	withFilters,
	type PeopleQuery,
} from "./model.ts";
import { When } from "./parts.tsx";
import { PipelineBoard } from "./PipelineBoard.tsx";

type PlantPerson = z.infer<typeof people.plantPerson>;
export type PeopleData =
	| { kind: "list"; page: z.infer<typeof people.peoplePage>; expired: boolean }
	| { kind: "pipeline"; pipeline: z.infer<typeof people.pipelineResult> }
	| { kind: "failed" };

const COMMITMENT_LABEL = { active: "Committed", withdrawn: "Withdrawn", unknown: "Not recorded" } as const;
const RETIRED_LABEL = { include: "Active and retired", only: "Retired only" } as const;

/**
 * People list, cards and pipeline (REQ-PPL-001, REQ-PPL-007). Search, filters, view and page live in the address; any
 * change goes back to the first page and keeps the other filters. Members read; Owners and Admins also add and move.
 */
export function PeopleScreen({
	query,
	data,
	canWrite,
	workspaceEmpty,
}: {
	query: PeopleQuery;
	data: PeopleData;
	canWrite: boolean;
	/** True when this church has no people at all (not just none matching a filter). */
	workspaceEmpty: boolean;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const [navigating, startTransition] = useTransition();
	const [adding, setAdding] = useState(false);
	const go = (next: PeopleQuery, replace = false) =>
		startTransition(() => (replace ? router.replace : router.push)(pathname + querySearch(next), { scroll: false }));

	return (
		<>
			<PageHeader
				size="xl"
				title="People"
				subtitle="Everyone you have met, from first visit to leader."
				actions={
					canWrite ? (
						<Button variant="primary" icon={UserAdd01Icon} onClick={() => setAdding(true)}>
							Add person
						</Button>
					) : null
				}
			/>
			{workspaceEmpty ? (
				<Card>
					<EmptyState
						icon={UserMultipleIcon}
						title="No people yet"
						headingLevel="h2"
						action={
							canWrite ? (
								<Button variant="primary" icon={UserAdd01Icon} onClick={() => setAdding(true)}>
									Add a person
								</Button>
							) : null
						}
					>
						{canWrite
							? "Start with the people you already know: friends, family and anyone who asked about the new church. Everyone starts as a prospect."
							: "When an Owner or Admin adds people, they appear here."}
					</EmptyState>
				</Card>
			) : (
				<Card className="gap-6">
					<Toolbar query={query} go={go} />
					<div aria-busy={navigating || undefined} className="transition-opacity duration-150 aria-busy:opacity-60">
						<Results query={query} data={data} go={go} canWrite={canWrite} />
					</div>
				</Card>
			)}
			{canWrite ? <AddPersonDialog open={adding} onOpenChange={setAdding} /> : null}
		</>
	);
}

function SearchBox({ query, go }: { query: PeopleQuery; go: (q: PeopleQuery, replace?: boolean) => void }) {
	const [value, setValue] = useState(query.search);
	const latest = useRef(query);
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => {
		latest.current = query;
	});
	useEffect(() => () => clearTimeout(timer.current), []);
	// Typing waits for a pause before it changes the address, so each keystroke is not a page load.
	return (
		<div className="w-[320px] max-app-sm:w-full">
			<SearchInput
				aria-label="Search people"
				placeholder="Search name, email or phone"
				value={value}
				maxLength={255}
				onChange={(e) => {
					const next = e.target.value;
					setValue(next);
					clearTimeout(timer.current);
					timer.current = setTimeout(() => {
						if (next.trim() !== latest.current.search) go(withFilters(latest.current, { search: next.trim() }), true);
					}, 300);
				}}
				data-people-search=""
			/>
		</div>
	);
}

function Toolbar({ query, go }: { query: PeopleQuery; go: (q: PeopleQuery, replace?: boolean) => void }) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<SearchBox key={query.search} query={query} go={go} />
			<FilterChip
				label="Stage"
				icon={FilterHorizontalIcon}
				searchLabel="Search stages"
				options={STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
				value={query.stages}
				onValueChange={(v) => go(withFilters(query, { stages: STAGES.filter((s) => v.includes(s)) }))}
			/>
			<FilterChip
				label="Source"
				searchLabel="Search sources"
				options={SOURCES.map((s) => ({ value: s, label: SOURCE_LABEL[s] }))}
				value={query.sources}
				onValueChange={(v) => go(withFilters(query, { sources: SOURCES.filter((s) => v.includes(s)) }))}
			/>
			<FilterChip
				label="Adult or child"
				searchLabel="Search classifications"
				multiple={false}
				options={CLASSIFICATIONS.map((c) => ({ value: c, label: CLASSIFICATION_LABEL[c] }))}
				value={query.classification ? [query.classification] : []}
				onValueChange={(v) =>
					go(withFilters(query, { classification: CLASSIFICATIONS.find((c) => c === v.at(-1)) ?? null }))
				}
			/>
			<FilterChip
				label="Commitment"
				searchLabel="Search commitment states"
				multiple={false}
				options={(["active", "withdrawn", "unknown"] as const).map((c) => ({ value: c, label: COMMITMENT_LABEL[c] }))}
				value={query.commitment === "any" ? [] : [query.commitment]}
				onValueChange={(v) => {
					const c = (["active", "withdrawn", "unknown"] as const).find((x) => x === v.at(-1));
					go(withFilters(query, { commitment: c ?? "any" }));
				}}
			/>
			{query.view !== "pipeline" ? (
				<FilterChip
					label="Retired"
					searchLabel="Search retired options"
					anyText="Hidden"
					multiple={false}
					options={(["include", "only"] as const).map((c) => ({ value: c, label: RETIRED_LABEL[c] }))}
					value={query.archived === "exclude" ? [] : [query.archived]}
					onValueChange={(v) => {
						const a = (["include", "only"] as const).find((x) => x === v.at(-1));
						go(withFilters(query, { archived: a ?? "exclude" }));
					}}
				/>
			) : null}
			{query.tags.map((tag, i) => (
				<TagChip
					key={tag}
					label={query.tags.length === 1 ? "Tag" : `Tag ${i + 1}`}
					onRemove={() => go(withFilters(query, { tags: query.tags.filter((t) => t !== tag) }))}
				/>
			))}
			<span className="grow" />
			<SegmentedControl
				label="View"
				value={query.view}
				onValueChange={(view) => go(withFilters(query, { view }))}
				options={[
					{ value: "list", label: "List", icon: LeftToRightListBulletIcon },
					{ value: "card", label: "Cards", icon: GridViewIcon },
					{ value: "pipeline", label: "Pipeline", icon: KanbanIcon },
				]}
			/>
		</div>
	);
}

function Results({
	query,
	data,
	go,
	canWrite,
}: {
	query: PeopleQuery;
	data: PeopleData;
	go: (q: PeopleQuery) => void;
	canWrite: boolean;
}) {
	if (data.kind === "failed")
		return (
			<StatePanel
				tone="error"
				title="We could not load your people"
				actions={
					<Button variant="primary" onClick={() => go(query)}>
						Try again
					</Button>
				}
			>
				This is a loading problem, not an empty list. Your people are safe. Try again in a moment.
			</StatePanel>
		);
	if (data.kind === "pipeline") return <PipelineBoard query={query} pipeline={data.pipeline} canWrite={canWrite} />;
	const page = data.page;
	const clear = (
		<Button
			variant="secondary"
			onClick={() =>
				go(
					withFilters(query, {
						search: "",
						stages: [],
						sources: [],
						classification: null,
						commitment: "any",
						archived: "exclude",
						tags: [],
					}),
				)
			}
		>
			Clear filters
		</Button>
	);
	return (
		<div className="flex flex-col gap-4">
			{data.expired ? (
				<p role="status" className="rounded-md bg-blue-50 px-4 py-3 text-sm text-ink-2">
					That page link has expired, so this is the first page.
				</p>
			) : null}
			{query.view === "card" ? (
				page.items.length ? (
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5" aria-label="People">
						{page.items.map((p) => (
							<li key={p.id}>
								<PersonCard
									name={p.displayName}
									href={`/people/${p.id}`}
									linkAs={Link}
									meta={p.email ?? p.phone ?? undefined}
									footer={<PersonBadges person={p} />}
								/>
							</li>
						))}
					</ul>
				) : (
					<EmptyState icon={UserMultipleIcon} title="No one matches" action={isFiltered(query) ? clear : null}>
						Try a different search or remove a filter.
					</EmptyState>
				)
			) : (
				<DataTable
					caption="People"
					columns={COLUMNS}
					state={{ status: "ready", data: page.items }}
					rowId={(p) => p.id}
					rowLabel={(p) => p.displayName}
					empty={{
						icon: UserMultipleIcon,
						title: "No one matches",
						text: "Try a different search or remove a filter.",
						action: isFiltered(query) ? clear : undefined,
					}}
				/>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<span className="text-text-3" role="status">
					{rangeText(query, page.items.length, page.total)}
				</span>
				{query.trail.length || page.next ? (
					<nav aria-label="Pages" className="flex gap-2">
						<Button
							variant="secondary"
							size="sm"
							icon={ArrowLeft01Icon}
							disabled={!query.trail.length}
							onClick={() => go(previousPage(query))}
						>
							Previous
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={!page.next}
							onClick={() => page.next && go(nextPage(query, page.next))}
						>
							Next
							<Icon icon={ArrowRight01Icon} size={16} />
						</Button>
					</nav>
				) : null}
			</div>
		</div>
	);
}

/** Retired, committed and launch-team or leader badges: the facts a list row says in words. */
export function PersonBadges({ person }: { person: PlantPerson }) {
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			<StageChip stage={STAGE_KEY[person.stage]}>{STAGE_LABEL[person.stage]}</StageChip>
			{person.lifecycle.state !== "live" ? (
				<StatusBadge status="unknown" size="sm">
					{person.lifecycle.state === "merged" ? "Merged" : "Retired"}
				</StatusBadge>
			) : null}
		</span>
	);
}

const COLUMNS: Column<PlantPerson>[] = [
	{
		key: "person",
		header: "Person",
		cell: (p) => (
			<div className="flex items-center gap-3">
				<Avatar name={p.displayName} size="sm" decorative />
				<div className="min-w-0">
					<Link href={`/people/${p.id}`} className="font-semibold text-ink hover:underline">
						{p.displayName}
					</Link>
					<div className="truncate text-sm text-text-3">{p.email ?? p.phone ?? "No contact details"}</div>
				</div>
			</div>
		),
	},
	{ key: "stage", header: "Stage", cell: (p) => <PersonBadges person={p} /> },
	{
		key: "commitment",
		header: "Commitment",
		cell: (p) =>
			p.commitment.state === "unknown" ? (
				<span className="text-text-3">Not recorded</span>
			) : (
				<StatusBadge status={p.commitment.state === "active" ? "positive" : "unknown"} size="sm">
					{p.commitment.state === "active" ? "Committed" : "Withdrawn"}
				</StatusBadge>
			),
	},
	{
		key: "adult",
		header: "Adult or child",
		cell: (p) =>
			p.adultClassification === "unknown" ? (
				<span className="text-text-3">Not recorded</span>
			) : (
				CLASSIFICATION_LABEL[p.adultClassification]
			),
	},
	{ key: "source", header: "Source", cell: (p) => SOURCE_LABEL[p.source] },
	{ key: "added", header: "Added", cell: (p) => <When at={p.createdAt} /> },
];

/**
 * An active tag filter from the address (ruling D47). People must carry every selected tag. The tag picker and tag
 * names come with WP-012/ui; until then a chip only shows that a tag filter is on and removes it.
 */
function TagChip({ label, onRemove }: { label: string; onRemove: () => void }) {
	return (
		<span className="inline-flex h-10 flex-none items-center gap-2 rounded-[12px] bg-amber-100 pr-1.5 pl-3.5 font-medium whitespace-nowrap text-amber-600 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ef-amber-500)_35%,transparent)]">
			{label}
			<span className="font-normal">Selected</span>
			<IconButton icon={Cancel01Icon} label={`Remove ${label.toLowerCase()} filter`} size="sm" onClick={onRemove} />
		</span>
	);
}
