"use client";

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import type * as people from "@everyfield/contracts/people";
import { Button, IconButton, Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@everyfield/ui/controls";
import { PersonCard, PipelineColumn, StageChip, StatusBadge } from "@everyfield/ui/display";
import Link from "next/link";
import { useState, type DragEvent } from "react";
import type { z } from "zod";
import { loadColumn } from "./actions.ts";
import {
	listRequest,
	PersonStore,
	STAGE_KEY,
	STAGE_LABEL,
	STAGES,
	type ColumnValue,
	type PeopleQuery,
	type StageValue,
} from "./model.ts";
import { FormProblem, problemOf, When } from "./parts.tsx";
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
							key={`${g.column}:${g.cards.map((c) => c.person.id + c.person.revision).join()}`}
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
	// "Show more" pages stay in this column only; a refresh of the board starts every column again.
	const [extra, setExtra] = useState<{ cards: CardData[]; next: string | null; problem?: string }>({
		cards: [],
		next: group.next,
	});
	const [loading, setLoading] = useState(false);
	const cards = [...group.cards, ...extra.cards];
	async function more() {
		if (!extra.next || loading) return;
		setLoading(true);
		const r = await loadColumn(listRequest(query), group.column, extra.next).catch(() => ({ status: "lost" }) as const);
		setLoading(false);
		setExtra((x) =>
			r.status === "ok"
				? { cards: [...x.cards, ...r.value.cards], next: r.value.next }
				: { ...x, problem: problemOf(r) },
		);
	}

	return (
		<div
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
									linkAs={Link}
									dragging={dragging === card.person.id}
									meta={
										<>
											Added <When at={card.person.createdAt} />
										</>
									}
									footer={<CardBadges card={card} />}
									className={canWrite ? "pr-12" : undefined}
								/>
								{canWrite ? <MoveMenu card={card} onMove={onMove} /> : null}
							</li>
						))}
					</ul>
				) : null}
				{extra.next ? (
					<Button variant="ghost" size="sm" onClick={more} loading={loading} className="self-center">
						Show more
					</Button>
				) : null}
				<FormProblem code={extra.problem} />
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

/** The keyboard way to move a card: a menu of the other stages, in the card's corner. */
function MoveMenu({ card, onMove }: { card: CardData; onMove: (card: CardData, target?: StageValue) => void }) {
	return (
		<span className="absolute top-2 right-2 z-10">
			<Menu>
				<MenuTrigger asChild>
					<IconButton icon={MoreHorizontalIcon} label={`Move ${card.person.displayName}`} size="sm" />
				</MenuTrigger>
				<MenuContent align="end">
					<MenuLabel>Move to</MenuLabel>
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
