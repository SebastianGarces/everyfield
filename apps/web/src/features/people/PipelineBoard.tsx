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
import { useMemo, useState, type DragEvent } from "react";
import type { z } from "zod";
import { reorderPipeline } from "./actions.ts";
import { loadColumn } from "./fetch.ts";
import { useRouter } from "next/navigation";
import {
	columnCards,
	columnOf,
	isFiltered,
	listRequest,
	moveInOrder,
	STAGE_KEY,
	STAGE_LABEL,
	STAGES,
	type ColumnAnswer,
	type ColumnValue,
	type PeopleQuery,
	type StageValue,
} from "./model.ts";
import { useLocalStore } from "../../components/store.ts";
import { createPersonStore, runSave, withServer, type PersonStore } from "./person.store.ts";
import {
	CardLink,
	FormProblem,
	fresh,
	prefetchWarnings,
	problemOf,
	problemText,
	usePersonState,
	When,
} from "./parts.tsx";
import { StageDialog, type PersonDraft } from "./StageDialog.tsx";

type Pipeline = z.infer<typeof people.pipelineResult>;
type Group = Pipeline["groups"][number];
type CardData = Group["cards"][number];
type PlantPerson = z.infer<typeof people.plantPerson>;

export function PipelineBoard({
	query,
	pipeline,
	canWrite,
}: {
	query: PeopleQuery;
	pipeline: Pipeline;
	canWrite: boolean;
}) {
	const router = useRouter();
	const [moving, setMoving] = useState<{
		store: PersonStore<PlantPerson, PersonDraft>;
		card: CardData;
		target?: StageValue;
	} | null>(null);
	const [since, setSince] = useState<Since>(() => nothingSince(pipeline));
	const now = since.from === pipeline ? since : nothingSince(pipeline);
	const change = (edit: (s: Since) => void) =>
		setSince((s) => {
			const base = s.from === pipeline ? s : nothingSince(pipeline);
			const next = { from: pipeline, moved: new Map(base.moved), columns: new Map(base.columns) };
			edit(next);
			return next;
		});
	const place = (card: CardData) => change((s) => void s.moved.set(card.person.id, card));
	const answered = (column: ColumnValue, answer: Answer) => change((s) => void s.columns.set(column, answer));
	const [dragged, setDragged] = useState<CardData | null>(null);
	const [over, setOver] = useState<ColumnValue | null>(null);
	const move = (card: CardData, target?: StageValue) => {
		prefetchWarnings(card.person.id);
		setMoving({ store: createPersonStore<PlantPerson, PersonDraft>(card.person), card, target });
	};

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
							key={g.column}
							group={g}
							moved={now.moved}
							answer={now.columns.get(g.column)}
							onAnswer={(a) => answered(g.column, a)}
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
					key={moving.store.getState().saved.id}
					open
					onOpenChange={(open) => !open && setMoving(null)}
					store={moving.store}
					target={moving.target}
					from={columnOf(moving.card.person.stage)}
					onStage={(person, columns) => {
						place({ ...moving.card, person: person ?? moving.card.person });
						for (const column of columns ?? []) answered(column.column, column);
					}}
					onConflict={() => router.refresh()}
				/>
			) : null}
		</>
	);
}

type Answer = ColumnAnswer<PlantPerson["revision"]>;
type Since = { from: Pipeline; moved: Map<string, CardData>; columns: Map<ColumnValue, Answer> };
const nothingSince = (pipeline: Pipeline): Since => ({ from: pipeline, moved: new Map(), columns: new Map() });
const inColumn = (card: CardData, column: ColumnValue) => columnOf(card.person.stage) === column;

function Column({
	group,
	moved,
	answer,
	onAnswer,
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
	moved: ReadonlyMap<string, CardData>;
	answer: Answer | undefined;
	onAnswer: (answer: Answer) => void;
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
	const [extra, setExtra] = useState<{ from: Group; cards: CardData[]; next: number | null; problem?: string }>({
		from: group,
		cards: [],
		next: group.next,
	});
	const more_ = extra.from === group ? extra : { from: group, cards: [], next: group.next };
	const [loading, setLoading] = useState(false);
	const [pending, setPending] = useState<{ from: Group; ids: string[] } | null>(null);
	const loaded = [...group.cards, ...more_.cards];
	const cards = columnCards(group.column, loaded, moved, answer, pending?.from === group ? pending.ids : undefined);
	const count = (group.total ?? loaded.length) + cards.length - loaded.length;
	const router = useRouter();
	const own = useLocalStore(() => createPersonStore<{ revision: string }, null>({ revision: group.revision }));
	const columnRevision = answer?.revision ?? group.revision;
	const store = useMemo(() => withServer(own, { revision: columnRevision }), [own, columnRevision]);
	const order = usePersonState(store);
	const [said, setSaid] = useState("");
	const filtered = isFiltered(query);
	const complete = !filtered && !more_.next && cards.length <= 100;
	async function reorder(card: CardData, direction: "up" | "down") {
		const ids = moveInOrder(
			cards.map((c) => c.person.id),
			card.person.id,
			direction,
		);
		const at = ids.indexOf(card.person.id);
		const input = { column: group.column, personId: card.person.id, afterId: at > 0 ? ids[at - 1]! : null };
		const rev = order.saved.revision;
		setPending({ from: group, ids });
		const r = await runSave(store, "order", { input, rev }, (key) => reorderPipeline(key, rev, input), {
			fresh,
			toPerson: (v) => ({ revision: v.revision }),
		});
		setPending(null);
		if (r?.status === "ok") {
			onAnswer(r.value);
			setSaid(
				r.value.personIds.join() === ids.join()
					? `${card.person.displayName} moved ${direction}.`
					: "The order changed somewhere else. The column shows the latest order.",
			);
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
			data-revision={order.saved.revision}
			onDragOver={canWrite ? onDragOver : undefined}
			onDragLeave={canWrite ? onDragLeave : undefined}
			onDrop={canWrite ? onDrop : undefined}
		>
			<PipelineColumn stage={STAGE_KEY[group.column]} count={count} dropTarget={dropTarget}>
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

function CardBadges({ card }: { card: CardData }) {
	const overdue = card.activeParentDuties.filter((d) => d.warning === "overdue").length;
	const undated = card.activeParentDuties.filter((d) => d.warning === "missing_due_date").length;
	const stage = card.person.stage;
	const quiet = card.inactivity.level;
	if (!overdue && !undated && quiet === "none" && stage !== "launch_team" && stage !== "leader") return null;
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
			{quiet !== "none" ? (
				<StatusBadge status={quiet === "alert" ? "risk" : "attention"} size="sm" suppressHydrationWarning>
					Quiet {quietDays(card.inactivity.lastActivityAt)}
				</StatusBadge>
			) : null}
		</span>
	);
}

function quietDays(lastActivityAt: string): string {
	const days = Math.max(1, Math.floor((Date.now() - Date.parse(lastActivityAt)) / 86_400_000));
	return `${days} ${days === 1 ? "day" : "days"}`;
}

function MoveMenu({
	card,
	onMove,
	onReorder,
	first,
	last,
	why,
}: {
	card: CardData;
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
