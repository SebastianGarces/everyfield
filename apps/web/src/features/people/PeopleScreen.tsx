"use client";

import {
	Cancel01Icon,
	FileExportIcon,
	FileImportIcon,
	FilterHorizontalIcon,
	GridViewIcon,
	KanbanIcon,
	LeftToRightListBulletIcon,
	UserAdd01Icon,
	UserMultiple02Icon,
	UserMultipleIcon,
} from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import { listPhotoRoute } from "@everyfield/contracts/people";
import {
	Button,
	buttonVariants,
	Card,
	EmptyState,
	FilterChip,
	IconButton,
	IntentLink,
	PageHeader,
	SearchInput,
	SegmentedControl,
	StatePanel,
} from "@everyfield/ui/controls";
import { Avatar, DataTable, Pagination, PersonCard, StageChip, StatusBadge, type Column } from "@everyfield/ui/display";
import { createDebouncer, Icon } from "@everyfield/ui/foundations";
import { usePathname, useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition, type ComponentProps } from "react";
import type { z } from "zod";
import { currentAddress, useAddress, writeAddress } from "../../components/location.ts";
import { useLocalStore, useStore } from "../../components/store.ts";
import { loadPeopleView } from "./actions.ts";
import { AddPersonDialog } from "./AddPersonDialog.tsx";
import { ExportDialog } from "./import-export/ExportDialog.tsx";
import {
	CLASSIFICATION_LABEL,
	CLASSIFICATIONS,
	isFiltered,
	pageCount,
	parseQuery,
	querySearch,
	rangeText,
	SOURCE_LABEL,
	SOURCES,
	STAGE_KEY,
	STAGE_LABEL,
	STAGES,
	withFilters,
	type PeopleQuery,
	type ViewValue,
} from "./model.ts";
import { CardLink, PersonLink, When } from "./parts.tsx";
import { createPeopleViewsStore, shownOf, viewsOf } from "./PeopleScreen.store.ts";
import { PipelineBoard } from "./PipelineBoard.tsx";
import type { PeopleData, PeopleView } from "./server.ts";

type PlantPerson = z.infer<typeof people.plantPerson>;
type ListRow = PlantPerson & { photo?: string };

const COMMITMENT_LABEL = { active: "Committed", withdrawn: "Withdrawn", unknown: "Not recorded" } as const;
const RETIRED_LABEL = { include: "Active and retired", only: "Retired only" } as const;

export function PeopleScreen({ loaded, canWrite }: { loaded: PeopleView; canWrite: boolean }) {
	const router = useRouter();
	const pathname = usePathname();
	const [navigating, startTransition] = useTransition();
	const [adding, setAdding] = useState(false);
	const [exporting, setExporting] = useState(false);
	const store = useLocalStore(() => createPeopleViewsStore(loaded));
	const views = viewsOf(
		useStore(store, (s) => s),
		loaded,
	);
	const view = views.view;
	const [chosen, setChosen] = useOptimistic(view);
	const current = shownOf(views);
	const shown = current ?? loaded;
	const query: PeopleQuery = current ? { ...current.query, view } : loaded.query;

	const go = (next: PeopleQuery, replace = false) =>
		startTransition(() => (replace ? router.replace : router.push)(pathname + querySearch(next), { scroll: false }));
	const address = (q: PeopleQuery) => writeAddress(pathname + querySearch(q), { replace: true });
	const switchView = (next: ViewValue) => {
		const { want, arrived } = store.getState().actions;
		const have = want(loaded, next);
		const target = { ...(have?.query ?? query), view: next };
		address(target);
		if (have) return;
		const base = loaded;
		const from = currentAddress();
		startTransition(async () => {
			setChosen(next);
			const got = await loadPeopleView(querySearch(target)).catch(() => null);
			if (got) return arrived(base, next, got);
			if (currentAddress() === from && store.getState().wanted === next) go(target, true);
		});
	};

	return (
		<>
			<PageHeader
				size="xl"
				title="People"
				subtitle="Everyone you have met, from first visit to leader."
				actions={
					<>
						{loaded.review ? (
							<IntentLink href="/people/duplicates" className={buttonVariants({ variant: "ghost" })}>
								<Icon icon={UserMultiple02Icon} size={18} />
								{loaded.review}
							</IntentLink>
						) : null}
						{shown.workspaceEmpty ? null : (
							<Button variant="secondary" icon={FileExportIcon} onClick={() => setExporting(true)}>
								Export CSV
							</Button>
						)}
						{canWrite ? (
							<>
								<IntentLink href="/people/import" className={buttonVariants({ variant: "secondary" })}>
									<Icon icon={FileImportIcon} size={18} />
									Import CSV
								</IntentLink>
								<Button variant="primary" icon={UserAdd01Icon} onClick={() => setAdding(true)}>
									Add person
								</Button>
							</>
						) : null}
					</>
				}
			/>
			{shown.workspaceEmpty ? (
				<Card>
					<EmptyState
						icon={UserMultipleIcon}
						title="No people yet"
						headingLevel="h2"
						action={
							canWrite ? (
								<>
									<IntentLink href="/people/import" className={buttonVariants({ variant: "primary" })}>
										<Icon icon={FileImportIcon} size={18} />
										Import a spreadsheet
									</IntentLink>
									<Button variant="secondary" icon={UserAdd01Icon} onClick={() => setAdding(true)}>
										Add a person
									</Button>
								</>
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
					<Toolbar query={query} view={chosen} go={go} switchView={switchView} />
					<div aria-busy={navigating || undefined} className="transition-opacity duration-150 aria-busy:opacity-60">
						<Results query={query} data={shown.data} go={go} canWrite={canWrite} />
					</div>
				</Card>
			)}
			{canWrite ? <AddPersonDialog open={adding} onOpenChange={setAdding} /> : null}
			<ExportDialog query={query} open={exporting} onOpenChange={setExporting} />
		</>
	);
}

function SearchBox({ go }: { go: (q: PeopleQuery, replace?: boolean) => void }) {
	const search = parseQuery(useAddress().params).search;
	const [value, setValue] = useState(search);
	const [seen, setSeen] = useState(search);
	const [{ run: afterPause, cancelOnDetach }] = useState(() => createDebouncer(300));
	if (search !== seen) {
		setSeen(search);
		setValue(search);
	}
	return (
		<div className="w-[320px] max-app-sm:w-full">
			<SearchInput
				ref={cancelOnDetach}
				aria-label="Search people"
				placeholder="Search name, email or phone"
				value={value}
				maxLength={255}
				onChange={(e) => {
					const next = e.target.value;
					setValue(next);
					afterPause(() => {
						const now = parseQuery(new URLSearchParams(window.location.search));
						const term = next.trim();
						if (now.search !== search || term === now.search) return;
						const target = withFilters(now, { search: term });
						setSeen(term);
						writeAddress(window.location.pathname + querySearch(target), { replace: true });
						go(target, true);
					});
				}}
				data-people-search=""
			/>
		</div>
	);
}

function Toolbar({
	query,
	view,
	go,
	switchView,
}: {
	query: PeopleQuery;
	view: ViewValue;
	go: (q: PeopleQuery, replace?: boolean) => void;
	switchView: (view: ViewValue) => void;
}) {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<SearchBox go={go} />
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
				value={view}
				onValueChange={switchView}
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
	const photos = new Map(page.photos.map((p) => [p.personId, listPhotoRoute(p.photo)]));
	const rows: ListRow[] = page.items.map((p) => ({ ...p, photo: photos.get(p.id) }));
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
			{query.view === "card" ? (
				rows.length ? (
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3.5" aria-label="People">
						{rows.map((p) => (
							<li key={p.id}>
								<PersonCard
									name={p.displayName}
									photo={p.photo}
									href={`/people/${p.id}`}
									linkAs={RowCardLink}
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
					state={{ status: "ready", data: rows }}
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
			<Pager query={query} shown={page.items.length} total={page.total ?? 0} go={go} />
		</div>
	);
}

function Pager({
	query,
	shown,
	total,
	go,
}: {
	query: PeopleQuery;
	shown: number;
	total: number;
	go: (q: PeopleQuery) => void;
}) {
	return (
		<div className="sticky bottom-0 z-[2] -mx-7 -mb-[26px] flex flex-wrap items-center justify-between gap-3 rounded-b-card border-t border-line bg-surface px-7 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] max-app-sm:-mx-5 max-app-sm:-mb-5 max-app-sm:px-5">
			<span className="text-text-3" role="status">
				{rangeText(query, shown, total)}
			</span>
			<Pagination page={query.page} pageCount={pageCount(total)} onPageChange={(n) => go({ ...query, page: n })} />
		</div>
	);
}

function RowCardLink({ className, ...props }: ComponentProps<typeof CardLink>) {
	return <CardLink {...props} className={`${className ?? ""} scroll-mb-24`} />;
}

function PersonBadges({ person }: { person: PlantPerson }) {
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

const COLUMNS: Column<ListRow>[] = [
	{
		key: "person",
		header: "Person",
		cell: (p) => (
			<div className="flex items-center gap-3">
				<Avatar name={p.displayName} src={p.photo} size="sm" decorative />
				<div className="min-w-0">
					<PersonLink href={`/people/${p.id}`} className="scroll-mb-24 font-semibold text-ink hover:underline">
						{p.displayName}
					</PersonLink>
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

function TagChip({ label, onRemove }: { label: string; onRemove: () => void }) {
	return (
		<span className="inline-flex h-10 flex-none items-center gap-2 rounded-md bg-amber-100 pr-1.5 pl-3.5 font-medium whitespace-nowrap text-amber-600 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ef-amber-500)_35%,transparent)]">
			{label}
			<span className="font-normal">Selected</span>
			<IconButton icon={Cancel01Icon} label={`Remove ${label.toLowerCase()} filter`} size="sm" onClick={onRemove} />
		</span>
	);
}
