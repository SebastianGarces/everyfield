"use client";

import type { PipelineBoard } from "@everyfield/contracts/organizations";
import { Edit02Icon, PlusSignIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { Button, EmptyState, PageHeader, SearchInput } from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import { cn } from "@everyfield/ui/foundations";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { readBoard } from "./actions";
import { boardHref, formatDay, PIPELINE_PATH, plural } from "./model";
import { PersonDialog } from "./PersonDialog";
import { StageEditor } from "./StageEditor";

type Stage = PipelineBoard["stages"][number];
type Card = Stage["people"][number];

/**
 * The organization's Pipeline (REQ-MUL-008): one column per stage in the organization's order. Owners and Admins see
 * everyone and add people and edit stages; responsible staff see their own people; any other seat sees counts only.
 * The filters live in the address (D67). Moving a person happens on their record, with a reason.
 */
export function PipelineScreen({ initial }: { initial: PipelineBoard }) {
	const [board, setBoard] = useState(initial);
	const [seen, setSeen] = useState(initial);
	// A new server read (another address) replaces local changes.
	if (seen !== initial) {
		setSeen(initial);
		setBoard(initial);
	}
	const [adding, setAdding] = useState(false);
	const [editingStages, setEditingStages] = useState(false);
	const router = useRouter();
	const admin = board.audience === "administrator";
	const { query } = board;
	const total = board.stages.reduce((n, s) => n + s.count, 0);
	const retiredView = query.view === "retired";

	async function reread() {
		const answer = await readBoard(query).catch(() => null);
		if (answer?.status === "ok") setBoard(answer.value);
		else router.refresh();
	}

	const added = (person: {
		personId: string;
		revision: string;
		name: string;
		email: string | null;
		responsibleSeatId: string | null;
		stageId: string;
	}) => {
		setAdding(false);
		const responsible = board.staff.find((s) => s.seatId === person.responsibleSeatId);
		const card: Card = {
			personId: person.personId as Card["personId"],
			name: person.name,
			email: person.email,
			revision: person.revision as Card["revision"],
			responsible: responsible ? { seatId: responsible.seatId, name: responsible.name } : null,
			lastMovedOn: board.asOf,
		};
		setBoard((b) => ({
			...b,
			stages: b.stages.map((s) =>
				s.id === person.stageId && !retiredView
					? {
							...s,
							count: s.count + 1,
							matching: s.matching + 1,
							people: [...s.people, card].sort((x, y) => x.name.localeCompare(y.name)),
						}
					: s,
			),
		}));
	};

	return (
		<div className="flex flex-col">
			<PageHeader
				title="Pipeline"
				subtitle={`The people ${board.organizationName} is developing toward planting.`}
				actions={
					admin ? (
						<>
							<Button variant="secondary" icon={Edit02Icon} onClick={() => setEditingStages(true)}>
								Edit stages
							</Button>
							<Button variant="primary" icon={PlusSignIcon} onClick={() => setAdding(true)}>
								Add person
							</Button>
						</>
					) : null
				}
			/>
			{board.audience === "counts" ? (
				<Counts board={board} />
			) : (
				<>
					<Toolbar board={board} />
					{retiredView ? (
						<Retired board={board} />
					) : admin && total === 0 && !query.q && !query.stale ? (
						<>
							<Columns board={board} />
							<EmptyState
								icon={UserMultipleIcon}
								title="No one in your pipeline yet"
								action={
									<Button variant="primary" icon={PlusSignIcon} onClick={() => setAdding(true)}>
										Add person
									</Button>
								}
								className="mt-2"
							>
								Add the people you are deliberately developing toward planting, and move each one through your stages as
								they grow.
							</EmptyState>
						</>
					) : (
						<Columns board={board} />
					)}
					<Pages board={board} />
				</>
			)}
			{admin ? (
				<>
					<PersonDialog
						open={adding}
						onOpenChange={setAdding}
						staff={board.staff}
						stages={board.stages}
						onSaved={added}
					/>
					<StageEditor
						open={editingStages}
						onOpenChange={setEditingStages}
						stages={board.stages}
						onSaved={() => {
							setEditingStages(false);
							void reread();
						}}
					/>
				</>
			) : null}
		</div>
	);
}

/** Search, the six-month filter with its as-of date, and Board or Retired for Owners and Admins. */
function Toolbar({ board }: { board: PipelineBoard }) {
	const { query } = board;
	const router = useRouter();
	const [text, setText] = useState(query.q);
	const retired = query.view === "retired";
	return (
		<div className="mb-5 flex flex-wrap items-center gap-2.5">
			<form
				role="search"
				className="min-w-0 flex-1 basis-[240px]"
				onSubmit={(e) => {
					e.preventDefault();
					router.push(boardHref({ ...query, q: text.trim(), page: 1 }));
				}}
			>
				<SearchInput
					aria-label="Search the pipeline"
					placeholder="Search names, emails and notes"
					value={text}
					onChange={(e) => setText(e.target.value)}
					data-people-search
				/>
			</form>
			{retired ? null : (
				<Link
					href={boardHref({ ...query, stale: !query.stale, page: 1 })}
					aria-pressed={query.stale}
					className={cn(
						"inline-flex h-10 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-[background-color,box-shadow] duration-150",
						query.stale
							? "bg-amber-100 text-amber-600 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ef-amber-500)_35%,transparent)]"
							: "bg-surface-raised text-ink shadow-[inset_0_0_0_1px_var(--ef-line)] hover:shadow-[inset_0_0_0_1px_var(--ef-line-2)]",
					)}
				>
					No stage move in 6 months
					<span className={query.stale ? "text-amber-600" : "text-text-3"}>· as of {formatDay(board.asOf)}</span>
				</Link>
			)}
			{board.audience === "administrator" ? (
				<nav aria-label="Pipeline lists" className="flex items-center gap-1 rounded-md bg-surface-2 p-1">
					{(["board", "retired"] as const).map((view) => (
						<Link
							key={view}
							href={boardHref({ view, stale: false, q: "", page: 1 })}
							aria-current={query.view === view ? "page" : undefined}
							className={cn(
								"cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium",
								query.view === view ? "bg-surface-raised text-ink shadow-raised" : "text-text-2 hover:text-ink",
							)}
						>
							{view === "board" ? "Board" : `Retired (${board.retiredCount})`}
						</Link>
					))}
				</nav>
			) : null}
		</div>
	);
}

function Columns({ board }: { board: PipelineBoard }) {
	const filtered = board.query.q !== "" || board.query.stale;
	return (
		<div className="-mx-1 overflow-x-auto px-1 pb-2 max-app-md:overflow-visible">
			<div
				className="grid grid-cols-[repeat(var(--stages),minmax(220px,1fr))] gap-3.5 max-app-md:grid-cols-1"
				style={{ "--stages": board.stages.length } as CSSProperties}
			>
				{board.stages.map((stage) => (
					<section
						key={stage.id}
						aria-label={stage.label}
						className="flex min-h-[160px] min-w-0 flex-col gap-2.5 rounded-card bg-surface-2 p-2.5 max-app-md:min-h-0"
					>
						<h2 className="flex items-center gap-2 px-1.5 pt-1 pb-1.5 font-body text-sm font-semibold tracking-normal text-ink">
							<span className="min-w-0 truncate">{stage.label}</span>
							<span className="ml-auto font-medium text-text-3">
								{filtered ? `${stage.matching} of ${stage.count}` : stage.count}
								<span className="sr-only"> {stage.count === 1 ? "person" : "people"}</span>
							</span>
						</h2>
						{stage.people.length ? (
							<ul className="flex flex-col gap-2.5">
								{stage.people.map((p) => (
									<li key={p.personId}>
										<PersonCard person={p} />
									</li>
								))}
							</ul>
						) : (
							<p className="rounded-card border-[1.5px] border-dashed border-line-2 px-3 py-5 text-center text-sm text-text-3">
								{filtered ? "No one matches" : stage.count ? "No one you’re responsible for" : "No one at this stage"}
							</p>
						)}
					</section>
				))}
			</div>
		</div>
	);
}

function PersonCard({ person, stage }: { person: Card; stage?: string }) {
	return (
		<article className="relative flex items-center gap-2.5 rounded-card bg-surface-raised p-3 shadow-raised">
			<Avatar name={person.name} size="sm" decorative />
			<div className="min-w-0">
				<Link
					href={`${PIPELINE_PATH}/${person.personId}`}
					className="block cursor-pointer truncate text-sm leading-[1.2] font-semibold text-ink after:absolute after:inset-0 after:rounded-card hover:underline"
				>
					{person.name}
				</Link>
				<p className="truncate text-xs text-text-3">
					{[stage, person.responsible ? `With ${person.responsible.name}` : "No responsible staff"]
						.filter(Boolean)
						.join(" · ")}
				</p>
				{person.lastMovedOn ? (
					<p className="truncate text-xs text-text-3">Last move {formatDay(person.lastMovedOn)}</p>
				) : null}
			</div>
		</article>
	);
}

/** Owners and Admins find retired people here, with their stage and history kept. */
function Retired({ board }: { board: PipelineBoard }) {
	const people = board.stages.flatMap((s) => s.people.map((p) => ({ p, stage: s.label })));
	if (!people.length)
		return (
			<EmptyState icon={UserMultipleIcon} title={board.query.q ? "No retired person matches" : "No one is retired"}>
				People you retire leave the board and the counts. Their history stays, and you can restore them.
			</EmptyState>
		);
	return (
		<ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
			{people.map(({ p, stage }) => (
				<li key={p.personId}>
					<PersonCard person={p} stage={stage} />
				</li>
			))}
		</ul>
	);
}

/** A seat with no pipeline duty sees how many people are at each stage, and nothing about who they are. */
function Counts({ board }: { board: PipelineBoard }) {
	return (
		<>
			<p className="mb-4 max-w-[640px] text-sm text-text-2">
				You can see how many people are at each stage. Owners, Admins and each person’s responsible staff see who they
				are.
			</p>
			<ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" aria-label="People at each stage">
				{board.stages.map((s) => (
					<li key={s.id} className="flex flex-col gap-1 rounded-card bg-surface-2 p-4">
						<span className="text-sm font-semibold text-ink">{s.label}</span>
						<span className="text-title-lg leading-none text-ink">{s.count}</span>
						<span className="sr-only">{plural(s.count, "person", "people")}</span>
					</li>
				))}
			</ul>
		</>
	);
}

function Pages({ board }: { board: PipelineBoard }) {
	const { query, pages } = board;
	if (pages <= 1 && query.page <= 1) return null;
	return (
		<nav aria-label="Pages" className="mt-4 flex items-center justify-center gap-3 text-sm">
			{query.page > 1 ? (
				<Link
					className="cursor-pointer font-medium text-ink underline"
					href={boardHref({ ...query, page: query.page - 1 })}
				>
					Previous
				</Link>
			) : null}
			<span className="text-text-2">
				Page {query.page} of {pages}
			</span>
			{query.page < pages ? (
				<Link
					className="cursor-pointer font-medium text-ink underline"
					href={boardHref({ ...query, page: query.page + 1 })}
				>
					Next
				</Link>
			) : null}
		</nav>
	);
}
