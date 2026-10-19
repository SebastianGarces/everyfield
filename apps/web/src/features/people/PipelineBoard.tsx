"use client";

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import {
	Button,
	IconButton,
	Menu,
	MenuContent,
	MenuItem,
	MenuLabel,
	MenuSeparator,
	MenuTrigger,
} from "@everyfield/ui/controls";
import { PersonCard, PipelineColumn, StageChip, StatusBadge } from "@everyfield/ui/display";
import { useEffect, useState, type DragEvent } from "react";
import type { z } from "zod";
import { loadColumn, reorderPipeline } from "./actions.ts";
import { useRouter } from "next/navigation";
import {
	isFiltered,
	listRequest,
	moveInOrder,
	PersonStore,
	runSave,
	STAGE_KEY,
	STAGE_LABEL,
	STAGES,
	type ColumnValue,
	type PeopleQuery,
	type StageValue,
} from "./model.ts";
import { CardLink, FormProblem, fresh, problemOf, problemText, useStore, When } from "./parts.tsx";
import { StageDialog, type PersonDraft } from "./StageDialog.tsx";

type Pipeline = z.infer<typeof people.pipelineResult>;
type Group = Pipeline["groups"][number];
type CardData = Group["cards"][number];
type PlantPerson = z.infer<typeof people.plantPerson>;

/**
 * The pipeline (REQ-PPL-007): five columns; the last holds core group, launch team and leader with milestone badges.
 * Cards show only open parent follow-up work and its due-day warnings. Owners and Admins move a person by dragging a
 * card to another column or with the card's Move menu (the keyboard way); both open the same Change stage dialog.
 * Members see no move controls. Order inside a column is the server's order.
 */
export function PipelineBoard({
	query,
	pipeline,
	canWrite,
}: {
	query: PeopleQuery;
	pipeline: Pipeline;
	canWrite: boolean;
}) {
	const [moving, setMoving] = useState<{ store: PersonStore<PlantPerson, PersonDraft>; target?: StageValue } | null>(
		null,
	);
	const [dragged, setDragged] = useState<CardData | null>(null);
	const [over, setOver] = useState<ColumnValue | null>(null);
	const move = (card: CardData, target?: StageValue) =>
		setMoving({ store: new PersonStore<PlantPerson, PersonDraft>(card.person), target });

	return (
		<>
			<div
				role="region"
				aria-label="Pipeline"
				tabIndex={0}
				className="-mx-1 overflow-x-auto px-1 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--ef-focus)]"
			>
				<div className="grid min-w-[1180px] grid-cols-5 gap-3.5">
					{pipeline.groups.map((g) => (
						<Column
							// Keyed by column only: a refresh must not remount the column, or keyboard focus and the
							// last reorder message would be lost (verifier finding on b4d2ec0).
							key={g.column}
							group={g}
							query={query}
							canWrite={canWrite}
							dropTarget={over === g.column && dragged !== null && !inColumn(dragged, g.column)}
							onDragOver={(e) => {
								if (!dragged || inColumn(dragged, g.column)) return;
								e.preventDefault();
								setOver(g.column);
							}}
							onDragLeave={() => setOver((o) => (o === g.column ? null : o))}
							onDrop={(e) => {
								e.preventDefault();
								setOver(null);
								if (dragged && !inColumn(dragged, g.column)) move(dragged, g.column);
								setDragged(null);
							}}
							onDragStart={setDragged}
							onDragEnd={() => {
								setDragged(null);
								setOver(null);
							}}
							dragging={dragged?.person.id ?? null}
							onMove={move}
						/>
					))}
				</div>
			</div>
			{moving ? (
				<StageDialog
					key={moving.store.get().saved.id}
					open
					onOpenChange={(open) => !open && setMoving(null)}
					store={moving.store}
					target={moving.target}
				/>
			) : null}
		</>
	);
}

const inColumn = (card: CardData, column: ColumnValue) =>
	column === "core_group"
		? ["core_group", "launch_team", "leader"].includes(card.person.stage)
		: card.person.stage === column;

function Column({
	group,
	query,
	canWrite,
	dropTarget,
	dragging,
	onDragOver,
	onDragLeave,
	onDrop,
	onDragStart,
	onDragEnd,
	onMove,
}: {
	group: Group;
	query: PeopleQuery;
	canWrite: boolean;
	dropTarget: boolean;
	dragging: string | null;
	onDragOver: (e: DragEvent) => void;
	onDragLeave: () => void;
	onDrop: (e: DragEvent) => void;
	onDragStart: (card: CardData) => void;
	onDragEnd: () => void;
	onMove: (card: CardData, target?: StageValue) => void;
}) {
	// "Show more" pages belong to the server copy they were loaded on; a refresh brings a new first page and drops them.
	const [extra, setExtra] = useState<{ from: Group; cards: CardData[]; next: number | null; problem?: string }>({
		from: group,
		cards: [],
		next: group.next,
	});
	const more_ = extra.from === group ? extra : { from: group, cards: [], next: group.next };
	const [loading, setLoading] = useState(false);
	const loaded = [...group.cards, ...more_.cards];
	const router = useRouter();
	// One reorder at a time per column, with the column's revision as the lock (REQ-PPL-007). The whole column must be
	// loaded, because the server takes the complete order and refuses a partial one. The store outlives refreshes, so a
	// refusal message stays until the next try; the server's newer revision replaces the old one.
	const [store] = useState(() => new PersonStore<{ revision: string }, null>({ revision: group.revision }));
	const order = useStore(store);
	useEffect(() => store.dispatch({ type: "server", person: { revision: group.revision } }), [store, group.revision]);
	// The order just saved, shown until the server copy it was saved against is replaced by a refresh.
	const [saved, setSaved] = useState<{ from: Group; ids: string[] } | null>(null);
	const [said, setSaid] = useState("");
	const cards =
		saved && saved.from === group
			? saved.ids.map((id) => loaded.find((c) => c.person.id === id)!).filter(Boolean)
			: loaded;
	// The server takes the complete column order. A search or filter hides people, and "Show more" may not have run, so
	// reorder is offered only for an unfiltered, fully loaded column (verifier finding: q=an sent 2 of 5 IDs).
	const filtered = isFiltered(query);
	const complete = !filtered && !more_.next && loaded.length <= 100;
	// After a keyboard reorder, focus returns to the moved person's Move button, also after the refresh re-renders.
	async function reorder(card: CardData, direction: "up" | "down") {
		const ids = moveInOrder(
			cards.map((c) => c.person.id),
			card.person.id,
			direction,
		);
		const input = { column: group.column, personIds: ids };
		const rev = order.saved.revision;
		const r = await runSave(store, "order", { input, rev }, (key) => reorderPipeline(key, rev, input), {
			fresh,
			// The answer carries the column revision as saved now, so a quick next move uses it.
			toPerson: (v) => ({ revision: v.revision }),
		});
		if (r?.status === "ok") {
			// Show the column the server answered with: its order belongs to the revision the store just took.
			setSaved({ from: group, ids: r.value.personIds });
			setSaid(
				r.value.personIds.join() === ids.join()
					? `${card.person.displayName} moved ${direction}.`
					: "The order changed somewhere else. The column shows the latest order.",
			);
			router.refresh();
		} else if (r?.status === "refused" && r.code === "conflict") {
			setSaid("");
			router.refresh();
		}
	}
	async function more() {
		if (!more_.next || loading) return;
		setLoading(true);
		const r = await loadColumn(listRequest(query), group.column, more_.next).catch(() => ({ status: "lost" }) as const);
		setLoading(false);
		setExtra(
			r.status === "ok"
				? { from: group, cards: [...more_.cards, ...r.value.cards], next: r.value.next }
				: { ...more_, problem: problemOf(r) },
		);
	}

	return (
		<div
			// The server's column revision: changes when a refresh brings a newer saved order.
			data-revision={group.revision}
			onDragOver={canWrite ? onDragOver : undefined}
			onDragLeave={canWrite ? onDragLeave : undefined}
			onDrop={canWrite ? onDrop : undefined}
		>
			<PipelineColumn stage={STAGE_KEY[group.column]} count={group.total ?? cards.length} dropTarget={dropTarget}>
				{cards.length ? (
					<ul className="flex flex-col gap-2.5" aria-label={`${STAGE_LABEL[group.column]} people`}>
						{cards.map((card) => (
							<li
								key={card.person.id}
								draggable={canWrite}
								onDragStart={(e) => {
									e.dataTransfer.effectAllowed = "move";
									e.dataTransfer.setData("text/plain", card.person.displayName);
									onDragStart(card);
								}}
								onDragEnd={onDragEnd}
								className={canWrite ? "relative cursor-grab active:cursor-grabbing" : undefined}
							>
								<PersonCard
									name={card.person.displayName}
									href={`/people/${card.person.id}`}
									linkAs={CardLink}
									dragging={dragging === card.person.id}
									meta={
										<>
											Added <When at={card.person.createdAt} />
										</>
									}
									footer={<CardBadges card={card} />}
									className={canWrite ? "pr-12" : undefined}
								/>
								{canWrite ? (
									<MoveMenu
										card={card}
										onMove={onMove}
										onReorder={complete && order.pending === null ? (d) => reorder(card, d) : null}
										why={filtered ? "Clear filters to reorder" : "Show the whole column to reorder"}
										first={card === cards[0]}
										last={card === cards.at(-1)}
									/>
								) : null}
							</li>
						))}
					</ul>
				) : null}
				{more_.next ? (
					<Button variant="ghost" size="sm" onClick={more} loading={loading} className="self-center">
						Show more
					</Button>
				) : null}
				<FormProblem code={more_.problem} />
				<div aria-live="assertive" className="empty:hidden">
					{order.errors.order ? (
						<p className="rounded-md bg-magenta-50 px-3 py-2.5 text-sm text-magenta-600">
							{order.errors.order === "conflict"
								? "The order changed somewhere else. The column now shows the latest order; try the move again."
								: problemText(order.errors.order)}
						</p>
					) : null}
				</div>
				<p role="status" className="sr-only">
					{said}
				</p>
			</PipelineColumn>
		</div>
	);
}

/** Milestone and due-day badges. A person with no duty shows none: no follow-up is not urgent work (REQ-PPL-007). */
function CardBadges({ card }: { card: CardData }) {
	const overdue = card.activeParentDuties.filter((d) => d.warning === "overdue").length;
	const undated = card.activeParentDuties.filter((d) => d.warning === "missing_due_date").length;
	const stage = card.person.stage;
	if (!overdue && !undated && stage !== "launch_team" && stage !== "leader") return null;
	return (
		<span className="flex flex-wrap items-center gap-1.5">
			{stage === "launch_team" || stage === "leader" ? (
				<StageChip stage={STAGE_KEY[stage]}>{STAGE_LABEL[stage]}</StageChip>
			) : null}
			{overdue ? (
				<StatusBadge status="risk" size="sm">
					{overdue} overdue
				</StatusBadge>
			) : null}
			{undated ? (
				<StatusBadge status="attention" size="sm">
					No due date
				</StatusBadge>
			) : null}
		</span>
	);
}

/**
 * The keyboard way to move a card, in its corner: up or down inside the column, or to another stage. Up and down need
 * the whole column on screen; until then they are disabled and say why.
 */
function MoveMenu({
	card,
	onMove,
	onReorder,
	first,
	last,
	why,
}: {
	card: CardData;
	/** Why Move up and Move down are off, when they are. */
	why: string;
	onMove: (card: CardData, target?: StageValue) => void;
	onReorder: ((direction: "up" | "down") => void) | null;
	first: boolean;
	last: boolean;
}) {
	return (
		<span className="absolute top-2 right-2 z-10">
			<Menu>
				<MenuTrigger asChild>
					<IconButton icon={MoreHorizontalIcon} label={`Move ${card.person.displayName}`} size="sm" />
				</MenuTrigger>
				<MenuContent align="end">
					<MenuLabel>{onReorder ? "Order in this column" : why}</MenuLabel>
					<MenuItem disabled={!onReorder || first} onSelect={() => onReorder?.("up")}>
						Move up
					</MenuItem>
					<MenuItem disabled={!onReorder || last} onSelect={() => onReorder?.("down")}>
						Move down
					</MenuItem>
					<MenuSeparator />
					<MenuLabel>Move to stage</MenuLabel>
					{STAGES.filter((s) => s !== card.person.stage).map((s) => (
						<MenuItem key={s} onSelect={() => onMove(card, s)}>
							{STAGE_LABEL[s]}
						</MenuItem>
					))}
				</MenuContent>
			</Menu>
		</span>
	);
}
